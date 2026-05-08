#!/usr/bin/env node
/**
 * merge-clarice-subscribers.ts
 *
 * Merge multiple Stripe customer CSV exports into a single ranked list
 * for newsletter import to Kit (per #540).
 *
 * Lê todos os *.csv de data/clarice-subscribers/ (schemas distintos OK),
 * dedups+merges por email com regras campo-a-campo, aplica filtros hard,
 * computa score, divide em tiers.
 *
 * Uso:
 *   npx tsx scripts/merge-clarice-subscribers.ts [--filter-clrc-pt]
 *
 * Output (em data/clarice-subscribers/):
 *   brevo-import-t01.csv      Tier 1: assinante atual
 *   brevo-import-t02.csv      Tier 2: ex-assinante
 *   brevo-import-t03.csv      Tier 3: lead 2026-H1
 *   brevo-import-t04.csv      Tier 4: lead 2025-H2
 *   ...
 *   brevo-import-t10.csv      Tier 10: lead 2021–2022
 *   brevo-import-excluded.csv (audit trail — bounce risk, dispute, low-quality email)
 *
 * Stdout: JSON sumário; stderr: progresso humano-legível.
 */

import { readFileSync, writeFileSync, readdirSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import Papa from "papaparse";

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
//   1–3 = baixo (enviar sem verificar)
//   4–6 = médio (verificar se possível)
//   7–8 = alto  (verificar antes de enviar)
//   9–10 = crítico (verificar prioritariamente ou descartar)
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

  // 5: pagou pelo menos 1x e conta 3–5 anos
  if (m.payment_count >= 1 && months < 60) return 5;

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
// Tier — taxonomia 10-níveis pra warmup faseado (#1018).
//
// T1  = assinante atual (status ∈ {active, past_due, paused, trialing})
// T2  = ex-assinante (pagou alguma vez E não está em T1)
// T3  = lead 2026-H1 (nunca pagou, criado jan–jun/2026)
// T4  = lead 2025-H2
// T5  = lead 2025-H1
// T6  = lead 2024-H2
// T7  = lead 2024-H1
// T8  = lead 2023-H2
// T9  = lead 2023-H1
// T10 = lead 2021–2022 (todo, agrupado — caudão antigo)
//
// Critério: estado atual da relação (T1) → história de pagamento (T2) →
// recência por semestre (T3–T10). Substitui o slicing por rank de score
// (slice(0,1000)/slice(1000,5000)/slice(5000)) que tinha cortes arbitrários
// no meio de empates.
// ---------------------------------------------------------------------------

const TIER1_STATUSES = new Set(["active", "past_due", "paused", "trialing"]);

/**
 * Labels human-readable de cada tier — exportado pra reuso (logging, dashboard
 * futuro, ferramentas de análise). Mantém em sync com `tierOf`.
 */
export const TIER_LABELS: { readonly [k: number]: string } = {
  1: "Assinante atual (active/past_due/paused/trialing)",
  2: "Ex-assinante (pagou alguma vez)",
  3: "Lead nunca-pagou — 2026-H1",
  4: "Lead nunca-pagou — 2025-H2",
  5: "Lead nunca-pagou — 2025-H1",
  6: "Lead nunca-pagou — 2024-H2",
  7: "Lead nunca-pagou — 2024-H1",
  8: "Lead nunca-pagou — 2023-H2",
  9: "Lead nunca-pagou — 2023-H1",
  10: "Lead nunca-pagou — 2021–2022 (caudão antigo)",
};

export function tierOf(m: Merged): number {
  if (m.status && TIER1_STATUSES.has(m.status)) return 1;
  if (m.payment_count > 0 || m.total_spend > 0) return 2;

  // Lead nunca-pagante: bucket por semestre de criação.
  if (!m.created) return 10; // sem data → fóssil
  const y = m.created.getUTCFullYear();
  const h2 = m.created.getUTCMonth() >= 6;

  // FIXME(#1020, antes-de-2026-07-01): adicionar ramo `y === 2026 && h2 ? ... : 3`
  // ou parametrizar `now` (ver #1020). Hoje N=0 contatos H2 (estamos em 2026-05);
  // a partir de jul/2026 novos cadastros serão lumpados em T3.
  if (y === 2026) return 3;
  if (y === 2025) return h2 ? 4 : 5;
  if (y === 2024) return h2 ? 6 : 7;
  if (y === 2023) return h2 ? 8 : 9;
  return 10; // 2021, 2022, ou anteriores. Anos futuros (2027+) caem aqui também
             // até o script ser atualizado — ver FIXME acima.
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

interface Scored extends Merged {
  score: number;
  verify_risk: number;
  open_probability: number;
  tier: number;
}

function formatTierRow(r: Scored): { [k: string]: string | number } {
  // Schema enxuto pra import no Brevo:
  // - identidade: email, first_name, full_name
  // - tier (segmentação) + score/risk/probability (ordenação dentro do tier)
  // - audit trail: stripe_ids, source_files
  //
  // Removidos (#1019, decisão editorial): created, status, plan, delinquent,
  // total_spend, payment_count, refunded_volume, description, tag — dados
  // financeiros e meta não vão pro Brevo (campos calculados ficam só no CSV).
  return {
    email: r.email,
    first_name: r.name?.split(" ")[0] || "",
    full_name: r.name || "",
    tier: r.tier,
    score: r.score.toFixed(3),
    open_probability: r.open_probability,
    verify_risk: r.verify_risk,
    stripe_ids: r.stripe_ids.join(";"),
    source_files: r.source_files.join(";"),
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const filterClrcPt = process.argv.includes("--filter-clrc-pt");

  // Filtra arquivos CSV que NÃO são output do próprio script (importa só fontes
  // do Stripe). Tanto `kit-import-*` (legacy) quanto `brevo-import-*` (atual).
  const files = readdirSync(DATA_DIR)
    .filter((f) =>
      f.endsWith(".csv") &&
      !f.startsWith("kit-import-") &&
      !f.startsWith("brevo-import-"),
    );

  console.error(`📂 lendo ${files.length} CSVs de ${DATA_DIR}`);
  if (filterClrcPt) {
    console.error(`🎯 filtro hard --filter-clrc-pt ATIVO`);
  } else {
    console.error(`ℹ️  sem filtro de clrc-pt (default — só logging informacional)`);
  }

  const allRecords: Array<{ rec: Record; filename: string }> = [];
  for (const f of files) {
    const path = resolve(DATA_DIR, f);
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
  const now = new Date();
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
    const tier = tierOf(m);
    kept.push({ ...m, score, verify_risk, open_probability, tier });
  }

  console.error(`\n✅ kept: ${kept.length} · ❌ excluded: ${excluded.length}`);

  // Agrupa por tier; dentro do tier ordena por score desc + email asc.
  const byTier = new Map<number, Scored[]>();
  for (const c of kept) {
    if (!byTier.has(c.tier)) byTier.set(c.tier, []);
    byTier.get(c.tier)!.push(c);
  }
  for (const arr of byTier.values()) {
    arr.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.email.localeCompare(b.email);
    });
  }

  function writeTier(filename: string, rows: Scored[]): void {
    const csv = Papa.unparse(rows.map(formatTierRow));
    writeFileSync(resolve(DATA_DIR, filename), csv, "utf8");
  }

  // Cleanup de outputs órfãos de runs anteriores que usavam taxonomia diferente.
  // Remove APENAS arquivos no schema antigo (kit-import-* e brevo-import-tier{N}.csv);
  // os novos brevo-import-t{NN}.csv (com padding zero) são preservados/sobrescritos.
  // Idempotente: se rodar 2x, o segundo run já não acha nada pra remover.
  const orphanPatterns = [
    /^kit-import-(tier\d+|excluded)\.csv$/,
    /^brevo-import-tier\d+\.csv$/, // só sem padding (tier1, tier2, tier3 antigos)
  ];
  for (const f of readdirSync(DATA_DIR)) {
    if (orphanPatterns.some((re) => re.test(f))) {
      const path = resolve(DATA_DIR, f);
      try {
        unlinkSync(path);
        console.error(`🧹 removido órfão: ${f}`);
      } catch (e) {
        console.error(`⚠️  falha ao remover ${f}: ${(e as Error).message}`);
      }
    }
  }

  // Output: 10 CSVs (brevo-import-t01.csv ... t10.csv).
  // Padding zero garante ordenação alfabética correta no filesystem.
  for (let t = 1; t <= 10; t++) {
    const rows = byTier.get(t) ?? [];
    const filename = `brevo-import-t${String(t).padStart(2, "0")}.csv`;
    writeTier(filename, rows);
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
  writeFileSync(resolve(DATA_DIR, "brevo-import-excluded.csv"), excludedCsv, "utf8");

  // Distribuição de motivos
  const reasons: { [k: string]: number } = {};
  for (const e of excluded) reasons[e.reason] = (reasons[e.reason] || 0) + 1;

  // Tier counts pra log + JSON summary
  const tierCounts: { [k: string]: number } = {};
  for (let t = 1; t <= 10; t++) {
    tierCounts[`t${String(t).padStart(2, "0")}`] = (byTier.get(t) ?? []).length;
  }

  console.error(`\n📤 outputs em ${DATA_DIR}:`);
  for (let t = 1; t <= 10; t++) {
    const n = tierCounts[`t${String(t).padStart(2, "0")}`];
    console.error(`   t${String(t).padStart(2, "0")} (${TIER_LABELS[t]}): ${n.toLocaleString("pt-BR")}`);
  }
  console.error(`   excluded: ${excluded.length.toLocaleString("pt-BR")}`);

  console.error(`\n📋 motivos de exclusão:`);
  for (const [r, c] of Object.entries(reasons).sort((a, b) => b[1] - a[1])) {
    console.error(`   ${r}: ${c}`);
  }

  // Sample top 10 do T1 (assinantes atuais — quem vai primeiro num warmup).
  const t1Sample = byTier.get(1) ?? [];
  console.error(`\n🏆 sample top 10 do T1:`);
  for (let i = 0; i < Math.min(10, t1Sample.length); i++) {
    const t = t1Sample[i];
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
        tiers: tierCounts,
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
