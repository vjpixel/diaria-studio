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
 *   stripe-export-t01-assinantes-ativos.csv            T1 canônico (BASE, no root) — email,NOME,OPEN_PROBABILITY
 *   {ciclo}/mv-export-t02-ex-assinantes-verified.csv   T2 limpo pós-MV (por-ciclo), já em recência DESC
 *   {ciclo}/mv-export-maio-verified.csv                W5 OPCIONAL — leads frescos de maio (se existir)
 *
 * Outputs (em data/clarice-subscribers/{conteúdo}-{envio}/waves/). Nome = wX + ferramenta
 * que segmentou + tier (T1 = segmentado por opens da Brevo; T2/maio = vêm do MV-verified):
 *   w1-brevo-export-t1-openers.csv      W1
 *   w2-brevo-export-t1-non-openers.csv  W2
 *   w3-mv-export-t2.csv                 W3 (+RECENCY_QUARTIL, RECENCY_RANK)
 *   w4-mv-export-t2.csv                 W4
 *   w5-mv-export-maio.csv               W5 (só se o cohort de maio existir; suprime blacklist + tira MV_*)
 *   waves-summary.json
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import Papa from "papaparse";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { clariceBaseFile, clariceCycleDir, clariceWavesDir, ensureDir, requireCycleArg } from "./lib/clarice-paths.ts";
// #2651: brevoGet + pool consolidados na lib. Re-export de brevoGet mantém as 4
// suites de teste que importam daqui (o código de produção já migrou pra lib).
import { brevoGet } from "./lib/brevo-client.ts";
import { pool } from "./lib/pool.ts";
export { brevoGet };

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
  const t1Path = clariceBaseFile("stripe-export-t01-assinantes-ativos.csv");
  const t2Path = resolve(cycleDir, "mv-export-t02-ex-assinantes-verified.csv");
  for (const p of [t1Path, t2Path]) {
    if (!existsSync(p)) {
      console.error(`input não encontrado: ${p}`);
      process.exit(1);
    }
  }
  ensureDir(wavesDir);

  // 1) engajamento Brevo
  const engagement = await fetchBrevoEngagement(apiKey, concurrency);
  const blacklist = new Set<string>();
  for (const [email, e] of engagement) if (e.blacklisted) blacklist.add(email);
  console.error(`🚫 blacklisted (suprimidos): ${blacklist.size}`);

  // 2) T1 → W1 / W2
  const t1 = readCsv(t1Path);
  const t1Key = emailKeyOf(t1.fields);
  const split = classifyT1(t1.rows, t1Key, engagement);
  writeCsv(wavesDir, "w1-brevo-export-t1-openers.csv", t1.fields, split.openers);
  writeCsv(wavesDir, "w2-brevo-export-t1-non-openers.csv", t1.fields, split.nonOpeners);
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
  writeCsv(wavesDir, "w3-mv-export-t2.csv", t2Fields, w3);
  writeCsv(wavesDir, "w4-mv-export-t2.csv", t2Fields, w4);
  console.error(
    `📨 T2: W3=${w3.length} · W4=${w4.length} · suprimidos(blacklist)=${dropped.length} (de ${t2.rows.length})`,
  );

  // 4) W5 (opcional) — leads frescos de maio, SE o cohort verificado existir no
  // ciclo. Mesmo tratamento do T2 (suprime blacklist + tira MV_*) pra ser
  // reprodutível: re-rodar regenera, em vez de depender de arquivo hand-built.
  // Sem o cohort (outros ciclos), simplesmente não emite W5.
  const maioVerifiedPath = resolve(cycleDir, "mv-export-maio-verified.csv");
  let w5Count: number | null = null;
  if (existsSync(maioVerifiedPath)) {
    const maio = readCsv(maioVerifiedPath);
    const maioKey = emailKeyOf(maio.fields);
    const { kept: maioKept, dropped: maioDropped } = suppressBlacklisted(maio.rows, maioKey, blacklist);
    const maioFields = maio.fields.filter((f) => !/^MV_/i.test(f)); // não vaza MV_* pro Brevo
    writeCsv(wavesDir, "w5-mv-export-maio.csv", maioFields, maioKept);
    w5Count = maioKept.length;
    console.error(
      `📨 W5 (maio): ${maioKept.length} · suprimidos(blacklist)=${maioDropped.length} (de ${maio.rows.length})`,
    );
  }

  const summary = {
    generated_for: "próximo envio Clarice (warm-up por engajamento)",
    cycle,
    blacklisted_suppressed: blacklist.size,
    waves: {
      w1_t1_openers: split.openers.length,
      w2_t1_non_openers: split.nonOpeners.length,
      w3_t2: w3.length,
      w4_t2: w4.length,
      ...(w5Count !== null ? { w5_maio: w5Count } : {}),
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
