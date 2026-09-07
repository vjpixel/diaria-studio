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
 * ## A armadilha: `gen-archive-pages.ts` APAGA página que não conhece
 *
 * `gen-archive-pages.ts` faz `rmSync(outDir)` no `public/p/` inteiro e depois
 * reescreve só o que está na fonte dele — o cache Beehiiv (o caminho Kit é
 * gated por `read_backend`, ainda `"beehiiv"`). Desde 04/09/2026
 * (`publishing.newsletter.backend = "kit"`, #7388) as edições novas não
 * passam mais pela Beehiiv.
 *
 * Ou seja: rodá-lo **apagaria do DISCO** as páginas publicadas pelo Kit, não
 * só as tiraria do sitemap. **Este script NÃO recupera isso** — ele só
 * reconcilia o sitemap a partir de páginas que existem; recuperar exige
 * re-rodar `publish-edition-site-page.ts` slug por slug.
 *
 * Por isso o #7578 fechou o buraco na origem: `gen-archive-pages.ts` agora
 * RECUSA rodar (exit 2, `WouldDeleteUnknownPagesError`) quando encontraria
 * página que não reproduziria, e só apaga com `--allow-prune` explícito.
 * Este script continua sendo o passo aditivo que garante o sitemap; os dois
 * resolvem problemas diferentes e nenhum substitui o outro.
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
import { dirname, join } from "node:path";
import { addSitemapEntry, archiveUrlForSlug } from "./lib/site-archive-pages.ts";
import { ARCHIVE_CARD_LIMIT, buildHomeFeed, buildIndexHtml } from "./lib/site-home-page.ts";
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
    // A home DERIVA do sitemap — mora no mesmo diretório. Usar um caminho fixo
    // aqui fazia `--sitemap /tmp/x.xml` regenerar mesmo assim
    // `workers/site/public/index.html`, ou seja: apontar o script pra outro
    // lugar sobrescrevia a home de PRODUÇÃO. Foi o que os testes desta PR
    // fizeram (a home passou a listar os slugs de fixture "a" e "b"), e o guard
    // do #6375 pegou. Um `--home` explícito continua vencendo.
    homePath: get("--home", join(dirname(get("--sitemap", DEFAULT_SITEMAP)), "index.html")),
  };
}

export function main(argv = process.argv.slice(2)): number {
  const { check, pagesDir, sitemapPath, homePath } = parseArgs(argv);

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

  // `addSitemapEntry` insere via `.replace("</urlset>", …)`, que num XML sem
  // essa tag devolve a string intacta — no-op SILENCIOSO. Checar antes para
  // que a causa apareça nomeada, em vez de virar "0 entradas" inexplicável.
  if (!xml.includes("</urlset>")) {
    console.error(
      `[reconcile-site-sitemap] ${sitemapPath} não tem a tag de fechamento </urlset> — ` +
        `nenhuma entrada pode ser inserida. Corrigir o arquivo antes de reconciliar.`,
    );
    return 1;
  }

  const { map: dates, corrupt } = buildSlugDateMap();
  // "sem data" tem duas causas opostas (data/ ausente vs. cache ilegível) e
  // colapsá-las esconderia corrupção sistêmica — por isso reporta separado.
  for (const c of corrupt) console.warn(`[reconcile-site-sitemap] cache ilegível, ignorado: ${c}`);

  let next = xml;
  let semData = 0;
  for (const slug of orphans) {
    const lastmod = dates.get(slug);
    if (!lastmod) semData += 1;
    next = addSitemapEntry(next, { loc: archiveUrlForSlug(slug), lastmod });
  }
  writeFileSync(sitemapPath, next, "utf8");

  // VERIFICA O PRÓPRIO CONSERTO antes de reportar sucesso. Contar chamadas a
  // `addSitemapEntry` não prova que houve inserção; sem esta releitura, um
  // no-op devolveria exit 0 com "N entradas acrescentadas" e mandaria o editor
  // de volta ao gate achando que resolveu — que é exatamente a classe de falha
  // silenciosa que este script existe para acabar, reintroduzida no corretor.
  const restantes = findOrphanSlugs(pageSlugs, readFileSync(sitemapPath, "utf8"));
  if (restantes.length > 0) {
    console.error(
      `[reconcile-site-sitemap] a escrita não resolveu ${restantes.length} órfã(s): ` +
        `${restantes.join(", ")}. O sitemap foi gravado, mas segue incompleto — NÃO tratar como corrigido.`,
    );
    return 1;
  }

  // A home (`index.html`) é DERIVADA do sitemap + das páginas
  // (`buildHomeFeed`), então acrescentar entrada sem regenerá-la deixa
  // `diar.ia.br/` mostrando uma edição antiga — o mesmo tipo de defasagem
  // que este script existe para acabar, uma superfície acima. É a mesma
  // regeneração que `publish-edition-site-page.ts --sitemap` já faz por
  // edição; aqui ela fecha o caso do backfill em lote. Idempotente e barata:
  // só lê arquivos que já estão em disco.
  const readPageHtml = (slug: string): string | null => {
    const f = join(pagesDir, slug, "index.html");
    return existsSync(f) ? readFileSync(f, "utf8") : null;
  };
  const feed = buildHomeFeed(readFileSync(sitemapPath, "utf8"), readPageHtml, ARCHIVE_CARD_LIMIT + 1);
  writeFileSync(homePath, buildIndexHtml({ feature: feed[0] ?? null, archive: feed.slice(1) }), "utf8");

  console.log(
    `[reconcile-site-sitemap] ${orphans.length} entrada(s) acrescentada(s), 0 órfãs restantes; home regenerada` +
      (semData > 0 ? ` (${semData} sem <lastmod> — nenhuma fonte de data disponível)` : "") +
      (corrupt.length > 0 ? ` (${corrupt.length} arquivo(s) de cache ilegível)` : ""),
  );
  return 0;
}

if (process.argv[1]?.endsWith("reconcile-site-sitemap.ts")) {
  process.exit(main());
}
