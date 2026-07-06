#!/usr/bin/env node
/**
 * merge-clarice-subscribers.ts
 *
 * Merge multiple Stripe customer CSV exports into a single ranked list
 * for newsletter import to Kit (per #540).
 *
 * Lê todos os *.csv de data/clarice-subscribers/ (schemas distintos OK),
 * dedups+merges por email com regras campo-a-campo, aplica filtros hard,
 * computa score, classifica em COHORTS nomeados (#2857 fase C — sucessor da
 * taxonomia numérica T01-T10).
 *
 * Uso:
 *   npx tsx scripts/merge-clarice-subscribers.ts [--filter-clrc-pt]
 *
 * Output (em data/clarice-subscribers/):
 *   stripe-export-excluded.csv (audit trail — bounce risk, dispute, low-quality email)
 *
 * O universo por cohort (assinantes-ativos, ex-assinantes, leads-*) NÃO é
 * mais escrito em CSV por cohort (#2886 PR4) — CSV-as-SOURCE foi eliminado
 * depois que PR2 (#3019, clarice-mv-status.ts) e PR3 (#3020,
 * verify-emails-mv.ts) migraram seus leitores pro store. O universo
 * pontuado/classificado alimenta o store único via `buildUniverse()`
 * (consumido por `scripts/clarice-build-db.ts`); o `main()` abaixo só
 * escreve o audit trail de excluídos + faz o cleanup de outputs órfãos de
 * runs antigos deste script (o cleanup roda em toda invocação — não é
 * one-time, ver `orphanPatterns`).
 *
 * Stdout: JSON sumário; stderr: progresso humano-legível.
 */

import { readFileSync, writeFileSync, readdirSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import Papa from "papaparse";
import { deriveLeadCohort } from "./lib/clarice-segment.ts";
import {
  COHORT_ASSINANTES_ATIVOS,
  COHORT_EX_ASSINANTES,
  COHORT_LEADS_CAUDAO,
  cohortSendRank,
  cohortDisplayLabel,
} from "./lib/cohorts.ts";

const ROOT = resolve(import.meta.dirname, "..");
const DATA_DIR = resolve(ROOT, "data/clarice-subscribers");

type Record = {
  id: string | null;
  email: string;
  name: string | null;
  created: Date | null;
  description: string | null;
  tag: string | null;
  delinquent: boolean | null;
  plan: string | null;
  status: string | null;
  total_spend: number;
  payment_count: number;
  refunded_volume: number;
  dispute_losses: number;
};

export type Merged = Record & {
  stripe_ids: string[];
  source_files: string[];
};

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

function parseFloatSafe(v: string | undefined | null): number {
  if (!v || !v.trim()) return 0;
  const n = parseFloat(v);
  return isNaN(n) ? 0 : n;
}

function parseIntSafe(v: string | undefined | null): number {
  if (!v || !v.trim()) return 0;
  const n = parseInt(v, 10);
  return isNaN(n) ? 0 : n;
}

function parseBool(v: string | undefined | null): boolean | null {
  if (!v || !v.trim()) return null;
  return v.trim().toLowerCase() === "true";
}

function parseDate(v: string | undefined | null): Date | null {
  if (!v || !v.trim()) return null;
  // "2024-01-01 02:57" → ISO
  const s = v.trim();
  const iso = s.includes("T") ? s : s.replace(" ", "T") + ":00Z";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}

function emailValid(e: string | null): boolean {
  if (!e) return false;
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e.trim());
}

// ---------------------------------------------------------------------------
// Filtros de emails que não valem nem verificar (bounce garantido ou nenhum
// humano vai abrir — role accounts, descartáveis, institucionais, fake)
// ---------------------------------------------------------------------------

const DISPOSABLE_DOMAINS = new Set([
  "mailinator.com","guerrillamail.com","throwam.com","trashmail.com","yopmail.com",
  "tempmail.com","10minutemail.com","10mail.org","sharklasers.com","grr.la",
  "dispostable.com","maildrop.cc","mintemail.com","spamgourmet.com","trashmail.at",
  "trashmail.io","trashmail.me","trashmail.net","trashmail.org","discard.email",
  "spam4.me","getairmail.com","binkmail.com","bobmail.info","lol.ovh",
  "20minutemail.com","tempr.email","filzmail.com","mailnull.com","spamspot.com",
  "no-spam.ws","e4ward.com",
]);

const ROLE_PREFIXES = [
  // Técnicos
  "noreply","no-reply","donotreply","do-not-reply","postmaster","webmaster",
  "abuse","hostmaster","mailer-daemon","mailer_daemon",
  // Role accounts em português (caixas de empresa)
  "contato","info","contact","comercial","vendas","suporte","financeiro",
  "administrativo","compras","marketing","juridico","fiscal",
  "dp","sac","diretoria","secretaria","recepcao","atendimento",
];

export function isLowQualityEmail(email: string): { bad: boolean; reason: string } {
  const [local, domain] = email.toLowerCase().split("@");
  if (!local || !domain) return { bad: false, reason: "" };

  // 1. Domínio descartável
  if (DISPOSABLE_DOMAINS.has(domain))
    return { bad: true, reason: "disposable_domain" };

  // 2. Domínio de teste/exemplo
  if (/^(example|test|invalid|localhost)\./.test(domain) || domain === "example.com")
    return { bad: true, reason: "test_domain" };

  // 3. Role account (prefixo de função)
  if (ROLE_PREFIXES.some(r => local === r || local.startsWith(r + ".") || local.startsWith(r + "-") || local.startsWith(r + "_")))
    return { bad: true, reason: "role_account" };

  // 4. Parte local muito curta (1–2 chars) — siglas de departamento
  if (local.length <= 2)
    return { bad: true, reason: "local_too_short" };

  // 5. Parte local numéricamente pura + domínio educacional/gov
  if (/^\d+$/.test(local) && /\.(edu|ac)\.(br|pt|ao)|estudantes?\.|alunos?\.|students?\.|\.gov\.|emeb\.|joinville\.edu/.test(domain))
    return { bad: true, reason: "institutional_student_id" };

  // 6. Número muito longo (CPF/matrícula) em provedores pessoais
  if (/^\d{8,}$/.test(local) && ["gmail.com","hotmail.com","yahoo.com.br","outlook.com"].includes(domain))
    return { bad: true, reason: "numeric_id_personal_provider" };

  // 7. Placeholder óbvio
  if (/^(seuemail|youremail|meuemail|email|nome|your\.name|yourname|your-name)$/.test(local))
    return { bad: true, reason: "placeholder" };

  // 8. Padrão claramente fake
  if (/^(test|teste|demo|fake|asdf|qwerty|a{3,}|abc123?|null|undefined|admin_test)$/.test(local))
    return { bad: true, reason: "fake_pattern" };

  return { bad: false, reason: "" };
}

// ---------------------------------------------------------------------------
// CSV reading
// ---------------------------------------------------------------------------

interface CsvFile {
  rows: Record_<string, string>[];
  headers: string[];
  filename: string;
}
type Record_<K extends string, V> = { [P in K]: V };

function readCsv(path: string): CsvFile {
  const content = readFileSync(path, "utf8");
  const result = Papa.parse<Record_<string, string>>(content, {
    header: true,
    skipEmptyLines: true,
  });
  return {
    rows: result.data,
    headers: result.meta.fields || [],
    filename: path.split(/[\/\\]/).pop() || path,
  };
}

function normalizeRow(row: Record_<string, string>): Record | null {
  const email = (row["Email"] || "").trim().toLowerCase();
  if (!email) return null;
  return {
    id: (row["id"] || "").trim() || null,
    email,
    name: (row["Name"] || "").trim() || null,
    created: parseDate(row["Created (UTC)"]),
    description: (row["Description"] || "").trim() || null,
    tag: (row["tag (metadata)"] || "").trim() || null,
    delinquent: parseBool(row["Delinquent"]),
    plan: (row["Plan"] || "").trim() || null,
    status: (row["Status"] || "").trim() || null,
    total_spend: parseFloatSafe(row["Total Spend"]),
    payment_count: parseIntSafe(row["Payment Count"]),
    refunded_volume: parseFloatSafe(row["Refunded Volume"]),
    dispute_losses: parseFloatSafe(row["Dispute Losses"]),
  };
}

// ---------------------------------------------------------------------------
// Merge logic (per #540)
// ---------------------------------------------------------------------------

const STATUS_RANK: { [k: string]: number } = {
  active: 5,
  past_due: 4,
  trialing: 3,
  canceled: 2,
  "": 1,
};

function preferStatus(a: string | null, b: string | null): string | null {
  const ra = STATUS_RANK[a || ""] ?? 1;
  const rb = STATUS_RANK[b || ""] ?? 1;
  return ra >= rb ? a : b;
}

export function mergeRecord(existing: Merged, rec: Record, filename: string): void {
  if (rec.id && !existing.stripe_ids.includes(rec.id)) {
    existing.stripe_ids.push(rec.id);
  }
  if (!existing.source_files.includes(filename)) {
    existing.source_files.push(filename);
  }
  // Name: prefer record with mais recente Created
  if (rec.name) {
    if (!existing.name) existing.name = rec.name;
    else if (rec.created && existing.created && rec.created > existing.created) {
      existing.name = rec.name;
    }
  }
  // Created: keep MAX
  if (rec.created && (!existing.created || rec.created > existing.created)) {
    existing.created = rec.created;
  }
  // Description: prefer 'clrc-pt'
  if (rec.description === "clrc-pt") existing.description = "clrc-pt";
  else if (!existing.description && rec.description) existing.description = rec.description;
  // Tag: prefer 'clrc-pt'
  if (rec.tag === "clrc-pt") existing.tag = "clrc-pt";
  else if (!existing.tag && rec.tag) existing.tag = rec.tag;
  // Delinquent: OR (any true → true)
  if (rec.delinquent === true) existing.delinquent = true;
  else if (existing.delinquent === null && rec.delinquent !== null) {
    existing.delinquent = rec.delinquent;
  }
  // Plan: prefer non-null
  if (rec.plan && !existing.plan) existing.plan = rec.plan;
  // Status: prefer most active
  existing.status = preferStatus(existing.status, rec.status);
  // Sums
  existing.total_spend += rec.total_spend;
  existing.payment_count += rec.payment_count;
  existing.refunded_volume += rec.refunded_volume;
  existing.dispute_losses += rec.dispute_losses;
}

// ---------------------------------------------------------------------------
// Score
// ---------------------------------------------------------------------------

export function recencyWeight(d: Date | null, now: Date): number {
  if (!d) return 0.1;
  const months = (now.getTime() - d.getTime()) / (1000 * 60 * 60 * 24 * 30.44);
  if (months < 12) return 1.0;
  if (months < 24) return 0.6;
  if (months < 36) return 0.3;
  return 0.1;
}

export function computeScore(m: Merged, now: Date): number {
  const spendW = Math.log(1 + m.total_spend) * 1.0;
  const countW = Math.log(1 + m.payment_count) * 0.5;
  const recencyW = recencyWeight(m.created, now);
  let s = spendW + countW + recencyW;
  if (m.dispute_losses > 0) s -= 5;
  if (m.total_spend > 0 && m.refunded_volume > 0.5 * m.total_spend) s -= 2;
  return s;
}

/**
 * Helper informacional — verifica se o contato tem tag/description `clrc-pt`.
 *
 * **NÃO usar em scoring** (verifyRisk, openProbability, computeScore). O tagging
 * Stripe começou em 2024 e foi populado inconsistentemente até 2025; usar como
 * sinal enviesa contatos antigos legítimos.
 *
 * Uso correto: filtros opt-in (--filter-clrc-pt) e logs informacionais.
 */
export function hasClariceAudienceTag(
  m: Pick<Merged, "description" | "tag">,
): boolean {
  return m.description === "clrc-pt" || m.tag === "clrc-pt";
}

// ---------------------------------------------------------------------------
// verify_risk: escala 1–10 de necessidade de verificar o email antes de enviar
//   1–2 = baixo (enviar sem verificar)
//   3–10 = verificar no MillionVerifier antes de enviar (#1297)
//
// Convenção revisada em #1297: antes era T6+ → MV, mas o T02 (ex-assinantes)
// cai em verify_risk 4–5 e mostrou bounce esperado de 5–10% — alto o bastante
// pra contaminar a reputação do IP/domínio Brevo (afeta o T01 no mesmo IP).
// Agora qualquer verify_risk ≥ 3 passa pelo MillionVerifier via
// `scripts/verify-emails-mv.ts` antes do envio. Só T1 ativo (risk 1) e
// pagantes muito engajados recentes (risk 2) pulam a verificação.
//
// Não usa tag clrc-pt como sinal: tagging só começou em 2024 e foi populado
// inconsistentemente até 2025; usar tag enviesava contatos antigos legítimos
// pra níveis piores. Pra não-pagantes, recência sozinha é o sinal mais defensável.
// ---------------------------------------------------------------------------

export function verifyRisk(m: Merged, now: Date): number {
  const months = m.created
    ? (now.getTime() - m.created.getTime()) / (1000 * 60 * 60 * 24 * 30.44)
    : 48; // sem data → tratar como antigo

  // --- Baixo risco (1–3): evidência forte de email ativo ---

  // 1: status ativo hoje → recebendo cobranças Clarice, email certamente válido
  if (m.status === "active") return 1;

  // 2: muito engajado historicamente + conta recente
  if (m.payment_count >= 10 && months < 24) return 2;

  // 3: engajado + conta jovem
  if (m.payment_count >= 3 && months < 24) return 3;

  // --- Médio risco (4–5): algum histórico mas incerteza crescente ---

  // 4: pagou pelo menos 1x e conta ≤ 3 anos
  if (m.payment_count >= 1 && months < 36) return 4;

  // 5: pagou pelo menos 1x e conta ≥ 3 anos (legacy paid customer)
  // Fix #1017: antes era `months < 60` que deixava paid+60mo cair em níveis
  // 6–10 (nunca-pagou). Sem upper bound aqui, qualquer pagante antigo fica
  // em 5 corretamente.
  if (m.payment_count >= 1) return 5;

  // --- Risco crescente por recência pura (6–10): nunca pagou ---

  // 6: nunca pagou, conta ≤ 1 ano (lead fresco)
  if (months < 12) return 6;

  // 7: nunca pagou, conta 1–2 anos
  if (months < 24) return 7;

  // 8: nunca pagou, conta 2–3 anos
  if (months < 36) return 8;

  // 9: nunca pagou, conta 3–4 anos
  if (months < 48) return 9;

  // 10: nunca pagou, 4+ anos (fóssil)
  return 10;
}

// ---------------------------------------------------------------------------
// open_probability: chance estimada (0–100%) de abrir a newsletter
// ---------------------------------------------------------------------------

export function openProbability(m: Merged, now: Date): number {
  // Base pela relação financeira com a Clarice.
  // Tag clrc-pt removida do critério: tagging começou em 2024 e foi populado
  // inconsistentemente, criava viés contra contatos antigos legítimos.
  //
  // Não-pagantes agora começam em 12 (média ponderada da fórmula antiga
  // 17 se clrc-pt / 11 caso contrário). Cálculo: na base atual ~24% têm tag,
  // logo 0.24*17 + 0.76*11 ≈ 12.4. Arredondado pra 12 — fiel ao histórico,
  // sem premiar artificialmente leads sem tag por uma inferência fraca.
  let prob: number;
  if (m.status === "active")          prob = 62; // cliente pagando hoje
  else if (m.total_spend >= 1000)     prob = 50;
  else if (m.total_spend >= 100)      prob = 40;
  else if (m.total_spend >= 10)       prob = 30;
  else if (m.total_spend > 0)         prob = 22;
  else                                prob = 12; // nunca pagou (recência aplica modificador abaixo)

  // Modificador de recência
  if (m.created) {
    const months = (now.getTime() - m.created.getTime()) / (1000 * 60 * 60 * 24 * 30.44);
    if (months < 12)      prob += 12;
    else if (months < 24) prob += 6;
    else if (months < 36) prob += 0;
    else                  prob -= 6;
  }

  // Modificador de engajamento (payment_count)
  if (m.payment_count >= 20)      prob += 10;
  else if (m.payment_count >= 10) prob += 7;
  else if (m.payment_count >= 5)  prob += 4;

  // Negativos
  if (m.delinquent === true) prob -= 5;
  if (m.status === "canceled") prob -= 3;

  return Math.max(4, Math.min(80, Math.round(prob)));
}

// ---------------------------------------------------------------------------
// Cohort — taxonomia nomeada pra warmup faseado (#2857 fase C — sucessor da
// taxonomia numérica T01-T10 de #1018/#1020, cutover final).
//
// assinantes-ativos = status ∈ {active, past_due, paused, trialing}
// ex-assinantes     = pagou alguma vez E não está em assinantes-ativos
// leads-YYYY-MM     = nunca pagou, `created` >= epoch da safra (2026-05, #2817)
// leads-YYYYhN      = nunca pagou, `created` anterior ao epoch (semestre REAL)
// leads-caudao      = nunca pagou, sem `created` (fóssil)
//
// Critério: estado atual da relação (assinante-ativo) → história de pagamento
// (ex-assinante) → período REAL de `created` (lead). Payer é SEMPRE fixo
// (created irrelevante) — mesma regra que `computeCohort` (clarice-db.ts) usa
// como fallback pra dado legado; aqui computada com o contexto COMPLETO do
// Stripe (payment_count/total_spend, que o store NÃO persiste — por isso é o
// merge, não o store, quem precisa fazer essa distinção). Lead usa
// `deriveLeadCohort` (scripts/lib/clarice-segment.ts) — MESMA fonte que o
// store usa pra derivar cohort de linhas legadas, unifica a derivação e
// elimina a divergência que existia entre o rótulo estático que o tier
// residual do merge atribuía e o `created` real (motivo da fase B.1).
// ---------------------------------------------------------------------------

const PAYER_ACTIVE_STATUSES = new Set(["active", "past_due", "paused", "trialing"]);

/**
 * Cohort de um contato (#2857 fase C — sucessor de `tierOf`, removida nesta
 * fase). Sem parâmetro `now`: ao contrário da antiga taxonomia por tier (que
 * rotulava leads por SEMESTRE DESLIZANTE relativo à data do merge — rótulo que
 * ficava errado a cada virada de semestre, motivo da fase B.1), o cohort de
 * lead deriva do período REAL e ABSOLUTO de `created` — não muda com o tempo.
 */
export function cohortOf(m: Merged): string {
  if (m.status && PAYER_ACTIVE_STATUSES.has(m.status)) return COHORT_ASSINANTES_ATIVOS;
  if (m.payment_count > 0 || m.total_spend > 0) return COHORT_EX_ASSINANTES;
  const created = m.created ? m.created.toISOString() : null;
  return deriveLeadCohort(created) ?? COHORT_LEADS_CAUDAO; // sem created → fóssil
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export interface Scored extends Merged {
  score: number;
  verify_risk: number;
  open_probability: number;
  cohort: string;
}

// ---------------------------------------------------------------------------
// buildUniverse — pipeline read→merge→filter→score→tier como função reutilizável.
//
// Extraído pra alimentar o store único da Clarice (#2647,
// `scripts/clarice-build-db.ts`) sem reexecutar o `main()` (que faz logging +
// escreve só o audit trail de excluídos desde #2886 PR4 — o write side por
// cohort foi eliminado). Retorna o universo completo com TODOS os sinais do
// Stripe preservados (o `Scored` carrega os campos brutos do `Merged`).
//
// NB (#2647): `main()` abaixo ainda tem uma cópia inline desta lógica (logging
// per-arquivo + distribuições). Migrar `main()` pra chamar `buildUniverse` é
// follow-up — mantido separado aqui pra não tocar o caminho de leitura/merge
// já validado em produção. As duas cópias compartilham os mesmos helpers
// (readCsv/normalizeRow/mergeRecord/computeScore/verifyRisk/cohortOf).
// ---------------------------------------------------------------------------

export interface Universe {
  kept: Scored[];
  excluded: Array<Merged & { reason: string }>;
  merged: Map<string, Merged>;
  filesCount: number;
  allRecordsCount: number;
  /** CSVs que falharam ao ler (ex: placeholder OneDrive) → store fica parcial. */
  skippedFiles: string[];
}

export function buildUniverse(
  dataDir: string = DATA_DIR,
  now: Date = new Date(),
  filterClrcPt = false,
): Universe {
  const files = readdirSync(dataDir).filter(
    (f) =>
      f.endsWith(".csv") &&
      !f.startsWith("kit-import-") &&
      !f.startsWith("brevo-import-") &&
      !f.startsWith("mv-export-") && // outputs do MillionVerifier não são fonte Stripe
      !f.startsWith("stripe-export-"),
  );

  const merged = new Map<string, Merged>();
  const skippedFiles: string[] = [];
  let allRecordsCount = 0;
  for (const f of files) {
    let parsed: CsvFile;
    try {
      parsed = readCsv(resolve(dataDir, f));
    } catch (e) {
      // Um arquivo ilegível (ex: placeholder OneDrive não-hidratado / provedor de
      // nuvem offline) não deve crashar o build inteiro — pula com aviso alto.
      // O store fica PARCIAL (faltam os contatos desse arquivo); o caller reporta.
      console.error(`⚠️  pulando CSV ilegível ${f}: ${(e as Error).message}`);
      skippedFiles.push(f);
      continue;
    }
    const { rows, filename } = parsed;
    for (const row of rows) {
      const rec = normalizeRow(row);
      if (!rec) continue;
      allRecordsCount++;
      const existing = merged.get(rec.email);
      if (!existing) {
        merged.set(rec.email, {
          ...rec,
          stripe_ids: rec.id ? [rec.id] : [],
          source_files: [filename],
        });
      } else {
        mergeRecord(existing, rec, filename);
      }
    }
  }

  const kept: Scored[] = [];
  const excluded: Array<Merged & { reason: string }> = [];
  for (const m of merged.values()) {
    if (!emailValid(m.email)) {
      excluded.push({ ...m, reason: "invalid_email" });
      continue;
    }
    const lqCheck = isLowQualityEmail(m.email);
    if (lqCheck.bad) {
      excluded.push({ ...m, reason: lqCheck.reason });
      continue;
    }
    if (filterClrcPt && !hasClariceAudienceTag(m)) {
      excluded.push({ ...m, reason: "not_clrc_pt" });
      continue;
    }
    if (m.dispute_losses > 0) {
      excluded.push({ ...m, reason: "dispute_losses" });
      continue;
    }
    kept.push({
      ...m,
      score: computeScore(m, now),
      verify_risk: verifyRisk(m, now),
      open_probability: openProbability(m, now),
      cohort: cohortOf(m),
    });
  }

  return { kept, excluded, merged, filesCount: files.length, allRecordsCount, skippedFiles };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * @param now Data de referência para score/verify_risk (cohort não depende mais
 *            de `now` desde a fase C — deriva do período ABSOLUTO de `created`,
 *            ver `cohortOf`). Default = `new Date()` (produção). Testes de
 *            integração devem passar explicitamente pra não ficarem sujeitos à
 *            virada de semestre do sistema (#2724 CI incident).
 */
export function main(dataDir: string = DATA_DIR, now: Date = new Date()): void {
  const filterClrcPt = process.argv.includes("--filter-clrc-pt");

  // Filtra arquivos CSV que NÃO são output do próprio script (importa só as
  // FONTES cruas do Stripe = stripe-customers-*). Pula os outputs `stripe-export-*`
  // (atual) e os legados `brevo-import-*`/`kit-import-*`. NB: `stripe-customers-`
  // NÃO casa com `stripe-export-`, então as fontes continuam sendo lidas.
  const files = readdirSync(dataDir)
    .filter((f) =>
      f.endsWith(".csv") &&
      !f.startsWith("kit-import-") &&
      !f.startsWith("brevo-import-") &&
      !f.startsWith("stripe-export-"),
    );

  console.error(`📂 lendo ${files.length} CSVs de ${dataDir}`);
  if (filterClrcPt) {
    console.error(`🎯 filtro hard --filter-clrc-pt ATIVO`);
  } else {
    console.error(`ℹ️  sem filtro de clrc-pt (default — só logging informacional)`);
  }

  const allRecords: Array<{ rec: Record; filename: string }> = [];
  for (const f of files) {
    const path = resolve(dataDir, f);
    const { rows, filename } = readCsv(path);
    let valid = 0;
    for (const row of rows) {
      const rec = normalizeRow(row);
      if (rec) {
        allRecords.push({ rec, filename });
        valid++;
      }
    }
    console.error(`  ${f}: ${rows.length} linhas → ${valid} com email`);
  }

  console.error(`\n📊 total registros (pré-merge): ${allRecords.length}`);

  // Merge by email
  const merged = new Map<string, Merged>();
  for (const { rec, filename } of allRecords) {
    const existing = merged.get(rec.email);
    if (!existing) {
      merged.set(rec.email, {
        ...rec,
        stripe_ids: rec.id ? [rec.id] : [],
        source_files: [filename],
      });
    } else {
      mergeRecord(existing, rec, filename);
    }
  }

  console.error(`📦 emails únicos pós-merge: ${merged.size}`);
  console.error(`   colapso: ${allRecords.length - merged.size} duplicatas eliminadas`);

  // Distribution diagnostics — tag clrc-pt rastreada só pra log informacional;
  // não entra mais no scoring (verifyRisk/openProbability) pois o tagging foi
  // populado inconsistentemente entre 2021–2024.
  const distrClrcPt = { yes: 0, no: 0 };
  const distrSpend = { zero: 0, lt10: 0, lt100: 0, lt1000: 0, gte1000: 0 };
  const distrCreated: { [year: string]: number } = {};
  for (const m of merged.values()) {
    if (hasClariceAudienceTag(m)) distrClrcPt.yes++;
    else distrClrcPt.no++;
    if (m.total_spend === 0) distrSpend.zero++;
    else if (m.total_spend < 10) distrSpend.lt10++;
    else if (m.total_spend < 100) distrSpend.lt100++;
    else if (m.total_spend < 1000) distrSpend.lt1000++;
    else distrSpend.gte1000++;
    const year = m.created ? String(m.created.getUTCFullYear()) : "unknown";
    distrCreated[year] = (distrCreated[year] || 0) + 1;
  }

  console.error(`\n📋 distribuição clrc-pt: yes=${distrClrcPt.yes} (${(distrClrcPt.yes / merged.size * 100).toFixed(1)}%) · no=${distrClrcPt.no}`);
  console.error(`📋 distribuição total_spend:`);
  console.error(`   zero:   ${distrSpend.zero}`);
  console.error(`   <10:    ${distrSpend.lt10}`);
  console.error(`   <100:   ${distrSpend.lt100}`);
  console.error(`   <1000:  ${distrSpend.lt1000}`);
  console.error(`   ≥1000:  ${distrSpend.gte1000}`);
  console.error(`📋 distribuição created (year max):`);
  for (const [y, c] of Object.entries(distrCreated).sort()) {
    console.error(`   ${y}: ${c}`);
  }

  // Apply hard filters
  const kept: Scored[] = [];
  const excluded: Array<Merged & { reason: string }> = [];
  for (const m of merged.values()) {
    if (!emailValid(m.email)) {
      excluded.push({ ...m, reason: "invalid_email" });
      continue;
    }
    const lqCheck = isLowQualityEmail(m.email);
    if (lqCheck.bad) {
      excluded.push({ ...m, reason: lqCheck.reason });
      continue;
    }
    if (filterClrcPt && !hasClariceAudienceTag(m)) {
      excluded.push({ ...m, reason: "not_clrc_pt" });
      continue;
    }
    if (m.dispute_losses > 0) {
      excluded.push({ ...m, reason: "dispute_losses" });
      continue;
    }
    const score = computeScore(m, now);
    const verify_risk = verifyRisk(m, now);
    const open_probability = openProbability(m, now);
    const cohort = cohortOf(m);
    kept.push({ ...m, score, verify_risk, open_probability, cohort });
  }

  console.error(`\n✅ kept: ${kept.length} · ❌ excluded: ${excluded.length}`);

  // Agrupa por cohort; dentro do cohort ordena por score desc + email asc.
  const byCohort = new Map<string, Scored[]>();
  for (const c of kept) {
    if (!byCohort.has(c.cohort)) byCohort.set(c.cohort, []);
    byCohort.get(c.cohort)!.push(c);
  }
  for (const arr of byCohort.values()) {
    arr.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.email.localeCompare(b.email);
    });
  }

  // Ordem determinística via cohortSendRank (morno→frio) — só afeta a ordem
  // do logging abaixo (cohortCounts/sample); cada cohort não vira mais CSV
  // (#2886 PR4 — o write side de `stripe-export-{cohort}.csv` foi eliminado:
  // a lista base por cohort agora vive só no store, via `buildUniverse` +
  // `clarice-build-db.ts`. `stripe-export-{cohort}.csv` não tinha mais
  // nenhum leitor desde PR2 (#3019, clarice-mv-status.ts) e PR3 (#3020,
  // verify-emails-mv.ts) migrarem pra query no store).
  const cohortsSorted = [...byCohort.keys()].sort(
    (a, b) => cohortSendRank(a) - cohortSendRank(b),
  );

  // Cleanup de outputs órfãos: qualquer `stripe-export-{cohort}.csv` de um run
  // anterior (agora sempre órfão, já que este script parou de escrever esses
  // arquivos) + o formato numérico ANTIGO `stripe-export-t{NN}-*` (#2857 fase
  // C) + os esquemas LEGADOS (`kit-import-*`, `brevo-import-tier{N}`,
  // `brevo-import-t{NN}[-slug]`). Nunca casa `stripe-export-excluded.csv`
  // (audit trail distinto, mantido — não tem prefixo de cohort reconhecido).
  // (não pega -verified/-rejected/-unknown, que moram no dir do ciclo, não no root)
  const orphanPatterns = [
    /^kit-import-(tier\d+|excluded)\.csv$/,
    /^brevo-import-tier\d+\.csv$/, // legado sem padding (tier1, tier2, tier3 antigos)
    /^brevo-import-t\d{2}(-[A-Za-z0-9-]+)?\.csv$/, // legado pré-stripe-export (#1965)
    /^stripe-export-t\d{2}(-[A-Za-z0-9-]+)?\.csv$/, // formato numérico pré-#2857-fase-C
    /^stripe-export-(assinantes-ativos|ex-assinantes|leads-[\w-]+)\.csv$/, // cohort atual: sempre órfão pós-#2886 PR4
  ];
  for (const f of readdirSync(dataDir)) {
    if (orphanPatterns.some((re) => re.test(f))) {
      const path = resolve(dataDir, f);
      try {
        unlinkSync(path);
        console.error(`🧹 removido órfão: ${f}`);
      } catch (e) {
        console.error(`⚠️  falha ao remover ${f}: ${(e as Error).message}`);
      }
    }
  }

  const excludedCsv = Papa.unparse(
    excluded.map((r) => ({
      email: r.email,
      reason: r.reason,
      full_name: r.name || "",
      description: r.description || "",
      tag: r.tag || "",
      dispute_losses: r.dispute_losses.toFixed(2),
      total_spend: r.total_spend.toFixed(2),
      stripe_ids: r.stripe_ids.join(";"),
    })),
  );
  writeFileSync(resolve(dataDir, "stripe-export-excluded.csv"), excludedCsv, "utf8");

  // Distribuição de motivos
  const reasons: { [k: string]: number } = {};
  for (const e of excluded) reasons[e.reason] = (reasons[e.reason] || 0) + 1;

  // Cohort counts pra log + JSON summary
  const cohortCounts: { [k: string]: number } = {};
  for (const cohort of cohortsSorted) {
    cohortCounts[cohort] = (byCohort.get(cohort) ?? []).length;
  }

  console.error(`\n📤 outputs em ${dataDir}:`);
  for (const cohort of cohortsSorted) {
    console.error(`   ${cohort} (${cohortDisplayLabel(cohort)}): ${cohortCounts[cohort].toLocaleString("pt-BR")}`);
  }
  console.error(`   excluded: ${excluded.length.toLocaleString("pt-BR")}`);

  console.error(`\n📋 motivos de exclusão:`);
  for (const [r, c] of Object.entries(reasons).sort((a, b) => b[1] - a[1])) {
    console.error(`   ${r}: ${c}`);
  }

  // Sample top 10 de assinantes-ativos (quem vai primeiro num warmup).
  const payerSample = byCohort.get(COHORT_ASSINANTES_ATIVOS) ?? [];
  console.error(`\n🏆 sample top 10 de ${COHORT_ASSINANTES_ATIVOS}:`);
  for (let i = 0; i < Math.min(10, payerSample.length); i++) {
    const t = payerSample[i];
    console.error(
      `   ${(i + 1).toString().padStart(2)}. ${t.email.padEnd(40)} ` +
        `score=${t.score.toFixed(2)} ` +
        `spend=${t.total_spend.toFixed(0)} ` +
        `pmt=${t.payment_count} ` +
        `created=${t.created?.toISOString().slice(0, 10) || "?"} ` +
        `clrc=${hasClariceAudienceTag(t) ? "Y" : "N"}`,
    );
  }

  // Final summary as JSON
  console.log(
    JSON.stringify(
      {
        files_read: files.length,
        records_total: allRecords.length,
        unique_emails: merged.size,
        kept: kept.length,
        excluded: excluded.length,
        cohorts: cohortCounts,
        exclude_reasons: reasons,
        distribution: {
          clrc_pt: distrClrcPt,
          spend: distrSpend,
          year: distrCreated,
        },
      },
      null,
      2,
    ),
  );
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  main();
}
