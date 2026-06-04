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
 *   npx tsx scripts/clarice-build-waves.ts [--w3-size 2000] [--concurrency 6]
 *
 * Env:
 *   BREVO_CLARICE_API_KEY   obrigatório (lê opens + blacklist do T1)
 *
 * Inputs (em data/clarice-subscribers/):
 *   brevo-import-t01.csv            T1 canônico (email,NOME,OPEN_PROBABILITY)
 *   brevo-import-t02-verified.csv   T2 limpo pós-MV, já em recência DESC
 *
 * Outputs (em data/clarice-subscribers/waves/):
 *   t1-openers.csv      W1
 *   t1-non-openers.csv  W2
 *   t2-w3.csv           W3 (+RECENCY_QUARTIL, RECENCY_RANK)
 *   t2-w4.csv           W4
 *   waves-summary.json
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import Papa from "papaparse";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";

loadProjectEnv();

const ROOT = resolve(import.meta.dirname, "..");
const DATA_DIR = resolve(ROOT, "data/clarice-subscribers");
const WAVES_DIR = resolve(DATA_DIR, "waves");

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

async function brevoGet(apiKey: string, path: string): Promise<{ status: number; body: any }> {
  const r = await fetch(`https://api.brevo.com/v3${path}`, {
    headers: { "api-key": apiKey, Accept: "application/json" },
  });
  const t = await r.text();
  let body: any = {};
  try {
    body = t.length ? JSON.parse(t) : {};
  } catch {
    body = {};
  }
  return { status: r.status, body };
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
    const { body } = await brevoGet(apiKey, `/contacts/${c.id}`);
    const opened = (body?.statistics?.opened ?? []).length > 0;
    map.set(c.email, { opened, blacklisted: c.blacklisted });
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

function writeCsv(name: string, fields: string[], rows: Row[]): void {
  writeFileSync(resolve(WAVES_DIR, name), Papa.unparse({ fields, data: rows }), "utf-8");
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

  const t1Path = resolve(DATA_DIR, "brevo-import-t01.csv");
  const t2Path = resolve(DATA_DIR, "brevo-import-t02-verified.csv");
  for (const p of [t1Path, t2Path]) {
    if (!existsSync(p)) {
      console.error(`input não encontrado: ${p}`);
      process.exit(1);
    }
  }
  mkdirSync(WAVES_DIR, { recursive: true });

  // 1) engajamento Brevo
  const engagement = await fetchBrevoEngagement(apiKey, concurrency);
  const blacklist = new Set<string>();
  for (const [email, e] of engagement) if (e.blacklisted) blacklist.add(email);
  console.error(`🚫 blacklisted (suprimidos): ${blacklist.size}`);

  // 2) T1 → W1 / W2
  const t1 = readCsv(t1Path);
  const t1Key = emailKeyOf(t1.fields);
  const split = classifyT1(t1.rows, t1Key, engagement);
  writeCsv("t1-openers.csv", t1.fields, split.openers);
  writeCsv("t1-non-openers.csv", t1.fields, split.nonOpeners);
  console.error(
    `\n📨 T1: W1(abriu)=${split.openers.length} · W2(não-abriu)=${split.nonOpeners.length} · ` +
      `suprimidos=${split.suppressed.length} · não-encontrados(excluídos)=${split.notFound.length}`,
  );

  // 3) T2 → suprime blacklist → quartil → split representativo W3 / W4
  const t2 = readCsv(t2Path);
  const t2Key = emailKeyOf(t2.fields);
  const { kept, dropped } = suppressBlacklisted(t2.rows, t2Key, blacklist);
  const tagged = assignQuartiles(kept);
  const t2Fields = [...t2.fields, "RECENCY_QUARTIL", "RECENCY_RANK"];
  const { w3, w4 } = representativeSplit(tagged, w3Size);
  writeCsv("t2-w3.csv", t2Fields, w3);
  writeCsv("t2-w4.csv", t2Fields, w4);
  console.error(
    `📨 T2: W3=${w3.length} · W4=${w4.length} · suprimidos(blacklist)=${dropped.length} (de ${t2.rows.length})`,
  );

  const summary = {
    generated_for: "próximo envio Clarice (warm-up por engajamento)",
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
  writeFileAtomic(resolve(WAVES_DIR, "waves-summary.json"), JSON.stringify(summary, null, 2));
  console.error(`\n✅ waves em ${WAVES_DIR}`);
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
