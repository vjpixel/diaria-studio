/**
 * youtube-title-research.ts (#12552) — miolo puro da pesquisa de títulos do
 * D1 no YouTube.
 *
 * Na edição 261109 o título do D1 foi trocado três vezes no gate da Etapa 4,
 * e a troca decisiva veio de uma busca na YouTube Data API pelos vídeos de
 * maior audiência sobre a mesma história ("admits affair", "suspected Chinese
 * spy"). O D1 é o título do Short e o assunto do e-mail (#12464), então a
 * busca passou a rodar toda edição: no Stage 2, antes do `writer-destaque` do
 * D1, e de novo no gate da Etapa 4 quando o D1 mudou.
 *
 * O resultado é SÓ VOCABULÁRIO, nunca decisão: a amostra é pequena, dominada
 * por veículos grandes e muitas vezes sem vídeo em português. Nada aqui altera
 * título; o writer e o `title-picker` leem o arquivo como insumo, e um termo
 * que a fonte não sustenta continua fora do título (#4000, #9383).
 *
 * Custo: `search.list` gasta 100 unidades da cota diária (10 mil) por query;
 * `videos.list` gasta 1 por lote de 50. Teto de 3 queries por execução.
 *
 * I/O (token, fetch, arquivo) fica no CLI `scripts/youtube-title-research.ts`.
 */

import { parseIsoDuration } from "./youtube-analytics.ts";

export const YOUTUBE_TITLE_RESEARCH_FILE = "_internal/youtube-title-research.json";
export const YOUTUBE_TITLE_RESEARCH_SCHEMA_VERSION = 1;

/** Janela padrão da busca: vídeos dos últimos 4 dias (#12552). */
export const DEFAULT_RESEARCH_DAYS = 4;
/** Quantos vídeos de maior audiência entram no arquivo (a issue pede 15 a 20). */
export const DEFAULT_RESEARCH_MAX_VIDEOS = 20;
/** Teto de queries por execução: 3 × 100 unidades de `search.list`. */
export const MAX_RESEARCH_QUERIES = 3;
/** Quantos títulos de topo entram na contagem de termos do gate. */
export const TOP_TERMS_SAMPLE = 10;

export type ResearchStatus = "ok" | "no_results" | "skipped" | "error";

export interface ResearchD1 {
  title: string;
  url: string;
}

export interface ResearchVideo {
  videoId: string;
  title: string;
  channel: string;
  views: number | null;
  durationSec: number | null;
  /** `defaultAudioLanguage` (ou `defaultLanguage`) do vídeo; `null` se o canal não declara. */
  language: string | null;
  publishedAt: string | null;
  /** Query que trouxe o vídeo (a primeira, se mais de uma trouxe). */
  query: string;
}

export interface TermCount {
  term: string;
  /** Em quantos títulos da amostra de topo o termo aparece. */
  count: number;
}

export interface YouTubeTitleResearch {
  schema_version: number;
  edition: string | null;
  generated_at: string;
  status: ResearchStatus;
  /** Motivo de `skipped`/`error`/`no_results`, legível pelo editor. */
  reason: string | null;
  d1: ResearchD1 | null;
  queries: string[];
  published_after: string | null;
  videos: ResearchVideo[];
  top_terms: TermCount[];
  warnings: string[];
}

// ─── Queries ─────────────────────────────────────────────────────────────────

const STOPWORDS = new Set([
  // PT
  "a", "à", "às", "ao", "aos", "o", "os", "as", "um", "uma", "uns", "umas", "de", "da", "do", "das", "dos",
  "em", "na", "no", "nas", "nos", "num", "numa", "e", "ou", "que", "com", "sem", "por", "para", "pra", "pelo",
  "pela", "pelos", "pelas", "se", "sua", "seu", "suas", "seus", "como", "mais", "menos", "já", "não", "sim",
  "é", "são", "foi", "ser", "ter", "tem", "têm", "isso", "esse", "essa", "este", "esta", "entre", "sobre",
  "após", "até", "contra", "quando", "onde", "porque", "agora", "novo", "nova", "novos", "novas", "diz",
  "vai", "vão", "pode", "podem", "ia", "ai",
  // EN
  "the", "an", "of", "to", "in", "on", "at", "for", "with", "and", "or", "by", "from", "as", "is", "are",
  "was", "were", "be", "it", "its", "this", "that", "these", "those", "into", "over", "after", "before",
  "about", "how", "why", "what", "who", "new", "says", "say", "will", "can", "has", "have", "had", "not",
  "his", "her", "their", "they", "he", "she", "we", "you", "your", "our", "up", "out", "vs", "amid",
  // ruído de título de vídeo
  "video", "vídeo", "news", "live", "shorts", "short", "breaking", "update", "watch",
]);

/** Palavras de título que começam com maiúscula e não são stopword: nomes próprios e siglas. */
export function extractProperNouns(title: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of title.split(/[\s:;,.!?()"“”'‘’|/–—-]+/)) {
    const w = raw.trim();
    if (w.length < 2) continue;
    if (!/^[A-ZÀ-ÖØ-Þ0-9]/.test(w) || /^\d+$/.test(w)) continue;
    if (STOPWORDS.has(w.toLowerCase())) continue;
    const key = w.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(w);
  }
  return out;
}

/** Palavras de conteúdo (minúsculas, sem stopword, ≥4 letras) na ordem em que aparecem. */
export function contentWords(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < 4 || /^\d+$/.test(raw) || STOPWORDS.has(raw) || seen.has(raw)) continue;
    seen.add(raw);
    out.push(raw);
  }
  return out;
}

/** Palavras do último segmento do caminho da URL (o slug, quase sempre em inglês nos veículos de fora). */
export function slugWords(url: string): string[] {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return [];
  }
  const segments = path.split("/").filter((s) => s && !/^\d+$/.test(s));
  const slug = segments[segments.length - 1] ?? "";
  return contentWords(slug.replace(/\.[a-z]{2,5}$/i, "").replace(/[-_]+/g, " "));
}

/**
 * 2 a 3 queries a partir do D1 (#12552): os nomes próprios do título (vale em
 * PT e EN), nomes + termo principal do título (PT) e nomes + termos do slug
 * da URL (EN, quando o slug traz palavra que o título não tem). Sem nome
 * próprio, cai nas 3-4 primeiras palavras de conteúdo do título.
 * `overrides` (do editor) substitui tudo.
 */
export function buildResearchQueries(d1: ResearchD1, overrides: string[] = []): string[] {
  const clean = (q: string) => q.replace(/\s+/g, " ").trim();
  const dedup = (qs: string[]) => {
    const seen = new Set<string>();
    return qs.map(clean).filter((q) => q && !seen.has(q.toLowerCase()) && seen.add(q.toLowerCase()));
  };
  if (overrides.length) return dedup(overrides).slice(0, MAX_RESEARCH_QUERIES);

  const nouns = extractProperNouns(d1.title).slice(0, 3);
  const nounKeys = new Set(nouns.map((n) => n.toLowerCase()));
  const titleTerms = contentWords(d1.title).filter((w) => !nounKeys.has(w));
  const slugTerms = slugWords(d1.url).filter((w) => !nounKeys.has(w) && !titleTerms.includes(w));

  const queries: string[] = [];
  if (nouns.length) {
    queries.push(nouns.join(" "));
    if (titleTerms.length) queries.push([...nouns, ...titleTerms.slice(0, 2)].join(" "));
    if (slugTerms.length) queries.push([...nouns, ...slugTerms.slice(0, 2)].join(" "));
  } else {
    if (titleTerms.length) queries.push(titleTerms.slice(0, 4).join(" "));
    if (slugTerms.length) queries.push(slugTerms.slice(0, 4).join(" "));
  }
  return dedup(queries).slice(0, MAX_RESEARCH_QUERIES);
}

// ─── URLs da API ─────────────────────────────────────────────────────────────

export function publishedAfterIso(now: Date, days: number): string {
  return new Date(now.getTime() - days * 86_400_000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function buildSearchUrl(apiBase: string, query: string, publishedAfter: string, maxResults = 25): string {
  const params = new URLSearchParams({
    part: "snippet",
    type: "video",
    order: "viewCount",
    publishedAfter,
    maxResults: String(maxResults),
    q: query,
  });
  return `${apiBase}/search?${params}`;
}

export function buildVideosUrl(apiBase: string, ids: string[]): string {
  return `${apiBase}/videos?part=snippet,statistics,contentDetails&id=${ids.map(encodeURIComponent).join(",")}`;
}

// ─── Parse ───────────────────────────────────────────────────────────────────

/** IDs de vídeo de uma resposta de `search.list`, na ordem devolvida. */
export function parseSearchIds(body: unknown): string[] {
  const items = (body as { items?: unknown })?.items;
  if (!Array.isArray(items)) return [];
  const out: string[] = [];
  for (const it of items) {
    const id = (it as { id?: { videoId?: unknown } })?.id?.videoId;
    if (typeof id === "string" && id && !out.includes(id)) out.push(id);
  }
  return out;
}

/** Vídeos de uma resposta de `videos.list?part=snippet,statistics,contentDetails`. */
export function parseVideoDetails(body: unknown): Map<string, Omit<ResearchVideo, "query">> {
  const out = new Map<string, Omit<ResearchVideo, "query">>();
  const items = (body as { items?: unknown })?.items;
  if (!Array.isArray(items)) return out;
  for (const it of items) {
    const id = (it as { id?: unknown })?.id;
    if (typeof id !== "string" || !id) continue;
    const sn = ((it as { snippet?: Record<string, unknown> })?.snippet ?? {}) as Record<string, unknown>;
    const st = ((it as { statistics?: Record<string, unknown> })?.statistics ?? {}) as Record<string, unknown>;
    const viewsRaw = st.viewCount;
    const views = typeof viewsRaw === "string" || typeof viewsRaw === "number" ? Number(viewsRaw) : NaN;
    const lang = [sn.defaultAudioLanguage, sn.defaultLanguage].find((v) => typeof v === "string" && v);
    out.set(id, {
      videoId: id,
      title: typeof sn.title === "string" ? sn.title : "",
      channel: typeof sn.channelTitle === "string" ? sn.channelTitle : "",
      views: Number.isFinite(views) ? views : null,
      durationSec: parseIsoDuration((it as { contentDetails?: { duration?: unknown } })?.contentDetails?.duration),
      language: (lang as string | undefined) ?? null,
      publishedAt: typeof sn.publishedAt === "string" ? sn.publishedAt : null,
    });
  }
  return out;
}

/** Ordena por views (desconhecido no fim), remove título vazio e corta em `max`. */
export function rankVideos(videos: ResearchVideo[], max: number = DEFAULT_RESEARCH_MAX_VIDEOS): ResearchVideo[] {
  return videos
    .filter((v) => v.title.trim())
    .sort((a, b) => (b.views ?? -1) - (a.views ?? -1))
    .slice(0, max);
}

/**
 * Termos que mais se repetem nos títulos de topo (#12552: "affair",
 * "suspected"). Conta em quantos títulos distintos o termo aparece; tira
 * `excludeWords` (os nomes próprios do D1: o nome da empresa estaria em todos
 * e não é vocabulário novo) e só devolve termo presente em 2+ títulos. As
 * outras palavras das queries ficam: o termo do slug ("affair") é justamente
 * o gancho que o gate precisa mostrar.
 */
export function topTerms(videos: ResearchVideo[], excludeWords: string[], limit = 8, sample = TOP_TERMS_SAMPLE): TermCount[] {
  const exclude = new Set(excludeWords.flatMap((q) => q.toLowerCase().split(/[^\p{L}\p{N}]+/u)).filter(Boolean));
  const counts = new Map<string, number>();
  for (const v of videos.slice(0, sample)) {
    for (const w of contentWords(v.title)) {
      if (exclude.has(w)) continue;
      counts.set(w, (counts.get(w) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .filter(([, c]) => c >= 2)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([term, count]) => ({ term, count }));
}

/** Motivo legível de uma falha da API (quota, escopo, API desativada), sem ecoar token. */
export function explainResearchApiError(status: number, body: string): string {
  if (status === 403 && /quotaExceeded|dailyLimitExceeded|rateLimitExceeded/i.test(body)) {
    return "cota diária da YouTube Data API esgotada — a pesquisa volta amanhã";
  }
  if (status === 403 && /accessNotConfigured|has not been used|is disabled/i.test(body)) {
    return "YouTube Data API v3 não está ativada no projeto GCP do client OAuth";
  }
  if (status === 403 && /insufficientPermissions|insufficient authentication scopes/i.test(body)) {
    return "token sem o escopo youtube.readonly — rodar scripts/youtube-oauth-setup.ts";
  }
  if (status === 401) return "token do YouTube recusado (401) — rodar scripts/youtube-oauth-setup.ts";
  return `YouTube API respondeu ${status}: ${body.slice(0, 200)}`;
}

// ─── Execução (fetch injetado) ───────────────────────────────────────────────

export type ResearchFetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface RunResearchInput {
  d1: ResearchD1;
  edition: string | null;
  accessToken: string;
  apiBase: string;
  now: Date;
  days?: number;
  maxVideos?: number;
  queryOverrides?: string[];
}

export class ResearchApiError extends Error {}

async function getJson(fetchFn: ResearchFetch, url: string, token: string, what: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchFn(url, { headers: { Authorization: `Bearer ${token}` } });
  } catch (e) {
    throw new ResearchApiError(`sem rede para ${what}: ${(e as Error).message}`);
  }
  const text = await res.text().catch(() => "");
  if (!res.ok) throw new ResearchApiError(`${what}: ${explainResearchApiError(res.status, text)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new ResearchApiError(`${what} devolveu corpo não-JSON (HTTP ${res.status})`);
  }
}

export function emptyResearch(
  status: ResearchStatus,
  reason: string | null,
  opts: { edition: string | null; d1: ResearchD1 | null; now: Date; queries?: string[]; warnings?: string[] },
): YouTubeTitleResearch {
  return {
    schema_version: YOUTUBE_TITLE_RESEARCH_SCHEMA_VERSION,
    edition: opts.edition,
    generated_at: opts.now.toISOString(),
    status,
    reason,
    d1: opts.d1,
    queries: opts.queries ?? [],
    published_after: null,
    videos: [],
    top_terms: [],
    warnings: opts.warnings ?? [],
  };
}

/**
 * Roda as queries e monta o resultado. Nunca lança: falha de uma query vira
 * warning (as outras seguem); falha de TODAS, ou de `videos.list`, vira
 * `status: "error"` com o motivo. Sem vídeo nenhum = `no_results`.
 */
export async function runTitleResearch(fetchFn: ResearchFetch, input: RunResearchInput): Promise<YouTubeTitleResearch> {
  const days = input.days ?? DEFAULT_RESEARCH_DAYS;
  const queries = buildResearchQueries(input.d1, input.queryOverrides ?? []);
  const base = { edition: input.edition, d1: input.d1, now: input.now, queries };
  if (!queries.length) return emptyResearch("skipped", "não deu para montar query a partir do título do D1", base);

  const publishedAfter = publishedAfterIso(input.now, days);
  const warnings: string[] = [];
  const firstQuery = new Map<string, string>();
  let failed = 0;
  let lastError = "";
  for (const q of queries) {
    try {
      const ids = parseSearchIds(await getJson(fetchFn, buildSearchUrl(input.apiBase, q, publishedAfter), input.accessToken, "search.list"));
      for (const id of ids) if (!firstQuery.has(id)) firstQuery.set(id, q);
    } catch (e) {
      failed++;
      lastError = (e as Error).message;
      warnings.push(`query "${q}": ${lastError}`);
    }
  }
  if (failed === queries.length) return emptyResearch("error", lastError, { ...base, warnings });

  const ids = [...firstQuery.keys()];
  const videos: ResearchVideo[] = [];
  try {
    for (let i = 0; i < ids.length; i += 50) {
      const batch = ids.slice(i, i + 50);
      const details = parseVideoDetails(await getJson(fetchFn, buildVideosUrl(input.apiBase, batch), input.accessToken, "videos.list"));
      for (const id of batch) {
        const d = details.get(id);
        if (d) videos.push({ ...d, query: firstQuery.get(id)! });
      }
    }
  } catch (e) {
    return emptyResearch("error", (e as Error).message, { ...base, warnings });
  }

  const ranked = rankVideos(videos, input.maxVideos ?? DEFAULT_RESEARCH_MAX_VIDEOS);
  if (!ranked.length) {
    return { ...emptyResearch("no_results", `nenhum vídeo dos últimos ${days} dias para as queries`, { ...base, warnings }), published_after: publishedAfter };
  }
  return {
    schema_version: YOUTUBE_TITLE_RESEARCH_SCHEMA_VERSION,
    edition: input.edition,
    generated_at: input.now.toISOString(),
    status: "ok",
    reason: null,
    d1: input.d1,
    queries,
    published_after: publishedAfter,
    videos: ranked,
    top_terms: topTerms(ranked, extractProperNouns(input.d1.title)),
    warnings,
  };
}

// ─── Gate da Etapa 4 ─────────────────────────────────────────────────────────

/** "1,6 mi", "412 mil", "980". */
export function formatViews(n: number | null): string {
  if (n === null) return "? views";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(".", ",").replace(",0", "")} mi views`;
  if (n >= 1_000) return `${Math.round(n / 1_000)} mil views`;
  return `${n} views`;
}

/** O arquivo é do D1 atual? Compara a URL (sem fragmento). */
export function researchMatchesD1(research: YouTubeTitleResearch | null, d1: ResearchD1 | null): boolean {
  if (!research?.d1 || !d1) return false;
  const norm = (u: string) => u.replace(/#.*$/, "").replace(/\/+$/, "");
  return norm(research.d1.url) === norm(d1.url);
}

/**
 * Bloco do gate (#12552): termos que mais se repetem + os 3 títulos de maior
 * audiência + o lembrete de que é vocabulário, não decisão. Indisponível vira
 * uma linha de aviso, nunca bloqueia.
 */
export function formatGateBlock(research: YouTubeTitleResearch | null): string {
  if (!research) return "⚠️ Pesquisa de títulos no YouTube indisponível (arquivo ausente)";
  if (research.status === "skipped" || research.status === "error") {
    return `⚠️ Pesquisa de títulos no YouTube indisponível (${research.reason ?? research.status})`;
  }
  if (research.status === "no_results") {
    return `ℹ️ YouTube: nenhum vídeo recente sobre o D1 (queries: ${research.queries.map((q) => `"${q}"`).join(", ")})`;
  }
  const lines: string[] = [];
  const pt = research.videos.filter((v) => /^pt/i.test(v.language ?? "")).length;
  lines.push(
    `YouTube, vídeos dos últimos dias sobre o D1: ${research.videos.length} títulos (${pt} em português). Queries: ${research.queries.map((q) => `"${q}"`).join(", ")}`,
  );
  lines.push(
    research.top_terms.length
      ? `  Termos que mais se repetem no topo: ${research.top_terms.map((t) => `${t.term} (${t.count})`).join(", ")}`
      : "  Nenhum termo se repete nos títulos de topo.",
  );
  for (const v of research.videos.slice(0, 3)) {
    lines.push(`  • "${v.title}" (${v.channel}, ${formatViews(v.views)})`);
  }
  lines.push("  Só vocabulário: termo que a fonte do D1 não sustenta não entra no título (#4000, #9383).");
  return lines.join("\n");
}
