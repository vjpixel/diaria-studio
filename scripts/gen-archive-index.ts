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
} from "./lib/site-archive-index.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_SITEMAP_PATH = resolve(ROOT, "workers", "site", "public", "sitemap.xml");
const DEFAULT_PAGES_DIR = resolve(ROOT, "workers", "site", "public", "p");
const DEFAULT_OUT_DIR = resolve(ROOT, "workers", "site", "public");

/**
 * Apaga `archive/{n}/` de páginas que não existem mais (ver "Idempotente"
 * na docstring do módulo). Nunca toca `archive/index.html` nem qualquer
 * diretório cujo nome não seja um inteiro — o que houver de não-numerado
 * dentro de `archive/` não é deste gerador e não é dele pra apagar.
 */
export function pruneStaleIndexPages(archiveDir: string, totalPages: number): string[] {
  if (!existsSync(archiveDir)) return [];
  const removed: string[] = [];
  for (const entry of readdirSync(archiveDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (!/^[0-9]+$/.test(entry.name)) continue;
    const n = Number(entry.name);
    if (n >= 2 && n <= totalPages) continue;
    rmSync(join(archiveDir, entry.name), { recursive: true, force: true });
    removed.push(entry.name);
  }
  return removed;
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
  for (let page = 1; page <= totalPages; page++) {
    const html = buildArchiveIndexHtml({
      entries: archiveIndexPageEntries(entries, page, pageSize),
      page,
      totalPages,
      totalEditions: entries.length,
    });
    const outPath = join(outDir, archiveIndexFilePath(page));
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, html, "utf8");
  }

  const removed = pruneStaleIndexPages(join(outDir, "archive"), totalPages);
  for (const name of removed) console.log(`gen-archive-index: removida página órfã /archive/${name}`);

  if (!flags.has("no-sitemap")) {
    let xml = sitemapXml;
    const added: string[] = [];
    for (let page = 1; page <= totalPages; page++) {
      const loc = archiveIndexUrl(page);
      const before = xml;
      // `addSitemapEntry` já é no-op pra `<loc>` idêntico (#7280) — o
      // diff é o que diz se entrou, sem reimplementar o dedup aqui.
      xml = addSitemapEntry(xml, { loc });
      if (xml !== before) added.push(loc);
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
