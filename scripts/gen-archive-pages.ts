/**
 * gen-archive-pages.ts (#467, 1º item do checklist revisado)
 *
 * Lê os posts confirmados de `data/beehiiv-cache/posts/post_*.json` e gera
 * `public/p/{slug}/index.html` + `public/sitemap.xml` dentro de
 * `workers/site/` — static assets pro Worker que vai servir o acervo
 * `/p/{slug}` (258 edições) a partir do apex `diar.ia.br`, mesmo padrão de
 * `workers/artigos` ([assets] sem script). `robots.txt` é escrito à mão
 * (mesmo conteúdo fixo dos outros Workers de curadoria) e não regenerado
 * aqui.
 *
 * Escopo desta unidade: só o acervo EXISTENTE. NÃO cobre o passo de
 * pipeline que publica a página de uma edição NOVA (2º item do checklist,
 * #467), nem `/`, `/subscribe`, `/forms/*` (3º item) — ver PR body.
 *
 * Uso:
 *   npx tsx scripts/gen-archive-pages.ts [--posts-dir data/beehiiv-cache/posts] [--out workers/site/public/p]
 *
 * Idempotente — pode ser rerodado a qualquer momento pra refletir um cache
 * atualizado (`beehiiv-sync.ts`); sobrescreve os arquivos existentes.
 */

import { readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import {
  type ArchivePost,
  selectPublishedPosts,
  buildArchivePageHtml,
  buildSitemapXml,
  sitemapEntriesForPosts,
} from "./lib/site-archive-pages.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_POSTS_DIR = resolve(ROOT, "data", "beehiiv-cache", "posts");
const DEFAULT_OUT_DIR = resolve(ROOT, "workers", "site", "public", "p");
const DEFAULT_SITEMAP_PATH = resolve(ROOT, "workers", "site", "public", "sitemap.xml");

export function loadPosts(postsDir: string): ArchivePost[] {
  const files = readdirSync(postsDir).filter((f) => f.startsWith("post_") && f.endsWith(".json"));
  const posts: ArchivePost[] = [];
  for (const file of files) {
    const raw = readFileSync(join(postsDir, file), "utf8");
    posts.push(JSON.parse(raw) as ArchivePost);
  }
  return posts;
}

export interface GenerateResult {
  written: number;
  skipped: { slug: string; reason: string }[];
}

export function generateArchivePages(
  posts: ArchivePost[],
  outDir: string,
  sitemapPath: string,
): GenerateResult {
  const published = selectPublishedPosts(posts);
  const skipped: { slug: string; reason: string }[] = [];

  // Regenera do zero — evita órfão de um slug que saiu do cache (ex:
  // despublicado) continuar servindo página velha.
  if (existsSync(outDir)) {
    rmSync(outDir, { recursive: true, force: true });
  }
  mkdirSync(outDir, { recursive: true });

  const writtenPosts: ArchivePost[] = [];
  for (const post of published) {
    if (!post.content?.free?.web) {
      skipped.push({ slug: post.slug, reason: "sem content.free.web" });
      continue;
    }
    const html = buildArchivePageHtml(post);
    const pageDir = join(outDir, post.slug);
    mkdirSync(pageDir, { recursive: true });
    writeFileSync(join(pageDir, "index.html"), html, "utf8");
    writtenPosts.push(post);
  }
  const written = writtenPosts.length;

  // Sitemap só lista o que de fato ganhou página — nunca um slug pulado
  // (ex: post confirmado sem content.free.web) que daria 404.
  const sitemap = buildSitemapXml(sitemapEntriesForPosts(writtenPosts));
  mkdirSync(dirname(sitemapPath), { recursive: true });
  writeFileSync(sitemapPath, sitemap, "utf8");

  return { written, skipped };
}

async function main() {
  const { values } = parseArgs(process.argv.slice(2));
  const postsDir = values["posts-dir"] ? resolve(ROOT, values["posts-dir"]) : DEFAULT_POSTS_DIR;
  const outDir = values["out"] ? resolve(ROOT, values["out"]) : DEFAULT_OUT_DIR;
  const sitemapPath = values["sitemap"] ? resolve(ROOT, values["sitemap"]) : DEFAULT_SITEMAP_PATH;

  const posts = loadPosts(postsDir);
  const result = generateArchivePages(posts, outDir, sitemapPath);

  console.log(`gen-archive-pages: ${result.written} páginas escritas em ${outDir}`);
  if (result.skipped.length > 0) {
    console.log(`  ${result.skipped.length} posts pulados:`);
    for (const s of result.skipped) console.log(`    - ${s.slug}: ${s.reason}`);
  }
  console.log(`  sitemap: ${sitemapPath}`);
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
