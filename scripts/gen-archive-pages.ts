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
 *   npx tsx scripts/gen-archive-pages.ts [--posts-dir data/beehiiv-cache/posts] [--out workers/site/public/p] [--sitemap workers/site/public/sitemap.xml] [--allow-prune]
 *
 * `--keep-unknown` (#7576): regenera todas as páginas que este gerador conhece
 * e NÃO TOCA nas demais (sem `rmSync` do diretório). É o modo para propagar
 * uma mudança de template ao acervo inteiro enquanto dois backends escrevem no
 * mesmo lugar. Não apaga nada; o sitemap sai só com o que ele conhece, então
 * rodar `reconcile-site-sitemap.ts` depois continua obrigatório.
 *
 * `--allow-prune` (#7578): autoriza APAGAR páginas em disco que este gerador
 * não reproduziria. Sem ele, encontrar qualquer uma é recusa (exit 2) — ver
 * `WouldDeleteUnknownPagesError`. Necessário desde que a diária passou a
 * publicar pelo Kit (#7388), fonte que este gerador não lê.
 *
 * Idempotente — pode ser rerodado a qualquer momento pra refletir um cache
 * atualizado (`beehiiv-sync.ts`); sobrescreve os arquivos existentes.
 *
 * ## #7280 — correção de slug histórico
 *
 * `main()` aplica `applyLegacySlugCorrections` (ver docstring em
 * `lib/site-archive-pages.ts`) a TODO post carregado (Beehiiv + Kit) antes
 * de gerar — os 21 slugs históricos com acento corrompido nascem direto na
 * forma correta, sem passo extra. `workers/site/public/_redirects` tem as
 * 301 old→new correspondentes, pra quem já tinha o link antigo.
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
  applyLegacySlugCorrections,
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

/**
 * Erro de recusa do prune (#7578): há páginas em disco que este gerador NÃO
 * reproduziria, e apagá-las seria perda de dado, não limpeza de órfão.
 */
export class WouldDeleteUnknownPagesError extends Error {
  constructor(readonly slugs: string[]) {
    super(
      `gen-archive-pages recusou regenerar: ${slugs.length} página(s) em disco não estão na fonte deste ` +
        `gerador e seriam APAGADAS — ${slugs.slice(0, 10).join(", ")}${slugs.length > 10 ? ", …" : ""}. ` +
        `Causa provável: foram publicadas por um backend que este gerador não lê. Ele monta o acervo do ` +
        `cache Beehiiv (o caminho Kit é gated por 'read_backend', hoje "beehiiv"), enquanto ` +
        `'publishing.newsletter.backend' é "kit" desde 04/09/2026 (#7388) — toda edição nova nasce fora ` +
        `da fonte dele. Se a remoção for MESMO desejada (despublicação real), rode com --allow-prune.`,
    );
    this.name = "WouldDeleteUnknownPagesError";
  }
}

/**
 * Slugs com página em disco que `published` não reproduziria — os que um
 * `rmSync(outDir)` destruiria sem que nada os reescrevesse depois.
 */
export function findPagesThatWouldBeDeleted(outDir: string, publishedSlugs: Iterable<string>): string[] {
  if (!existsSync(outDir)) return [];
  const keep = new Set(publishedSlugs);
  return readdirSync(outDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(outDir, d.name, "index.html")) && !keep.has(d.name))
    .map((d) => d.name)
    .sort();
}

export function generateArchivePages(
  posts: ArchivePost[],
  outDir: string,
  sitemapPath: string,
  options: { allowPrune?: boolean; keepUnknown?: boolean } = {},
): GenerateResult {
  const published = selectPublishedPosts(posts);
  const skipped: { slug: string; reason: string }[] = [];
  const unresolvedMergeTags: { slug: string; tags: string[] }[] = [];

  // Regenera do zero — evita órfão de um slug que saiu do cache (ex:
  // despublicado) continuar servindo página velha.
  //
  // #7578: mas SÓ depois de confirmar que a regeneração reescreve tudo que
  // está lá. Esse `rmSync` nasceu quando o cache Beehiiv era a única fonte de
  // páginas, e "está no disco mas não no cache" só podia significar
  // despublicado. Isso deixou de valer em 04/09/2026, quando
  // `publishing.newsletter.backend` virou "kit" (#7388) e `read_backend`
  // continuou "beehiiv": edição publicada pelo Kit escreve em `outDir` via
  // `publish-edition-site-page.ts` e NUNCA aparece na fonte deste gerador.
  // Rodá-lo apagaria essas páginas do DISCO — perda silenciosa de conteúdo
  // que nem `reconcile-site-sitemap.ts` recupera (ele só reconcilia o sitemap
  // a partir de páginas existentes; recuperar exige re-rodar
  // `publish-edition-site-page.ts` por slug). Falha fechada, nomeia as
  // páginas, e exige `--allow-prune` para o caso legítimo.
  //
  // `keepUnknown` é a terceira saída, e a certa para uma regeneração em lote
  // com dois backends escrevendo no mesmo diretório: reescreve TODAS as páginas
  // que este gerador conhece e não toca nas demais. Não apaga (ao contrário do
  // prune) e não desiste (ao contrário da recusa) — é o modo para propagar uma
  // mudança de template ao acervo inteiro sem perder o que veio do Kit.
  const wouldDelete = findPagesThatWouldBeDeleted(outDir, published.map((p) => p.slug));
  if (wouldDelete.length > 0 && !options.allowPrune && !options.keepUnknown) {
    throw new WouldDeleteUnknownPagesError(wouldDelete);
  }
  if (existsSync(outDir) && !options.keepUnknown) {
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

  // #7280: corrige os 21 slugs históricos com acento corrompido ANTES de
  // gerar — post.slug já sai certo, então buildArchivePageHtml/
  // archiveUrlForSlug (canonical, diretório de saída) nunca veem o valor
  // quebrado. Ver docstring de LEGACY_SLUG_CORRECTIONS.
  const posts = applyLegacySlugCorrections([...loadPosts(postsDir), ...loadKitArchivePosts()]);
  // #7578: sem `--allow-prune`, o gerador RECUSA rodar quando encontraria
  // páginas em disco que não reproduziria (hoje: toda edição publicada pelo
  // Kit). Antes disso ele as apagava em silêncio. Sai 2 pra distinguir
  // "recusa deliberada, dado intacto" de crash.
  let result: GenerateResult;
  try {
    result = generateArchivePages(posts, outDir, sitemapPath, {
      allowPrune: process.argv.includes("--allow-prune"),
      keepUnknown: process.argv.includes("--keep-unknown"),
    });
  } catch (e) {
    if (e instanceof WouldDeleteUnknownPagesError) {
      console.error(`gen-archive-pages: ${e.message}`);
      process.exit(2);
    }
    throw e;
  }

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
