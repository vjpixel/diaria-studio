/**
 * build-hub-page.ts (#4558 Parte A)
 *
 * Gera o HTML de um hub temático a partir do módulo de conteúdo em
 * `scripts/lib/hubs/{slug}.ts` e escreve um arquivo GERADO — NÃO EDITAR À
 * MÃO — em `workers/arquivo/src/hubs/{slug}.generated.ts`, exportando o HTML
 * como `const` (mesmo padrão de `workers/cursos/src/courses-full.generated.ts`,
 * #4052). O Worker `arquivo` importa esse const estaticamente (bundlado pelo
 * esbuild do Wrangler) — nunca gera HTML em runtime pra um hub.
 *
 * Registry de hubs (`HUB_LOADERS`) fica NESTE arquivo (não em
 * `scripts/lib/hubs/`) porque só o builder precisa enumerar todos os hubs;
 * o Worker só importa o registry PRÓPRIO dele
 * (`workers/arquivo/src/hubs/registry.ts`), escrito à mão e atualizado 1x
 * por hub novo — 2 registries deliberadamente separados, mesma fronteira de
 * `lib/shared/` vs Worker já usada por `titles-cache.json`/`render-archive.ts`.
 *
 * Uso:
 *   npx tsx scripts/build-hub-page.ts --hub anthropic-claude
 *   npx tsx scripts/build-hub-page.ts --all
 *   npx tsx scripts/build-hub-page.ts --hub anthropic-claude --check   # renderiza (valida invariantes via HubContent), não escreve
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";

import { writeFileAtomic } from "./lib/atomic-write.ts";
import { isMainModule } from "./lib/cli-args.ts";
import { renderHubPage, type HubContent } from "./lib/shared/hub-page.ts";
import { getAnthropicClaudeHub } from "./lib/hubs/anthropic-claude.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Registry completo de hubs — 1 entrada por tema publicado. Adicionar um
 * hub novo: escrever `scripts/lib/hubs/{slug}.ts` (exportando `HubContent`)
 * e uma linha aqui. Exportado (não só usado localmente) pra
 * `test/hub-registry-completeness.test.ts` cruzar contra
 * `workers/arquivo/src/hubs/registry.ts::HUB_REGISTRY` — pega o caso "hub
 * novo entrou aqui, mas ninguém atualizou o registry do Worker" antes de
 * virar 404 em produção (achado do fleet review). */
export const HUB_LOADERS: Record<string, () => HubContent> = {
  "anthropic-claude": getAnthropicClaudeHub,
};

function outPathFor(slug: string): string {
  return resolve(ROOT, `workers/arquivo/src/hubs/${slug}.generated.ts`);
}

/** Nome da constante exportada — `HUB_HTML` + slug em SCREAMING_SNAKE_CASE. */
function constNameFor(slug: string): string {
  return `HUB_HTML_${slug.replace(/-/g, "_").toUpperCase()}`;
}

export function renderGeneratedModule(slug: string, html: string): string {
  const constName = constNameFor(slug);
  return `/**
 * ${slug}.generated.ts (#4558 Parte A) — GERADO, NÃO EDITAR À MÃO.
 *
 * Fonte: scripts/lib/hubs/${slug}.ts → scripts/build-hub-page.ts.
 * HTML completo do hub temático "${slug}", servido pelo Worker \`arquivo\`
 * em GET /temas/${slug}. Regenerar:
 *
 *   npx tsx scripts/build-hub-page.ts --hub ${slug}
 *
 * test/hub-page-drift.test.ts garante que este arquivo reflete o conteúdo.
 */
export const ${constName} = ${JSON.stringify(html)};
`;
}

function buildOne(slug: string, check: boolean): void {
  const loader = HUB_LOADERS[slug];
  if (!loader) {
    console.error(`[build-hub-page] hub desconhecido: "${slug}". Disponíveis: ${Object.keys(HUB_LOADERS).join(", ")}`);
    process.exit(2);
  }
  const hub = loader();
  const html = renderHubPage(hub);
  const outPath = outPathFor(slug);
  if (check) {
    process.stderr.write(`[build-hub-page] ${slug}: --check, não escreve.\n`);
    return;
  }
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileAtomic(outPath, renderGeneratedModule(slug, html));
  process.stderr.write(`[build-hub-page] ${slug}: escrito em ${outPath}\n`);
  console.log(outPath);
}

function main(): void {
  const argv = process.argv.slice(2);
  const check = argv.includes("--check");
  const all = argv.includes("--all");
  const hubIdx = argv.indexOf("--hub");
  const hub = hubIdx >= 0 ? argv[hubIdx + 1] : undefined;

  if (!all && !hub) {
    console.error("[build-hub-page] uso: --hub <slug> ou --all");
    process.exit(2);
  }

  const slugs = all ? Object.keys(HUB_LOADERS) : [hub as string];
  for (const slug of slugs) buildOne(slug, check);
}

if (isMainModule(import.meta.url)) {
  main();
}
