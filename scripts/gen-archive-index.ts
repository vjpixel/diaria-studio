/**
 * gen-archive-index.ts (#8353 item 2)
 *
 * Gera o índice PAGINADO do acervo no apex — `workers/site/public/archive/index.html`
 * (`/archive`) + `archive/{n}/index.html` (`/archive/{n}`) — a partir do que
 * já está commitado: `workers/site/public/sitemap.xml` +
 * `public/p/{slug}/index.html`. Mesma fonte e mesma disciplina de
 * `gen-home-page.ts`; racional completo em `scripts/lib/site-archive-index.ts`.
 *
 * Rodar DEPOIS de `gen-archive-pages.ts`/`publish-edition-site-page.ts`
 * sempre que o acervo mudar — junto do `gen-home-page.ts`, que lê as mesmas
 * duas fontes.
 *
 * Idempotente: reescreve as páginas do índice do zero e APAGA as páginas
 * numeradas que sobraram de um acervo maior (o acervo só cresce, mas um
 * `--page-size` maior reduz a contagem de páginas — sem essa limpeza,
 * `/archive/9` continuaria no ar servindo uma lista órfã, fora da
 * paginação e do sitemap).
 *
 * **Poda e sitemap andam juntos — `--no-sitemap` desliga as DUAS.** A
 * entrada `<loc>` de uma página podada só sai do `sitemap.xml` na mesma
 * execução que a apagou; se a poda rodasse com `--no-sitemap` (o modo do
 * `regen-home.yml` diário), a página sumiria do disco e a `<loc>` dela
 * continuaria declarada ao buscador — URL anunciada respondendo 404, pior
 * que a página órfã que a poda existe pra evitar. Com `--no-sitemap` o
 * script só AVISA quais páginas ficariam órfãs; quem poda é a execução
 * seguinte sem a flag, que limpa as duas pontas de uma vez.
 *
 * Acrescenta as entradas `/archive*` ao `sitemap.xml` quando faltarem
 * (`addSitemapEntry`, aditivo e idempotente — mesmo helper de
 * `publish-edition-site-page.ts --sitemap`). Sem `<lastmod>`: um índice não
 * tem data de publicação própria, e datá-lo com o relógio da geração faria
 * o arquivo mudar a cada execução sem nenhuma mudança de conteúdo.
 *
 * Uso:
 *   npx tsx scripts/gen-archive-index.ts [--sitemap ...] [--pages-dir ...] [--out-dir ...] [--page-size 30] [--no-sitemap]
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import { addSitemapEntry } from "./lib/site-archive-pages.ts";
import {
  ARCHIVE_INDEX_PAGE_SIZE,
  archiveIndexFilePath,
  archiveIndexPageCount,
  archiveIndexPageEntries,
  archiveIndexUrl,
  buildArchiveIndexFeed,
  buildArchiveIndexHtml,
  resolveArchiveIndexCover,
} from "./lib/site-archive-index.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_SITEMAP_PATH = resolve(ROOT, "workers", "site", "public", "sitemap.xml");
const DEFAULT_PAGES_DIR = resolve(ROOT, "workers", "site", "public", "p");
const DEFAULT_OUT_DIR = resolve(ROOT, "workers", "site", "public");

/**
 * Lista (sem apagar) os `archive/{n}/` que não fazem mais parte da
 * paginação atual. Nunca considera `archive/index.html` nem qualquer
 * diretório cujo nome não seja um inteiro — o que houver de não-numerado
 * dentro de `archive/` não é deste gerador e não é dele pra apagar.
 */
export function findStaleIndexPages(archiveDir: string, totalPages: number): string[] {
  if (!existsSync(archiveDir)) return [];
  const stale: string[] = [];
  for (const entry of readdirSync(archiveDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (!/^[0-9]+$/.test(entry.name)) continue;
    const n = Number(entry.name);
    if (n >= 2 && n <= totalPages) continue;
    stale.push(entry.name);
  }
  return stale;
}

/**
 * Apaga `archive/{n}/` de páginas que não existem mais (ver "Idempotente"
 * na docstring do módulo).
 *
 * **Só pode ser chamada quando o sitemap for reescrito na mesma execução**
 * — ver a nota "poda e sitemap andam juntos" na docstring do módulo. A
 * limpeza da `<loc>` correspondente vive em `main`, logo depois; separar
 * as duas é exatamente o que produziria a URL 404 declarada ao buscador.
 */
export function pruneStaleIndexPages(archiveDir: string, totalPages: number): string[] {
  const stale = findStaleIndexPages(archiveDir, totalPages);
  for (const name of stale) rmSync(join(archiveDir, name), { recursive: true, force: true });
  return stale;
}

export function main(argv = process.argv.slice(2)): number {
  const { values, flags } = parseArgs(argv);
  const sitemapPath = values["sitemap"] ? resolve(ROOT, values["sitemap"]) : DEFAULT_SITEMAP_PATH;
  const pagesDir = values["pages-dir"] ? resolve(ROOT, values["pages-dir"]) : DEFAULT_PAGES_DIR;
  const outDir = values["out-dir"] ? resolve(ROOT, values["out-dir"]) : DEFAULT_OUT_DIR;

  // Mesma validação explícita de `--archive-limit` em gen-home-page.ts:
  // `Number("lixo")` é `NaN` e sairia como "1 página com o acervo inteiro"
  // sem nenhum erro.
  const pageSizeRaw = values["page-size"];
  const pageSize = pageSizeRaw !== undefined ? Number(pageSizeRaw) : ARCHIVE_INDEX_PAGE_SIZE;
  if (!Number.isInteger(pageSize) || pageSize < 1) {
    throw new Error(`gen-archive-index: --page-size inválido: "${pageSizeRaw}" (esperado inteiro >= 1)`);
  }

  if (!existsSync(sitemapPath)) {
    console.error(`gen-archive-index: sitemap ausente: ${sitemapPath}`);
    return 1;
  }

  const sitemapXml = readFileSync(sitemapPath, "utf8");
  const readPageHtml = (slug: string): string | null => {
    const path = join(pagesDir, slug, "index.html");
    return existsSync(path) ? readFileSync(path, "utf8") : null;
  };

  const entries = buildArchiveIndexFeed(sitemapXml, readPageHtml);
  if (entries.length === 0) {
    console.error(
      `gen-archive-index: nenhuma edição resolvida a partir de ${sitemapPath} + ${pagesDir} — ` +
        `nada a gerar (índice vazio seria pior que o 404 atual)`,
    );
    return 1;
  }

  const totalPages = archiveIndexPageCount(entries.length, pageSize);
  // Capa de compartilhamento: a mesma nas N páginas (ver
  // `resolveArchiveIndexCover`). `null` → sem og:image, twitter:card=summary.
  const coverImage = resolveArchiveIndexCover(entries, readPageHtml);
  if (!coverImage) {
    console.warn(
      `gen-archive-index: edição mais recente ("${entries[0].slug}") sem <img class="hero"> — ` +
        `índice sai sem og:image/twitter:image (card de compartilhamento só-texto)`,
    );
  }
  for (let page = 1; page <= totalPages; page++) {
    const html = buildArchiveIndexHtml({
      entries: archiveIndexPageEntries(entries, page, pageSize),
      page,
      totalPages,
      totalEditions: entries.length,
      coverImage,
    });
    const outPath = join(outDir, archiveIndexFilePath(page));
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, html, "utf8");
  }

  // Poda e limpeza de sitemap são UMA operação só (ver docstring do módulo):
  // com `--no-sitemap` a poda não acontece, porque apagar a página sem poder
  // tirar a `<loc>` deixaria o buscador com uma URL declarada respondendo
  // 404 — estado pior que a página órfã que a poda existe pra evitar.
  const archiveDir = join(outDir, "archive");
  const skipSitemap = flags.has("no-sitemap");
  let removed: string[] = [];
  if (skipSitemap) {
    const stale = findStaleIndexPages(archiveDir, totalPages);
    if (stale.length > 0) {
      console.warn(
        `gen-archive-index: --no-sitemap — mantendo ${stale.length} página(s) órfã(s) ` +
          `(${stale.map((n) => `/archive/${n}`).join(", ")}): podar sem limpar o sitemap deixaria ` +
          `<loc> apontando pra 404. Rode sem --no-sitemap pra podar e limpar de uma vez.`,
      );
    }
  } else {
    removed = pruneStaleIndexPages(archiveDir, totalPages);
    for (const name of removed) console.log(`gen-archive-index: removida página órfã /archive/${name}`);
  }

  if (!skipSitemap) {
    let xml = sitemapXml;
    const added: string[] = [];
    for (let page = 1; page <= totalPages; page++) {
      const loc = archiveIndexUrl(page);
      // "Entrou?" é medido pela PRESENÇA da `<loc>`, não pelo diff da string
      // inteira. Até o #8390 o diff servia (`addSitemapEntry` era no-op
      // exato pra `<loc>` idêntico, #7280), mas ele passou a PODAR blocos
      // `<news:news>` vencidos de OUTRAS URLs em toda chamada — então o XML
      // muda rotineiramente sem que nada de índice tenha sido acrescentado,
      // e o diff passaria a reportar "+N entrada(s)" com N errado. A `<loc>`
      // de índice (`https://diar.ia.br/archive/{n}`) não tem caractere que
      // `escXml` altere, então a comparação crua é exata.
      const locTag = `<loc>${loc}</loc>`;
      const jaEstava = xml.includes(locTag);
      xml = addSitemapEntry(xml, { loc });
      // Confirma a INSERÇÃO, não a intenção — mesmo princípio do
      // "verifica o próprio conserto" de `reconcile-site-sitemap.ts`.
      if (!jaEstava && xml.includes(locTag)) added.push(loc);
    }
    // Entrada de página que deixou de existir sai do sitemap junto —
    // senão o buscador continuaria batendo num 404 que este mesmo script
    // acabou de criar ao podar a página.
    for (const name of removed) {
      xml = xml.replace(
        new RegExp(`\\s*<url>\\s*<loc>https://diar\\.ia\\.br/archive/${name}</loc>\\s*</url>`, "g"),
        "",
      );
    }
    if (xml !== sitemapXml) {
      writeFileSync(sitemapPath, xml, "utf8");
      console.log(`gen-archive-index: sitemap atualizado (+${added.length} entrada(s) de índice)`);
    }
  }

  console.log(
    `gen-archive-index: ${totalPages} página(s) escrita(s) em ${join(outDir, "archive")} ` +
      `(${entries.length} edições, ${pageSize} por página)`,
  );
  return 0;
}

if (isMainModule(import.meta.url)) {
  process.exit(main());
}
