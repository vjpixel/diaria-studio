/**
 * video-pauta-report.ts (#13090, item 1)
 *
 * Relatório de pauta PERENE de vídeo (tutorial / explicador / comparativo) a
 * partir dos pulls do Google Keyword Planner já gravados em `data/seo/`. Não
 * chama a API: lê o JSON mais recente de cada fonte, agrupa por intenção e
 * tema e ranqueia por volume e competição. Miolo: `scripts/lib/video-pauta.ts`.
 *
 * Uso:
 *   npx tsx scripts/video-pauta-report.ts [--input a.json,b.json] \
 *     [--out data/seo/pauta-video-{YYYY-MM-DD}.md] [--json-out data/seo/pauta-video-{YYYY-MM-DD}.json] \
 *     [--top 15]
 *
 * Sem `--input`, usa o mais recente de cada fonte que existir em `data/seo/`:
 *  - `video-keywords-{data}.json` — sementes de vídeo (`seed/video-keywords.csv`),
 *    gravado pelo passo `video-keywords` da task mensal
 *    `Diaria-Google-Keyword-Monthly-Pull`;
 *  - `google-keywords-{data}.json` — sementes gerais (`seed/keywords.csv`).
 *
 * Exit: 0 ok; 1 nenhuma fonte encontrada ou fontes sem ideia; 2 erro de uso.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import { runCli } from "./lib/cli-exit.ts";
import type { KeywordIdea, SeedContamination } from "./lib/google-keyword-planner.ts";
import { buildPautaTopics, mergeIdeaSources, renderPautaReport } from "./lib/video-pauta.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Prefixos dos pulls lidos por padrão, na ordem de prioridade. */
export const PAUTA_SOURCE_PREFIXES = ["video-keywords", "google-keywords"] as const;

/** Acha `{prefix}-{YYYY-MM-DD}.json` mais recente pela data do NOME (não mtime). `null` se não houver. */
export function findLatestPull(dirAbs: string, prefix: string): string | null {
  if (!existsSync(dirAbs)) return null;
  const re = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-(\\d{4}-\\d{2}-\\d{2})\\.json$`);
  const dated = readdirSync(dirAbs)
    .map((name) => ({ name, date: name.match(re)?.[1] }))
    .filter((e): e is { name: string; date: string } => Boolean(e.date))
    .sort((a, b) => b.date.localeCompare(a.date));
  return dated.length ? resolve(dirAbs, dated[0].name) : null;
}

export interface PullFile {
  kept: KeywordIdea[];
  contaminated: SeedContamination[];
}

/** Lê um JSON de `google-keyword-pull.ts`. Lança com mensagem clara se o formato não bater. */
export function readPullFile(path: string): PullFile {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { kept?: unknown; contaminated_seeds?: unknown };
  if (!Array.isArray(parsed.kept)) throw new Error(`${path}: sem array "kept" (não parece saída de google-keyword-pull.ts)`);
  return {
    kept: parsed.kept as KeywordIdea[],
    contaminated: Array.isArray(parsed.contaminated_seeds) ? (parsed.contaminated_seeds as SeedContamination[]) : [],
  };
}

async function main(argv: string[]): Promise<number> {
  const { values, flags } = parseArgs(argv);
  for (const k of ["input", "out", "json-out", "top"]) {
    if (flags.has(k) || values[k] === "") {
      console.error(`[video-pauta-report] --${k} exige um valor`);
      return 2;
    }
  }
  const top = values.top ? Number(values.top) : 15;
  if (!Number.isInteger(top) || top < 1) {
    console.error(`[video-pauta-report] --top inválido: ${values.top}`);
    return 2;
  }

  const seoDir = resolve(ROOT, "data/seo");
  const inputs = values.input
    ? values.input.split(",").map((p) => resolve(ROOT, p.trim())).filter(Boolean)
    : PAUTA_SOURCE_PREFIXES.map((p) => findLatestPull(seoDir, p)).filter((p): p is string => p !== null);
  if (inputs.length === 0) {
    console.error(`[video-pauta-report] nenhum pull do Keyword Planner em ${seoDir} (${PAUTA_SOURCE_PREFIXES.join("-*.json, ")}-*.json)`);
    return 1;
  }

  const pulls = inputs.map((p) => readPullFile(p));
  const ideas = mergeIdeaSources(pulls.map((p) => p.kept));
  if (ideas.length === 0) {
    console.error(`[video-pauta-report] as fontes não têm nenhuma ideia em "kept": ${inputs.join(", ")}`);
    return 1;
  }
  const topics = buildPautaTopics(ideas);
  const contaminated = pulls.flatMap((p) => p.contaminated);

  const date = new Date().toISOString().slice(0, 10);
  const sources = inputs.map((p) => basename(p));
  const mdPath = resolve(ROOT, values.out ?? `data/seo/pauta-video-${date}.md`);
  const jsonPath = resolve(ROOT, values["json-out"] ?? `data/seo/pauta-video-${date}.json`);
  for (const p of [mdPath, jsonPath]) mkdirSync(dirname(p), { recursive: true });
  writeFileSync(mdPath, renderPautaReport({ date, sources, topics, contaminated, topPerIntent: top }));
  writeFileSync(
    jsonPath,
    JSON.stringify({ generated_at: new Date().toISOString(), sources, topics, contaminated_seeds: contaminated }, null, 2),
  );
  console.log(`[video-pauta-report] ${topics.length} temas de ${ideas.length} termos (${sources.join(", ")}) → ${mdPath}`);
  return 0;
}

if (isMainModule(import.meta.url)) {
  runCli(() => main(process.argv.slice(2)), {
    onError: (e) => {
      console.error(`[video-pauta-report] ${e instanceof Error ? e.message : e}`);
    },
  });
}
export { main };
