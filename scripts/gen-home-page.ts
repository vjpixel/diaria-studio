/**
 * gen-home-page.ts (#6375)
 *
 * Gera `workers/site/public/index.html` (Direção A · Edição diária, ver
 * `references/design-v1-daily-6375.md` e o corpo da issue #6375) a partir do
 * acervo já commitado: `workers/site/public/sitemap.xml` (ordem
 * mais-recente-primeiro) + `workers/site/public/p/{slug}/index.html`
 * (título/description já resolvidos por `buildArchivePageHtml`) — ver
 * docstring de `scripts/lib/site-home-page.ts` pro porquê desta fonte em vez
 * de reler `data/beehiiv-cache/posts/*.json` diretamente.
 *
 * Rodar DEPOIS de `gen-archive-pages.ts` sempre que o acervo mudar (edição
 * nova publicada, cache resincronizado) — mesma disciplina "commitado à
 * mão" descrita em `workers/site/README.md`.
 *
 * Uso:
 *   npx tsx scripts/gen-home-page.ts [--sitemap workers/site/public/sitemap.xml] [--pages-dir workers/site/public/p] [--out workers/site/public/index.html] [--archive-limit 6]
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import { buildHomeFeed, buildIndexHtml } from "./lib/site-home-page.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_SITEMAP_PATH = resolve(ROOT, "workers", "site", "public", "sitemap.xml");
const DEFAULT_PAGES_DIR = resolve(ROOT, "workers", "site", "public", "p");
const DEFAULT_OUT_PATH = resolve(ROOT, "workers", "site", "public", "index.html");
// 6, não 9 (#7022 item 3) — Beehiiv mostra 6 cards + "Carregar mais"; a
// home estática manda o resto pro acervo completo (arquivo.diar.ia.br) em
// vez de renderizar tudo de uma vez (rationale completo em
// ARCHIVE_CARD_LIMIT, scripts/lib/site-home-page.ts). buildIndexHtml
// também corta em 6 defensivamente, então mudar isto só evita ler/computar
// (word count, capa) páginas que nunca aparecem no HTML final.
const DEFAULT_ARCHIVE_LIMIT = 6;

function main() {
  const { values } = parseArgs(process.argv.slice(2));
  const sitemapPath = values["sitemap"] ? resolve(ROOT, values["sitemap"]) : DEFAULT_SITEMAP_PATH;
  const pagesDir = values["pages-dir"] ? resolve(ROOT, values["pages-dir"]) : DEFAULT_PAGES_DIR;
  const outPath = values["out"] ? resolve(ROOT, values["out"]) : DEFAULT_OUT_PATH;

  // Validação explícita — achado do fleet review desta PR (#6375,
  // silent-failure-hunter): `Number("lixo")` é `NaN`, e `feed.length >= NaN`
  // é sempre `false` dentro de `buildHomeFeed`, então um --archive-limit mal
  // digitado silenciosamente virava "sem limite" (o sitemap inteiro) em vez
  // de um erro claro.
  const archiveLimitRaw = values["archive-limit"];
  const archiveLimit = archiveLimitRaw !== undefined ? Number(archiveLimitRaw) : DEFAULT_ARCHIVE_LIMIT;
  if (!Number.isFinite(archiveLimit) || archiveLimit < 0) {
    throw new Error(`gen-home-page: --archive-limit inválido: "${archiveLimitRaw}" (esperado inteiro >= 0)`);
  }

  const sitemapXml = readFileSync(sitemapPath, "utf8");
  const readPageHtml = (slug: string): string | null => {
    const path = join(pagesDir, slug, "index.html");
    return existsSync(path) ? readFileSync(path, "utf8") : null;
  };

  // +1 pra pegar a feature (feed[0]) e ainda ter `archiveLimit` anteriores
  // depois de retirá-la — mesma soma que `V1Archive` faz em `v1-daily.jsx`
  // (`issues.slice(1)`).
  const feed = buildHomeFeed(sitemapXml, readPageHtml, archiveLimit + 1);
  const feature = feed[0] ?? null;
  const archive = feed.slice(1);

  const html = buildIndexHtml({ feature, archive });
  writeFileSync(outPath, html, "utf8");

  console.log(
    `gen-home-page: ${outPath} escrito (feature=${feature?.slug ?? "nenhuma"}, ${archive.length} edições no arquivo)`,
  );
}

if (isMainModule(import.meta.url)) {
  main();
}
