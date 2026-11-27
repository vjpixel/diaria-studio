/**
 * generate-hub-sources.ts (#4558 Parte A)
 *
 * CLI de `scripts/lib/hub-sources.ts` (#14001): a lógica (patterns por hub,
 * coleta, dedup, merge de entradas manuais, diff do `--dry-run`, gravação)
 * mora na lib, onde está a documentação completa do módulo e das flags. Este
 * arquivo só lê os argumentos e chama a lib, e reexporta tudo dela para os
 * importadores de sempre.
 *
 *   npx tsx scripts/generate-hub-sources.ts --hub anthropic-claude [--dry-run]
 *   npx tsx scripts/generate-hub-sources.ts --all [--dry-run]
 *   npx tsx scripts/generate-hub-sources.ts --hub anthropic-claude --backfill-titles
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { isMainModule } from "./lib/cli-args.ts";
import type { RawCachedPost } from "./lib/raw-cached-post.ts";
import {
  HUB_KEYWORD_PATTERNS,
  backfillEditionTitles,
  collectHubSources,
  loadPosts,
  loadTitlesCache,
  mergeManualHubSources,
  writeGeneratedHubSources,
  type HubSourceEntry,
} from "./lib/hub-sources.ts";

export * from "./lib/hub-sources.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HUBS_DIR = resolve(ROOT, "scripts/lib/hubs");

function runBackfillTitles(hub: string, opts: { dryRun: boolean }): void {
  const path = resolve(HUBS_DIR, `${hub}-sources.generated.json`);
  if (!existsSync(path)) {
    console.error(`[generate-hub-sources] ${path} não existe — rode sem --backfill-titles primeiro`);
    process.exit(2);
  }
  const rows = JSON.parse(readFileSync(path, "utf8")) as HubSourceEntry[];
  const titlesCache = loadTitlesCache();
  const filled = backfillEditionTitles(rows, titlesCache);
  const before = rows.filter((r) => r.editionTitle).length;
  const after = filled.filter((r) => r.editionTitle).length;
  writeGeneratedHubSources(path, filled, opts);
  if (!opts.dryRun) {
    process.stderr.write(
      `[generate-hub-sources] ${hub}: editionTitle preenchido em ${after}/${filled.length} (${after - before} novos via titles-cache.json) -> ${path}\n`,
    );
  }
  console.log(path);
}

/** Fluxo normal (precisa do junction `data/`, ver `loadPosts`): coleta,
 * loga warnings, e grava (ou, em `--dry-run`, só previsualiza) o JSON do
 * hub. Extraído de `main()` pra dar nome ao que o comentário do pattern
 * `brasil-regulacao` acima já referenciava como `runGenerate`. */
function runGenerate(hub: string, opts: { dryRun: boolean }, posts?: RawCachedPost[]): void {
  const loaded = posts ?? loadPosts();
  const { rows: collected, warnings } = collectHubSources(loaded, HUB_KEYWORD_PATTERNS[hub]);
  for (const w of warnings) process.stderr.write(`[generate-hub-sources] ⚠ ${w}\n`);
  const outPath = resolve(HUBS_DIR, `${hub}-sources.generated.json`);
  // #5125: entradas `manual: true` do JSON commitado sobrevivem ao regen —
  // sem isso a sobrescrita sem merge apaga curadoria em silêncio (era o caso
  // de 3 entradas de `brasil-regulacao`, das quais só 2 estavam documentadas).
  const existing: HubSourceEntry[] = existsSync(outPath)
    ? (JSON.parse(readFileSync(outPath, "utf8")) as HubSourceEntry[])
    : [];
  const rows = mergeManualHubSources(existing, collected);
  const preserved = rows.length - collected.length;
  if (preserved > 0) {
    process.stderr.write(
      `[generate-hub-sources] ${hub}: ${preserved} entrada(s) manual(is) preservada(s) (campo "manual": true).\n`,
    );
  }
  writeGeneratedHubSources(outPath, rows, opts);
  if (!opts.dryRun) {
    process.stderr.write(`[generate-hub-sources] ${hub}: ${rows.length} edições -> ${outPath}\n`);
  }
  console.log(outPath);
}

function main(): void {
  const argv = process.argv.slice(2);
  const all = argv.includes("--all");
  const hubIdx = argv.indexOf("--hub");
  const hubArg = hubIdx >= 0 ? argv[hubIdx + 1] : undefined;
  const dryRun = argv.includes("--dry-run");

  // `--all` (#5125): regenera TODOS os hubs numa invocação, carregando o
  // corpus UMA vez só (`loadPosts` lê ~250 arquivos JSON do junction `data/`;
  // 7 invocações separadas pagavam essa leitura 7×). Invocação MANUAL — não
  // está ligado a nenhuma task agendada, ver a nota do módulo sobre
  // `UPDATED_DATE`/#6267. Incompatível com `--backfill-titles`, que é um
  // modo de reparo por hub.
  if (all) {
    if (argv.includes("--backfill-titles")) {
      console.error("[generate-hub-sources] --all não combina com --backfill-titles (modo por hub).");
      process.exit(2);
    }
    const posts = loadPosts();
    for (const slug of Object.keys(HUB_KEYWORD_PATTERNS)) {
      runGenerate(slug, { dryRun }, posts);
    }
    return;
  }

  if (!hubArg || !(hubArg in HUB_KEYWORD_PATTERNS)) {
    console.error(
      `[generate-hub-sources] --hub obrigatório (ou --all), um de: ${Object.keys(HUB_KEYWORD_PATTERNS).join(", ")}`,
    );
    process.exit(2);
    return;
  }
  const hub: string = hubArg;

  // #4918 Conserto 2, "caminho barato": preenche `editionTitle` no JSON já
  // commitado a partir de `titles-cache.json` (também commitado) — NÃO
  // precisa do junction `data/`, roda em sessão cloud. Modo separado do
  // fluxo normal (que precisa de `data/beehiiv-cache/posts` via
  // `loadUnifiedEditionCache`, ver `loadPosts` abaixo) — sai antes de
  // checar o cache.
  if (argv.includes("--backfill-titles")) {
    runBackfillTitles(hub, { dryRun });
    return;
  }

  runGenerate(hub, { dryRun });
}

if (isMainModule(import.meta.url)) {
  main();
}
