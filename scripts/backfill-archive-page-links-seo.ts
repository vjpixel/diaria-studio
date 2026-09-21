#!/usr/bin/env node
/**
 * scripts/backfill-archive-page-links-seo.ts (#8352, #8353 item 1, #8354, #8359)
 *
 * Backfill ÚNICO sobre as páginas do acervo já escritas em
 * `workers/site/public/p/{slug}/index.html` — nunca chama nenhuma API, nunca
 * lê `data/` (junction OneDrive, só na máquina do editor): a fonte de
 * título/description/canonical de cada página é o PRÓPRIO HTML já
 * publicado, e a data vem do `<lastmod>` que `sitemap.xml` já carrega pra
 * toda edição.
 *
 * ## Por que este script existe (e não só esperar a próxima regeneração)
 *
 * `gen-archive-pages.ts` REGENERA as 259 páginas de origem Beehiiv toda vez
 * que roda (lê `data/beehiiv-cache/posts/` do zero) — qualquer feature nova
 * em `buildArchivePageHtml` chega nelas automaticamente na próxima rodada.
 * As 11 páginas de origem Kit não: foram publicadas uma a uma por
 * `publish-edition-site-page.ts` (Stage 6) e o gerador em lote só as
 * incluiria numa regeneração completa se `data/kit-cache/broadcasts/`
 * estivesse populado — o que ainda não aconteceu (`kit-sync.ts` existe desde
 * #7570, mas nenhuma rodada real com `KIT_API_KEY` o alimentou até agora,
 * #8359). Sem este backfill, as 11 ficam para sempre na versão de
 * `buildArchivePageHtml` do dia em que cada uma foi publicada.
 *
 * O nav prev/next (#8353 item 1) é diferente: é feature NOVA nesta mesma PR
 * — mesmo as 259 Beehiiv, que SERIAM cobertas pela próxima regeneração
 * completa, não têm nav ainda porque essa regeneração não é disparada por
 * esta PR (ela roda só na máquina do editor, com `data/` montado). Rodar
 * este backfill agora dá linkagem interna ao acervo inteiro sem esperar por
 * isso.
 *
 * ## O que NÃO reprocessa
 *
 * Este script NUNCA roda `buildArchivePageHtml` do zero sobre uma página já
 * publicada — faria dupla injeção de CTA (`editionCtaBlock`, #7576) e de
 * `<head>` (a versão antiga já injetou description/canonical/etc., rodar de
 * novo empilharia uma 2ª cópia). Ele só ADICIONA os blocos que ainda faltam
 * (`scripts/lib/site-archive-page-backfill.ts`, guardado por marcador —
 * idempotente).
 *
 * Uso:
 *   npx tsx scripts/backfill-archive-page-links-seo.ts [--pages-dir workers/site/public/p] [--sitemap workers/site/public/sitemap.xml] [--dry-run]
 *
 * Saída (stdout): contagem de páginas alteradas (SEO / nav / total) sobre o
 * total de páginas listadas no sitemap. Exit 0 sempre que o processo
 * completar — página individual sem `<title>`/description/canonical
 * (nunca visto no corpus real) só é pulada, não aborta o lote (mesma
 * disciplina de degradação por-item de `gen-archive-pages.ts`).
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getStringArg, hasFlag, isMainModule } from "./lib/cli-args.ts";
import { backfillArchivePageOnDisk, extractPageTitle } from "./lib/site-archive-page-backfill.ts";
import type { ArchiveNeighbor } from "./lib/site-archive-pages.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_PAGES_DIR = resolve(ROOT, "workers", "site", "public", "p");
const DEFAULT_SITEMAP_PATH = resolve(ROOT, "workers", "site", "public", "sitemap.xml");

export interface SitemapPageEntry {
  slug: string;
  lastmod?: string;
}

/**
 * Extrai as entradas `/p/{slug}` de um `sitemap.xml` já gerado — na ORDEM em
 * que aparecem (`buildSitemapXml`/`sitemapEntriesForPosts` já escrevem em
 * ordem cronológica descendente, mesma ordem que `selectPublishedPosts`
 * usa), então entradas ADJACENTES nesta lista são vizinhas por data — sem
 * precisar reparsear/reordenar por conta própria. URLs fora de `/p/{slug}`
 * (ex: `https://diar.ia.br/clarice`) são ignoradas, não uma página do
 * acervo.
 */
export function parseSitemapPageEntries(xml: string): SitemapPageEntry[] {
  const entries: SitemapPageEntry[] = [];
  // O `[\s\S]*?` final tolera filhos DEPOIS do `<lastmod>` — hoje o bloco
  // `<news:news>` do #8390. Sem ele a entrada com bloco news simplesmente
  // não casava, e a página correspondente sumia do backfill em SILÊNCIO
  // (nenhum erro: o `continue` do loop trata "não casou" como "não é /p/").
  const urlRe = /<url>\s*<loc>([\s\S]*?)<\/loc>(?:\s*<lastmod>([\s\S]*?)<\/lastmod>)?[\s\S]*?<\/url>/g;
  let m: RegExpExecArray | null;
  while ((m = urlRe.exec(xml))) {
    const loc = m[1].trim();
    const slugMatch = loc.match(/\/p\/([^/?#]+)\/?$/);
    if (!slugMatch) continue;
    entries.push({ slug: decodeURIComponent(slugMatch[1]), lastmod: m[2]?.trim() });
  }
  return entries;
}

/** Unix seconds a meia-noite UTC do `lastmod` (`YYYY-MM-DD`) — mesma
 * convenção de `deriveFallbackPublishedAtIso` (`publish-edition-site-page.ts`)
 * pra data conhecida só por dia, sem hora. `undefined` se ausente/inválido. */
export function lastmodToUnixSeconds(lastmod: string | undefined): number | undefined {
  if (!lastmod) return undefined;
  const ms = Date.parse(`${lastmod}T00:00:00Z`);
  return Number.isNaN(ms) ? undefined : Math.floor(ms / 1000);
}

export interface BackfillRunResult {
  totalInSitemap: number;
  pagesFound: number;
  pagesMissing: string[];
  changed: number;
  seoChanged: number;
  navChanged: number;
  /** #8390 — páginas que ganharam `<meta name="robots">`. */
  robotsChanged: number;
  /** #8390 — páginas cujo JSON-LD ganhou `image`. */
  jsonLdImageChanged: number;
  siteNavChanged: number;
}

/**
 * Roda o backfill sobre todas as páginas listadas em `sitemapXml` que
 * existem em `pagesDir`. Puro em relação ao SISTEMA DE ARQUIVOS além dos 2
 * parâmetros (não lê nada além do que o caller já passou) — só não é 100%
 * puro porque ESCREVE (a menos que `dryRun`); a extração pura de sitemap/
 * título/vizinhos vive nas funções exportadas acima e em
 * `site-archive-page-backfill.ts`, testáveis sem tocar disco.
 *
 * `opts.onlySlug` (#8645): restringe o processamento a UM slug — usado por
 * `publish-edition-site-page.ts` (Stage 6) pra rodar o backfill como parte
 * do próprio publish de página. Rodar o LOTE inteiro a cada edição
 * publicada seria I/O desperdiçado (~270 leituras de arquivo por
 * publicação diária, a esmagadora maioria já convergida pelos marcadores
 * de idempotência) — `onlySlug` lê/escreve só a página alvo, mais as 2
 * vizinhas imediatas na ordem do sitemap (só o `<title>`, pro link de nav).
 * `pagesFound`/`pagesMissing` no resultado refletem só o slug pedido nesse
 * modo. **Sem `onlySlug`, o comportamento é BYTE-A-BYTE o mesmo de antes
 * desta mudança** — mesma ordem de iteração, mesmo `pagesMissing`/
 * `titleBySlug` — os testes de lote (#8353/#8359) não podem regredir.
 */
export function runBackfill(
  pagesDir: string,
  sitemapXml: string,
  opts: {
    dryRun?: boolean;
    readPage?: (path: string) => string;
    writePage?: (path: string, html: string) => void;
    onlySlug?: string;
  } = {},
): BackfillRunResult {
  const readPage = opts.readPage ?? ((p: string) => readFileSync(p, "utf8"));
  const writePage = opts.writePage ?? ((p: string, html: string) => writeFileSync(p, html, "utf8"));

  const order = parseSitemapPageEntries(sitemapXml);
  const pagePath = (slug: string) => join(pagesDir, slug, "index.html");

  const onlySlug = opts.onlySlug;
  const targetIndices: number[] =
    onlySlug === undefined
      ? order.map((_, i) => i)
      : order.reduce<number[]>((acc, e, i) => (e.slug === onlySlug ? [...acc, i] : acc), []);

  if (onlySlug !== undefined && targetIndices.length === 0) {
    // Slug pedido não está (ainda) no sitemap — nada a fazer, sem erro
    // (mesma degradação silenciosa que uma corrida com o passo que escreve
    // o sitemap já toleraria).
    return {
      totalInSitemap: order.length,
      pagesFound: 0,
      pagesMissing: [onlySlug],
      changed: 0,
      seoChanged: 0,
      navChanged: 0,
      robotsChanged: 0,
      jsonLdImageChanged: 0,
      siteNavChanged: 0,
    };
  }

  // Slugs cujo TÍTULO é necessário: os alvos + os vizinhos imediatos de
  // cada um (pro link de nav). Modo lote (sem `onlySlug`): isso é
  // EXATAMENTE `order` inteiro, na MESMA ordem — comportamento intocado.
  const titleSlugsInOrder: string[] =
    onlySlug === undefined
      ? order.map((e) => e.slug)
      : (() => {
          const seen = new Set<string>();
          const list: string[] = [];
          for (const i of targetIndices) {
            for (const idx of [i, i - 1, i + 1]) {
              const e = order[idx];
              if (e && !seen.has(e.slug)) {
                seen.add(e.slug);
                list.push(e.slug);
              }
            }
          }
          return list;
        })();

  // Pré-carrega título de cada página que EXISTE — precisa do texto do
  // vizinho pro link (`ArchiveNeighbor.title`), não só do slug.
  const titleBySlug = new Map<string, string>();
  const pagesFoundSlugs = new Set<string>();
  const pagesMissing: string[] = [];
  for (const slug of titleSlugsInOrder) {
    const p = pagePath(slug);
    if (!existsSync(p)) {
      pagesMissing.push(slug);
      continue;
    }
    pagesFoundSlugs.add(slug);
    const title = extractPageTitle(readPage(p));
    if (title) titleBySlug.set(slug, title);
  }

  let changed = 0;
  let seoChanged = 0;
  let navChanged = 0;
  let robotsChanged = 0;
  let jsonLdImageChanged = 0;
  let siteNavChanged = 0;

  for (const i of targetIndices) {
    const { slug, lastmod } = order[i];
    if (!pagesFoundSlugs.has(slug)) continue;
    const p = pagePath(slug);
    const html = readPage(p);

    const prevEntry = order[i + 1]; // mais antiga
    const nextEntry = order[i - 1]; // mais nova
    const prev: ArchiveNeighbor | undefined =
      prevEntry && titleBySlug.has(prevEntry.slug)
        ? { slug: prevEntry.slug, title: titleBySlug.get(prevEntry.slug)! }
        : undefined;
    const next: ArchiveNeighbor | undefined =
      nextEntry && titleBySlug.has(nextEntry.slug)
        ? { slug: nextEntry.slug, title: titleBySlug.get(nextEntry.slug)! }
        : undefined;

    const result = backfillArchivePageOnDisk(html, {
      slug,
      prev,
      next,
      publishDateUnixSeconds: lastmodToUnixSeconds(lastmod),
    });

    if (result.changed) {
      changed++;
      if (result.addedSeo) seoChanged++;
      if (result.addedNav) navChanged++;
      if (result.addedRobots) robotsChanged++;
      if (result.addedJsonLdImage) jsonLdImageChanged++;
      if (result.addedSiteNav) siteNavChanged++;
      if (!opts.dryRun) writePage(p, result.html);
    }
  }

  return {
    totalInSitemap: order.length,
    pagesFound: onlySlug === undefined ? pagesFoundSlugs.size : pagesFoundSlugs.has(onlySlug) ? 1 : 0,
    pagesMissing: onlySlug === undefined ? pagesMissing : pagesMissing.filter((s) => s === onlySlug),
    changed,
    seoChanged,
    navChanged,
    robotsChanged,
    jsonLdImageChanged,
    siteNavChanged,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const pagesDirArg = getStringArg(args, "pages-dir");
  const sitemapArg = getStringArg(args, "sitemap");
  const pagesDir = pagesDirArg ? resolve(ROOT, pagesDirArg) : DEFAULT_PAGES_DIR;
  const sitemapPath = sitemapArg ? resolve(ROOT, sitemapArg) : DEFAULT_SITEMAP_PATH;
  const dryRun = hasFlag(args, "dry-run");

  const sitemapXml = readFileSync(sitemapPath, "utf8");
  const result = runBackfill(pagesDir, sitemapXml, { dryRun });

  console.log(
    `backfill-archive-page-links-seo: ${result.changed}/${result.pagesFound} páginas alteradas ` +
      `(${result.seoChanged} SEO, ${result.navChanged} nav, ${result.robotsChanged} robots, ` +
        `${result.jsonLdImageChanged} JSON-LD image, ${result.siteNavChanged} menu global) de ${result.totalInSitemap} no sitemap` +
      `${dryRun ? " [dry-run]" : ""}`,
  );
  if (result.pagesMissing.length > 0) {
    console.log(
      `  ${result.pagesMissing.length} slug(s) no sitemap sem arquivo em disco (não é erro — ` +
        `sitemap pode citar edição ainda não deployada localmente): ${result.pagesMissing.slice(0, 10).join(", ")}` +
        `${result.pagesMissing.length > 10 ? ", …" : ""}`,
    );
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
