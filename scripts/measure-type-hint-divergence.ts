/**
 * measure-type-hint-divergence.ts (#1718 — fase 1: instrumentação)
 *
 * Mede, SEM mudar nada na classificação, a divergência entre o `type_hint` do
 * source-researcher (que LEU a página) e a decisão real do `categorize.ts`
 * (domain-default + 13 overrides) — especialmente a decisão de LANÇAMENTO.
 *
 * O #1718 propõe inverter o ônus (type_hint primário, regex secundário), mas
 * antes disso precisamos de DADO: o type_hint do Haiku é confiável? Esta fase
 * só loga a divergência por edição (append-only) pra que, em ~2 semanas, a
 * decisão de inverter seja baseada em medição, não em palpite. Zero risco de
 * produção — lê o `tmp-categorized.json` (que preserva o type_hint) e compara.
 *
 * Uso:
 *   npx tsx scripts/measure-type-hint-divergence.ts \
 *     --in data/editions/AAMMDD/_internal/tmp-categorized.json \
 *     --edition AAMMDD \
 *     [--log data/type-hint-divergence.jsonl]
 *
 * Output: summary JSON no stdout; records no log (1 por linha), idempotente por
 * edição (re-run/resume não duplica). Exit: 0 no fluxo normal (incl. input
 * ausente/inválido → no-op); 2 só em erro de USO (--in não passado).
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs as parseCliArgs } from "./lib/cli-args.ts";

const LAUNCH_TYPE_HINT = "lancamento";
const LAUNCH_BUCKET = "lancamento";

interface Article {
  url?: string;
  title?: string;
  type_hint?: unknown;
  [k: string]: unknown;
}

interface Categorized {
  lancamento?: Article[];
  radar?: Article[];
  use_melhor?: Article[];
  video?: Article[];
  [k: string]: unknown;
}

export interface DivergenceRecord {
  edition: string;
  url: string;
  title?: string;
  type_hint: string;
  bucket: string;
  type_hint_launch: boolean;
  bucket_launch: boolean;
  launch_agree: boolean;
}

export interface DivergenceSummary {
  edition: string;
  total_articles: number;
  with_type_hint: number;
  launch_disagreements: number;
  disagreements: Array<{ url: string; title?: string; type_hint: string; bucket: string }>;
}

/**
 * Compara type_hint vs bucket pra cada artigo COM type_hint. Pura e testável.
 * Foco: a decisão de LANÇAMENTO (type_hint==='lancamento' vs bucket==='lancamento').
 */
export function measureDivergence(
  cat: Categorized,
  edition: string,
): { records: DivergenceRecord[]; summary: DivergenceSummary } {
  const buckets: Array<[string, Article[] | undefined]> = [
    ["lancamento", cat.lancamento],
    ["radar", cat.radar],
    ["use_melhor", cat.use_melhor],
    ["video", cat.video],
  ];
  const records: DivergenceRecord[] = [];
  let totalArticles = 0;
  for (const [bucket, arr] of buckets) {
    for (const a of arr ?? []) {
      totalArticles++;
      if (typeof a.type_hint !== "string" || a.type_hint.length === 0) continue;
      const th = a.type_hint.toLowerCase();
      const type_hint_launch = th === LAUNCH_TYPE_HINT;
      const bucket_launch = bucket === LAUNCH_BUCKET;
      records.push({
        edition,
        url: typeof a.url === "string" ? a.url : "",
        title: typeof a.title === "string" ? a.title : undefined,
        type_hint: th,
        bucket,
        type_hint_launch,
        bucket_launch,
        launch_agree: type_hint_launch === bucket_launch,
      });
    }
  }
  const disagree = records.filter((r) => !r.launch_agree);
  return {
    records,
    summary: {
      edition,
      total_articles: totalArticles,
      with_type_hint: records.length,
      launch_disagreements: disagree.length,
      disagreements: disagree.map((r) => ({
        url: r.url,
        title: r.title,
        type_hint: r.type_hint,
        bucket: r.bucket,
      })),
    },
  };
}

/**
 * #1830 review: merge idempotente por edição. Remove do log existente os records
 * desta edição (re-run/resume não duplica → não viesa a agregação do #1718) e
 * anexa os novos. Linhas não-parseáveis (não nossas) são preservadas.
 */
export function mergeLogLines(
  existingContent: string,
  newRecords: DivergenceRecord[],
  edition: string,
): string {
  const kept = existingContent
    .split("\n")
    .filter((line) => {
      if (!line.trim()) return false;
      try {
        return (JSON.parse(line) as { edition?: string }).edition !== edition;
      } catch {
        return true; // preserva linhas não-parseáveis
      }
    });
  const all = [...kept, ...newRecords.map((r) => JSON.stringify(r))];
  return all.join("\n") + "\n";
}

function main(): void {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const { values } = parseCliArgs(process.argv.slice(2));
  const inArg = values["in"];
  const edition = values["edition"] ?? "unknown";
  const logArg = values["log"] ?? "data/type-hint-divergence.jsonl";
  if (!inArg) {
    console.error("Uso: measure-type-hint-divergence.ts --in <tmp-categorized.json> --edition AAMMDD [--log <path>]");
    process.exit(2);
  }
  const inPath = resolve(ROOT, inArg);
  if (!existsSync(inPath)) {
    // Instrumentação nunca bloqueia: input ausente → no-op silencioso.
    console.error(`[measure-type-hint-divergence] input ausente (${inPath}) — skip.`);
    process.exit(0);
  }
  let cat: Categorized;
  try {
    cat = JSON.parse(readFileSync(inPath, "utf8")) as Categorized;
  } catch (err) {
    console.error(`[measure-type-hint-divergence] parse falhou: ${(err as Error).message} — skip.`);
    process.exit(0);
  }

  const { records, summary } = measureDivergence(cat, edition);
  // Acumula entre edições (pro #1718), idempotente por edição (#1830 review).
  if (records.length > 0) {
    const logPath = resolve(ROOT, logArg);
    const existing = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
    writeFileSync(logPath, mergeLogLines(existing, records, edition), "utf8");
  }
  console.log(JSON.stringify(summary, null, 2));
  if (summary.launch_disagreements > 0) {
    console.error(
      `[measure-type-hint-divergence] ${summary.launch_disagreements}/${summary.with_type_hint} divergência(s) de LANÇAMENTO (type_hint vs bucket) — acumulado em ${logArg} (#1718).`,
    );
  }
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  main();
}
