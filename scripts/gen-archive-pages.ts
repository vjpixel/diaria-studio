/**
 * gen-archive-pages.ts (#467, 1º item do checklist revisado; #6184 fecha o
 * resíduo da migração Beehiiv → Kit pra este script)
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
 * ## Kit (#6184)
 *
 * `loadPosts` (Beehiiv, abaixo) **não muda** — continua lendo o cache local
 * direto, com fidelidade total dos campos SEO (`meta_default_title`,
 * `meta_default_description`, `preview_text`) que só existem nesse
 * vocabulário. `loadKitArchivePosts` é um caminho ADICIONAL, gated por
 * `publishing.newsletter.read_backend` (`resolveNewsletterBackend`,
 * `newsletter-read-source.ts`) — hoje esse valor é `"beehiiv"` (nenhuma
 * edição real publicada no Kit ainda, ver #6362), então esta função devolve
 * `[]` e o comportamento deste script fica idêntico ao de antes do #6184.
 * Quando `read_backend` virar `"kit"` (depois de haver histórico real
 * `public: true`), broadcasts Kit passam a virar página de acervo também,
 * usando o mesmo `generateArchivePages` de sempre — sem terceiro caminho de
 * leitura, ver `kitUnifiedPostToArchivePost` em `lib/site-archive-pages.ts`.
 *
 * Uso:
 *   npx tsx scripts/gen-archive-pages.ts [--posts-dir data/beehiiv-cache/posts] [--out workers/site/public/p] [--sitemap workers/site/public/sitemap.xml]
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
  kitUnifiedPostToArchivePost,
  UnresolvedMergeTagError,
} from "./lib/site-archive-pages.ts";
import { loadKitCache } from "./lib/shared/edition-cache-reader.ts";
import { resolveNewsletterBackend } from "./lib/shared/newsletter-read-source.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_POSTS_DIR = resolve(ROOT, "data", "beehiiv-cache", "posts");
const DEFAULT_OUT_DIR = resolve(ROOT, "workers", "site", "public", "p");
const DEFAULT_SITEMAP_PATH = resolve(ROOT, "workers", "site", "public", "sitemap.xml");

export function loadPosts(postsDir: string): ArchivePost[] {
  const files = readdirSync(postsDir).filter((f) => f.startsWith("post_") && f.endsWith(".json"));
  const posts: ArchivePost[] = [];
  for (const file of files) {
    const raw = readFileSync(join(postsDir, file), "utf8");
    // Achado do fleet review (#467, silent-failure-hunter): sem o nome do
    // arquivo na mensagem, um post_*.json corrompido (escrita não-atômica
    // do sync) faria quem debugasse bisectar os 258 arquivos à mão. Aborta
    // o lote inteiro (não degrada por-post) — é a mesma escolha que
    // `buildArchivePageHtml` já faz pra HTML ausente/malformado.
    try {
      posts.push(JSON.parse(raw) as ArchivePost);
    } catch (err) {
      throw new Error(`gen-archive-pages: ${file} tem JSON inválido — ${(err as Error).message}`);
    }
  }
  return posts;
}

/**
 * Broadcasts Kit prontos pra virar página de acervo — `[]` a menos que
 * `read_backend` esteja em `"kit"` (ver docstring do módulo, #6184). Filtra
 * `public === true` (mesmo discriminador de `newsletter-read-source.ts`
 * #6362 item 2 — probe/piloto/test-send são sempre `public: false`) e
 * descarta broadcasts sem `slug` resolvível (`kitUnifiedPostToArchivePost`
 * devolve `null` nesse caso — mesmo critério que um post Beehiiv sem slug
 * já teria em `isPublishedPost`).
 */
export function loadKitArchivePosts(opts: { kitBroadcastsDir?: string; configPath?: string } = {}): ArchivePost[] {
  const backend = resolveNewsletterBackend(opts.configPath);
  if (backend !== "kit") return [];
  const unified = loadKitCache(opts.kitBroadcastsDir);
  const posts: ArchivePost[] = [];
  for (const u of unified) {
    if (u.origin !== "kit" || u.public !== true) continue;
    const mapped = kitUnifiedPostToArchivePost(u);
    if (mapped) posts.push(mapped);
  }
  return posts;
}

export interface GenerateResult {
  written: number;
  skipped: { slug: string; reason: string }[];
  /**
   * Subconjunto de `skipped` cuja causa foi merge tag desconhecida (#6256) —
   * separado pra o report final poder listar "quantos, quais posts, quais
   * tags" numa passada, sem re-parsear a string de `reason`.
   */
  unresolvedMergeTags: { slug: string; tags: string[] }[];
}

export function generateArchivePages(
  posts: ArchivePost[],
  outDir: string,
  sitemapPath: string,
): GenerateResult {
  const published = selectPublishedPosts(posts);
  const skipped: { slug: string; reason: string }[] = [];
  const unresolvedMergeTags: { slug: string; tags: string[] }[] = [];

  // Regenera do zero — evita órfão de um slug que saiu do cache (ex:
  // despublicado) continuar servindo página velha.
  if (existsSync(outDir)) {
    rmSync(outDir, { recursive: true, force: true });
  }
  mkdirSync(outDir, { recursive: true });

  // Slug já escrito nesta rodada — detecta colisão em vez de deixar o 2º
  // post sobrescrever o `index.html` do 1º em silêncio (last-write-wins).
  // Achado ao vivo no cache real: um `new-post` duplicado (ver comentário de
  // `isPublishedPost`) — dado sujo neste dataset não é hipotético.
  const writtenSlugs = new Set<string>();
  const writtenPosts: ArchivePost[] = [];
  for (const post of published) {
    if (!post.content?.free?.web) {
      skipped.push({ slug: post.slug, reason: "sem content.free.web" });
      continue;
    }
    if (writtenSlugs.has(post.slug)) {
      skipped.push({ slug: post.slug, reason: "slug duplicado — outro post já escreveu esta página nesta rodada" });
      continue;
    }
    let html: string;
    try {
      html = buildArchivePageHtml(post);
    } catch (err) {
      // Degradação POR POST — só para merge tag desconhecida (#6256). Este é
      // o caso vizinho ao de `loadPosts` acima, mas com o veredito OPOSTO de
      // propósito: lá um JSON corrompido é sinal de sync quebrado (continuar
      // publicaria dado parcial de UM post que nem devia estar ali), então
      // aborta o lote inteiro. Aqui o resto do acervo está íntegro — uma tag
      // nova que a Beehiiv passou a emitir é um problema DAQUELE post, não
      // do lote. Não uniformizar os dois: se um dia alguém tentar, a
      // distinção editorial (dado corrompido vs. dado íntegro mas com um
      // padrão novo) é o motivo, não coincidência de código.
      if (err instanceof UnresolvedMergeTagError) {
        unresolvedMergeTags.push({ slug: post.slug, tags: err.tags });
        skipped.push({
          slug: post.slug,
          reason: `merge tag não resolvida: ${err.tags.join(", ")}`,
        });
        continue;
      }
      // Qualquer OUTRO erro (status inesperado, sem <html> na origem, etc.)
      // segue abortando o lote inteiro — sinal estrutural, não "1 tag nova".
      throw err;
    }
    const pageDir = join(outDir, post.slug);
    mkdirSync(pageDir, { recursive: true });
    writeFileSync(join(pageDir, "index.html"), html, "utf8");
    writtenSlugs.add(post.slug);
    writtenPosts.push(post);
  }
  const written = writtenPosts.length;

  // Sitemap só lista o que de fato ganhou página — nunca um slug pulado
  // (ex: post confirmado sem content.free.web) que daria 404.
  const sitemap = buildSitemapXml(sitemapEntriesForPosts(writtenPosts));
  mkdirSync(dirname(sitemapPath), { recursive: true });
  writeFileSync(sitemapPath, sitemap, "utf8");

  return { written, skipped, unresolvedMergeTags };
}

async function main() {
  const { values } = parseArgs(process.argv.slice(2));
  const postsDir = values["posts-dir"] ? resolve(ROOT, values["posts-dir"]) : DEFAULT_POSTS_DIR;
  const outDir = values["out"] ? resolve(ROOT, values["out"]) : DEFAULT_OUT_DIR;
  const sitemapPath = values["sitemap"] ? resolve(ROOT, values["sitemap"]) : DEFAULT_SITEMAP_PATH;

  const posts = [...loadPosts(postsDir), ...loadKitArchivePosts()];
  const result = generateArchivePages(posts, outDir, sitemapPath);

  console.log(`gen-archive-pages: ${result.written} páginas escritas em ${outDir}`);
  if (result.skipped.length > 0) {
    console.log(`  ${result.skipped.length} posts pulados:`);
    for (const s of result.skipped) console.log(`    - ${s.slug}: ${s.reason}`);
  }
  console.log(`  sitemap: ${sitemapPath}`);

  // Falha no FIM, com o relatório COMPLETO (#6256) — nunca no primeiro post
  // encontrado. Os outros já foram escritos em disco acima; isto só sinaliza
  // (exit code != 0) que o corpus tem tag(s) que o sanitize ainda não cobre,
  // pra quem rodar o script localmente (ver nota em deploy-site.yml — a
  // geração roda fora do CI, o resultado é commitado à mão) decidir se
  // adiciona o sanitize ou aceita o post fora do acervo por enquanto.
  if (result.unresolvedMergeTags.length > 0) {
    const allTags = new Set<string>();
    console.error(
      `gen-archive-pages: ${result.unresolvedMergeTags.length} posts com merge tag desconhecida — pulados, NÃO impediram os outros ${result.written} de serem gerados:`,
    );
    for (const p of result.unresolvedMergeTags) {
      console.error(`    - ${p.slug}: ${p.tags.join(", ")}`);
      for (const t of p.tags) allTags.add(t);
    }
    console.error(`  tags desconhecidas no corpus (${allTags.size}): ${[...allTags].join(", ")}`);
    process.exitCode = 1;
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
