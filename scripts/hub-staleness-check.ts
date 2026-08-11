#!/usr/bin/env node
/**
 * scripts/hub-staleness-check.ts (#4924, item 5 — "alternativa mais barata")
 *
 * CLI fino chamado pelo playbook do Stage 6 (`.claude/agents/orchestrator-stage-6.md`)
 * no fim de cada edição: audita o cache Beehiiv sincronizado
 * (`data/beehiiv-cache/posts/*.json`, atualizado no Stage 0 de toda edição)
 * contra os 4 datasets de hub commitados (`scripts/lib/hubs/*-sources.generated.json`)
 * e, se alguma edição confirmada casar `HUB_KEYWORD_PATTERNS` de um hub sem
 * estar no dataset daquele hub, imprime no stdout a lista + os comandos de
 * regen sugeridos. **Custo zero, sem task agendada, sem credencial** — só
 * comparação de JSON já em disco.
 *
 * Lógica pura em `scripts/lib/hub-staleness-check.ts` (`findStaleHubEditions`,
 * testada com fixture sintética). Este arquivo só faz I/O: lê os posts do
 * cache + os datasets commitados, chama a função pura, formata e imprime.
 *
 * **Fail-soft, NUNCA bloqueia o Stage 6 (#2643, label `local`).** O cache
 * Beehiiv só existe com o junction `data/` (OneDrive) populado — em sessão
 * cloud, ou antes do 1º `beehiiv-sync.ts`, o diretório não existe. Isso é
 * tratado como "nada a reportar", não como erro: imprime um aviso em
 * stderr e sai com exit 0. O Stage 6 nunca deve travar por causa desta
 * checagem informacional.
 *
 * Uso:
 *   npx tsx scripts/hub-staleness-check.ts
 *   → stdout vazio se todos os hubs estão em dia; senão, bloco de texto
 *     pronto pra colar no resumo do gate (ver `formatStaleHubReport`).
 *
 * NÃO regenera nem commita nada — só imprime os comandos sugeridos. Rodar
 * `generate-hub-sources.ts`/`build-hub-page.ts` de verdade é decisão do
 * editor (item 2 da issue #4924: política de commit continua manual).
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { loadPosts, HUB_KEYWORD_PATTERNS, type HubSourceEntry } from "./generate-hub-sources.ts";
import { findStaleHubEditions, formatStaleHubReport } from "./lib/hub-staleness-check.ts";
import { isMainModule } from "./lib/cli-args.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const POSTS_DIR = resolve(ROOT, "data/beehiiv-cache/posts");
const HUBS_DIR = resolve(ROOT, "scripts/lib/hubs");

/** Lê os `{slug}-sources.generated.json` commitados dos hubs registrados em
 * `HUB_KEYWORD_PATTERNS`. Sempre commitados (diferente de `POSTS_DIR`) —
 * ausência de um arquivo individual vira dataset vazio pra aquele hub
 * (nunca aborta a checagem inteira por um hub faltando). */
function loadHubDatasets(): Record<string, HubSourceEntry[]> {
  const out: Record<string, HubSourceEntry[]> = {};
  for (const slug of Object.keys(HUB_KEYWORD_PATTERNS)) {
    const path = resolve(HUBS_DIR, `${slug}-sources.generated.json`);
    if (!existsSync(path)) {
      out[slug] = [];
      continue;
    }
    try {
      out[slug] = JSON.parse(readFileSync(path, "utf8")) as HubSourceEntry[];
    } catch (e) {
      process.stderr.write(
        `[hub-staleness-check] ⚠ falha ao parsear ${path}: ${e instanceof Error ? e.message : e} — tratando como dataset vazio\n`,
      );
      out[slug] = [];
    }
  }
  return out;
}

function main(): void {
  if (!existsSync(POSTS_DIR)) {
    process.stderr.write(
      `[hub-staleness-check] ${POSTS_DIR} ausente — precisa do junction data/ (OneDrive) populado por beehiiv-sync.ts. Pulando checagem (fail-soft, ver CLAUDE.md label "local").\n`,
    );
    process.exit(0);
  }

  const posts = loadPosts();
  const datasets = loadHubDatasets();
  const { stale, warnings } = findStaleHubEditions(posts, datasets);

  for (const w of warnings) process.stderr.write(`[hub-staleness-check] ⚠ ${w}\n`);

  const report = formatStaleHubReport(stale);
  if (report) {
    console.log(report);
  } else {
    process.stderr.write("[hub-staleness-check] todos os hubs em dia — nada a reportar.\n");
  }
}

if (isMainModule(import.meta.url)) {
  main();
}
