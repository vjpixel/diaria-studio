/**
 * generate-hub-sources.ts (#4558 Parte A)
 *
 * Gera `scripts/lib/hubs/{slug}-sources.generated.json` — a lista de edições
 * confirmadas da diar.ia.br cujo título ou subtítulo casa a palavra-chave de
 * um hub temático, a partir de `data/beehiiv-cache/posts/*.json` (mesma
 * fonte de `generate-arquivo-titles.ts`). Cada entrada carrega
 * `{date, slug, url, matchedHeadlines}` — `url` já no domínio de marca
 * (`diar.ia.br/p/{slug}`, #4059), `matchedHeadlines` são só os destaques que
 * bateram a palavra-chave (não os 3 da edição inteira).
 *
 * O JSON gerado é COMMITADO — `scripts/lib/hubs/{slug}.ts` importa
 * estaticamente pra computar os números do FAQ (`buildXxxFaq`) e a lista de
 * "edições citadas". Regenerar depois de qualquer `beehiiv-sync.ts` novo:
 *
 *   npx tsx scripts/generate-hub-sources.ts --hub anthropic-claude
 *
 * Acento normalizado (NFD, strip de combining marks) antes do match — o
 * cache Beehiiv tem corrupção de diacrítico conhecida (ver
 * `generate-arquivo-titles.ts`), então casar só a forma acentuada
 * subcontaria.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { writeFileAtomic } from "./lib/atomic-write.ts";
import { isMainModule } from "./lib/cli-args.ts";
import type { RawCachedPost } from "./generate-arquivo-titles.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const POSTS_DIR = resolve(ROOT, "data/beehiiv-cache/posts");
const HUBS_DIR = resolve(ROOT, "scripts/lib/hubs");

export interface HubSourceEntry {
  /** `YYYY-MM-DD`, BRT. */
  date: string;
  slug: string;
  /** Domínio de marca — `https://diar.ia.br/p/{slug}` (#4059). */
  url: string;
  /** Só os destaques (título e/ou trechos do subtítulo) que bateram a palavra-chave. */
  matchedHeadlines: string[];
}

/** Registro de palavra-chave por hub — espelha os padrões usados na proposta
 * de temas (#4558, artefato da sessão 260804). Só `anthropic-claude`
 * implementado por ora (decisão do editor: hubs de empresa e temáticos
 * coexistem, mas só este entra nesta rodada). */
export const HUB_KEYWORD_PATTERNS: Record<string, RegExp> = {
  "anthropic-claude": /anthropic|\bclaude\b|\bopus\b|\bsonnet\b|\bmythos\b|\bfable\b/i,
};

function stripAccents(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

function toDateBrt(unixSeconds: number): string {
  // Mesmo ajuste BRT (UTC-3) de generate-arquivo-titles.ts/monthly-relink-to-diaria.ts.
  const d = new Date((unixSeconds - 3 * 3600) * 1000);
  return d.toISOString().slice(0, 10);
}

/** Pure: varre os posts confirmados e devolve as entradas que casam `pattern`.
 * Ordenado por data crescente. */
export function collectHubSources(
  posts: RawCachedPost[],
  pattern: RegExp,
): HubSourceEntry[] {
  const rows: HubSourceEntry[] = [];
  for (const post of posts) {
    if (post.status !== "confirmed") continue;
    if (!post.slug) continue;
    const destaques = [post.title, ...(post.subtitle ? post.subtitle.split("|").map((s) => s.trim()) : [])].filter(
      (s): s is string => Boolean(s),
    );
    const matched = destaques.filter((d) => pattern.test(stripAccents(d)));
    if (matched.length === 0) continue;
    rows.push({
      date: post.publish_date ? toDateBrt(post.publish_date) : "",
      slug: post.slug,
      url: `https://diar.ia.br/p/${post.slug}`,
      matchedHeadlines: matched,
    });
  }
  rows.sort((a, b) => a.date.localeCompare(b.date));
  return rows;
}

function loadPosts(): RawCachedPost[] {
  if (!existsSync(POSTS_DIR)) {
    throw new Error(
      `${POSTS_DIR} ausente — precisa do junction data/ (OneDrive) populado por beehiiv-sync.ts. Ver CLAUDE.md label "local".`,
    );
  }
  return readdirSync(POSTS_DIR)
    .filter((f) => f.endsWith(".json") && f !== "index.json")
    .map((f) => JSON.parse(readFileSync(resolve(POSTS_DIR, f), "utf8")) as RawCachedPost);
}

function main(): void {
  const argv = process.argv.slice(2);
  const hubIdx = argv.indexOf("--hub");
  const hub = hubIdx >= 0 ? argv[hubIdx + 1] : undefined;
  if (!hub || !(hub in HUB_KEYWORD_PATTERNS)) {
    console.error(
      `[generate-hub-sources] --hub obrigatório, um de: ${Object.keys(HUB_KEYWORD_PATTERNS).join(", ")}`,
    );
    process.exit(2);
  }

  const posts = loadPosts();
  const rows = collectHubSources(posts, HUB_KEYWORD_PATTERNS[hub]);
  const outPath = resolve(HUBS_DIR, `${hub}-sources.generated.json`);
  writeFileAtomic(outPath, `${JSON.stringify(rows, null, 2)}\n`);
  process.stderr.write(`[generate-hub-sources] ${hub}: ${rows.length} edições -> ${outPath}\n`);
  console.log(outPath);
}

if (isMainModule(import.meta.url)) {
  main();
}
