#!/usr/bin/env node
/**
 * scripts/build-artigo-especial-teaser.ts (#7030)
 *
 * Gera, pra cada Artigo Especial listado em `ARTICLES`, os DOIS artefatos
 * que o gate do `workers/artigos` precisa a partir de UMA fonte canônica
 * (mesmo padrão de `scripts/build-cursos-page.ts` #4052: seed → teaser
 * estático + "full" embutido num módulo `.generated.ts`, committed, nunca
 * fetchable como asset):
 *
 *   FONTE (committed, editável à mão): `workers/artigos/articles-src/{slug}.html`
 *     — o HTML COMPLETO do artigo, com o marcador `<!-- ESPECIAL:GATE_CUT -->`
 *     (`scripts/lib/shared/html-teaser-split.ts`) no ponto de corte. É AQUI
 *     que o editor edita o texto do artigo — nunca no `public/` gerado nem
 *     no `.generated.ts` gerado.
 *
 *   GERADO 1: `workers/artigos/public/{ano}/{slug}/index.html` — TEASER
 *     (fonte até o marcador + bloco de convite,
 *     `scripts/lib/shared/artigo-especial-gate-cta.ts`, + fechamento de
 *     tags). Servido pelo `env.ASSETS` (estático) — o que TODO visitante vê
 *     antes do gate.
 *
 *   GERADO 2: `workers/artigos/src/{slug}-full.generated.ts` — o HTML
 *     completo (marcador removido), como export `const`. Servido pelo
 *     worker script só depois do gate confirmar apoio ≥ limiar
 *     (`workers/artigos/src/index.ts`).
 *
 * Rodar este script de novo é sempre seguro/idempotente — a fonte nunca é
 * sobrescrita, só os 2 artefatos gerados. `--check` (CI) recomputa os 2 a
 * partir da fonte e falha se algum dos artefatos committed divergir — mesmo
 * padrão de `test/cursos-asset-drift.test.ts`/`test/cursos-full-drift.test.ts`.
 *
 * Uso:
 *   npx tsx scripts/build-artigo-especial-teaser.ts           # escreve os 2 artefatos
 *   npx tsx scripts/build-artigo-especial-teaser.ts --check   # só verifica drift, não escreve
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { isMainModule } from "./lib/cli-args.ts";
import { GATE_CUT_MARKER, splitAtMarker, buildTeaserDocument, rewriteGatedTocAnchors } from "./lib/shared/html-teaser-split.ts";
import { renderGateCta, GATE_CTA_ID } from "./lib/shared/artigo-especial-gate-cta.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKER_DIR = resolve(ROOT, "workers", "artigos");

export interface ArticleConfig {
  slug: string;
  year: string;
}

/** Fonte única da lista de Artigos Especiais gateados — os 2 publicados até
 * #7030. Artigo novo: criar `articles-src/{slug}.html` com o marcador,
 * adicionar aqui, rodar este script. `workers/artigos/src/index.ts` deriva
 * `GATED_ARTICLE_PATHS` desta MESMA lista (importada de lá), nunca duplicada. */
export const ARTICLES: readonly ArticleConfig[] = [
  { slug: "engenharia-de-ilusao", year: "2026" },
  { slug: "o-agente", year: "2026" },
];

export function articleSourcePath(article: ArticleConfig): string {
  return resolve(WORKER_DIR, "articles-src", `${article.slug}.html`);
}

export function publicHtmlPath(article: ArticleConfig): string {
  return resolve(WORKER_DIR, "public", article.year, article.slug, "index.html");
}

export function generatedTsPath(article: ArticleConfig): string {
  return resolve(WORKER_DIR, "src", `${article.slug}-full.generated.ts`);
}

export function exportConstName(slug: string): string {
  // "engenharia-de-ilusao" → "ENGENHARIA_DE_ILUSAO_FULL_HTML"
  return `${slug.toUpperCase().replace(/-/g, "_")}_FULL_HTML`;
}

/** Pure: {full, teaser} a partir do HTML fonte (com marcador). Exportada pra
 * teste sem tocar disco. Lança se o marcador não existir — nunca produz um
 * teaser "por acidente completo" nem um full "por acidente cortado". */
export function buildArticleArtifacts(
  sourceHtml: string,
  article: ArticleConfig,
): { full: string; teaser: string } {
  const split = splitAtMarker(sourceHtml, GATE_CUT_MARKER);
  if (!split) {
    throw new Error(`${article.slug}: marcador ${GATE_CUT_MARKER} não encontrado em articles-src/${article.slug}.html`);
  }
  const full = `${split.before}${split.after}`;
  const before = rewriteGatedTocAnchors(split.before, GATE_CTA_ID);
  const teaser = buildTeaserDocument(before, renderGateCta(article.slug), full);
  return { full, teaser };
}

export function renderGeneratedTsModule(article: ArticleConfig, fullHtml: string): string {
  const constName = exportConstName(article.slug);
  return `/**
 * ${article.slug}-full.generated.ts — GERADO por \`scripts/build-artigo-especial-teaser.ts\`.
 * NÃO EDITAR À MÃO — edite
 * \`workers/artigos/articles-src/${article.slug}.html\` e rode o build
 * script de novo. Mesmo padrão de
 * \`workers/cursos/src/courses-full.generated.ts\` (#4052).
 */
export const ${constName} = ${JSON.stringify(fullHtml)};
`;
}

export interface DriftEntry {
  slug: string;
  reason: string;
}

export function checkDrift(): DriftEntry[] {
  const drift: DriftEntry[] = [];
  for (const article of ARTICLES) {
    const srcPath = articleSourcePath(article);
    if (!existsSync(srcPath)) {
      drift.push({ slug: article.slug, reason: `${srcPath} ausente` });
      continue;
    }
    const source = readFileSync(srcPath, "utf8");
    let artifacts: { full: string; teaser: string };
    try {
      artifacts = buildArticleArtifacts(source, article);
    } catch (e) {
      drift.push({ slug: article.slug, reason: e instanceof Error ? e.message : String(e) });
      continue;
    }

    const genPath = generatedTsPath(article);
    const expectedGenerated = renderGeneratedTsModule(article, artifacts.full);
    const actualGenerated = existsSync(genPath) ? readFileSync(genPath, "utf8") : null;
    if (actualGenerated !== expectedGenerated) {
      drift.push({ slug: article.slug, reason: `${genPath} não reflete a fonte atual — rode o build script.` });
    }

    const pubPath = publicHtmlPath(article);
    const actualTeaser = existsSync(pubPath) ? readFileSync(pubPath, "utf8") : null;
    if (actualTeaser !== artifacts.teaser) {
      drift.push({ slug: article.slug, reason: `${pubPath} não reflete a fonte atual — rode o build script.` });
    }
  }
  return drift;
}

function main(): void {
  const checkOnly = process.argv.includes("--check");

  if (checkOnly) {
    const drift = checkDrift();
    if (drift.length > 0) {
      process.stderr.write("[build-artigo-especial-teaser] DRIFT detectado:\n");
      for (const d of drift) process.stderr.write(`  - ${d.slug}: ${d.reason}\n`);
      process.exit(1);
    }
    process.stdout.write("[build-artigo-especial-teaser] sem drift.\n");
    return;
  }

  for (const article of ARTICLES) {
    const srcPath = articleSourcePath(article);
    if (!existsSync(srcPath)) {
      process.stderr.write(`[build-artigo-especial-teaser] ${srcPath} ausente — pulando.\n`);
      continue;
    }
    const source = readFileSync(srcPath, "utf8");
    const artifacts = buildArticleArtifacts(source, article);
    writeFileSync(generatedTsPath(article), renderGeneratedTsModule(article, artifacts.full), "utf8");
    writeFileSync(publicHtmlPath(article), artifacts.teaser, "utf8");
    process.stderr.write(`[build-artigo-especial-teaser] ${article.slug}: teaser + full.generated.ts escritos.\n`);
  }
}

if (isMainModule(import.meta.url)) main();
