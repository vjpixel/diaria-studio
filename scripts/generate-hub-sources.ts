/**
 * generate-hub-sources.ts (#4558 Parte A)
 *
 * Gera `scripts/lib/hubs/{slug}-sources.generated.json` — a lista de edições
 * confirmadas da diar.ia.br cujo título ou subtítulo casa a palavra-chave de
 * um hub temático, a partir de `data/beehiiv-cache/posts/*.json` (mesma
 * fonte de `generate-arquivo-titles.ts`). Cada entrada carrega
 * `{date, editionSlug, url, matchedHeadlines}` — `url` já no domínio de
 * marca (`diar.ia.br/p/{editionSlug}`, #4059), `matchedHeadlines` são só os
 * destaques que bateram a palavra-chave (não os 3 da edição inteira).
 *
 * O JSON gerado é COMMITADO — `scripts/lib/hubs/{slug}.ts` importa
 * estaticamente pra computar os números do FAQ (`buildXxxFaq`) e a lista de
 * "edições citadas". Regenerar depois de qualquer `beehiiv-sync.ts` novo:
 *
 *   npx tsx scripts/generate-hub-sources.ts --hub anthropic-claude
 *
 * **Normalização de acento (NFD, strip de combining marks) — defensiva, não
 * corrige um bug já observado neste pattern.** `HUB_KEYWORD_PATTERNS` de
 * hoje (`anthropic-claude`) não tem nenhum caractere acentuado, então
 * `stripAccents()` é um no-op pra ele — o achado ao vivo desta feature
 * (regex acentuado batendo 0 contra texto NFD real do cache) foi em
 * `countMatching()`, `scripts/lib/hubs/anthropic-claude.ts` (normaliza pra
 * NFC, direção OPOSTA — porque lá os patterns TÊM acento: "lanç", "análise
 * psicológica"). `stripAccents()` aqui existe pra um hub FUTURO cujo
 * `HUB_KEYWORD_PATTERNS` venha a ter acento — sem ela, esse hub futuro
 * repetiria o mesmo bug. Não é a mesma corrupção documentada em
 * `generate-arquivo-titles.ts` (aquela é o Beehiiv REMOVENDO acento ao
 * gerar o slug da URL, afetando só o fallback `displayTextFromLoc` — nunca
 * `post.title`/`post.subtitle`, que é o que este arquivo lê); a daqui é o
 * cache armazenando `title`/`subtitle` em NFD (combining mark separado, ex:
 * "ç" = "c" + U+0327) em vez de NFC.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { writeFileAtomic } from "./lib/atomic-write.ts";
import { isMainModule } from "./lib/cli-args.ts";
import { resolvePublishDate } from "./lib/beehiiv-publish-date.ts";
import type { RawCachedPost } from "./generate-arquivo-titles.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const POSTS_DIR = resolve(ROOT, "data/beehiiv-cache/posts");
const HUBS_DIR = resolve(ROOT, "scripts/lib/hubs");

export interface HubSourceEntry {
  /** `YYYY-MM-DD`, BRT — via `resolvePublishDate` (`lib/beehiiv-publish-date.ts`,
   * #4796): override por slug primeiro, senão `publish_date` bruto. */
  date: string;
  /** Slug da EDIÇÃO no Beehiiv — nome deliberadamente distinto de
   * `HubContent.slug` (o slug do HUB, em `hub-page.ts`) pra não confundir
   * os dois na leitura de `scripts/lib/hubs/{slug}.ts` (achado do fleet
   * review). */
  editionSlug: string;
  /** Domínio de marca — `https://diar.ia.br/p/{editionSlug}` (#4059). */
  url: string;
  /** Só os destaques (título e/ou trechos do subtítulo) que bateram a palavra-chave. */
  matchedHeadlines: string[];
}

/** Registro de palavra-chave por hub — espelha os padrões usados na proposta
 * de temas (#4558, artefato da sessão 260804). 3 hubs implementados até
 * aqui: `anthropic-claude` (#4558 original), `openai-chatgpt` e
 * `google-gemini` (mesma issue, rodada seguinte). Adicionar um hub novo é
 * uma entrada aqui + seu `scripts/lib/hubs/{slug}.ts` — este comentário não
 * precisa de update a cada hub adicionado. */
export const HUB_KEYWORD_PATTERNS: Record<string, RegExp> = {
  "anthropic-claude": /anthropic|\bclaude\b|\bopus\b|\bsonnet\b|\bmythos\b|\bfable\b/i,
  "openai-chatgpt": /openai|\bchatgpt\b|\bgpt-?\d|\bsora\b|sam altman/i,
  "google-gemini": /\bgoogle\b|\bgemini\b|deepmind|\bveo\b|\bnano banana\b|sundar pichai/i,
};

function stripAccents(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

export interface CollectHubSourcesResult {
  rows: HubSourceEntry[];
  /** Posts confirmados que bateram a palavra-chave mas foram PULADOS por
   * falta de `slug`/`publish_date` resolvível — mesmo espírito de
   * `buildTitlesCache` (generate-arquivo-titles.ts): nunca descartar dado
   * em silêncio, sempre reportar o motivo. */
  warnings: string[];
}

/** Pure: varre os posts confirmados e devolve as entradas que casam
 * `pattern`, mais os warnings de qualquer post pulado. Ordenado por data
 * crescente. */
export function collectHubSources(
  posts: RawCachedPost[],
  pattern: RegExp,
): CollectHubSourcesResult {
  const rows: HubSourceEntry[] = [];
  const warnings: string[] = [];
  for (const post of posts) {
    if (post.status !== "confirmed") continue;
    const destaques = [post.title, ...(post.subtitle ? post.subtitle.split("|").map((s) => s.trim()) : [])].filter(
      (s): s is string => Boolean(s),
    );
    const matched = destaques.filter((d) => pattern.test(stripAccents(d)));
    if (matched.length === 0) continue;
    // A partir daqui o post BATEU a palavra-chave — pular por dado ausente
    // sempre com warning (achado do fleet review: antes o drop era mudo).
    const where = post.slug ?? post.title ?? "(post sem slug nem title)";
    if (!post.slug) {
      warnings.push(`post confirmado e casado, mas sem slug resolvível: "${where}"`);
      continue;
    }
    // #4796: override por slug primeiro, cai no publish_date bruto pra todo o resto.
    const date = resolvePublishDate(post.slug, post.publish_date);
    if (!date) {
      warnings.push(`slug "${post.slug}" confirmado e casado, mas sem publish_date — pulado`);
      continue;
    }
    rows.push({
      date,
      editionSlug: post.slug,
      url: `https://diar.ia.br/p/${post.slug}`,
      matchedHeadlines: matched,
    });
  }
  rows.sort((a, b) => a.date.localeCompare(b.date));
  return { rows, warnings };
}

/** Lê `data/beehiiv-cache/posts/*.json`, isolando falha de parse POR ARQUIVO
 * (mesmo padrão de `loadRawPosts` em `generate-arquivo-titles.ts`) — um JSON
 * truncado/corrompido em um post não pode abortar a geração inteira sem
 * dizer qual arquivo é o culpado. */
function loadPosts(): RawCachedPost[] {
  if (!existsSync(POSTS_DIR)) {
    throw new Error(
      `${POSTS_DIR} ausente — precisa do junction data/ (OneDrive) populado por beehiiv-sync.ts. Ver CLAUDE.md label "local".`,
    );
  }
  const posts: RawCachedPost[] = [];
  const files = readdirSync(POSTS_DIR).filter((f) => f.endsWith(".json") && f !== "index.json");
  for (const f of files) {
    try {
      posts.push(JSON.parse(readFileSync(resolve(POSTS_DIR, f), "utf8")) as RawCachedPost);
    } catch (e) {
      process.stderr.write(`[generate-hub-sources] ⚠ falha ao parsear ${f}: ${e instanceof Error ? e.message : e}\n`);
    }
  }
  return posts;
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
  const { rows, warnings } = collectHubSources(posts, HUB_KEYWORD_PATTERNS[hub]);
  for (const w of warnings) process.stderr.write(`[generate-hub-sources] ⚠ ${w}\n`);
  const outPath = resolve(HUBS_DIR, `${hub}-sources.generated.json`);
  writeFileAtomic(outPath, `${JSON.stringify(rows, null, 2)}\n`);
  process.stderr.write(`[generate-hub-sources] ${hub}: ${rows.length} edições -> ${outPath}\n`);
  console.log(outPath);
}

if (isMainModule(import.meta.url)) {
  main();
}
