/**
 * build-entity-page.ts (#5125 item 3)
 *
 * Gera o HTML de uma página de entidade a partir do módulo de conteúdo em
 * `scripts/lib/entities/{slug}.ts` e escreve o arquivo ESTÁTICO COMMITADO —
 * NÃO EDITAR À MÃO — em `workers/artigos/public/entidades/{slug}/index.html`.
 * Diferente de `build-hub-page.ts` (que gera um `.generated.ts` importado
 * em RUNTIME pelo Worker `arquivo`), `workers/artigos` é um Worker de
 * assets ESTÁTICOS puro (`[assets] directory = ./public`, sem `main`,
 * `workers/artigos/README.md`) — não há import em runtime possível, o
 * arquivo escrito aqui É o arquivo servido, byte a byte.
 *
 * Uso:
 *   npx tsx scripts/build-entity-page.ts --entity perplexity
 *   npx tsx scripts/build-entity-page.ts --all
 *   npx tsx scripts/build-entity-page.ts --entity perplexity --check   # renderiza (valida invariantes), não escreve
 *
 * Depois de gerar, atualizar À MÃO `workers/artigos/public/sitemap.xml` e a
 * seção "Entidades" de `workers/artigos/public/index.html` (mesmo padrão
 * manual já usado pra artigos avulsos, ver README do Worker) e rodar
 * `cd workers/artigos && npx wrangler deploy`.
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";

import { writeFileAtomic } from "./lib/atomic-write.ts";
import { isMainModule } from "./lib/cli-args.ts";
import { renderEntityPage, type EntityContent } from "./lib/shared/entity-page.ts";
import { getPerplexityEntity } from "./lib/entities/perplexity.ts";
import { getXaiEntity } from "./lib/entities/xai.ts";
import { getAmazonEntity } from "./lib/entities/amazon.ts";
import { getSamsungEntity } from "./lib/entities/samsung.ts";
import { getAppleEntity } from "./lib/entities/apple.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Registry completo de páginas de entidade — 1 entrada por entidade
 * publicada. Adicionar uma entidade nova: escrever `scripts/lib/entities/{slug}.ts`
 * (exportando `EntityContent`) e uma linha aqui. Mesmo padrão de
 * `HUB_LOADERS` em `build-hub-page.ts`. */
export const ENTITY_LOADERS: Record<string, () => EntityContent> = {
  perplexity: getPerplexityEntity,
  xai: getXaiEntity,
  amazon: getAmazonEntity,
  samsung: getSamsungEntity,
  apple: getAppleEntity,
};

function outPathFor(slug: string): string {
  return resolve(ROOT, `workers/artigos/public/entidades/${slug}/index.html`);
}

function buildOne(slug: string, check: boolean): void {
  const loader = ENTITY_LOADERS[slug];
  if (!loader) {
    console.error(`[build-entity-page] entidade desconhecida: "${slug}". Disponíveis: ${Object.keys(ENTITY_LOADERS).join(", ")}`);
    process.exit(2);
  }
  const entity = loader();
  const html = renderEntityPage(entity); // lança se EntityContent for inválido (validateEntityContent)
  const outPath = outPathFor(slug);
  if (check) {
    process.stderr.write(`[build-entity-page] ${slug}: --check, não escreve.\n`);
    return;
  }
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileAtomic(outPath, html);
  process.stderr.write(`[build-entity-page] ${slug}: escrito em ${outPath}\n`);
  console.log(outPath);
}

function main(): void {
  const args = process.argv.slice(2);
  const check = args.includes("--check");
  const all = args.includes("--all");
  const entityIdx = args.indexOf("--entity");
  const entitySlug = entityIdx >= 0 ? args[entityIdx + 1] : undefined;

  if (all) {
    for (const slug of Object.keys(ENTITY_LOADERS)) buildOne(slug, check);
    return;
  }
  if (!entitySlug) {
    console.error("[build-entity-page] uso: --entity <slug> | --all [--check]");
    process.exit(2);
  }
  buildOne(entitySlug, check);
}

if (isMainModule(import.meta.url)) {
  main();
}
