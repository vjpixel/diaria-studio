#!/usr/bin/env node
/**
 * clarice-build-waves.ts
 *
 * Monta os CSVs de waves do próximo envio Clarice, prontos pra importar no Brevo.
 * Decisão de targeting fundamentada nos Achados #1 (recência/score não predizem
 * abertura; o sinal real é comportamento de abertura passado):
 *
 *   W1 — T1 que ABRIU a edição anterior   (engaged-first; warm restart)
 *   W2 — T1 que NÃO abriu                 (re-engajamento; A/B de subject)
 *   W3 — T2 verified, fatia representativa de recência (~2.000)
 *   W4 — T2 verified, restante representativo          (~4.840)
 *
 * Princípios:
 *   - EXCLUI unsubscribes (emailBlacklisted no Brevo) de TODAS as waves.
 *   - W3/W4 são fatias REPRESENTATIVAS de recência (amostragem sistemática),
 *     nunca "wave dos recentes / wave dos antigos" — senão o dia-da-semana
 *     confunde a validação de recência (erro do T1). Cada wave carrega todos
 *     os 4 quartis (RECENCY_QUARTIL), permitindo a correlação intra-dia.
 *
 * Uso:
 *   npx tsx scripts/clarice-build-waves.ts --cycle 2605-06 [--w3-size 2000] [--concurrency 6]
 *   (--cycle {conteúdo}-{envio} é OBRIGATÓRIO — ciclo do envio; waves vivem em
 *    {conteúdo}-{envio}/waves/, #1961)
 *
 * Env:
 *   BREVO_CLARICE_API_KEY   obrigatório (lê opens + blacklist do T1)
 *
 * Inputs:
 *   brevo-import-t01.csv            T1 canônico (BASE, no root) — email,NOME,OPEN_PROBABILITY
 *   {ciclo}/brevo-import-t02-verified.csv   T2 limpo pós-MV (por-ciclo), já em recência DESC
 *
 * Outputs (em data/clarice-subscribers/{conteúdo}-{envio}/waves/):
 *   t1-openers.csv      W1
 *   t1-non-openers.csv  W2
 *   t2-w3.csv           W3 (+RECENCY_QUARTIL, RECENCY_RANK)
 *   t2-w4.csv           W4
 *   waves-summary.json
 */

import { readFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import Papa from "papaparse";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { clariceBaseFile, clariceCycleDir, clariceWavesDir, requireCycleArg } from "./lib/clarice-paths.ts";

loadProjectEnv();

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

export interface Engagement {
  /** Abriu ≥1 campanha (qualquer edição anterior). */
  opened: boolean;
  /** Descadastrou / bounce-blacklisted no Brevo → suprimir. */
  blacklisted: boolean;
}

type Row = Record<string, string>;

// ---------------------------------------------------------------------------
// Pure: classificação T1 (abriu / não-abriu / suprimido / não-encontrado)
// ---------------------------------------------------------------------------

export interface T1Split {
  openers: Row[];
  nonOpeners: Row[];
  /** emailBlacklisted=true → fora de tudo (instrução: excluir unsubs). */
  suppressed: Row[];
  /** Sem registro no Brevo → status desconhecido, excluído por segurança. */
  notFound: Row[];
}

/**
 * Classifica as linhas do T1 contra o engajamento do Brevo.
 *
 * notFound (sem registro no Brevo) é EXCLUÍDO de openers/nonOpeners: como não
 * dá pra confirmar que não é um unsub deletado, mandar seria arriscar violar a
 * regra de excluir descadastrados. Reportado pra inspeção.
 */
export function classifyT1(
  rows: Row[],
  emailKey: string,
  engagement: Map<string, Engagement>,
): T1Split {
  const out: T1Split = { openers: [], nonOpeners: [], suppressed: [], notFound: [] };
  for (const r of rows) {
    const e = (r[emailKey] ?? "").trim().toLowerCase();
    const eng = engagement.get(e);
    if (!eng) {
      out.notFound.push(r);
      continue;
    }
    if (eng.blacklisted) {
      out.suppressed.push(r);
      continue;
    }
    (eng.opened ? out.openers : out.nonOpeners).push(r);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Pure: supressão de blacklisted (T2)
// ---------------------------------------------------------------------------

export function suppressBlacklisted(
  rows: Row[],
  emailKey: string,
  blacklist: Set<string>,
): { kept: Row[]; dropped: Row[] } {
  const kept: Row[] = [];
  const dropped: Row[] = [];
  for (const r of rows) {
    const e = (r[emailKey] ?? "").trim().toLowerCase();
    (blacklist.has(e) ? dropped : kept).push(r);
  }
  return { kept, dropped };
}

// ---------------------------------------------------------------------------
// Pure: quartil de recência (rows já em recência DESC → Q1 = mais recentes)
// ---------------------------------------------------------------------------

export function assignQuartiles(rows: Row[]): Row[] {
  const n = rows.length;
  return rows.map((r, i) => ({
    ...r,
    RECENCY_RANK: String(i + 1),
    RECENCY_QUARTIL: `Q${n > 0 ? Math.min(4, Math.floor((i / n) * 4) + 1) : 1}`,
  }));
}

// ---------------------------------------------------------------------------
// Pure: split representativo de recência (amostragem sistemática)
// ---------------------------------------------------------------------------

/**
 * Divide `rows` (ordenadas por recência) em W3 (tamanho `w3Size`) e W4 (resto),
 * de forma que W3 seja uma AMOSTRA REPRESENTATIVA de toda a faixa de recência —
 * não os `w3Size` mais recentes. Amostragem sistemática: pega ~1 a cada `n/w3Size`,
 * espalhado uniformemente. Determinístico (sem random → reproduzível).
 */
export function representativeSplit(
  rows: Row[],
  w3Size: number,
): { w3: Row[]; w4: Row[] } {
  const n = rows.length;
  const size = Math.max(0, Math.min(w3Size, n));
  if (size === 0) return { w3: [], w4: [...rows] };
  if (size === n) return { w3: [...rows], w4: [] };

  const step = n / size;
  const w3: Row[] = [];
  const w4: Row[] = [];
  let next = step / 2; // offset inicial p/ espalhamento uniforme
  for (let i = 0; i < n; i++) {
    if (w3.length < size && i + 1e-9 >= next) {
      w3.push(rows[i]);
      next += step;
    } else {
      w4.push(rows[i]);
    }
  }
  return { w3, w4 };
}

// ---------------------------------------------------------------------------
// Brevo — engajamento per-contato (opens + blacklist)
// ---------------------------------------------------------------------------

const RETRY_MS = [1000, 3000, 9000];
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * GET na Brevo v3 que FALHA ALTO em vez de silenciar.
 *
 * Crítico: a versão anterior engolia qualquer status e devolvia body={}, então
 * um 429/5xx (a) truncava a paginação de contatos (unsub vazava pro T2) e
 * (b) marcava um opener real como `opened:false` (ia pro W2). Aqui:
 *   - 429/5xx → retry com backoff, depois throw (aborta o run, não corrompe);
 *   - 404 → {status:404, body:{}} (contato sumiu entre listar e buscar — não-fatal);
 *   - outro 4xx (401/403) → throw (auth/config — re-tentar não ajuda);
 *   - corpo não-JSON → throw.
 */
export async function brevoGet(
  apiKey: string,
  path: string,
): Promise<{ status: number; body: any }> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= RETRY_MS.length; attempt++) {
    if (attempt > 0) await sleep(RETRY_MS[attempt - 1]);
    const r = await fetch(`https://api.brevo.com/v3${path}`, {
      headers: { "api-key": apiKey, Accept: "application/json" },
    });
    if (r.status === 429 || r.status >= 500) {
      await r.body?.cancel().catch(() => {});
      lastErr = new Error(`Brevo GET ${path} HTTP ${r.status}`);
      continue;
    }
    if (r.status === 404) return { status: 404, body: {} };
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      throw new Error(`Brevo GET ${path} falhou (${r.status}): ${t.slice(0, 200)}`);
    }
    const t = await r.text();
    try {
      return { status: r.status, body: t.length ? JSON.parse(t) : {} };
    } catch {
      throw new Error(`Brevo GET ${path}: resposta não-JSON`);
    }
  }
  throw new Error(`Brevo GET ${path} falhou após ${RETRY_MS.length + 1} tentativas: ${String(lastErr)}`);
}

/** Pool de concorrência limitada (idêntico em forma a runBounded — #636: extrair pra lib é refactor à parte). */
async function pool<T>(items: T[], n: number, worker: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  const run = async (): Promise<void> => {
    while (i < items.length) await worker(items[i++]);
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, run));
}

/**
 * Busca, da conta Brevo, por contato: abriu ≥1 campanha + está blacklisted.
 * O agregado das campanhas vem zerado (quirk Brevo), mas o evento per-contato
 * (`statistics.opened`) sobrevive — daí o GET individual.
 */
export async function fetchBrevoEngagement(
  apiKey: string,
  concurrency = 6,
): Promise<Map<string, Engagement>> {
  // 1) paginar contatos → email + blacklist + id
  const base: { id: number; email: string; blacklisted: boolean }[] = [];
  let offset = 0;
  for (;;) {
    const { body } = await brevoGet(apiKey, `/contacts?limit=500&offset=${offset}`);
    const cs = body?.contacts ?? [];
    for (const c of cs) {
      base.push({
        id: c.id,
        email: (c.email ?? "").toLowerCase(),
        blacklisted: !!c.emailBlacklisted,
      });
    }
    if (cs.length < 500) break;
    offset += 500;
  }
  console.error(`📇 Brevo: ${base.length} contatos`);

  // 2) per-id → opened (statistics.opened não-vazio)
  const map = new Map<string, Engagement>();
  let done = 0;
  await pool(base, concurrency, async (c) => {
    if (!c.email) return; // contato sem email → ignora (evita colisão na key "")
    const { body } = await brevoGet(apiKey, `/contacts/${c.id}`);
    const opened = (body?.statistics?.opened ?? []).length > 0;
    // OR-merge: 2 registros do mesmo email (re-add após unsub) não podem deixar
    // um vazar — se QUALQUER registro é blacklisted/opened, vale o conservador.
    const prev = map.get(c.email);
    map.set(c.email, {
      opened: opened || !!prev?.opened,
      blacklisted: c.blacklisted || !!prev?.blacklisted,
    });
    if (++done % 200 === 0) console.error(`  …${done}/${base.length}`);
  });
  return map;
}

// ---------------------------------------------------------------------------
// CSV helpers
// ---------------------------------------------------------------------------

function readCsv(path: string): { rows: Row[]; fields: string[] } {
  const parsed = Papa.parse<Row>(readFileSync(path, "utf-8"), {
    header: true,
    skipEmptyLines: true,
  });
  return { rows: parsed.data, fields: parsed.meta.fields ?? [] };
}

function emailKeyOf(fields: string[]): string {
  const k = fields.find((f) => /e-?mail/i.test(f.trim()));
  if (!k) throw new Error(`CSV sem coluna de email: colunas=${fields.join(",")}`);
  return k;
}

function writeCsv(dir: string, name: string, fields: string[], rows: Row[]): void {
  // Atômico: os CSVs de wave são o deliverável de fato (vão pro import Brevo).
  // Um write truncado por crash/SIGINT seria importado como wave parcial.
  writeFileAtomic(resolve(dir, name), Papa.unparse({ fields, data: rows }));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const apiKey = process.env.BREVO_CLARICE_API_KEY;
  if (!apiKey) {
    console.error("BREVO_CLARICE_API_KEY não definida (veja .env.example).");
    process.exit(1);
  }
  const argOf = (flag: string, def: number): number => {
    const i = argv.indexOf(flag);
    if (i < 0) return def;
    const n = parseInt(argv[i + 1], 10);
    return Number.isFinite(n) && n > 0 ? n : def;
  };
  const w3Size = argOf("--w3-size", 2000);
  const concurrency = argOf("--concurrency", 6);
  // #1961: ciclo do ENVIO obrigatório → waves + t02-verified vivem em
  // {conteúdo}-{envio}/. Explícito (como "data da edição é sempre explícita"):
  // sem default, pra não ler/gravar o ciclo errado perto da virada.
  const cycle = requireCycleArg(argv);
  const cycleDir = clariceCycleDir(cycle);
  const wavesDir = clariceWavesDir(cycle);

  // T1 é BASE (root, output da merge); t02-verified é por-ciclo (output do verify-mv).
  const t1Path = clariceBaseFile("brevo-import-t01.csv");
  const t2Path = resolve(cycleDir, "brevo-import-t02-verified.csv");
  for (const p of [t1Path, t2Path]) {
    if (!existsSync(p)) {
      console.error(`input não encontrado: ${p}`);
      process.exit(1);
    }
  }
  mkdirSync(wavesDir, { recursive: true });

  // 1) engajamento Brevo
  const engagement = await fetchBrevoEngagement(apiKey, concurrency);
  const blacklist = new Set<string>();
  for (const [email, e] of engagement) if (e.blacklisted) blacklist.add(email);
  console.error(`🚫 blacklisted (suprimidos): ${blacklist.size}`);

  // 2) T1 → W1 / W2
  const t1 = readCsv(t1Path);
  const t1Key = emailKeyOf(t1.fields);
  const split = classifyT1(t1.rows, t1Key, engagement);
  writeCsv(wavesDir, "t1-openers.csv", t1.fields, split.openers);
  writeCsv(wavesDir, "t1-non-openers.csv", t1.fields, split.nonOpeners);
  console.error(
    `\n📨 T1: W1(abriu)=${split.openers.length} · W2(não-abriu)=${split.nonOpeners.length} · ` +
      `suprimidos=${split.suppressed.length} · não-encontrados(excluídos)=${split.notFound.length}`,
  );

  // 3) T2 → suprime blacklist → quartil → split representativo W3 / W4
  const t2 = readCsv(t2Path);
  const t2Key = emailKeyOf(t2.fields);
  const { kept, dropped } = suppressBlacklisted(t2.rows, t2Key, blacklist);
  const tagged = assignQuartiles(kept);
  // Não propaga as colunas MV_* (internas da verificação) pro import Brevo —
  // virariam atributos de contato espúrios na lista de produção. Papa.unparse
  // emite só os fields listados, então os MV_* nas rows são ignorados.
  const t2Fields = [...t2.fields.filter((f) => !/^MV_/i.test(f)), "RECENCY_QUARTIL", "RECENCY_RANK"];
  const { w3, w4 } = representativeSplit(tagged, w3Size);
  writeCsv(wavesDir, "t2-w3.csv", t2Fields, w3);
  writeCsv(wavesDir, "t2-w4.csv", t2Fields, w4);
  console.error(
    `📨 T2: W3=${w3.length} · W4=${w4.length} · suprimidos(blacklist)=${dropped.length} (de ${t2.rows.length})`,
  );

  const summary = {
    generated_for: "próximo envio Clarice (warm-up por engajamento)",
    cycle,
    blacklisted_suppressed: blacklist.size,
    waves: {
      w1_t1_openers: split.openers.length,
      w2_t1_non_openers: split.nonOpeners.length,
      w3_t2: w3.length,
      w4_t2: w4.length,
    },
    t1_suppressed: split.suppressed.length,
    t1_not_found_excluded: split.notFound.length,
    t2_suppressed: dropped.length,
    w3_size_param: w3Size,
  };
  writeFileAtomic(resolve(wavesDir, "waves-summary.json"), JSON.stringify(summary, null, 2));
  console.error(`\n✅ waves em ${wavesDir}`);
  console.log(JSON.stringify(summary, null, 2));
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
