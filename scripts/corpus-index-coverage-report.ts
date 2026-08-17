/**
 * corpus-index-coverage-report.ts (#5125 "índices por mês e por tema")
 *
 * CLI fino sobre `scripts/lib/corpus-index-coverage.ts`: carrega o corpus
 * confirmado (`data/beehiiv-cache/posts/*.json`, via `loadPosts` de
 * `generate-hub-sources.ts` — mesma leitura já usada pelos hubs, isolando
 * falha de parse por arquivo) + os 6 `{slug}-sources.generated.json` já
 * commitados (um por hub de `HUB_META`), cruza via
 * `computeCorpusIndexCoverage`, imprime o resumo no stdout e escreve
 * `docs/corpus-index-status-5125.md`.
 *
 * **Não é um artefato mantido em sync contínuo por CI** (diferente de
 * `test/build-entity-page.test.ts`, que trava o HTML committed contra o
 * conteúdo fonte) — o doc é uma FOTOGRAFIA do estado do corpus no dia em
 * que rodou, mesmo espírito de `docs/entity-page-candidates.md`. Re-rodar
 * manualmente quando quiser reconfirmar os números antes de citá-los (a
 * disciplina do #1172 já pede isso: nunca confiar em número escrito num doc
 * sem re-derivar). `test/corpus-index-coverage.test.ts` cobre a LÓGICA
 * (`computeCorpusIndexCoverage`/`renderCorpusIndexStatusMarkdown`) com
 * fixture pequena, não o corpus real — não precisa do junction `data/` pra
 * rodar em CI.
 *
 * Uso:
 *   npx tsx scripts/corpus-index-coverage-report.ts   # imprime + escreve o doc
 *
 * Precisa do junction `data/` (OneDrive) — ver `loadPosts` em
 * `generate-hub-sources.ts`. Sem ele, lança com a mensagem já padronizada
 * daquele helper (label `local`, CLAUDE.md).
 */
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { writeFileAtomic } from "./lib/atomic-write.ts";
import { isMainModule } from "./lib/cli-args.ts";
import { loadPosts, type HubSourceEntry } from "./generate-hub-sources.ts";
import {
  computeCorpusIndexCoverage,
  renderCorpusIndexStatusMarkdown,
  type CorpusEditionSummary,
  type ThemeCoverageInput,
} from "./lib/corpus-index-coverage.ts";
import { HUB_META } from "../workers/arquivo/src/hubs/meta.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HUBS_DIR = resolve(ROOT, "scripts", "lib", "hubs");
const OUT_PATH = resolve(ROOT, "docs", "corpus-index-status-5125.md");

/** `YYYY-MM-DD` — data de geração exibida no doc. Injetável só pra teste
 * (o CLI real sempre usa a data corrente). */
export function todayIso(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

function loadThemes(): ThemeCoverageInput[] {
  return HUB_META.map((hub) => {
    const path = resolve(HUBS_DIR, `${hub.slug}-sources.generated.json`);
    if (!existsSync(path)) {
      console.error(
        `[corpus-index-coverage-report] ⚠ ${path} ausente — rode "npx tsx scripts/generate-hub-sources.ts --hub ${hub.slug}" primeiro. Tratando como 0 edições cobertas por este tema.`,
      );
      return { slug: hub.slug, label: hub.label, editionSlugs: [] };
    }
    const rows = JSON.parse(readFileSync(path, "utf8")) as HubSourceEntry[];
    return { slug: hub.slug, label: hub.label, editionSlugs: rows.map((r) => r.editionSlug) };
  });
}

function loadEditions(): CorpusEditionSummary[] {
  return loadPosts()
    .filter((p) => p.status === "confirmed")
    .map((p) => ({
      slug: p.slug ?? "",
      hasResolvableDate: Boolean(p.slug) && p.publish_date != null,
    }))
    .filter((e) => e.slug !== "");
}

function main(): number {
  const editions = loadEditions();
  const themes = loadThemes();
  const result = computeCorpusIndexCoverage(editions, themes);
  const generatedAt = todayIso();
  const markdown = renderCorpusIndexStatusMarkdown(result, { generatedAt });

  console.log(
    `[corpus-index-coverage-report] ${result.totalEditions} edições confirmadas — mês: ${result.monthIndexCoveredEditions}/${result.totalEditions}; tema: ${result.themeIndexCoveredEditions}/${result.totalEditions} (${result.themeCoveragePct}%); sem tema: ${result.uncoveredSlugs.length}.`,
  );

  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileAtomic(OUT_PATH, markdown);
  console.log(`[corpus-index-coverage-report] escrito em ${OUT_PATH}`);
  return 0;
}

if (isMainModule(import.meta.url)) {
  process.exitCode = main();
}

export { main };
