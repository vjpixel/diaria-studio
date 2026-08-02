#!/usr/bin/env tsx
/**
 * select-linkedin-weekly.ts (#4456)
 *
 * Orquestra a seleção por clique da newsletter semanal do LinkedIn:
 *   1. Resolve ciclo + janela de conteúdo (segunda a sexta) a partir do
 *      AAMMDD da segunda de PUBLICAÇÃO.
 *   2. Lê `02-reviewed.md` de cada edição da janela, extrai candidatos
 *      (destaques + itens de seção).
 *   3. Cruza com o cache local de cliques do Beehiiv
 *      (`data/beehiiv-cache/posts/*.json`).
 *   4. Ranqueia por taxa (cliques verificados ÷ aberturas), filtra links
 *      comerciais/próprios, seleciona manchetes + Use Melhor + lista do
 *      resto da semana.
 *   5. Escreve `data/weekly/{cycle}/_internal/ln-selection.json`.
 *
 * **`--manifest-only`**: só resolve a janela + cruza com o cache pra emitir
 * o manifest de posts que precisam de enriquecimento de clicks via MCP
 * (mesmo shape de `posts_needing_clicks` do `beehiiv-sync.ts`) — NÃO calcula
 * seleção. A skill usa isso pra decidir se despacha o agent
 * `beehiiv-clicks-enricher` ANTES de rodar a seleção de verdade (sem isso, a
 * 1ª passada rodaria com clicks todos zerados).
 *
 * Uso:
 *   npx tsx scripts/select-linkedin-weekly.ts --publish-monday AAMMDD [--manifest-only]
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getArg, hasFlag, isMainModule } from "./lib/cli-args.ts";
import { resolveEditionDir } from "./lib/find-current-edition.ts";
import { resolveWeeklyLinkedinCycle, weeklyLinkedinRelDir } from "./lib/weekly-linkedin-cycle.ts";
import { extractWeeklyCandidates, type WeeklyRawCandidate } from "./lib/weekly-linkedin-parse.ts";
import {
  matchPostsToWindow,
  identifyWeeklyPostsNeedingClicks,
  clickCountsForUrl,
  uniqueOpensOf,
  type BeehiivCachePost,
} from "./lib/weekly-linkedin-clicks.ts";
import {
  toRankedCandidate,
  computeHeadlineCap,
  selectHeadlines,
  selectUseMelhor,
  type WeeklyRankedCandidate,
} from "./lib/weekly-linkedin-select.ts";
import { normalizeUrl } from "./lib/weekly-linkedin-clicks.ts";
import { parseDestaques } from "./extract-destaques.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EDITIONS_ROOT_DIR = join(ROOT, "data/editions");
const BEEHIIV_POSTS_DIR = join(ROOT, "data/beehiiv-cache/posts");

interface EditionRead {
  date: string;
  found: boolean;
  d1Title?: string;
  candidates: WeeklyRawCandidate[];
}

function readEdition(date: string): EditionRead {
  const dir = resolveEditionDir(EDITIONS_ROOT_DIR, date);
  const mdPath = join(dir, "02-reviewed.md");
  if (!existsSync(mdPath)) return { date, found: false, candidates: [] };
  const raw = readFileSync(mdPath, "utf8");
  const d1 = parseDestaques(raw).find((d) => d.n === 1);
  return { date, found: true, d1Title: d1?.title, candidates: extractWeeklyCandidates(raw, date) };
}

function loadBeehiivCache(): BeehiivCachePost[] {
  if (!existsSync(BEEHIIV_POSTS_DIR)) return [];
  const out: BeehiivCachePost[] = [];
  for (const f of readdirSync(BEEHIIV_POSTS_DIR)) {
    if (f === "index.json" || !f.endsWith(".json")) continue;
    try {
      out.push(JSON.parse(readFileSync(join(BEEHIIV_POSTS_DIR, f), "utf8")));
    } catch {
      // cache corrompido — ignora (mesmo comportamento de monthly-click-sections.ts)
    }
  }
  return out;
}

function main() {
  const argv = process.argv.slice(2);
  const publishMonday = getArg(argv, "publish-monday");
  const manifestOnly = hasFlag(argv, "manifest-only");

  if (!publishMonday) {
    console.error("Uso: select-linkedin-weekly.ts --publish-monday AAMMDD [--manifest-only]");
    process.exit(2);
  }

  const resolution = resolveWeeklyLinkedinCycle(publishMonday);
  if (!resolution) {
    console.error(`--publish-monday inválido: "${publishMonday}" (esperado AAMMDD)`);
    process.exit(2);
  }
  const { cycle, contentWindow } = resolution;

  const editions = contentWindow.map(readEdition);
  const editionsFound = editions.filter((e) => e.found);

  const cachePosts = loadBeehiivCache();
  const windowPosts = matchPostsToWindow(cachePosts, contentWindow);

  if (manifestOnly) {
    const manifest = identifyWeeklyPostsNeedingClicks(windowPosts);
    console.log(JSON.stringify({ cycle, contentWindow, editionsFound: editionsFound.length, posts_needing_clicks: manifest }, null, 2));
    return;
  }

  if (editionsFound.length === 0) {
    console.error(`Nenhuma edição encontrada na janela ${contentWindow.join(", ")} — nada pra selecionar.`);
    process.exit(1);
  }

  const allCandidates: WeeklyRawCandidate[] = editionsFound.flatMap((e) => e.candidates);

  const ranked: WeeklyRankedCandidate[] = allCandidates.map((c) => {
    const post = windowPosts.get(c.editionDate);
    const clicks = clickCountsForUrl(c.url, post?.stats?.clicks);
    const opens = uniqueOpensOf(post);
    return toRankedCandidate(c, clicks, opens);
  });

  const headlineCap = computeHeadlineCap(editionsFound.length);
  const headlineResult = selectHeadlines(ranked, headlineCap);
  const headlineUrls = new Set(headlineResult.selected.map((c) => normalizeUrl(c.url)));
  const headlineEditionDates = new Set(headlineResult.selected.map((c) => c.editionDate));

  const useMelhor = selectUseMelhor(ranked, headlineUrls);

  const restOfWeek = editionsFound
    .filter((e) => !headlineEditionDates.has(e.date) && e.d1Title)
    .map((e) => ({ editionDate: e.date, title: e.d1Title as string }));

  const manifest = identifyWeeklyPostsNeedingClicks(windowPosts);
  const warnings = [...headlineResult.warnings];
  if (manifest.length > 0) {
    warnings.push(
      `${manifest.length} post(s) da janela ainda sem clicks enriquecidos no cache — rode beehiiv-clicks-enricher e re-rode este script antes de confiar na seleção.`,
    );
  }
  const missingD1 = editionsFound.filter((e) => !headlineEditionDates.has(e.date) && !e.d1Title);
  if (missingD1.length > 0) {
    warnings.push(
      `${missingD1.length} edição(ões) sem DESTAQUE 1 parseável — não entram na lista "resto da semana": ${missingD1.map((e) => e.date).join(", ")}`,
    );
  }

  const output = {
    cycle,
    publishMonday: resolution.publishMonday,
    contentWindow,
    editionsFound: editionsFound.map((e) => e.date),
    editionsMissing: editions.filter((e) => !e.found).map((e) => e.date),
    headlines: headlineResult.selected,
    headlineCandidatesRanked: headlineResult.ranked,
    excludedCandidates: headlineResult.excluded,
    useMelhor: useMelhor ?? null,
    restOfWeek,
    postsNeedingClicks: manifest,
    warnings,
    generatedAt: new Date().toISOString(),
  };

  const outDir = join(ROOT, weeklyLinkedinRelDir(cycle), "_internal");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, "ln-selection.json");
  writeFileSync(outPath, JSON.stringify(output, null, 2), "utf8");

  console.log(`OK: ciclo ${cycle} — ${headlineResult.selected.length} manchete(s), Use Melhor ${useMelhor ? "✓" : "✗"}, ${restOfWeek.length} no resto da semana → ${outPath}`);
  for (const h of headlineResult.selected) {
    console.log(`  [${h.ratePct.toFixed(2)}%] ${h.title} (${h.editionDate}, ${h.section})`);
  }
  if (warnings.length > 0) {
    console.log("\nWarnings:");
    for (const w of warnings) console.log(`  - ${w}`);
  }
}

if (isMainModule(import.meta.url)) {
  main();
}
