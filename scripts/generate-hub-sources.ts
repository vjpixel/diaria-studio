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
 * **`--backfill-titles` (#4918 Conserto 2) — preenche `editionTitle` sem
 * precisar do junction `data/`.** Modo separado que lê o JSON JÁ commitado
 * e casa `editionSlug` contra `workers/arquivo/src/titles-cache.json`
 * (também commitado) — roda em sessão cloud:
 *
 *   npx tsx scripts/generate-hub-sources.ts --hub anthropic-claude --backfill-titles
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
import {
  loadPublishDateOverrides,
  resolvePublishDate,
  type PublishDateOverridesResult,
} from "./lib/beehiiv-publish-date.ts";
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
  /** Título real da edição (`post.title`, ou fallback via `titles-cache.json`
   * — ver `backfillEditionTitles`). Opcional: hub renderer cai no rótulo
   * antigo (só a manchete casada) quando ausente (#4918 Conserto 2, "o item
   * não diz de qual edição veio"). */
  editionTitle?: string;
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
  // #4558 (develop 260810, 4º hub, leva de empresa). `\bmeta\b` sozinho
  // arrisca casar o substantivo comum ("atinge a meta de", "metas
  // ambiciosas") — verificado ao vivo contra as 242 edições confirmadas do
  // cache real (`data/beehiiv-cache/posts`) no momento em que este pattern
  // foi escrito: nenhum destaque real usa "meta" como substantivo comum
  // isolado (todo destaque que bate começa com "Meta" maiúsculo, nome da
  // empresa) — é uma aposta textual verificada contra o dado de hoje, não
  // uma garantia estrutural; se uma edição futura usar "bateu a meta
  // trimestral" como destaque, ela entraria aqui por engano.
  // `\bllama\b`/`zuckerberg` são defensivos (nenhum destaque real depende
  // deles hoje — ver docstring de `scripts/lib/hubs/meta-ai.ts`).
  "meta-ai": /\bmeta\b|\bllama\b|zuckerberg/i,
};

/** Exportado (#4907) — `scripts/lib/hub-match.ts` reusa esta mesma
 * normalização pra decidir, na hora da escrita da edição, se as manchetes
 * do dia casam `HUB_KEYWORD_PATTERNS` de algum hub existente. Nunca duplicar
 * a lógica de strip de acento num 2º lugar. */
export function stripAccents(s: string): string {
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

/**
 * Pure: varre os posts confirmados e devolve as entradas que casam
 * `pattern`, mais os warnings de qualquer post pulado. Ordenado por data
 * crescente.
 *
 * @param overridesResult   Injetável pra testes (confirma que a função
 *                           propaga um override presente/erro/descarte real
 *                           — #4803); default é `loadPublishDateOverrides()`,
 *                           o arquivo committado.
 */
export function collectHubSources(
  posts: RawCachedPost[],
  pattern: RegExp,
  overridesResult: PublishDateOverridesResult = loadPublishDateOverrides(),
): CollectHubSourcesResult {
  const rows: HubSourceEntry[] = [];
  const warnings: string[] = [];

  // #4803: mesmo racional de generate-arquivo-titles.ts::buildTitlesCache —
  // falha de override não pode ficar só em stderr.
  if (overridesResult.error) {
    warnings.push(
      `beehiiv-publish-date-overrides.json malformado (${overridesResult.error}) — seguindo SEM nenhum override; slugs afetados voltam pro publish_date bruto (comportamento pré-#4796)`,
    );
  }
  for (const w of overridesResult.discarded) warnings.push(`beehiiv-publish-date-overrides.json: ${w}`);

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
    const date = resolvePublishDate(post.slug, post.publish_date, overridesResult.overrides);
    if (!date) {
      warnings.push(`slug "${post.slug}" confirmado e casado, mas sem publish_date — pulado`);
      continue;
    }
    rows.push({
      date,
      editionSlug: post.slug,
      url: `https://diar.ia.br/p/${post.slug}`,
      matchedHeadlines: matched,
      // #4918 Conserto 2, "caminho ideal": `post.title` já está em escopo
      // (usado acima pra montar `destaques`) — guardar aqui em vez de
      // descartar depois de casar o pattern.
      editionTitle: post.title || undefined,
    });
  }
  rows.sort((a, b) => a.date.localeCompare(b.date));
  return { rows, warnings };
}

/** Lê `data/beehiiv-cache/posts/*.json`, isolando falha de parse POR ARQUIVO
 * (mesmo padrão de `loadRawPosts` em `generate-arquivo-titles.ts`) — um JSON
 * truncado/corrompido em um post não pode abortar a geração inteira sem
 * dizer qual arquivo é o culpado. Exportado (#4924) — `scripts/lib/hub-staleness-check.ts`
 * reusa esta mesma leitura pra auditar TODOS os hubs de uma vez, em vez de
 * duplicar a leitura de `POSTS_DIR`. */
export function loadPosts(): RawCachedPost[] {
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

const TITLES_CACHE_PATH = resolve(ROOT, "workers/arquivo/src/titles-cache.json");

export interface TitlesCacheEntry {
  title: string;
  publishDate: string;
}

/** Lê `workers/arquivo/src/titles-cache.json` (COMMITADO, gerado por
 * `generate-arquivo-titles.ts` — que sim exige o junction `data/`). Usado só
 * como FALLBACK por `backfillEditionTitles` — fail-soft: cache ausente ou
 * malformado devolve `{}` (backfill vira no-op, nunca aborta). */
export function loadTitlesCache(path: string = TITLES_CACHE_PATH): Record<string, TitlesCacheEntry> {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, TitlesCacheEntry>;
  } catch (e) {
    process.stderr.write(
      `[generate-hub-sources] ⚠ falha ao parsear ${path}: ${e instanceof Error ? e.message : e} — seguindo sem cache de títulos\n`,
    );
    return {};
  }
}

/**
 * Pure: preenche `editionTitle` das linhas que ainda não têm, casando
 * `editionSlug` contra `titlesCache` (#4918 Conserto 2, "caminho barato" —
 * roda sem o junction `data/`, porque tanto `rows` quanto `titlesCache`
 * já são commitados no repo). Linha que já tem `editionTitle` (caminho
 * ideal já rodou) não é sobrescrita. Linha sem entrada correspondente no
 * cache fica como estava — sem `editionTitle`, o renderer cai no rótulo
 * antigo (fallback, ver `sourceEditionLabel` em `hub-page.ts`).
 */
export function backfillEditionTitles(
  rows: readonly HubSourceEntry[],
  titlesCache: Record<string, TitlesCacheEntry>,
): HubSourceEntry[] {
  return rows.map((row) => (row.editionTitle ? row : { ...row, editionTitle: titlesCache[row.editionSlug]?.title }));
}

function runBackfillTitles(hub: string): void {
  const path = resolve(HUBS_DIR, `${hub}-sources.generated.json`);
  if (!existsSync(path)) {
    console.error(`[generate-hub-sources] ${path} não existe — rode sem --backfill-titles primeiro`);
    process.exit(2);
  }
  const rows = JSON.parse(readFileSync(path, "utf8")) as HubSourceEntry[];
  const titlesCache = loadTitlesCache();
  const filled = backfillEditionTitles(rows, titlesCache);
  const before = rows.filter((r) => r.editionTitle).length;
  const after = filled.filter((r) => r.editionTitle).length;
  writeFileAtomic(path, `${JSON.stringify(filled, null, 2)}\n`);
  process.stderr.write(
    `[generate-hub-sources] ${hub}: editionTitle preenchido em ${after}/${filled.length} (${after - before} novos via titles-cache.json) -> ${path}\n`,
  );
  console.log(path);
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

  // #4918 Conserto 2, "caminho barato": preenche `editionTitle` no JSON já
  // commitado a partir de `titles-cache.json` (também commitado) — NÃO
  // precisa do junction `data/`, roda em sessão cloud. Modo separado do
  // fluxo normal (que precisa de `data/beehiiv-cache/posts`, ver
  // `loadPosts` abaixo) — sai antes de checar `POSTS_DIR`.
  if (argv.includes("--backfill-titles")) {
    runBackfillTitles(hub);
    return;
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
