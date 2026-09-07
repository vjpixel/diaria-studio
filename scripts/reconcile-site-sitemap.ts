/**
 * scripts/reconcile-site-sitemap.ts (#7578)
 *
 * Garante que toda página em `workers/site/public/p/` tenha entrada em
 * `workers/site/public/sitemap.xml`. Miolo puro (e o porquê do invariante)
 * em `scripts/lib/site-sitemap-orphans.ts`; aqui só a CLI.
 *
 * ## Por que este script existe, se já havia dois caminhos que mexem no sitemap
 *
 * Os dois cobrem casos disjuntos e nenhum cobre o buraco entre eles:
 *
 *   1. `gen-archive-pages.ts` — regenera o acervo INTEIRO a partir do cache
 *      Beehiiv (`data/beehiiv-cache/posts/`), sitemap junto.
 *   2. `publish-edition-site-page.ts --sitemap` — publica UMA edição nova e
 *      acrescenta só a entrada dela (`addSitemapEntry`, aditivo e idempotente).
 *
 * Página escrita fora desses dois caminhos — ou por um deles numa execução
 * que falhou depois de escrever e antes de commitar — fica órfã, e órfã é
 * invisível no buscador E em `arquivo.diar.ia.br` ao mesmo tempo. Medido em
 * 07/09/2026: 259 páginas locais, 254 no sitemap, **5 órfãs**, a mais antiga
 * de 28/08.
 *
 * ## A armadilha que torna este script obrigatório, não conveniente
 *
 * `gen-archive-pages.ts` reescreve o sitemap INTEIRO a partir do cache
 * Beehiiv. Desde 04/09/2026 (`publishing.newsletter.backend = "kit"`, #7388)
 * as edições novas não passam mais pela Beehiiv, e o caminho Kit daquele
 * script é gated por `read_backend === "kit"` — ainda `"beehiiv"`, então
 * devolve `[]`.
 *
 * Ou seja: **rodar `gen-archive-pages.ts` hoje REMOVE do sitemap as edições
 * publicadas via Kit.** Este script é aditivo e roda DEPOIS, restaurando o
 * que a regeneração não conhece. Enquanto os dois backends divergirem, a
 * ordem `gen-archive-pages` → `reconcile-site-sitemap` é obrigatória.
 *
 * ## Modos
 *
 *   --check   não escreve; sai 2 se houver órfã. É o modo do alarme e do CI.
 *   (padrão)  acrescenta as entradas faltantes e reescreve o sitemap.
 *
 * `--check` compara só CONJUNTOS (página existe ⇒ `<loc>` existe), então não
 * depende de `data/` nem do cache Beehiiv — roda em clone fresco e em CI.
 * O modo de escrita usa `data/` apenas para o `<lastmod>`, e degrada para
 * "entrada sem data" quando ele não está disponível.
 *
 * Uso:
 *   npx tsx scripts/reconcile-site-sitemap.ts
 *   npx tsx scripts/reconcile-site-sitemap.ts --check
 *   npx tsx scripts/reconcile-site-sitemap.ts --pages-dir ... --sitemap ...
 *
 * Exit codes:
 *   0 — sitemap já cobria tudo, ou passou a cobrir (modo escrita)
 *   1 — uso inválido, ou artefato ausente
 *   2 — `--check`: há página órfã (nomeadas na saída)
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { addSitemapEntry, archiveUrlForSlug } from "./lib/site-archive-pages.ts";
import {
  DEFAULT_PAGES_DIR,
  DEFAULT_SITEMAP,
  buildSlugDateMap,
  findOrphanSlugs,
  listPageSlugs,
  slugsInSitemap,
} from "./lib/site-sitemap-orphans.ts";

function parseArgs(argv: string[]) {
  const get = (flag: string, fallback: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
  };
  return {
    check: argv.includes("--check"),
    pagesDir: get("--pages-dir", DEFAULT_PAGES_DIR),
    sitemapPath: get("--sitemap", DEFAULT_SITEMAP),
  };
}

export function main(argv = process.argv.slice(2)): number {
  const { check, pagesDir, sitemapPath } = parseArgs(argv);

  if (!existsSync(sitemapPath)) {
    console.error(`[reconcile-site-sitemap] sitemap ausente: ${sitemapPath}`);
    return 1;
  }
  const pageSlugs = listPageSlugs(pagesDir);
  if (pageSlugs.length === 0) {
    console.error(`[reconcile-site-sitemap] nenhuma página em ${pagesDir} — nada a reconciliar`);
    return 1;
  }

  const xml = readFileSync(sitemapPath, "utf8");
  const orphans = findOrphanSlugs(pageSlugs, xml);

  console.log(
    `[reconcile-site-sitemap] páginas=${pageSlugs.length} no sitemap=${slugsInSitemap(xml).size} órfãs=${orphans.length}`,
  );
  if (orphans.length === 0) return 0;
  for (const slug of orphans) console.log(`  órfã: ${slug}`);

  if (check) {
    console.error(
      `[reconcile-site-sitemap] ${orphans.length} página(s) fora do sitemap — invisíveis para buscador ` +
        `E para arquivo.diar.ia.br. Corrigir: 'npx tsx scripts/reconcile-site-sitemap.ts'.`,
    );
    return 2;
  }

  const dates = buildSlugDateMap();
  let next = xml;
  let semData = 0;
  for (const slug of orphans) {
    const lastmod = dates.get(slug);
    if (!lastmod) semData += 1;
    next = addSitemapEntry(next, { loc: archiveUrlForSlug(slug), lastmod });
  }
  writeFileSync(sitemapPath, next, "utf8");
  console.log(
    `[reconcile-site-sitemap] ${orphans.length} entrada(s) acrescentada(s)` +
      (semData > 0 ? ` (${semData} sem <lastmod> — nenhuma fonte de data disponível)` : ""),
  );
  return 0;
}

if (process.argv[1]?.endsWith("reconcile-site-sitemap.ts")) {
  process.exit(main());
}
