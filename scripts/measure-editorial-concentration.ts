#!/usr/bin/env npx tsx
/**
 * scripts/measure-editorial-concentration.ts (#8370, Peça 3)
 *
 * @one-off-validity: permanente motivo="invariante mensal recorrente — roda pela task agendada Diaria-Editorial-Concentration-Monthly-Measure (dia 2, 09:00 BRT) e faz upsert por mês em data/editorial-concentration-monthly.jsonl; o prefixo measure-* casa o padrão one-off por coincidência de nome, mas a série existe justamente para acumular ao longo do tempo, não para responder uma pergunta de uma vez"
 *
 * Invariante mensal: % big-tech/lab, % Brasil, % `exploracao` e CTR
 * exploração-vs-resto, medidos do acervo público (`workers/site/public/p/`
 * + `sitemap.xml`, ambos versionados — funciona sem `data/`). A coluna
 * `% exploração` passou a ter fonte real com a Peça 2
 * (`data/exploration-quota.json`, só disponível onde `data/` existe);
 * `CTR exploração`/`CTR resto` seguem sem fonte. Método e ressalvas
 * completos: `scripts/lib/editorial-concentration.ts`.
 *
 * Sem isso, a Peça 1 (#8366) e a Peça 2 (cota de exploração no scorer) da
 * #8370 viram loop novo — nenhuma das duas se justifica sem um número que
 * meça se mudou algo depois de implementadas.
 *
 * Uso:
 *   npx tsx scripts/measure-editorial-concentration.ts [--out <path>] [--json]
 *
 * Sem `--out`, grava em `data/editorial-concentration-monthly.jsonl`
 * (append idempotente por mês — sobrescreve a linha do mês se já existir,
 * nunca duplica) quando `data/` está presente; se `data/` estiver ausente
 * (worktree isolado, clone fresco), imprime a tabela e AVISA que não
 * persistiu, sem lançar — mesma degradação graciosa de
 * `snippet-loader.ts`/painel Caixas (#5227).
 *
 * Exit code: sempre 0 — é medição, não gate. Nenhuma chamada de rede.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import {
  aggregateByMonth,
  parsePageSignal,
  parseSitemapEntries,
  type MonthlyConcentrationRow,
  type PageSignal,
} from "./lib/editorial-concentration.ts";
import {
  explorationFlagsBySlug,
  readExplorationState,
  EXPLORATION_STATE_RELATIVE_PATH,
} from "./lib/exploration-quota.ts"; // #8370 Peça 2

const ROOT = resolve(import.meta.dirname, "..");
const PAGES_DIR = resolve(ROOT, "workers/site/public/p");
const SITEMAP_PATH = resolve(ROOT, "workers/site/public/sitemap.xml");
const DEFAULT_OUT = resolve(ROOT, "data/editorial-concentration-monthly.jsonl");

const RESSALVA =
  "Ressalva de método: proxy por regex em <title>+<meta description> das páginas do acervo, não leitura de " +
  "corpo — falso positivo/negativo de keyword é esperado, e parte da alta de big-tech em 2026 é ciclo real de " +
  "lançamentos (Fable, Opus 5, Gemini), não só o loop de reforço do scorer. Ver scripts/lib/editorial-concentration.ts.";

export function loadPages(pagesDir: string): PageSignal[] {
  const slugs = readdirSync(pagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  return slugs
    .map((slug) => {
      const path = resolve(pagesDir, slug, "index.html");
      if (!existsSync(path)) return null;
      return parsePageSignal(readFileSync(path, "utf8"), slug);
    })
    .filter((page): page is NonNullable<typeof page> => page !== null);
}

export function formatTable(rows: MonthlyConcentrationRow[]): string {
  const header = "mês       | edições | destaques | % big-tech | % Brasil | % exploração | CTR exploração | CTR resto";
  const sep = "-".repeat(header.length);
  const pct = (n: number) => `${(n * 100).toFixed(0)}%`;
  const pctOrNd = (n: number | null) => (n === null ? "n/d" : pct(n));
  const ctrOrNd = (n: number | null) => (n === null ? "n/d" : `${(n * 100).toFixed(1)}%`);
  const lines = rows.map(
    (r) =>
      `${r.month} | ${String(r.editions).padStart(7)} | ${String(r.destaques).padStart(9)} | ` +
      `${pct(r.bigTechPct).padStart(10)} | ${pct(r.brasilPct).padStart(8)} | ${pctOrNd(r.exploracaoPct).padStart(13)} | ` +
      `${ctrOrNd(r.exploracaoCtr).padStart(15)} | ${ctrOrNd(r.restCtr).padStart(9)}`,
  );
  return [header, sep, ...lines].join("\n");
}

function persist(rows: MonthlyConcentrationRow[], outPath: string): { persisted: boolean; reason?: string } {
  const dataDir = resolve(ROOT, "data");
  if (!existsSync(dataDir)) {
    return { persisted: false, reason: "data/ ausente neste checkout (worktree isolado ou clone fresco) — só impresso no stdout." };
  }
  mkdirSync(resolve(outPath, ".."), { recursive: true });
  const existingByMonth = new Map<string, MonthlyConcentrationRow>();
  if (existsSync(outPath)) {
    for (const line of readFileSync(outPath, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line) as MonthlyConcentrationRow;
        existingByMonth.set(row.month, row);
      } catch {
        // linha corrompida — não deixa uma linha ruim travar o resto do arquivo.
      }
    }
  }
  for (const row of rows) existingByMonth.set(row.month, row);
  const sorted = [...existingByMonth.values()].sort((a, b) => a.month.localeCompare(b.month));
  writeFileSync(outPath, sorted.map((row) => JSON.stringify(row)).join("\n") + "\n");
  return { persisted: true };
}

export async function main(): Promise<void> {
  const { values, flags } = parseArgs(process.argv.slice(2));
  const outPath = values.out ? resolve(process.cwd(), values.out) : DEFAULT_OUT;

  const pages = loadPages(PAGES_DIR);
  const sitemapXml = readFileSync(SITEMAP_PATH, "utf8");
  const lastmodBySlug = new Map(parseSitemapEntries(sitemapXml).map((entry) => [entry.slug, entry.lastmod]));

  // #8370 Peça 2: `data/exploration-quota.json` registra, por edição, se ela
  // gastou um slot da cota semanal de exploração. `explorationFlagsBySlug`
  // faz o join edição→slug pela data editorial do próprio sitemap. Sem
  // `data/` (worktree, clone fresco) o estado sai vazio e a coluna volta a
  // degradar pra `null`, como antes desta peça. CTR real segue sem fonte.
  const explorationState = readExplorationState(resolve(ROOT, EXPLORATION_STATE_RELATIVE_PATH));
  const exploracaoFlags = explorationFlagsBySlug(explorationState, lastmodBySlug);
  const rows = aggregateByMonth(pages, lastmodBySlug, exploracaoFlags, new Map());

  if (flags.has("json")) {
    console.log(JSON.stringify(rows, null, 2));
  } else {
    console.log(formatTable(rows));
    console.log("");
    console.log(RESSALVA);
  }

  const result = persist(rows, outPath);
  if (result.persisted) {
    console.log(`\nPersistido em ${outPath}`);
  } else {
    console.warn(`\n[aviso] ${result.reason}`);
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 0; // medição, nunca gate — ver docstring.
  });
}
