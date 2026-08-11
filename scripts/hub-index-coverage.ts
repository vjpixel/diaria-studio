/**
 * scripts/hub-index-coverage.ts (#4903)
 *
 * CLI fino sobre `scripts/lib/hub-index-coverage.ts`: resolve o
 * `index-status-{data}.json` mais recente em `data/seo/` (o relatório do
 * site PRINCIPAL — as URLs de hub são todas `diar.ia.br/p/...`, nunca
 * `arquivo.diar.ia.br/temas/*`, então a variante com sufixo do #4909 não é
 * a fonte certa aqui), carrega `scripts/lib/hubs/{slug}-sources.generated.json`
 * pra cada hub pedido, cruza e imprime o resumo.
 *
 * Uso:
 *   npx tsx scripts/hub-index-coverage.ts [--hub <slug>] [--seo-dir data/seo]
 *     [--seo-file <path>]
 *
 *   --hub       slug de UM hub (`anthropic-claude`, `openai-chatgpt`,
 *               `google-gemini`, `meta-ai`). Default: todos os hubs de
 *               `HUB_META` (workers/arquivo/src/hubs/meta.ts).
 *   --seo-dir   diretório onde resolver o relatório mais recente (default
 *               `data/seo`) — precisa do junction `data/` (sessão local).
 *   --seo-file  path explícito de um `index-status-*.json`, pulando a
 *               resolução automática (útil pra testar contra um relatório
 *               específico, ou numa sessão sem o junction).
 *
 * Exit: 0 se todos os hubs pedidos cruzaram sem erro; 1 se algum hub não
 * tem `{slug}-sources.generated.json` gerado, ou se nenhum relatório foi
 * encontrado.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs as parseCliArgs, isMainModule } from "./lib/cli-args.ts";
import {
  crossReferenceHubIndexCoverage,
  renderHubIndexCoverageSummary,
  type HubSourceEntry,
  type HubIndexStatusRow,
} from "./lib/hub-index-coverage.ts";
import { HUB_META } from "../workers/arquivo/src/hubs/meta.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Pure: dado os nomes de arquivo de um diretório, resolve o
 * `index-status-{YYYY-MM-DD}.json` mais recente — exclui deliberadamente as
 * variantes com sufixo (`index-status-{sufixo}-{data}.json`, ex:
 * `index-status-arquivo-2026-08-10.json`, introduzidas pelo `--out-suffix`
 * do #4909 pro sitemap de `arquivo.diar.ia.br`), porque as URLs de hub são
 * todas `diar.ia.br/p/...` — cobertas pelo relatório PRINCIPAL (site
 * inteiro), nunca pelo relatório dedicado a `/temas/*`. `null` se nenhum
 * nome bater o padrão principal.
 */
export function resolveLatestMainIndexStatusFilename(filenames: readonly string[]): string | null {
  const MAIN_RE = /^index-status-(\d{4}-\d{2}-\d{2})\.json$/;
  const matches = filenames
    .map((f) => ({ f, date: f.match(MAIN_RE)?.[1] }))
    .filter((x): x is { f: string; date: string } => x.date !== undefined)
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return matches.length > 0 ? matches[0].f : null;
}

interface IndexStatusFile {
  site: string;
  date: string;
  sitemap: string;
  rows: HubIndexStatusRow[];
}

function loadHubSources(slug: string): HubSourceEntry[] {
  const path = resolve(ROOT, "scripts", "lib", "hubs", `${slug}-sources.generated.json`);
  if (!existsSync(path)) {
    throw new Error(
      `${path} não existe — rode "npx tsx scripts/generate-hub-sources.ts --hub ${slug}" primeiro.`,
    );
  }
  return JSON.parse(readFileSync(path, "utf8")) as HubSourceEntry[];
}

function loadIndexStatus(path: string): IndexStatusFile {
  return JSON.parse(readFileSync(path, "utf8")) as IndexStatusFile;
}

function resolveIndexStatusPath(seoDir: string, explicitFile: string | undefined): string | null {
  if (explicitFile) return resolve(ROOT, explicitFile);
  if (!existsSync(seoDir)) return null;
  const filename = resolveLatestMainIndexStatusFilename(readdirSync(seoDir));
  return filename ? resolve(seoDir, filename) : null;
}

function main(): number {
  const { values } = parseCliArgs(process.argv.slice(2));
  const seoDir = resolve(ROOT, values["seo-dir"] ?? "data/seo");
  const hubArg = values["hub"];
  const hubs = hubArg ? [hubArg] : HUB_META.map((h) => h.slug);

  const indexStatusPath = resolveIndexStatusPath(seoDir, values["seo-file"]);
  if (!indexStatusPath) {
    console.error(
      `[hub-index-coverage] nenhum index-status-YYYY-MM-DD.json encontrado em ${seoDir} (precisa do junction data/ em sessão local) — ou passe --seo-file explícito.`,
    );
    return 1;
  }

  let indexStatus: IndexStatusFile;
  try {
    indexStatus = loadIndexStatus(indexStatusPath);
  } catch (e) {
    console.error(`[hub-index-coverage] falha ao ler ${indexStatusPath}: ${(e as Error).message}`);
    return 1;
  }
  console.log(
    `[hub-index-coverage] relatório: ${indexStatusPath} (site ${indexStatus.site}, data ${indexStatus.date}, ${indexStatus.rows.length} linha(s)).`,
  );

  let exitCode = 0;
  for (const slug of hubs) {
    let hubEntries: HubSourceEntry[];
    try {
      hubEntries = loadHubSources(slug);
    } catch (e) {
      console.error(`[hub-index-coverage] ${(e as Error).message}`);
      exitCode = 1;
      continue;
    }
    const result = crossReferenceHubIndexCoverage(hubEntries, indexStatus.rows, indexStatus.date);
    console.log(renderHubIndexCoverageSummary(slug, result));
  }
  return exitCode;
}

if (isMainModule(import.meta.url)) {
  process.exitCode = main();
}

export { main };
