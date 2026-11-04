/**
 * scripts/youtube-analytics-snapshot.ts (#12075, épica #12072)
 *
 * Snapshot diário do YouTube Analytics do @diariabr: inscritos ganhos/perdidos
 * e retenção por vídeo, série diária do canal, views por fonte de tráfego
 * (Shorts, busca, sugeridos, URL externa...) e o total de inscritos do canal.
 * Miolo puro em `scripts/lib/diaria/youtube-analytics.ts`; este arquivo faz a
 * I/O (token, `data/youtube-analytics/*.jsonl`, índice das edições).
 *
 * Só LÊ o YouTube. Escopos: `youtube.readonly` (total do canal, títulos) e
 * `yt-analytics.readonly` (o resto). Token sem o 2º (gerado antes do #12075)
 * não falha: grava só o total do canal, marca `analytics: "missing-scope"` e
 * avisa para rodar `scripts/youtube-oauth-setup.ts`. A YouTube Analytics API
 * também precisa estar ativada no projeto GCP do client OAuth.
 *
 * Vídeo → edição: `_internal/05-youtube-published.json` (horizontal) e o
 * registro do vertical (`_internal/06-shorts-published*.json`, destino
 * `youtube_shorts`) de cada edição desde 21/10/2026. Vídeo fora desses
 * registros (corte extra, avulso) é classificado pela duração (≤ 3 min =
 * Short).
 *
 * Credenciais: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
 * `YOUTUBE_REFRESH_TOKEN`, com o `.env` do repo vencendo o ambiente (#8237).
 *
 * Uso:
 *   npx tsx scripts/youtube-analytics-snapshot.ts [--since YYYY-MM-DD] [--dry-run]
 *   npx tsx scripts/youtube-analytics-snapshot.ts --report [--out arquivo.md]
 *
 * `--since` re-busca a série diária desde a data (padrão: últimos 7 dias do
 * já gravado; sem histórico, desde 21/10/2026). `--dry-run` busca e imprime o
 * resumo sem gravar. `--report` só lê o que já foi gravado e imprime a tabela
 * por vídeo (Shorts e horizontais separados) e as séries, sem rede.
 *
 * Exit: 0 = ok (inclui token sem o escopo de Analytics, com aviso);
 * 1 = erro (credencial ausente, token, rede, API); 2 = uso inválido.
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as dotenvParse } from "dotenv";
import { findUnknownFlags, isMainModule, parseArgs } from "./lib/cli-args.ts";
import { runCli } from "./lib/cli-exit.ts";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { readShortsRegistry } from "./lib/diaria/shorts-published-store.ts";
import { readYouTubeRecordSummary } from "./lib/diaria/youtube-video-link-gate.ts";
import {
  DIARIA_YOUTUBE_CHANNEL_ID,
  resolveHorizontalId,
  resolveShortId,
  resolveYouTubeReadCredentials,
  type YouTubeReadCredentials,
} from "./lib/diaria/youtube-short-related.ts";
import { YOUTUBE_API_BASE, defaultYouTubeUploadDeps, refreshYouTubeAccessToken, type FetchLike } from "./lib/diaria/youtube-upload.ts";
import {
  CHANNEL_DAILY_METRICS,
  VIDEO_METRICS,
  YOUTUBE_ANALYTICS_DIR,
  YOUTUBE_ANALYTICS_FILES,
  YOUTUBE_ANALYTICS_RETENTION_MAX_VIDEOS,
  YOUTUBE_ANALYTICS_SERIES_START,
  YouTubeAnalyticsError,
  brtIsoDate,
  isoToAammdd,
  latestByKey,
  parseChannelStatistics,
  parseJsonl,
  parseVideoMeta,
  queryAnalytics,
  renderAnalyticsReport,
  resolveDailyWindow,
  toChannelDailyLines,
  toRetentionPoints,
  toTrafficSourceLines,
  toVideoSnapshotLines,
  type ChannelDailyLine,
  type ChannelSnapshotLine,
  type EditionVideoIndex,
  type RetentionLine,
  type TrafficSourceLine,
  type VideoMeta,
  type VideoSnapshotLine,
} from "./lib/diaria/youtube-analytics.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const KNOWN_FLAGS = ["since", "dry-run", "report", "out", "help"] as const;

// ─── Store ───────────────────────────────────────────────────────────────────

export function analyticsDir(dataRoot: string): string {
  return join(dataRoot, YOUTUBE_ANALYTICS_DIR);
}

function readStore<T>(dataRoot: string, file: string): T[] {
  const path = join(analyticsDir(dataRoot), file);
  return existsSync(path) ? parseJsonl<T>(readFileSync(path, "utf8"), path) : [];
}

function appendStore(dataRoot: string, file: string, lines: readonly object[]): void {
  if (!lines.length) return;
  const dir = analyticsDir(dataRoot);
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, file), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

// ─── Índice vídeo → edição ───────────────────────────────────────────────────

/**
 * Lê os registros de upload das edições desde `sinceAammdd`. Registro
 * ilegível de uma edição vira aviso (o vídeo dela cai na classificação por
 * duração), nunca aborta o snapshot.
 */
export function buildEditionVideoIndex(editionsRootAbs: string, sinceAammdd: string): { index: EditionVideoIndex; warnings: string[] } {
  const index: EditionVideoIndex = new Map();
  const warnings: string[] = [];
  if (!existsSync(editionsRootAbs)) return { index, warnings: [`${editionsRootAbs} ausente — sem vínculo vídeo → edição`] };
  for (const aamm of readdirSync(editionsRootAbs).filter((n) => /^\d{4}$/.test(n)).sort()) {
    for (const aammdd of readdirSync(join(editionsRootAbs, aamm)).filter((n) => /^\d{6}$/.test(n) && n >= sinceAammdd).sort()) {
      const dir = join(editionsRootAbs, aamm, aammdd);
      try {
        const h = resolveHorizontalId({ record: readYouTubeRecordSummary(dir), videoUrl: null });
        if (h) index.set(h.id, { edition: aammdd, kind: "horizontal" });
      } catch (e) {
        warnings.push(`${aammdd}: ${(e as Error).message}`);
      }
      try {
        const s = resolveShortId(readShortsRegistry(dir, aammdd));
        if (s) index.set(s.id, { edition: aammdd, kind: "short" });
      } catch (e) {
        warnings.push(`${aammdd}: ${(e as Error).message}`);
      }
    }
  }
  return { index, warnings };
}

// ─── Snapshot ────────────────────────────────────────────────────────────────

export interface SnapshotDeps {
  fetch: FetchLike;
  now: () => Date;
  log: (msg: string) => void;
  warn: (msg: string) => void;
}

export interface SnapshotInput {
  credentials: YouTubeReadCredentials;
  dataRoot: string;
  index: EditionVideoIndex;
  since?: string | null;
  dryRun?: boolean;
}

export interface SnapshotResult {
  channel: ChannelSnapshotLine;
  daily: ChannelDailyLine[];
  traffic: TrafficSourceLine[];
  videos: VideoSnapshotLine[];
  retention: RetentionLine[];
  written: boolean;
}

async function getJson(fetchFn: FetchLike, url: string, token: string, what: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchFn(url, { headers: { Authorization: `Bearer ${token}` } });
  } catch (e) {
    throw new Error(`sem rede para ${what}: ${(e as Error).message}`);
  }
  const text = await res.text().catch(() => "");
  if (!res.ok) throw new Error(`${what} respondeu ${res.status}: ${text.slice(0, 300)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${what} devolveu corpo não-JSON (HTTP ${res.status})`);
  }
}

/** `videos.list` em lotes de 50 (título + duração). Falha vira aviso: o snapshot segue sem título. */
async function fetchVideoMeta(deps: SnapshotDeps, token: string, ids: string[]): Promise<Map<string, VideoMeta>> {
  const out = new Map<string, VideoMeta>();
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    try {
      const body = await getJson(
        deps.fetch,
        `${YOUTUBE_API_BASE}/videos?part=snippet,contentDetails&id=${batch.map(encodeURIComponent).join(",")}`,
        token,
        "videos.list",
      );
      for (const [k, v] of parseVideoMeta(body)) out.set(k, v);
    } catch (e) {
      deps.warn(`[aviso] títulos/duração de ${batch.length} vídeo(s) indisponíveis: ${(e as Error).message}`);
    }
  }
  return out;
}

export async function runSnapshot(deps: SnapshotDeps, input: SnapshotInput): Promise<SnapshotResult> {
  const now = deps.now();
  const capturedAt = now.toISOString();
  const date = brtIsoDate(now);
  const token = await refreshYouTubeAccessToken(deps, { ...input.credentials, channelId: DIARIA_YOUTUBE_CHANNEL_ID });

  const stats = parseChannelStatistics(
    await getJson(deps.fetch, `${YOUTUBE_API_BASE}/channels?part=statistics&mine=true`, token, "channels.list"),
  );
  const channel: ChannelSnapshotLine = { capturedAt, date, ...stats, analytics: "ok" };
  const result: SnapshotResult = { channel, daily: [], traffic: [], videos: [], retention: [], written: false };

  const storedDays = readStore<ChannelDailyLine>(input.dataRoot, YOUTUBE_ANALYTICS_FILES.channelDaily).map((l) => l.day);
  const lastStoredDay = storedDays.length ? storedDays.reduce((m, d) => (d > m ? d : m)) : null;
  const window = resolveDailyWindow({ now, lastStoredDay, since: input.since });
  const cumulative = { startDate: YOUTUBE_ANALYTICS_SERIES_START, endDate: window.endDate };

  try {
    result.daily = toChannelDailyLines(
      await queryAnalytics(deps.fetch, token, { ...window, metrics: CHANNEL_DAILY_METRICS, dimensions: ["day"], sort: "day" }),
      capturedAt,
    );
    result.traffic = toTrafficSourceLines(
      await queryAnalytics(deps.fetch, token, { ...window, metrics: ["views"], dimensions: ["day", "insightTrafficSourceType"], sort: "day" }),
      capturedAt,
    );
    const videoRows = await queryAnalytics(deps.fetch, token, {
      ...cumulative,
      metrics: VIDEO_METRICS,
      dimensions: ["video"],
      sort: "-views",
      maxResults: 200,
    });
    const ids = videoRows.map((r) => r.video).filter((v): v is string => typeof v === "string" && !!v);
    const meta = await fetchVideoMeta(deps, token, ids);
    result.videos = toVideoSnapshotLines({ rows: videoRows, capturedAt, date, ...cumulative, index: input.index, meta });
    // Retenção: uma consulta por vídeo, a parte mais frágil do snapshot. Falha
    // real numa delas (ex.: 400 num vídeo sem curva) vira aviso e o laço segue —
    // não pode derrubar o total do canal nem as séries já buscadas (review do
    // PR #12137). Escopo ausente/API desligada continua subindo pro catch de
    // baixo: aí nenhuma consulta funcionaria.
    let retentionFailures = 0;
    for (const videoId of ids.slice(0, YOUTUBE_ANALYTICS_RETENTION_MAX_VIDEOS)) {
      let rows: Awaited<ReturnType<typeof queryAnalytics>>;
      try {
        rows = await queryAnalytics(deps.fetch, token, {
          ...cumulative,
          metrics: ["audienceWatchRatio"],
          dimensions: ["elapsedVideoTimeRatio"],
          filters: `video==${videoId}`,
          sort: "elapsedVideoTimeRatio",
        });
      } catch (e) {
        if (e instanceof YouTubeAnalyticsError && e.kind !== "error") throw e;
        retentionFailures++;
        deps.warn(`[aviso] retenção de ${videoId} indisponível: ${(e as Error).message}`);
        continue;
      }
      const points = toRetentionPoints(rows);
      if (points.length) result.retention.push({ capturedAt, date, videoId, points });
    }
    if (retentionFailures) deps.warn(`[aviso] ${retentionFailures} curva(s) de retenção falharam; o resto do snapshot foi gravado`);
  } catch (e) {
    if (!(e instanceof YouTubeAnalyticsError) || e.kind === "error") throw e;
    // Escopo ausente / API desligada: ação do editor, não falha da task.
    channel.analytics = e.kind;
    channel.analyticsError = e.message;
    result.daily = [];
    result.traffic = [];
    result.videos = [];
    result.retention = [];
    deps.warn(`[aviso] ${e.message}`);
  }

  if (!input.dryRun) {
    appendStore(input.dataRoot, YOUTUBE_ANALYTICS_FILES.channel, [channel]);
    appendStore(input.dataRoot, YOUTUBE_ANALYTICS_FILES.channelDaily, result.daily);
    appendStore(input.dataRoot, YOUTUBE_ANALYTICS_FILES.trafficSources, result.traffic);
    appendStore(input.dataRoot, YOUTUBE_ANALYTICS_FILES.videos, result.videos);
    appendStore(input.dataRoot, YOUTUBE_ANALYTICS_FILES.retention, result.retention);
    result.written = true;
  }
  deps.log(
    `snapshot ${date}: ${stats.subscriberCount ?? "?"} inscritos; analytics=${channel.analytics}; ` +
      `${result.daily.length} dia(s) ${window.startDate}..${window.endDate}, ${result.traffic.length} linha(s) de fonte, ` +
      `${result.videos.length} vídeo(s), ${result.retention.length} curva(s) de retenção${input.dryRun ? " (dry-run, nada gravado)" : ""}`,
  );
  return result;
}

export function buildReport(dataRoot: string): string {
  return renderAnalyticsReport({
    channel: readStore<ChannelSnapshotLine>(dataRoot, YOUTUBE_ANALYTICS_FILES.channel),
    daily: readStore<ChannelDailyLine>(dataRoot, YOUTUBE_ANALYTICS_FILES.channelDaily),
    traffic: readStore<TrafficSourceLine>(dataRoot, YOUTUBE_ANALYTICS_FILES.trafficSources),
    videos: readStore<VideoSnapshotLine>(dataRoot, YOUTUBE_ANALYTICS_FILES.videos),
  });
}

/** Retenção mais recente por vídeo (para quem for desenhar a curva, #12079). */
export function latestRetention(dataRoot: string): RetentionLine[] {
  return latestByKey(readStore<RetentionLine>(dataRoot, YOUTUBE_ANALYTICS_FILES.retention), (l) => l.videoId);
}

function readRepoEnvFile(): Record<string, string> {
  try {
    return dotenvParse(readFileSync(join(ROOT, ".env"), "utf8"));
  } catch {
    return {};
  }
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const unknown = findUnknownFlags(argv, KNOWN_FLAGS);
  const args = parseArgs(argv);
  if (unknown.length || args.flags.has("help")) {
    if (unknown.length) console.error(`flag(s) desconhecida(s): ${unknown.join(", ")}`);
    console.error("uso: youtube-analytics-snapshot.ts [--since YYYY-MM-DD] [--dry-run] | --report [--out arquivo.md]");
    return 2;
  }
  const since = args.values.since ?? null;
  if (since !== null && !/^\d{4}-\d{2}-\d{2}$/.test(since)) {
    console.error(`--since inválido: ${JSON.stringify(since)} (esperado YYYY-MM-DD)`);
    return 2;
  }
  const dataRoot = join(ROOT, "data");

  if (args.flags.has("report")) {
    const md = buildReport(dataRoot);
    if (args.values.out) writeFileSync(resolve(args.values.out), md);
    else console.log(md);
    return 0;
  }

  loadProjectEnv(ROOT);
  const creds = resolveYouTubeReadCredentials(readRepoEnvFile(), process.env);
  if (creds.overridden.length) console.error(`[premissa] ${creds.overridden.join(", ")} do .env do repo vencem o ambiente (#8237)`);
  if (!creds.credentials) {
    console.error(`credenciais do YouTube ausentes: ${creds.missing.join(", ")}`);
    return 1;
  }
  const { index, warnings } = buildEditionVideoIndex(join(dataRoot, "editions"), isoToAammdd(YOUTUBE_ANALYTICS_SERIES_START));
  for (const w of warnings) console.error(`[aviso] ${w}`);
  await runSnapshot(
    { fetch: defaultYouTubeUploadDeps.fetch, now: () => new Date(), log: (m) => console.log(m), warn: (m) => console.error(m) },
    { credentials: creds.credentials, dataRoot, index, since, dryRun: args.flags.has("dry-run") },
  );
  return 0;
}

if (isMainModule(import.meta.url)) {
  void runCli(main, { onError: (e) => console.error(`erro: ${(e as Error).message}`) });
}
