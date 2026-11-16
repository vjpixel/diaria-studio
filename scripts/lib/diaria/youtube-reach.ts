/**
 * scripts/lib/diaria/youtube-reach.ts (#13192, épica #12072)
 *
 * Impressões e taxa de cliques da CAPA (miniatura) por vídeo, para medir se
 * uma capa nova funcionou. Usado por `scripts/youtube-analytics-snapshot.ts`.
 *
 * Por que outra API: a YouTube Analytics API v2 (`reports.query`, o resto do
 * snapshot) NÃO expõe impressões nem taxa de cliques da miniatura — a lista
 * de métricas (https://developers.google.com/youtube/analytics/metrics, lida
 * em 16/11/2026) só tem impressões de card, anotação e anúncio. Quem expõe é
 * a YouTube Reporting API (relatórios em lote): o relatório
 * `channel_reach_basic_a1` traz, por dia e vídeo, `video_thumbnail_impressions`
 * e `video_thumbnail_impressions_ctr`
 * (https://developers.google.com/youtube/reporting/v1/reports/channel_reports).
 *
 * Como a Reporting API funciona (e o que isso muda aqui):
 *   - precisa de um JOB por tipo de relatório (`jobs.create`), criado uma vez.
 *     O snapshot procura o job e o cria se faltar: é configuração de leitura,
 *     não publica nada nem muda o canal (removível com `jobs.delete`);
 *   - o 1º relatório sai até 48h depois do job, e o YouTube gera também os 30
 *     dias anteriores à criação. Antes disso, o histórico só existe no Studio
 *     (linha de base em `docs/youtube-capa-ctr.md`);
 *   - um relatório por dia, CSV com cabeçalho, dia do Pacífico (não BRT);
 *     relatório de reprocessamento (backfill) chega com outro id e o mesmo
 *     período, e substitui o anterior: no dedup, o `createTime` mais novo de
 *     cada dia vence;
 *   - relatório fica disponível por 60 dias: o snapshot baixa o que ainda não
 *     baixou (ids em `reach-reports.jsonl`) e guarda as linhas em
 *     `reach-daily.jsonl`.
 *
 * Escala da taxa de cliques — PREMISSA a confirmar com o 1º relatório real: a
 * doc chama a métrica de "percentage" e define como cliques ÷ impressões, sem
 * dizer a escala. Por arquivo: algum valor > 1 → escala percentual (÷ 100);
 * senão, fração. O valor cru fica gravado (`ctrRaw`, `ctrScale`) para corrigir
 * sem re-baixar caso a premissa esteja errada (conferir contra o Studio: o
 * "Só o Claude Opus 5.5 supera..." tinha 0,8%).
 */

import { classifyAnalyticsFailure, type AnalyticsFailureKind } from "./youtube-analytics.ts";
import type { FetchLike } from "./youtube-upload.ts";

export const YOUTUBE_REPORTING_API_BASE = "https://youtubereporting.googleapis.com/v1";
export const YOUTUBE_REACH_REPORT_TYPE = "channel_reach_basic_a1";
export const YOUTUBE_REACH_JOB_NAME = "diaria-capa-ctr-13192";

/** Teto de relatórios baixados por execução (1 GET por relatório; ~90 cobre histórico + 60 dias). */
export const YOUTUBE_REACH_MAX_DOWNLOADS = 90;

export type CtrScale = "fraction" | "percent";

/** Uma linha por dia (Pacífico) e vídeo, de um relatório baixado. */
export interface ReachDailyLine {
  capturedAt: string;
  reportId: string;
  /** `createTime` do relatório: no mesmo dia, o mais novo (backfill) vence. */
  reportCreateTime: string;
  /** Dia do relatório, `YYYY-MM-DD`, fuso do Pacífico. */
  day: string;
  videoId: string;
  impressions: number;
  /** Cliques estimados (impressões × taxa), somados se o CSV trouxer várias linhas do par. */
  clicks: number;
  /** Taxa de cliques em fração (0..1); `null` sem impressões. */
  ctr: number | null;
  /** Último valor cru de `video_thumbnail_impressions_ctr` do par, para auditoria da escala. */
  ctrRaw: number | null;
  ctrScale: CtrScale;
}

/** Marcador de relatório já baixado (inclusive vazio: dia sem dado tem só cabeçalho). */
export interface ReachReportLine {
  capturedAt: string;
  reportId: string;
  jobId: string;
  startTime: string;
  endTime: string;
  createTime: string;
  rows: number;
}

/** Resumo gravado na linha do canal (`channel.jsonl` → `reach`). */
export interface ReachSummary {
  status: "ok" | AnalyticsFailureKind | "dry-run";
  jobId: string | null;
  /** O job foi criado nesta execução (relatórios só saem ~48h depois). */
  jobCreated: boolean;
  reportsListed: number;
  reportsDownloaded: number;
  rowsAdded: number;
  failures: number;
  error?: string;
}

// ─── CSV ─────────────────────────────────────────────────────────────────────

/** Divide uma linha CSV respeitando aspas duplas (`""` escapa aspas). */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

/** `YYYYMMDD` → `YYYY-MM-DD`; aceita também `YYYY-MM-DD`. */
export function reachDay(raw: string): string | null {
  const s = raw.trim();
  const m = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(s);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/**
 * Lê o CSV do `channel_reach_basic_a1`. A ordem das colunas sai do cabeçalho
 * (a doc pede isso: o relatório é versionado). Coluna obrigatória ausente
 * lança — formato mudou, melhor avisar que gravar zero. Linhas do mesmo dia e
 * vídeo (dimensão extra numa versão futura) são somadas por cliques estimados.
 */
export function parseReachCsv(
  csv: string,
  meta: { capturedAt: string; reportId: string; reportCreateTime: string },
): ReachDailyLine[] {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (!lines.length) return [];
  const header = splitCsvLine(lines[0]).map((h) => h.trim());
  const col = (name: string) => header.indexOf(name);
  const iDate = col("date");
  const iVideo = col("video_id");
  const iImpr = col("video_thumbnail_impressions");
  const iCtr = col("video_thumbnail_impressions_ctr");
  const missing = [
    ["date", iDate],
    ["video_id", iVideo],
    ["video_thumbnail_impressions", iImpr],
    ["video_thumbnail_impressions_ctr", iCtr],
  ]
    .filter(([, i]) => i === -1)
    .map(([n]) => n);
  if (missing.length) throw new Error(`relatório ${YOUTUBE_REACH_REPORT_TYPE} sem coluna(s) ${missing.join(", ")} (cabeçalho: ${header.join(",")})`);

  const raw: Array<{ day: string; videoId: string; impressions: number; ctrRaw: number }> = [];
  for (const line of lines.slice(1)) {
    const cells = splitCsvLine(line);
    const day = reachDay(cells[iDate] ?? "");
    const videoId = (cells[iVideo] ?? "").trim();
    if (!day || !videoId) continue;
    const impressions = Number(cells[iImpr]);
    const ctrRaw = Number(cells[iCtr]);
    raw.push({ day, videoId, impressions: Number.isFinite(impressions) ? impressions : 0, ctrRaw: Number.isFinite(ctrRaw) ? ctrRaw : 0 });
  }
  const ctrScale: CtrScale = raw.some((r) => r.ctrRaw > 1) ? "percent" : "fraction";
  const divisor = ctrScale === "percent" ? 100 : 1;

  const byKey = new Map<string, ReachDailyLine>();
  for (const r of raw) {
    const k = `${r.day}|${r.videoId}`;
    const clicks = r.impressions * (r.ctrRaw / divisor);
    const prev = byKey.get(k);
    if (prev) {
      prev.impressions += r.impressions;
      prev.clicks += clicks;
      prev.ctrRaw = r.ctrRaw;
    } else {
      byKey.set(k, { ...meta, day: r.day, videoId: r.videoId, impressions: r.impressions, clicks, ctr: null, ctrRaw: r.ctrRaw, ctrScale });
    }
  }
  return [...byKey.values()].map((l) => ({ ...l, ctr: l.impressions > 0 ? l.clicks / l.impressions : null }));
}

// ─── Dedup e agregação ───────────────────────────────────────────────────────

/**
 * Linhas vigentes: para cada dia, só as do relatório com `createTime` mais
 * novo (o backfill substitui o dia inteiro, inclusive vídeo que sumiu dele).
 * Empate de relatório: a captura mais recente vence por par dia/vídeo.
 */
export function currentReachDaily(lines: ReachDailyLine[]): ReachDailyLine[] {
  const newestByDay = new Map<string, string>();
  for (const l of lines) {
    const prev = newestByDay.get(l.day);
    if (!prev || l.reportCreateTime > prev) newestByDay.set(l.day, l.reportCreateTime);
  }
  const best = new Map<string, ReachDailyLine>();
  for (const l of lines) {
    if (l.reportCreateTime !== newestByDay.get(l.day)) continue;
    const k = `${l.day}|${l.videoId}`;
    const prev = best.get(k);
    if (!prev || l.capturedAt >= prev.capturedAt) best.set(k, l);
  }
  return [...best.values()];
}

export interface VideoReach {
  impressions: number;
  clicks: number;
  /** Fração (0..1); `null` sem impressões. */
  ctr: number | null;
  firstDay: string;
  lastDay: string;
}

/** Soma por vídeo das linhas vigentes dentro de `[startDate, endDate]` (dias do Pacífico). */
export function aggregateReachByVideo(lines: ReachDailyLine[], window?: { startDate?: string; endDate?: string }): Map<string, VideoReach> {
  const out = new Map<string, VideoReach>();
  for (const l of currentReachDaily(lines)) {
    if (window?.startDate && l.day < window.startDate) continue;
    if (window?.endDate && l.day > window.endDate) continue;
    const prev = out.get(l.videoId);
    if (prev) {
      prev.impressions += l.impressions;
      prev.clicks += l.clicks;
      if (l.day < prev.firstDay) prev.firstDay = l.day;
      if (l.day > prev.lastDay) prev.lastDay = l.day;
    } else out.set(l.videoId, { impressions: l.impressions, clicks: l.clicks, ctr: null, firstDay: l.day, lastDay: l.day });
  }
  for (const v of out.values()) v.ctr = v.impressions > 0 ? v.clicks / v.impressions : null;
  return out;
}

// ─── Rede (fetch injetável) ──────────────────────────────────────────────────

export class YouTubeReportingError extends Error {
  constructor(
    message: string,
    readonly kind: AnalyticsFailureKind,
    readonly httpStatus: number | null,
  ) {
    super(message);
    this.name = "YouTubeReportingError";
  }
}

export function explainReportingFailure(kind: AnalyticsFailureKind, status: number | null, body = ""): string {
  if (kind === "missing-scope") {
    return "token sem o escopo yt-analytics.readonly para a YouTube Reporting API: rode `npx tsx scripts/youtube-oauth-setup.ts` deixando todos os escopos marcados; até lá impressões e taxa de cliques da capa ficam de fora";
  }
  if (kind === "api-disabled") {
    return "YouTube Reporting API não está ativada no projeto GCP do client OAuth (é outra API, separada da YouTube Analytics API): ative em console.cloud.google.com → APIs → YouTube Reporting API e rode de novo";
  }
  return `YouTube Reporting API respondeu ${status ?? "sem status"}: ${body.slice(0, 300)}`;
}

async function reportingCall(fetchFn: FetchLike, token: string, url: string, init: { method?: string; body?: string } = {}): Promise<string> {
  let res: Response;
  try {
    res = await fetchFn(url, {
      method: init.method ?? "GET",
      headers: { Authorization: `Bearer ${token}`, ...(init.body ? { "Content-Type": "application/json" } : {}) },
      ...(init.body ? { body: init.body } : {}),
    });
  } catch (e) {
    throw new YouTubeReportingError(`sem rede para a YouTube Reporting API: ${(e as Error).message}`, "error", null);
  }
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    const kind = classifyAnalyticsFailure(res.status, text);
    throw new YouTubeReportingError(explainReportingFailure(kind, res.status, text), kind, res.status);
  }
  return text;
}

async function reportingJson(fetchFn: FetchLike, token: string, url: string, init?: { method?: string; body?: string }): Promise<Record<string, unknown>> {
  const text = await reportingCall(fetchFn, token, url, init);
  try {
    return (text ? JSON.parse(text) : {}) as Record<string, unknown>;
  } catch {
    throw new YouTubeReportingError("YouTube Reporting API devolveu corpo não-JSON", "error", null);
  }
}

/** Percorre uma listagem paginada (`nextPageToken`) e junta os itens de `field`. */
async function listAll(fetchFn: FetchLike, token: string, baseUrl: string, field: string): Promise<Array<Record<string, unknown>>> {
  const items: Array<Record<string, unknown>> = [];
  let pageToken: string | null = null;
  for (let page = 0; page < 50; page++) {
    const url = pageToken ? `${baseUrl}${baseUrl.includes("?") ? "&" : "?"}pageToken=${encodeURIComponent(pageToken)}` : baseUrl;
    const body = await reportingJson(fetchFn, token, url);
    const got = body[field];
    if (Array.isArray(got)) items.push(...(got as Array<Record<string, unknown>>));
    pageToken = typeof body.nextPageToken === "string" && body.nextPageToken ? body.nextPageToken : null;
    if (!pageToken) break;
  }
  return items;
}

/**
 * Job do `channel_reach_basic_a1`: o existente, ou um novo se `create`. Sem
 * job e sem `create` (dry-run) devolve `jobId: null`.
 */
export async function ensureReachJob(fetchFn: FetchLike, token: string, opts: { create: boolean }): Promise<{ jobId: string | null; created: boolean }> {
  const jobs = await listAll(fetchFn, token, `${YOUTUBE_REPORTING_API_BASE}/jobs`, "jobs");
  const hit = jobs.find((j) => j.reportTypeId === YOUTUBE_REACH_REPORT_TYPE && typeof j.id === "string");
  if (hit) return { jobId: hit.id as string, created: false };
  if (!opts.create) return { jobId: null, created: false };
  const made = await reportingJson(fetchFn, token, `${YOUTUBE_REPORTING_API_BASE}/jobs`, {
    method: "POST",
    body: JSON.stringify({ reportTypeId: YOUTUBE_REACH_REPORT_TYPE, name: YOUTUBE_REACH_JOB_NAME }),
  });
  if (typeof made.id !== "string" || !made.id) throw new YouTubeReportingError("jobs.create não devolveu o id do job", "error", null);
  return { jobId: made.id, created: true };
}

export interface ReachReportRef {
  id: string;
  startTime: string;
  endTime: string;
  createTime: string;
  downloadUrl: string;
}

export async function listReachReports(fetchFn: FetchLike, token: string, jobId: string): Promise<ReachReportRef[]> {
  const items = await listAll(fetchFn, token, `${YOUTUBE_REPORTING_API_BASE}/jobs/${encodeURIComponent(jobId)}/reports`, "reports");
  return items
    .filter((r) => typeof r.id === "string" && typeof r.downloadUrl === "string")
    .map((r) => ({
      id: r.id as string,
      startTime: String(r.startTime ?? ""),
      endTime: String(r.endTime ?? ""),
      createTime: String(r.createTime ?? ""),
      downloadUrl: r.downloadUrl as string,
    }))
    .sort((a, b) => a.createTime.localeCompare(b.createTime) || a.id.localeCompare(b.id));
}

export async function downloadReachReport(fetchFn: FetchLike, token: string, ref: ReachReportRef): Promise<string> {
  return reportingCall(fetchFn, token, ref.downloadUrl);
}

/**
 * Coleta da execução: garante o job, lista os relatórios e baixa os que ainda
 * não estão em `knownReportIds`. Falha de UM download vira aviso (os demais
 * seguem); falha de job/listagem sobe como `YouTubeReportingError`, que o
 * snapshot transforma em aviso sem derrubar o resto.
 */
export async function collectReach(
  fetchFn: FetchLike,
  token: string,
  input: { capturedAt: string; knownReportIds: ReadonlySet<string>; dryRun: boolean; warn: (m: string) => void },
): Promise<{ summary: ReachSummary; daily: ReachDailyLine[]; reports: ReachReportLine[] }> {
  const summary: ReachSummary = {
    status: input.dryRun ? "dry-run" : "ok",
    jobId: null,
    jobCreated: false,
    reportsListed: 0,
    reportsDownloaded: 0,
    rowsAdded: 0,
    failures: 0,
  };
  const daily: ReachDailyLine[] = [];
  const reports: ReachReportLine[] = [];
  const job = await ensureReachJob(fetchFn, token, { create: !input.dryRun });
  summary.jobId = job.jobId;
  summary.jobCreated = job.created;
  if (!job.jobId) return { summary, daily, reports };
  const refs = await listReachReports(fetchFn, token, job.jobId);
  summary.reportsListed = refs.length;
  for (const ref of refs.filter((r) => !input.knownReportIds.has(r.id)).slice(0, YOUTUBE_REACH_MAX_DOWNLOADS)) {
    let lines: ReachDailyLine[];
    try {
      const csv = await downloadReachReport(fetchFn, token, ref);
      lines = parseReachCsv(csv, { capturedAt: input.capturedAt, reportId: ref.id, reportCreateTime: ref.createTime });
    } catch (e) {
      if (e instanceof YouTubeReportingError && e.kind !== "error") throw e;
      summary.failures++;
      input.warn(`[aviso] relatório de alcance ${ref.id} (${ref.startTime}) indisponível: ${(e as Error).message}`);
      continue;
    }
    summary.reportsDownloaded++;
    summary.rowsAdded += lines.length;
    daily.push(...lines);
    reports.push({ capturedAt: input.capturedAt, reportId: ref.id, jobId: job.jobId, startTime: ref.startTime, endTime: ref.endTime, createTime: ref.createTime, rows: lines.length });
  }
  return { summary, daily, reports };
}
