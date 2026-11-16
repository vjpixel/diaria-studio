/**
 * scripts/lib/diaria/youtube-analytics.ts (#12075, épica #12072)
 *
 * Miolo puro do snapshot diário do YouTube Analytics do @diariabr, usado por
 * `scripts/youtube-analytics-snapshot.ts`. Toda a rede passa por `fetch`
 * injetável, então os testes cobrem o fluxo inteiro com fetch mockado.
 *
 * O que entra no snapshot (YouTube Analytics API v2, `reports.query`,
 * `ids=channel==MINE`):
 *   - por vídeo: views, minutos assistidos, duração média, % médio assistido,
 *     inscritos ganhos e perdidos (acumulado desde `YOUTUBE_ANALYTICS_SERIES_START`);
 *   - por dia: views, minutos e inscritos ganhos/perdidos do canal;
 *   - por dia e fonte (`insightTrafficSourceType`): views;
 *   - curva de retenção por vídeo (`elapsedVideoTimeRatio` × `audienceWatchRatio`);
 *   - termos de busca do YouTube que trouxeram views (`insightTrafficSourceDetail`
 *     com `insightTrafficSourceType==YT_SEARCH`), do canal e por vídeo, nos
 *     últimos 28 dias (#13087). Lista vazia é resultado válido: o YouTube omite
 *     termo abaixo do limiar de privacidade;
 *   - total de inscritos do canal (`channels.list`, Data API) como série;
 *   - impressões e taxa de cliques da capa por vídeo (#13192): a Analytics
 *     API não as expõe; vêm da YouTube Reporting API (`channel_reach_basic_a1`,
 *     `scripts/lib/diaria/youtube-reach.ts`), em `reach-daily.jsonl`, e entram
 *     somadas na linha de `videos.jsonl` (`thumbnailImpressions`, `thumbnailCtr`).
 *
 * Escopo: a Analytics API pede `yt-analytics.readonly`, escopo OPCIONAL do
 * token (`missingOptionalScopes`, `scripts/lib/youtube-oauth.ts`). Token antigo
 * (sem ele) responde 403: o snapshot grava só o total do canal (a Data API
 * com `youtube.readonly` já funciona) e marca `analytics: "missing-scope"`,
 * sem falhar. O editor re-roda `scripts/youtube-oauth-setup.ts` uma vez.
 *
 * Armazenamento em `data/youtube-analytics/`, jsonl append-only. A série
 * diária é re-buscada nos últimos dias a cada execução (o YouTube consolida o
 * dado com 2-3 dias de atraso), então o leitor deduplica por chave e a linha
 * capturada por último vence (`latestByKey`).
 */

import type { FetchLike } from "./youtube-upload.ts";
import type { ReachSummary, VideoReach } from "./youtube-reach.ts";
import { renderPautaSection, type EditionPautas } from "./youtube-pauta.ts";

export const YOUTUBE_ANALYTICS_SCOPE = "https://www.googleapis.com/auth/yt-analytics.readonly";
export const YOUTUBE_ANALYTICS_ENDPOINT = "https://youtubeanalytics.googleapis.com/v2/reports";

/** 1º vídeo do canal na série da épica (#12072): a API devolve o histórico. */
export const YOUTUBE_ANALYTICS_SERIES_START = "2026-10-21";

/** Dias re-buscados a cada execução (o YouTube consolida com atraso). */
export const YOUTUBE_ANALYTICS_REFETCH_DAYS = 7;

/** Teto de vídeos com curva de retenção por execução (1 chamada por vídeo). */
export const YOUTUBE_ANALYTICS_RETENTION_MAX_VIDEOS = 40;

/** Diretório relativo a `data/`. */
export const YOUTUBE_ANALYTICS_DIR = "youtube-analytics";

export const YOUTUBE_ANALYTICS_FILES = {
  channel: "channel.jsonl",
  channelDaily: "channel-daily.jsonl",
  trafficSources: "traffic-sources.jsonl",
  videos: "videos.jsonl",
  retention: "retention.jsonl",
  searchTerms: "search-terms.jsonl",
  /** Linhas dia × vídeo do `channel_reach_basic_a1` (#13192). */
  reachDaily: "reach-daily.jsonl",
  /** Relatórios de alcance já baixados (id, período, `createTime`) (#13192). */
  reachReports: "reach-reports.jsonl",
} as const;

/** Janela dos termos de busca (#13087): os últimos N dias até ontem (BRT). */
export const YOUTUBE_SEARCH_TERMS_WINDOW_DAYS = 28;

/** Teto da API para `insightTrafficSourceDetail` por consulta. */
export const YOUTUBE_SEARCH_TERMS_MAX_RESULTS = 25;

/** Teto de vídeos com consulta de termos por execução (1 chamada por vídeo). */
export const YOUTUBE_SEARCH_TERMS_MAX_VIDEOS = 40;

/** Métricas da consulta de termos de busca. */
export const SEARCH_TERM_METRICS = ["views", "estimatedMinutesWatched"] as const;

export const VIDEO_METRICS = [
  "views",
  "estimatedMinutesWatched",
  "averageViewDuration",
  "averageViewPercentage",
  "subscribersGained",
  "subscribersLost",
] as const;

export const CHANNEL_DAILY_METRICS = ["views", "estimatedMinutesWatched", "subscribersGained", "subscribersLost"] as const;

// ─── Datas ───────────────────────────────────────────────────────────────────

const BRT_OFFSET_MS = -3 * 3600_000;

/** Dia BRT (`YYYY-MM-DD`) de um instante. */
export function brtIsoDate(now: Date): string {
  return new Date(now.getTime() + BRT_OFFSET_MS).toISOString().slice(0, 10);
}

/** Soma `days` a um `YYYY-MM-DD` (UTC, sem fuso). */
export function addDays(iso: string, days: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) throw new Error(`data inválida: ${JSON.stringify(iso)} (esperado YYYY-MM-DD)`);
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + days)).toISOString().slice(0, 10);
}

/** `YYYY-MM-DD` → `AAMMDD`. */
export function isoToAammdd(iso: string): string {
  return iso.slice(2, 4) + iso.slice(5, 7) + iso.slice(8, 10);
}

/**
 * Janela da série diária desta execução: de `max(início da série, último dia
 * gravado − REFETCH_DAYS)` até ontem (BRT). Sem histórico, desde o início da
 * série. `since` explícito vence tudo.
 */
export function resolveDailyWindow(input: {
  now: Date;
  lastStoredDay: string | null;
  since?: string | null;
  seriesStart?: string;
}): { startDate: string; endDate: string } {
  const seriesStart = input.seriesStart ?? YOUTUBE_ANALYTICS_SERIES_START;
  const endDate = addDays(brtIsoDate(input.now), -1);
  let startDate = seriesStart;
  if (input.since) startDate = input.since;
  else if (input.lastStoredDay) {
    const refetch = addDays(input.lastStoredDay, -YOUTUBE_ANALYTICS_REFETCH_DAYS);
    if (refetch > startDate) startDate = refetch;
  }
  if (startDate > endDate) startDate = endDate;
  return { startDate, endDate };
}

/** Janela móvel dos termos de busca: `YOUTUBE_SEARCH_TERMS_WINDOW_DAYS` dias terminando ontem (BRT). */
export function resolveSearchTermsWindow(now: Date, days = YOUTUBE_SEARCH_TERMS_WINDOW_DAYS): { startDate: string; endDate: string } {
  const endDate = addDays(brtIsoDate(now), -1);
  return { startDate: addDays(endDate, -(days - 1)), endDate };
}

/**
 * Consulta de termos de busca do YouTube (`YT_SEARCH`), do canal inteiro ou de
 * um vídeo. A API exige `sort=-views` e `maxResults` ≤ 25 para essa dimensão.
 */
export function searchTermsQuery(window: { startDate: string; endDate: string }, videoId?: string | null): AnalyticsQuery {
  return {
    ...window,
    metrics: SEARCH_TERM_METRICS,
    dimensions: ["insightTrafficSourceDetail"],
    filters: videoId ? `insightTrafficSourceType==YT_SEARCH;video==${videoId}` : "insightTrafficSourceType==YT_SEARCH",
    sort: "-views",
    maxResults: YOUTUBE_SEARCH_TERMS_MAX_RESULTS,
  };
}

// ─── Consulta ────────────────────────────────────────────────────────────────

export interface AnalyticsQuery {
  startDate: string;
  endDate: string;
  metrics: readonly string[];
  dimensions?: readonly string[];
  filters?: string;
  sort?: string;
  maxResults?: number;
}

export function buildAnalyticsQueryUrl(q: AnalyticsQuery): string {
  const params = new URLSearchParams({
    ids: "channel==MINE",
    startDate: q.startDate,
    endDate: q.endDate,
    metrics: q.metrics.join(","),
  });
  if (q.dimensions?.length) params.set("dimensions", q.dimensions.join(","));
  if (q.filters) params.set("filters", q.filters);
  if (q.sort) params.set("sort", q.sort);
  if (q.maxResults) params.set("maxResults", String(q.maxResults));
  return `${YOUTUBE_ANALYTICS_ENDPOINT}?${params}`;
}

export type AnalyticsRow = Record<string, string | number | null>;

/**
 * Converte a `resultTable` (`columnHeaders` + `rows`) em objetos por nome de
 * coluna. Sem `columnHeaders` lança (resposta que não é uma tabela). Sem
 * `rows` é tabela vazia (a API omite o campo quando não há dado).
 */
export function parseResultTable(body: unknown): AnalyticsRow[] {
  const headers = (body as { columnHeaders?: unknown })?.columnHeaders;
  if (!Array.isArray(headers)) throw new Error("resposta da YouTube Analytics API sem columnHeaders");
  const names = headers.map((h) => String((h as { name?: unknown })?.name ?? ""));
  const rows = (body as { rows?: unknown }).rows;
  if (rows === undefined) return [];
  if (!Array.isArray(rows)) throw new Error("resposta da YouTube Analytics API com rows que não é lista");
  return rows.map((r) => {
    const cells = Array.isArray(r) ? r : [];
    const out: AnalyticsRow = {};
    names.forEach((n, i) => {
      const v = cells[i];
      out[n] = typeof v === "number" || typeof v === "string" ? v : null;
    });
    return out;
  });
}

export type AnalyticsFailureKind = "missing-scope" | "api-disabled" | "error";

export class YouTubeAnalyticsError extends Error {
  constructor(
    message: string,
    readonly kind: AnalyticsFailureKind,
    readonly httpStatus: number | null,
  ) {
    super(message);
    this.name = "YouTubeAnalyticsError";
  }
}

/** Classifica a falha da Analytics API pela resposta (sem expor token). */
export function classifyAnalyticsFailure(status: number, body: string): AnalyticsFailureKind {
  if (status === 403 && /accessNotConfigured|has not been used|is disabled|SERVICE_DISABLED/i.test(body)) return "api-disabled";
  if (status === 403 && /insufficient|ACCESS_TOKEN_SCOPE_INSUFFICIENT/i.test(body)) return "missing-scope";
  return "error";
}

export function explainAnalyticsFailure(kind: AnalyticsFailureKind, status: number | null, body = ""): string {
  if (kind === "missing-scope") {
    return "token sem o escopo yt-analytics.readonly: rode `npx tsx scripts/youtube-oauth-setup.ts` uma vez deixando todos os escopos marcados (e `npm run sync-env` no 300); até lá só o total de inscritos do canal entra na série";
  }
  if (kind === "api-disabled") {
    return "YouTube Analytics API não está ativada no projeto GCP do client OAuth: ative em console.cloud.google.com → APIs → YouTube Analytics API e rode de novo";
  }
  return `YouTube Analytics API respondeu ${status ?? "sem status"}: ${body.slice(0, 300)}`;
}

export async function queryAnalytics(fetchFn: FetchLike, token: string, q: AnalyticsQuery): Promise<AnalyticsRow[]> {
  let res: Response;
  try {
    res = await fetchFn(buildAnalyticsQueryUrl(q), { headers: { Authorization: `Bearer ${token}` } });
  } catch (e) {
    throw new YouTubeAnalyticsError(`sem rede para a YouTube Analytics API: ${(e as Error).message}`, "error", null);
  }
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    const kind = classifyAnalyticsFailure(res.status, text);
    throw new YouTubeAnalyticsError(explainAnalyticsFailure(kind, res.status, text), kind, res.status);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new YouTubeAnalyticsError(`YouTube Analytics API devolveu corpo não-JSON (HTTP ${res.status})`, "error", res.status);
  }
  try {
    return parseResultTable(json);
  } catch (e) {
    throw new YouTubeAnalyticsError((e as Error).message, "error", res.status);
  }
}

// ─── Registros ───────────────────────────────────────────────────────────────

export type VideoKind = "short" | "horizontal" | "desconhecido";

export interface ChannelSnapshotLine {
  capturedAt: string;
  /** Dia BRT da captura. */
  date: string;
  subscriberCount: number | null;
  viewCount: number | null;
  videoCount: number | null;
  /** Estado da parte Analytics desta execução. */
  analytics: "ok" | AnalyticsFailureKind;
  analyticsError?: string;
  /**
   * Resumo da coleta de termos de busca desta execução (#13087). Presente só
   * quando a coleta rodou: é o que separa "lista vazia" (limiar de privacidade
   * do YouTube) de "ainda não coletado" no relatório. Ausente em linhas
   * anteriores ao #13087.
   */
  searchTerms?: SearchTermsSummary;
  /**
   * Resumo da coleta de impressões/taxa de cliques da capa (#13192, Reporting
   * API). Ausente em linhas anteriores ao #13192 ou quando a parte Analytics
   * falhou antes dela.
   */
  reach?: ReachSummary;
}

export interface SearchTermsSummary {
  startDate: string;
  endDate: string;
  /** Termos devolvidos pela consulta do canal; `null` se ela falhou. */
  channelTerms: number | null;
  videosQueried: number;
  videoTerms: number;
  failures: number;
}

export interface SearchTermLine {
  capturedAt: string;
  /** Dia BRT da captura. */
  date: string;
  scope: "channel" | "video";
  /** `null` no escopo do canal. */
  videoId: string | null;
  startDate: string;
  endDate: string;
  term: string;
  views: number;
  estimatedMinutesWatched: number;
}

export interface ChannelDailyLine {
  capturedAt: string;
  day: string;
  views: number;
  estimatedMinutesWatched: number;
  subscribersGained: number;
  subscribersLost: number;
}

export interface TrafficSourceLine {
  capturedAt: string;
  day: string;
  source: string;
  views: number;
}

export interface VideoSnapshotLine {
  capturedAt: string;
  date: string;
  videoId: string;
  title: string | null;
  kind: VideoKind;
  edition: string | null;
  startDate: string;
  endDate: string;
  views: number;
  estimatedMinutesWatched: number;
  averageViewDuration: number;
  averageViewPercentage: number;
  subscribersGained: number;
  subscribersLost: number;
  /**
   * Impressões da capa somadas nos relatórios de alcance já baixados (#13192),
   * dias do Pacífico de `YOUTUBE_ANALYTICS_SERIES_START` até `endDate`. `null`:
   * nenhum relatório cobre o vídeo ainda (job recém-criado, ou vídeo sem
   * impressão). Ausente em linhas anteriores ao #13192.
   */
  thumbnailImpressions?: number | null;
  /** Taxa de cliques da capa em fração (0..1), cliques ÷ impressões; `null` como acima. */
  thumbnailCtr?: number | null;
  /** Último dia (Pacífico) coberto pelos relatórios de alcance do vídeo. */
  reachLastDay?: string | null;
}

export interface RetentionLine {
  capturedAt: string;
  date: string;
  videoId: string;
  /** Pares [elapsedVideoTimeRatio, audienceWatchRatio]. */
  points: Array<[number, number]>;
}

const num = (v: string | number | null | undefined): number => (typeof v === "number" ? v : Number(v ?? 0) || 0);

export function toChannelDailyLines(rows: AnalyticsRow[], capturedAt: string): ChannelDailyLine[] {
  return rows
    .filter((r) => typeof r.day === "string")
    .map((r) => ({
      capturedAt,
      day: r.day as string,
      views: num(r.views),
      estimatedMinutesWatched: num(r.estimatedMinutesWatched),
      subscribersGained: num(r.subscribersGained),
      subscribersLost: num(r.subscribersLost),
    }));
}

export function toTrafficSourceLines(rows: AnalyticsRow[], capturedAt: string): TrafficSourceLine[] {
  return rows
    .filter((r) => typeof r.day === "string" && typeof r.insightTrafficSourceType === "string")
    .map((r) => ({ capturedAt, day: r.day as string, source: r.insightTrafficSourceType as string, views: num(r.views) }));
}

/** Linhas de termos de busca; termo vazio/ausente fica de fora. Lista vazia é resultado válido. */
export function toSearchTermLines(input: {
  rows: AnalyticsRow[];
  capturedAt: string;
  date: string;
  startDate: string;
  endDate: string;
  videoId?: string | null;
}): SearchTermLine[] {
  const videoId = input.videoId ?? null;
  return input.rows
    .filter((r) => typeof r.insightTrafficSourceDetail === "string" && r.insightTrafficSourceDetail.trim() !== "")
    .map((r) => ({
      capturedAt: input.capturedAt,
      date: input.date,
      scope: videoId ? ("video" as const) : ("channel" as const),
      videoId,
      startDate: input.startDate,
      endDate: input.endDate,
      term: r.insightTrafficSourceDetail as string,
      views: num(r.views),
      estimatedMinutesWatched: num(r.estimatedMinutesWatched),
    }));
}

export function toRetentionPoints(rows: AnalyticsRow[]): Array<[number, number]> {
  return rows
    .filter((r) => r.elapsedVideoTimeRatio !== null && r.audienceWatchRatio !== null)
    .map((r) => [num(r.elapsedVideoTimeRatio), num(r.audienceWatchRatio)] as [number, number])
    .sort((a, b) => a[0] - b[0]);
}

/** Edição e tipo de cada vídeo, a partir dos registros de upload das edições. */
export type EditionVideoIndex = Map<string, { edition: string; kind: Exclude<VideoKind, "desconhecido"> }>;

/**
 * Vídeos publicados antes do upload pela API (#12224): as edições 261021 e
 * 261022 não têm `05-youtube-published.json` nem o registro do Short, então o
 * índice das pastas não os encontra e o relatório mostrava edição `?`. O par
 * de cada edição sai do D1 (`02-reviewed.md`) casado com o título do vídeo; o
 * horizontal é o título sem `#Shorts` (só nessas duas edições: desde #12463 o
 * Short também sai sem a tag no título, então edição nova nunca se separa pelo
 * título, só pelo registro da pasta). `MMyBVHVQELI` tem ~2 min e cairia em
 * Short pela duração: o mapa fixa `horizontal`. Lista fechada — edição nova
 * entra pelo registro da pasta, nunca aqui.
 */
export const PRE_API_EDITION_VIDEOS: ReadonlyArray<{ videoId: string; edition: string; kind: Exclude<VideoKind, "desconhecido"> }> = [
  { videoId: "QRbXMprk9o0", edition: "261021", kind: "horizontal" }, // Você já viu IA mentir. Já viu roubar?
  { videoId: "nhMUtgPPs4U", edition: "261021", kind: "short" },
  { videoId: "MMyBVHVQELI", edition: "261022", kind: "horizontal" }, // Claude projetou proteínas contra veneno de escorpião
  { videoId: "K3GqRK5gFds", edition: "261022", kind: "short" },
];

/**
 * Índice das pastas acrescido do mapa fixo de `PRE_API_EDITION_VIDEOS`. O
 * registro da pasta vence: se um dia a edição ganhar registro, ele manda.
 */
export function withPreApiEditionVideos(index: EditionVideoIndex, extra = PRE_API_EDITION_VIDEOS): EditionVideoIndex {
  const out: EditionVideoIndex = new Map(index);
  for (const v of extra) if (!out.has(v.videoId)) out.set(v.videoId, { edition: v.edition, kind: v.kind });
  return out;
}

/**
 * Reatribui edição e tipo de linhas já gravadas a partir do índice atual. O
 * snapshot grava `edition: null` quando o vídeo não estava no índice naquele
 * dia; o relatório relê o índice para não depender de regravar o histórico.
 */
export function applyEditionIndex(lines: VideoSnapshotLine[], index: EditionVideoIndex): VideoSnapshotLine[] {
  return lines.map((l) => {
    const hit = index.get(l.videoId);
    return hit ? { ...l, edition: hit.edition, kind: hit.kind } : l;
  });
}

export function toVideoSnapshotLines(input: {
  rows: AnalyticsRow[];
  capturedAt: string;
  date: string;
  startDate: string;
  endDate: string;
  index: EditionVideoIndex;
  meta: Map<string, VideoMeta>;
  /** Alcance agregado por vídeo (#13192); ausente = coleta não rodou, campos ficam de fora. */
  reach?: Map<string, VideoReach>;
}): VideoSnapshotLine[] {
  return input.rows
    .filter((r) => typeof r.video === "string" && r.video)
    .map((r) => {
      const videoId = r.video as string;
      const fromEdition = input.index.get(videoId);
      const meta = input.meta.get(videoId);
      // Sem registro de edição (corte extra, vídeo avulso), a duração decide.
      const kind: VideoKind =
        fromEdition?.kind ??
        (meta?.durationSec == null ? "desconhecido" : meta.durationSec <= SHORT_MAX_DURATION_SEC ? "short" : "horizontal");
      return {
        capturedAt: input.capturedAt,
        date: input.date,
        videoId,
        title: meta?.title ?? null,
        kind,
        edition: fromEdition?.edition ?? null,
        startDate: input.startDate,
        endDate: input.endDate,
        views: num(r.views),
        estimatedMinutesWatched: num(r.estimatedMinutesWatched),
        averageViewDuration: num(r.averageViewDuration),
        averageViewPercentage: num(r.averageViewPercentage),
        subscribersGained: num(r.subscribersGained),
        subscribersLost: num(r.subscribersLost),
        ...(input.reach ? reachFields(input.reach.get(videoId)) : {}),
      };
    });
}

function reachFields(r: VideoReach | undefined): Pick<VideoSnapshotLine, "thumbnailImpressions" | "thumbnailCtr" | "reachLastDay"> {
  return { thumbnailImpressions: r ? r.impressions : null, thumbnailCtr: r ? r.ctr : null, reachLastDay: r ? r.lastDay : null };
}

/** Extrai `statistics` de `channels.list?part=statistics&mine=true`. */
export function parseChannelStatistics(body: unknown): { subscriberCount: number | null; viewCount: number | null; videoCount: number | null } {
  const items = (body as { items?: unknown })?.items;
  const stats = Array.isArray(items) ? (items[0] as { statistics?: Record<string, unknown> })?.statistics : undefined;
  const n = (v: unknown): number | null => {
    const x = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
    return Number.isFinite(x) ? x : null;
  };
  return { subscriberCount: n(stats?.subscriberCount), viewCount: n(stats?.viewCount), videoCount: n(stats?.videoCount) };
}

export interface VideoMeta {
  title: string | null;
  durationSec: number | null;
}

/** Duração ISO 8601 do YouTube (`PT1H2M3S`) em segundos; `null` se ilegível. */
export function parseIsoDuration(raw: unknown): number | null {
  if (typeof raw !== "string") return null;
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(raw);
  if (!m || raw === "P" || raw === "PT") return null;
  return Number(m[1] ?? 0) * 86400 + Number(m[2] ?? 0) * 3600 + Number(m[3] ?? 0) * 60 + Number(m[4] ?? 0);
}

/** Teto de duração de um Short (o YouTube aceita até 3 min desde 15/10/2024). */
export const SHORT_MAX_DURATION_SEC = 180;

/** Extrai `id → {título, duração}` de `videos.list?part=snippet,contentDetails`. */
export function parseVideoMeta(body: unknown): Map<string, VideoMeta> {
  const out = new Map<string, VideoMeta>();
  const items = (body as { items?: unknown })?.items;
  if (!Array.isArray(items)) return out;
  for (const it of items) {
    const id = (it as { id?: unknown })?.id;
    if (typeof id !== "string" || !id) continue;
    const title = (it as { snippet?: { title?: unknown } })?.snippet?.title;
    out.set(id, {
      title: typeof title === "string" ? title : null,
      durationSec: parseIsoDuration((it as { contentDetails?: { duration?: unknown } })?.contentDetails?.duration),
    });
  }
  return out;
}

// ─── Leitura (dedup) e relatório ─────────────────────────────────────────────

/** Parse de jsonl tolerante a linha vazia; linha ilegível lança com o número. */
export function parseJsonl<T>(raw: string, where: string): T[] {
  const out: T[] = [];
  raw.split(/\r?\n/).forEach((line, i) => {
    if (!line.trim()) return;
    try {
      out.push(JSON.parse(line) as T);
    } catch (e) {
      throw new Error(`${where}:${i + 1} ilegível (${(e as Error).message})`);
    }
  });
  return out;
}

/** Última linha capturada por chave (empate de `capturedAt`: a posterior no arquivo vence). */
export function latestByKey<T extends { capturedAt: string }>(lines: T[], key: (l: T) => string): T[] {
  const best = new Map<string, T>();
  for (const l of lines) {
    const k = key(l);
    const prev = best.get(k);
    if (!prev || l.capturedAt >= prev.capturedAt) best.set(k, l);
  }
  return [...best.values()];
}

/** Snapshot por vídeo mais recente (linhas do último `date` gravado). */
export function latestVideoSnapshot(lines: VideoSnapshotLine[]): VideoSnapshotLine[] {
  if (!lines.length) return [];
  const lastDate = lines.reduce((m, l) => (l.date > m ? l.date : m), lines[0].date);
  return latestByKey(
    lines.filter((l) => l.date === lastDate),
    (l) => l.videoId,
  );
}

/**
 * Termos de busca da execução mais recente (#13087). Cada execução grava a
 * linha do canal e as de termo com o mesmo `capturedAt`; a última linha de
 * canal que registrou a coleta (`searchTerms`) aponta a execução, e só as
 * linhas de termo dela entram: re-rodar no mesmo dia não soma termos de duas
 * execuções, e a execução que voltou vazia mostra vazio (limiar de privacidade),
 * não a lista de uma captura anterior. Sem esse registro (store anterior ao
 * #13087, ou linhas soltas), vale o último `date` das linhas de termo, com
 * cada escopo (canal, ou vídeo) na sua captura mais recente.
 */
export function latestSearchTerms(
  lines: SearchTermLine[],
  channel: ChannelSnapshotLine[] = [],
): { date: string | null; summary: SearchTermsSummary | null; lines: SearchTermLine[] } {
  let marker: ChannelSnapshotLine | null = null;
  for (const c of channel) {
    if (!c.searchTerms) continue;
    if (!marker || c.capturedAt >= marker.capturedAt) marker = c;
  }
  const lastLineDate = lines.length ? lines.reduce((m, l) => (l.date > m ? l.date : m), lines[0].date) : null;
  if (marker && (!lastLineDate || marker.date >= lastLineDate)) {
    const capturedAt = marker.capturedAt;
    return { date: marker.date, summary: marker.searchTerms!, lines: lines.filter((l) => l.capturedAt === capturedAt) };
  }
  const date = lastLineDate;
  if (!date) return { date: null, summary: null, lines: [] };
  const ofDate = lines.filter((l) => l.date === date);
  const scopeKey = (l: SearchTermLine) => `${l.scope}|${l.videoId ?? ""}`;
  const lastCapture = new Map<string, string>();
  for (const l of ofDate) {
    const k = scopeKey(l);
    const prev = lastCapture.get(k);
    if (!prev || l.capturedAt > prev) lastCapture.set(k, l.capturedAt);
  }
  return { date, summary: null, lines: ofDate.filter((l) => l.capturedAt === lastCapture.get(scopeKey(l))) };
}

const SEARCH_TERMS_EMPTY_NOTE =
  "O YouTube omite termos com volume baixo (limiar de privacidade): com o canal pequeno, lista curta ou vazia é resultado válido, não falha do coletor.";

/** Seção do relatório com os termos de busca da execução mais recente (#13087). */
function searchTermsSection(lines: SearchTermLine[], channel: ChannelSnapshotLine[], videos: VideoSnapshotLine[]): string[] {
  const latest = latestSearchTerms(lines, channel);
  if (!latest.date) return ["## Termos de busca no YouTube", "", "Sem coleta de termos de busca gravada ainda.", ""];
  const window = latest.summary ?? latest.lines[0];
  const out = [
    `## Termos de busca no YouTube (${window ? `${window.startDate} a ${window.endDate}, ` : ""}captura de ${latest.date})`,
    "",
    SEARCH_TERMS_EMPTY_NOTE,
    "",
  ];
  const byViews = (a: SearchTermLine, b: SearchTermLine) => b.views - a.views || a.term.localeCompare(b.term);
  const esc = (s: string) => s.replace(/\|/g, "/");
  const chan = latest.lines.filter((l) => l.scope === "channel").sort(byViews);
  out.push("### Canal", "");
  if (chan.length) {
    out.push("| Termo | Views | Min. assistidos |", "|---|---:|---:|");
    for (const l of chan) out.push(`| ${esc(l.term)} | ${fmtInt(l.views)} | ${fmtInt(l.estimatedMinutesWatched)} |`);
  } else if (latest.summary && latest.summary.channelTerms === null) {
    out.push("Consulta do canal falhou nesta captura (ver o log da task).");
  } else {
    out.push("Nenhum termo acima do limiar de privacidade nesta janela.");
  }
  out.push("");
  const vid = latest.lines.filter((l) => l.scope === "video");
  out.push("### Por vídeo", "");
  if (vid.length) {
    const titles = new Map(latestVideoSnapshot(videos).map((v) => [v.videoId, v.title]));
    const totalByVideo = new Map<string, number>();
    for (const l of vid) totalByVideo.set(l.videoId!, (totalByVideo.get(l.videoId!) ?? 0) + l.views);
    vid.sort((a, b) => totalByVideo.get(b.videoId!)! - totalByVideo.get(a.videoId!)! || a.videoId!.localeCompare(b.videoId!) || byViews(a, b));
    out.push("| Vídeo | Termo | Views | Min. assistidos |", "|---|---|---:|---:|");
    for (const l of vid) {
      const label = esc(titles.get(l.videoId!) ?? l.videoId!);
      out.push(`| ${label} (${l.videoId}) | ${esc(l.term)} | ${fmtInt(l.views)} | ${fmtInt(l.estimatedMinutesWatched)} |`);
    }
  } else {
    out.push(
      latest.summary
        ? `Nenhum termo acima do limiar de privacidade nos ${latest.summary.videosQueried} vídeo(s) consultado(s)${latest.summary.failures ? ` (${latest.summary.failures} consulta(s) falharam)` : ""}.`
        : "Nenhum termo por vídeo nesta captura.",
    );
  }
  out.push("");
  return out;
}

const fmtInt = (n: number): string => Math.round(n).toLocaleString("pt-BR");
const fmtPct = (n: number): string => `${n.toFixed(1).replace(".", ",")}%`;
/** Segundos em "m:ss". Arredonda o total ANTES de dividir: 59,6 s é "1:00", nunca "0:60". */
export const fmtSec = (n: number): string => {
  const total = Math.round(n);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
};

/** Taxa de cliques da capa (fração) em "2,2%"; sem dado, "—". */
export const fmtCtr = (ctr: number | null | undefined): string => (ctr == null ? "—" : `${(ctr * 100).toFixed(1).replace(".", ",")}%`);

function videoTable(rows: VideoSnapshotLine[]): string[] {
  // Colunas da capa só quando a captura já traz o campo (#13192): store
  // anterior segue com a tabela de sempre.
  const withReach = rows.some((r) => r.thumbnailImpressions !== undefined);
  const out = [
    `| Edição | Vídeo | Views | Min. assistidos | Duração média | % médio | Inscritos + | Inscritos − | Líquido |${withReach ? " Impressões da capa | CTR da capa |" : ""}`,
    `|---|---|---:|---:|---:|---:|---:|---:|---:|${withReach ? "---:|---:|" : ""}`,
  ];
  for (const r of rows) {
    const label = (r.title ?? r.videoId).replace(/\|/g, "/");
    const reach = withReach ? ` ${r.thumbnailImpressions == null ? "—" : fmtInt(r.thumbnailImpressions)} | ${fmtCtr(r.thumbnailCtr)} |` : "";
    out.push(
      `| ${r.edition ?? "?"} | ${label} (${r.videoId}) | ${fmtInt(r.views)} | ${fmtInt(r.estimatedMinutesWatched)} | ${fmtSec(r.averageViewDuration)} | ${fmtPct(r.averageViewPercentage)} | ${fmtInt(r.subscribersGained)} | ${fmtInt(r.subscribersLost)} | ${fmtInt(r.subscribersGained - r.subscribersLost)} |${reach}`,
    );
  }
  return out;
}

/**
 * Relatório em markdown: tabela por vídeo (Shorts e horizontais separados,
 * ordenados por inscritos líquidos), com `pautas` os horizontais somados por
 * pauta (#13195), série do total de inscritos, série
 * diária do canal com a fonte de tráfego e, com `searchTerms`, os termos de
 * busca do YouTube do canal e por vídeo (#13087).
 */
export function renderAnalyticsReport(input: {
  channel: ChannelSnapshotLine[];
  daily: ChannelDailyLine[];
  traffic: TrafficSourceLine[];
  videos: VideoSnapshotLine[];
  /** Índice vídeo → edição atual; corrige linhas gravadas sem edição (#12224). */
  index?: EditionVideoIndex;
  /** Termos de busca gravados (#13087); ausente omite a seção. */
  searchTerms?: SearchTermLine[];
  /** Pauta por edição (#13195); ausente omite a seção "Horizontais por pauta". */
  pautas?: EditionPautas;
}): string {
  const lines: string[] = ["# YouTube Analytics — @diariabr", ""];
  const channel = latestByKey(input.channel, (l) => l.date).sort((a, b) => a.date.localeCompare(b.date));
  const last = channel[channel.length - 1];
  if (last && last.analytics !== "ok") {
    lines.push(`> Aviso: última captura (${last.date}) sem dados de Analytics: ${last.analyticsError ?? last.analytics}`, "");
  }
  if (last?.reach) {
    const r = last.reach;
    if (r.status !== "ok" && r.status !== "dry-run") {
      lines.push(`> Aviso: impressões e taxa de cliques da capa indisponíveis na última captura (${last.date}): ${r.error ?? r.status}`, "");
    } else if (r.jobCreated || (r.jobId && r.reportsListed === 0)) {
      lines.push(
        `> Impressões e taxa de cliques da capa: job da YouTube Reporting API ${r.jobCreated ? "criado nesta captura" : "ainda sem relatório"}; o 1º relatório sai em até 48h, com os 30 dias anteriores à criação. Linha de base anterior: docs/youtube-capa-ctr.md.`,
        "",
      );
    }
  }

  const latest = latestVideoSnapshot(input.videos);
  const snap = input.index ? applyEditionIndex(latest, input.index) : latest;
  const byNet = (a: VideoSnapshotLine, b: VideoSnapshotLine) =>
    b.subscribersGained - b.subscribersLost - (a.subscribersGained - a.subscribersLost) || b.views - a.views;
  const groups: Array<[string, VideoKind]> = [
    ["Shorts", "short"],
    ["Horizontais", "horizontal"],
    ["Tipo desconhecido", "desconhecido"],
  ];
  if (snap.length) {
    lines.push(`## Por vídeo (${snap[0].startDate} a ${snap[0].endDate}, captura de ${snap[0].date})`, "");
    for (const [title, kind] of groups) {
      const rows = snap.filter((r) => r.kind === kind).sort(byNet);
      if (!rows.length) continue;
      lines.push(`### ${title}`, "", ...videoTable(rows), "");
    }
  } else {
    lines.push("## Por vídeo", "", "Sem snapshot por vídeo gravado ainda.", "");
  }
  if (input.pautas) lines.push(...renderPautaSection(snap, input.pautas));

  lines.push("## Total de inscritos do canal", "", "| Dia | Inscritos |", "|---|---:|");
  for (const c of channel) lines.push(`| ${c.date} | ${c.subscriberCount === null ? "?" : fmtInt(c.subscriberCount)} |`);
  lines.push("");

  const daily = latestByKey(input.daily, (l) => l.day).sort((a, b) => a.day.localeCompare(b.day));
  const traffic = latestByKey(input.traffic, (l) => `${l.day}|${l.source}`);
  const sources = [...new Set(traffic.map((t) => t.source))].sort();
  if (daily.length) {
    lines.push("## Série diária do canal", "");
    lines.push(`| Dia | Views | Min. | Inscritos + | Inscritos − |${sources.map((s) => ` ${s} |`).join("")}`);
    lines.push(`|---|---:|---:|---:|---:|${sources.map(() => "---:|").join("")}`);
    const tByDay = new Map<string, Map<string, number>>();
    for (const t of traffic) {
      if (!tByDay.has(t.day)) tByDay.set(t.day, new Map());
      tByDay.get(t.day)!.set(t.source, t.views);
    }
    for (const d of daily) {
      const t = tByDay.get(d.day);
      lines.push(
        `| ${d.day} | ${fmtInt(d.views)} | ${fmtInt(d.estimatedMinutesWatched)} | ${fmtInt(d.subscribersGained)} | ${fmtInt(d.subscribersLost)} |${sources.map((s) => ` ${fmtInt(t?.get(s) ?? 0)} |`).join("")}`,
      );
    }
    lines.push("");
  }
  if (input.searchTerms) lines.push(...searchTermsSection(input.searchTerms, input.channel, input.videos));
  return lines.join("\n");
}
