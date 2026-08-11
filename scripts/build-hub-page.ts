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
import { getOpenaiChatgptHub } from "./lib/hubs/openai-chatgpt.ts";
import { getGoogleGeminiHub } from "./lib/hubs/google-gemini.ts";
import { getMetaAiHub } from "./lib/hubs/meta-ai.ts";
// #4913 item 1: só o builder (Node-side) enumera todos os hubs pra montar a
// nav "Outros temas" — `scripts/lib/shared/hub-page.ts` NÃO importa
// `HUB_META` diretamente (inverteria a fronteira que a docstring de
// `meta.ts` estabelece; ver nota de `relatedHubs` em `hub-page.ts`).
import { HUB_META } from "../workers/arquivo/src/hubs/meta.ts";

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
  "openai-chatgpt": getOpenaiChatgptHub,
  "google-gemini": getGoogleGeminiHub,
  "meta-ai": getMetaAiHub,
};

function outPathFor(slug: string): string {
  return resolve(ROOT, `workers/arquivo/src/hubs/${slug}.generated.ts`);
}

/** Nome da constante exportada — `HUB_HTML` + slug em SCREAMING_SNAKE_CASE. */
function constNameFor(slug: string): string {
  return `HUB_HTML_${slug.replace(/-/g, "_").toUpperCase()}`;
}

/** Nome da constante de `<lastmod>` exportada — `HUB_LASTMOD` + slug em
 * SCREAMING_SNAKE_CASE (#4909). Vem de graça do mesmo módulo gerado que já
 * carrega o HTML — nenhum registro manual novo. Valor é `hub.updatedDate`
 * (#4911 — NÃO `publishedDate`: `<lastmod>`/`Last-Modified` descrevem quando
 * o conteúdo mudou, o mesmo campo que já alimenta `dateModified` no JSON-LD;
 * ver docstring de `scripts/lib/shared/hub-page.ts`). */
function lastmodConstNameFor(slug: string): string {
  return `HUB_LASTMOD_${slug.replace(/-/g, "_").toUpperCase()}`;
}

export function renderGeneratedModule(slug: string, html: string, updatedDate: string): string {
  const constName = constNameFor(slug);
  const lastmodConstName = lastmodConstNameFor(slug);
  return `/**
 * ${slug}.generated.ts (#4558) — GERADO, NÃO EDITAR À MÃO.
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
export const ${lastmodConstName} = ${JSON.stringify(updatedDate)};
`;
}

/** Carrega o `HubContent` completo de um slug — loader do hub (`get{Hub}Hub()`)
 * MAIS o pós-processamento que só o builder pode fazer (#4913 itens 1/3: nav
 * "Outros temas" com os hubs irmãos, própria página excluída — preenchido
 * aqui, não em `get{Hub}Hub()`, porque só quem enumera `HUB_LOADERS` conhece
 * o registry completo). Exportado pra `test/hub-page-drift.test.ts` chamar o
 * MESMO caminho que `buildOne` usa — sem isso o teste de drift comparava o
 * asset committed (COM a nav, escrito por `buildOne`) contra um render fresco
 * que pulava esse pós-processamento (SEM a nav), acusando divergência falsa
 * toda vez que o conteúdo de um hub estivesse correto. */
export function loadHubContent(slug: string): HubContent {
  const loader = HUB_LOADERS[slug];
  if (!loader) {
    throw new Error(`[build-hub-page] hub desconhecido: "${slug}". Disponíveis: ${Object.keys(HUB_LOADERS).join(", ")}`);
  }
  const baseHub = loader();
  const relatedHubs = HUB_META.filter((m) => m.slug !== slug);
  return { ...baseHub, relatedHubs };
}

function buildOne(slug: string, check: boolean): void {
  if (!HUB_LOADERS[slug]) {
    console.error(`[build-hub-page] hub desconhecido: "${slug}". Disponíveis: ${Object.keys(HUB_LOADERS).join(", ")}`);
    process.exit(2);
  }
  const hub = loadHubContent(slug);
  const html = renderHubPage(hub);
  const outPath = outPathFor(slug);
  if (check) {
    process.stderr.write(`[build-hub-page] ${slug}: --check, não escreve.\n`);
    return;
  }
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileAtomic(outPath, renderGeneratedModule(slug, html, hub.updatedDate));
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
