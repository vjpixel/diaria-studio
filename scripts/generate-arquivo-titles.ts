/**
 * generate-arquivo-titles.ts (#4265 item 1)
 *
 * Gera `workers/arquivo/src/titles-cache.json` — um mapa `slug → {title,
 * publishDate}` construído a partir de `data/beehiiv-cache/posts/*.json`
 * (populado por `scripts/beehiiv-sync.ts`). Resolve o problema descrito em
 * #4265: `displayTextFromLoc` (`workers/arquivo/src/render-archive.ts`)
 * deriva o título só do slug da URL, e o Beehiiv remove acentos deixando o
 * caractere vazio — produzindo palavras quebradas ("Anthropic lan a o claude
 * opus 5" em vez de "Anthropic lança o Claude Opus 5").
 *
 * **Match por SLUG, nunca por URL completa** (decisão do #4265): o `web_url`
 * do cache aponta pro domínio antigo (`diaria.beehiiv.com/p/...`), o sitemap
 * público aponta pro domínio de marca (`diar.ia.br/p/...`) — só o último
 * segmento do path (o slug) é idêntico nos dois lados.
 *
 * O JSON gerado é COMMITADO dentro de `workers/arquivo/` — o Worker
 * (`render-archive.ts`) importa estaticamente em build-time (bundlado pelo
 * esbuild do Wrangler), nunca faz fetch de `data/` em runtime (o Worker
 * roda no edge, sem acesso a `data/`). Um slug ausente do cache cai no
 * fallback `displayTextFromLoc` já existente — nunca quebra o `<a href>`.
 *
 * **Execução:** precisa do junction `data/` (OneDrive) populado por
 * `beehiiv-sync.ts` — não roda em sessão cloud sem esse acesso (ver
 * `scripts/lib/exec-mode.ts`). Rodar numa sessão local após qualquer sync
 * novo de posts e commitar o JSON resultante.
 *
 * Uso:
 *   npx tsx scripts/generate-arquivo-titles.ts
 *   npx tsx scripts/generate-arquivo-titles.ts --out workers/arquivo/src/titles-cache.json
 *   npx tsx scripts/generate-arquivo-titles.ts --check   # só reporta, não escreve
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { writeFileAtomic } from "./lib/atomic-write.ts";
import { isMainModule } from "./lib/cli-args.ts";
import { resolvePublishDate, unixSecondsToBrtDate } from "./lib/beehiiv-publish-date.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const POSTS_DIR = resolve(ROOT, "data/beehiiv-cache/posts");
const DEFAULT_OUT = resolve(ROOT, "workers/arquivo/src/titles-cache.json");

/** Shape mínimo lido de cada `data/beehiiv-cache/posts/{id}.json` — passthrough
 * (a API/cache carrega bem mais campos; só os usados aqui). `subtitle` não é
 * usado por este arquivo (só por `generate-hub-sources.ts`, #4558 Parte A —
 * D2/D3 da edição, separados por " | "), mas vive na mesma interface
 * compartilhada em vez de duplicada, já que os dois scripts leem o mesmo
 * `data/beehiiv-cache/posts/*.json`. */
export interface RawCachedPost {
  slug?: string;
  title?: string;
  subtitle?: string;
  subject?: string;
  web_url?: string;
  publish_date?: number | null;
  status?: string;
}

export interface ArquivoTitleEntry {
  title: string;
  /** `YYYY-MM-DD` — via `resolvePublishDate` (`lib/beehiiv-publish-date.ts`,
   * #4796): override por slug primeiro, senão `publish_date` (Unix seconds)
   * ajustado pra BRT (UTC-3), mesmo padrão de `monthly-relink-to-diaria.ts`
   * — pra não cruzar o dia errado perto da meia-noite UTC. */
  publishDate: string;
}

export type TitlesCache = Record<string, ArquivoTitleEntry>;

/** Extrai o último segmento não-vazio do path de uma URL — mesma lógica de
 * `slugOf`/`displayTextFromLoc` em `render-archive.ts` (mantida em paralelo,
 * não importada, porque este script roda em Node puro e o Worker é bundle
 * separado — ver nota de fronteira em `workers/arquivo/src/render-archive.ts`). */
function slugFromUrl(url: string): string | null {
  try {
    const path = new URL(url).pathname;
    const parts = path.split("/").filter(Boolean);
    return parts[parts.length - 1] ?? null;
  } catch {
    return null;
  }
}

/** Converte `publish_date` (Unix seconds) num rótulo `YYYY-MM-DD` ajustado
 * pra BRT (UTC-3). Alias de `unixSecondsToBrtDate` (`lib/beehiiv-publish-date.ts`,
 * #4796) mantido aqui pra não quebrar imports/testes existentes deste
 * módulo — a lógica de fato vive só no helper compartilhado. */
export const publishDateLabel = unixSecondsToBrtDate;

/**
 * Pure: constrói o mapa slug → {title, publishDate} a partir dos posts crus
 * do cache. Ignora (com warning no `warnings` retornado, nunca lança) posts
 * sem slug resolvível, sem título (nem `title` nem `subject`) ou sem
 * `publish_date` — todos os 3 campos são necessários pro Worker usar a
 * entrada (item 1 exige título real + data de publicação juntos).
 */
export function buildTitlesCache(
  posts: RawCachedPost[],
): { cache: TitlesCache; warnings: string[] } {
  const cache: TitlesCache = {};
  const warnings: string[] = [];

  for (const post of posts) {
    const slug = post.slug ?? (post.web_url ? slugFromUrl(post.web_url) : null);
    const title = post.title ?? post.subject;

    if (!slug) {
      warnings.push(`post sem slug resolvível (web_url=${post.web_url ?? "ausente"})`);
      continue;
    }
    if (!title) {
      warnings.push(`slug "${slug}" sem title/subject — pulado`);
      continue;
    }

    // #4796: override por slug primeiro, cai no publish_date bruto pra todo o resto.
    const publishDate = resolvePublishDate(slug, post.publish_date);
    if (!publishDate) {
      warnings.push(`slug "${slug}" sem publish_date — pulado`);
      continue;
    }

    cache[slug] = { title, publishDate };
  }

  return { cache, warnings };
}

/** Lê `data/beehiiv-cache/posts/*.json` (exclui `index.json`, que tem outro
 * shape). Lança se o diretório não existir — caller (main) trata com
 * mensagem explícita (sessão cloud sem junction `data/`, ver nota do módulo). */
function loadRawPosts(): RawCachedPost[] {
  if (!existsSync(POSTS_DIR)) {
    throw new Error(
      `diretório não encontrado: ${POSTS_DIR} — precisa do junction data/ (OneDrive) ` +
        `populado por beehiiv-sync.ts. Rodar numa sessão local (ver CLAUDE.md, junction data/).`,
    );
  }
  const files = readdirSync(POSTS_DIR).filter(
    (f) => f.endsWith(".json") && f !== "index.json",
  );
  const posts: RawCachedPost[] = [];
  for (const f of files) {
    try {
      posts.push(JSON.parse(readFileSync(resolve(POSTS_DIR, f), "utf8")));
    } catch (e) {
      process.stderr.write(
        `[generate-arquivo-titles] ⚠ falha ao parsear ${f}: ${e instanceof Error ? e.message : e}\n`,
      );
    }
  }
  return posts;
}

function main(): void {
  const argv = process.argv.slice(2);
  const check = argv.includes("--check");
  const outIdx = argv.indexOf("--out");
  const outPath = outIdx >= 0 ? resolve(argv[outIdx + 1]) : DEFAULT_OUT;

  let posts: RawCachedPost[];
  try {
    posts = loadRawPosts();
  } catch (e) {
    console.error(`[generate-arquivo-titles] ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  }

  const { cache, warnings } = buildTitlesCache(posts);
  for (const w of warnings) process.stderr.write(`[generate-arquivo-titles] ⚠ ${w}\n`);

  const entryCount = Object.keys(cache).length;
  process.stderr.write(
    `[generate-arquivo-titles] ${entryCount}/${posts.length} posts com título+data resolvidos.\n`,
  );

  if (check) {
    process.stderr.write("[generate-arquivo-titles] --check: não escreve.\n");
    return;
  }

  writeFileAtomic(outPath, `${JSON.stringify(cache, null, 2)}\n`);
  console.log(outPath);
}

if (isMainModule(import.meta.url)) {
  main();
}
