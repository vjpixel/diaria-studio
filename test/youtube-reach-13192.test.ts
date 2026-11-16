/**
 * #13192 — impressões e taxa de cliques da capa por vídeo.
 *
 * A YouTube Analytics API não expõe essas métricas; elas vêm da YouTube
 * Reporting API (`channel_reach_basic_a1`). Cobre o miolo puro
 * (`scripts/lib/diaria/youtube-reach.ts`), a coleta com fetch mockado (nunca
 * rede real) e a integração no snapshot (`videos.jsonl` + relatório).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  YOUTUBE_REACH_REPORT_TYPE,
  YouTubeReportingError,
  aggregateReachByVideo,
  collectReach,
  currentReachDaily,
  parseReachCsv,
  reachDay,
  splitCsvLine,
  type ReachDailyLine,
} from "../scripts/lib/diaria/youtube-reach.ts";
import { fmtCtr, renderAnalyticsReport, type ChannelSnapshotLine, type VideoSnapshotLine } from "../scripts/lib/diaria/youtube-analytics.ts";
import { buildReport, runSnapshot, type SnapshotDeps } from "../scripts/youtube-analytics-snapshot.ts";

const H = "HHHHHHHHHH1";
const S = "SSSSSSSSSS1";
const NOW = new Date("2026-11-16T14:35:00Z");
const META = { capturedAt: "2026-11-16T14:35:00.000Z", reportId: "r1", reportCreateTime: "2026-11-15T10:00:00Z" };
const CSV_HEADER = "date,channel_id,video_id,video_thumbnail_impressions,video_thumbnail_impressions_ctr";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function line(day: string, videoId: string, impressions: number, clicks: number, reportCreateTime: string, capturedAt = "2026-11-16T00:00:00Z"): ReachDailyLine {
  return { capturedAt, reportId: reportCreateTime, reportCreateTime, day, videoId, impressions, clicks, ctr: impressions ? clicks / impressions : null, ctrRaw: null, ctrScale: "fraction" };
}

describe("#13192 CSV do channel_reach_basic_a1", () => {
  it("lê pelo cabeçalho (ordem livre), data YYYYMMDD, taxa em fração", () => {
    const csv = ["video_thumbnail_impressions_ctr,video_id,date,channel_id,video_thumbnail_impressions", `0.05,${H},20261110,UC,200`, `0.01,${S},20261110,UC,100`, ""].join("\n");
    const rows = parseReachCsv(csv, META);
    const h = rows.find((r) => r.videoId === H)!;
    assert.equal(h.day, "2026-11-10");
    assert.equal(h.impressions, 200);
    assert.equal(h.clicks, 10);
    assert.equal(h.ctr, 0.05);
    assert.equal(h.ctrScale, "fraction");
    assert.equal(h.reportId, "r1");
  });

  it("valor > 1 no arquivo: escala percentual, dividida por 100 (valor cru preservado)", () => {
    const rows = parseReachCsv([CSV_HEADER, `20261110,UC,${H},500,2.2`, `20261110,UC,${S},100,0.8`].join("\n"), META);
    const h = rows.find((r) => r.videoId === H)!;
    const s = rows.find((r) => r.videoId === S)!;
    assert.equal(h.ctrScale, "percent");
    assert.ok(Math.abs(h.ctr! - 0.022) < 1e-12);
    assert.ok(Math.abs(s.ctr! - 0.008) < 1e-12, "0,8 no mesmo arquivo percentual é 0,8%, não 80%");
    assert.equal(s.ctrRaw, 0.8);
  });

  it("linhas repetidas do par dia/vídeo somam por cliques estimados", () => {
    const rows = parseReachCsv([CSV_HEADER, `20261110,UC,${H},100,0.1`, `20261110,UC,${H},300,0.02`].join("\n"), META);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].impressions, 400);
    assert.ok(Math.abs(rows[0].ctr! - 16 / 400) < 1e-12);
  });

  it("só cabeçalho (dia sem dado) é lista vazia; coluna obrigatória ausente lança", () => {
    assert.deepEqual(parseReachCsv(CSV_HEADER + "\n", META), []);
    assert.deepEqual(parseReachCsv("", META), []);
    assert.throws(() => parseReachCsv("date,video_id,views\n20261110,x,3", META), /video_thumbnail_impressions/);
  });

  it("CSV com aspas e datas", () => {
    assert.deepEqual(splitCsvLine('a,"b,c","d""e"'), ["a", "b,c", 'd"e']);
    assert.equal(reachDay("20261110"), "2026-11-10");
    assert.equal(reachDay("2026-11-10"), "2026-11-10");
    assert.equal(reachDay("10/11/2026"), null);
  });

  it("vídeo sem impressão: taxa null, nunca NaN", () => {
    const rows = parseReachCsv([CSV_HEADER, `20261110,UC,${H},0,0`].join("\n"), META);
    assert.equal(rows[0].ctr, null);
  });
});

describe("#13192 dedup e agregação", () => {
  it("backfill (createTime mais novo) substitui o dia inteiro, inclusive vídeo que sumiu", () => {
    const old = [line("2026-11-10", H, 100, 1, "2026-11-11T00:00:00Z"), line("2026-11-10", S, 50, 5, "2026-11-11T00:00:00Z")];
    const backfill = [line("2026-11-10", H, 120, 3, "2026-11-14T00:00:00Z")];
    const cur = currentReachDaily([...backfill, ...old]);
    assert.equal(cur.length, 1);
    assert.equal(cur[0].impressions, 120);
  });

  it("soma por vídeo dentro da janela; taxa ponderada por impressões", () => {
    const rows = [
      line("2026-10-20", H, 999, 999, "a"),
      line("2026-11-10", H, 100, 5, "b"),
      line("2026-11-11", H, 300, 3, "c"),
      line("2026-11-11", S, 0, 0, "c"),
    ];
    const agg = aggregateReachByVideo(rows, { startDate: "2026-10-21", endDate: "2026-11-15" });
    const h = agg.get(H)!;
    assert.equal(h.impressions, 400);
    assert.equal(h.ctr, 8 / 400);
    assert.equal(h.firstDay, "2026-11-10");
    assert.equal(h.lastDay, "2026-11-11");
    assert.equal(agg.get(S)!.ctr, null);
  });

  it("fmtCtr: fração em %, sem dado vira travessão", () => {
    assert.equal(fmtCtr(0.022), "2,2%");
    assert.equal(fmtCtr(null), "—");
    assert.equal(fmtCtr(undefined), "—");
  });
});

/** Mock da Reporting API. `jobs` null = nenhum job; `failList` força status na listagem de jobs. */
function reportingMock(opts: {
  jobs?: Array<{ id: string; reportTypeId: string }>;
  reports?: Array<{ id: string; startTime: string; createTime: string; csv: string | { status: number; body: string } }>;
  failJobs?: { status: number; body: string };
}) {
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  const fetch = async (url: string, init?: RequestInit): Promise<Response | null> => {
    if (!url.startsWith("https://youtubereporting.googleapis.com") && !url.startsWith("https://dl.test/")) return null;
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: typeof init?.body === "string" ? init.body : undefined });
    if (url === "https://youtubereporting.googleapis.com/v1/jobs" && method === "GET") {
      if (opts.failJobs) return new Response(opts.failJobs.body, { status: opts.failJobs.status });
      return json(opts.jobs ? { jobs: opts.jobs } : {});
    }
    if (url === "https://youtubereporting.googleapis.com/v1/jobs" && method === "POST") return json({ id: "novo", reportTypeId: YOUTUBE_REACH_REPORT_TYPE });
    const m = /\/v1\/jobs\/([^/]+)\/reports/.exec(url);
    if (m) {
      return json({
        reports: (opts.reports ?? []).map((r) => ({ id: r.id, jobId: m[1], startTime: r.startTime, endTime: r.startTime, createTime: r.createTime, downloadUrl: `https://dl.test/${r.id}` })),
      });
    }
    const d = /^https:\/\/dl\.test\/(.+)$/.exec(url);
    if (d) {
      const r = (opts.reports ?? []).find((x) => x.id === d[1]);
      if (!r) return new Response("", { status: 404 });
      return typeof r.csv === "string" ? new Response(r.csv, { status: 200 }) : new Response(r.csv.body, { status: r.csv.status });
    }
    return new Response("inesperado", { status: 404 });
  };
  return { fetch, calls };
}

function only(mock: ReturnType<typeof reportingMock>) {
  return async (url: string, init?: RequestInit) => (await mock.fetch(url, init)) ?? new Response("inesperado", { status: 404 });
}

describe("#13192 coleta da Reporting API (fetch mockado)", () => {
  const csv1 = [CSV_HEADER, `20261110,UC,${H},200,0.05`].join("\n");

  it("job existente: lista e baixa só os relatórios ainda não baixados", async () => {
    const mock = reportingMock({
      jobs: [{ id: "outro", reportTypeId: "channel_basic_a2" }, { id: "j1", reportTypeId: YOUTUBE_REACH_REPORT_TYPE }],
      reports: [
        { id: "old", startTime: "2026-11-09T08:00:00Z", createTime: "2026-11-10T00:00:00Z", csv: csv1 },
        { id: "new", startTime: "2026-11-10T08:00:00Z", createTime: "2026-11-11T00:00:00Z", csv: csv1 },
      ],
    });
    const warnings: string[] = [];
    const out = await collectReach(only(mock), "tok", { capturedAt: "c", knownReportIds: new Set(["old"]), dryRun: false, warn: (m) => warnings.push(m) });
    assert.equal(out.summary.jobId, "j1");
    assert.equal(out.summary.jobCreated, false);
    assert.equal(out.summary.reportsListed, 2);
    assert.equal(out.summary.reportsDownloaded, 1);
    assert.deepEqual(out.reports.map((r) => r.reportId), ["new"]);
    assert.ok(!mock.calls.some((c) => c.url.endsWith("/old")), "relatório já baixado não é baixado de novo");
    assert.ok(!mock.calls.some((c) => c.method === "POST"), "job existente não é recriado");
    assert.deepEqual(warnings, []);
  });

  it("sem job: cria o do channel_reach_basic_a1 (relatórios só em até 48h)", async () => {
    const mock = reportingMock({});
    const out = await collectReach(only(mock), "tok", { capturedAt: "c", knownReportIds: new Set(), dryRun: false, warn: () => {} });
    const post = mock.calls.find((c) => c.method === "POST")!;
    assert.equal(JSON.parse(post.body!).reportTypeId, YOUTUBE_REACH_REPORT_TYPE);
    assert.equal(out.summary.jobId, "novo");
    assert.equal(out.summary.jobCreated, true);
    assert.equal(out.summary.reportsDownloaded, 0);
  });

  it("--dry-run nunca cria o job", async () => {
    const mock = reportingMock({});
    const out = await collectReach(only(mock), "tok", { capturedAt: "c", knownReportIds: new Set(), dryRun: true, warn: () => {} });
    assert.ok(!mock.calls.some((c) => c.method === "POST"));
    assert.equal(out.summary.jobId, null);
    assert.equal(out.summary.status, "dry-run");
  });

  it("download que falha vira aviso e os demais seguem; o falho não fica marcado como baixado", async () => {
    const mock = reportingMock({
      jobs: [{ id: "j1", reportTypeId: YOUTUBE_REACH_REPORT_TYPE }],
      reports: [
        { id: "bad", startTime: "2026-11-09T08:00:00Z", createTime: "2026-11-10T00:00:00Z", csv: { status: 500, body: "boom" } },
        { id: "ok", startTime: "2026-11-10T08:00:00Z", createTime: "2026-11-11T00:00:00Z", csv: csv1 },
      ],
    });
    const warnings: string[] = [];
    const out = await collectReach(only(mock), "tok", { capturedAt: "c", knownReportIds: new Set(), dryRun: false, warn: (m) => warnings.push(m) });
    assert.equal(out.summary.failures, 1);
    assert.deepEqual(out.reports.map((r) => r.reportId), ["ok"]);
    assert.ok(warnings.some((w) => w.includes("bad")));
  });

  it("Reporting API desligada: erro classificado api-disabled", async () => {
    const mock = reportingMock({ failJobs: { status: 403, body: '{"error":{"status":"PERMISSION_DENIED","message":"YouTube Reporting API has not been used in project 1"}}' } });
    await assert.rejects(
      collectReach(only(mock), "tok", { capturedAt: "c", knownReportIds: new Set(), dryRun: false, warn: () => {} }),
      (e: unknown) => e instanceof YouTubeReportingError && e.kind === "api-disabled" && /YouTube Reporting API/.test(e.message),
    );
  });
});

// ─── Integração no snapshot ─────────────────────────────────────────────────

function table(headers: string[], rows: unknown[][] | undefined) {
  return { kind: "youtubeAnalytics#resultTable", columnHeaders: headers.map((name) => ({ name })), ...(rows ? { rows } : {}) };
}

function snapshotFetch(reporting: ReturnType<typeof reportingMock>) {
  return async (url: string, init?: RequestInit): Promise<Response> => {
    const r = await reporting.fetch(url, init);
    if (r) return r;
    if (url.startsWith("https://oauth2.googleapis.com/token")) return json({ access_token: "tok" });
    if (url.includes("/youtube/v3/channels")) return json({ items: [{ id: "UC", statistics: { subscriberCount: "50", viewCount: "900", videoCount: "20" } }] });
    if (url.includes("/youtube/v3/videos")) {
      return json({
        items: [
          { id: H, snippet: { title: "Horizontal" }, contentDetails: { duration: "PT5M" } },
          { id: S, snippet: { title: "Short" }, contentDetails: { duration: "PT50S" } },
        ],
      });
    }
    if (url.startsWith("https://youtubeanalytics.googleapis.com/v2/reports")) {
      const dims = new URL(url).searchParams.get("dimensions");
      if (dims === "day") return json(table(["day", "views", "estimatedMinutesWatched", "subscribersGained", "subscribersLost"], [["2026-11-14", 10, 20, 1, 0]]));
      if (dims === "day,insightTrafficSourceType") return json(table(["day", "insightTrafficSourceType", "views"], []));
      if (dims === "video") {
        return json(
          table(["video", "views", "estimatedMinutesWatched", "averageViewDuration", "averageViewPercentage", "subscribersGained", "subscribersLost"], [
            [S, 300, 200, 40, 80, 3, 0],
            [H, 100, 400, 200, 40, 1, 0],
          ]),
        );
      }
      if (dims === "elapsedVideoTimeRatio") return json(table(["elapsedVideoTimeRatio", "audienceWatchRatio"], [[0.5, 0.5]]));
      if (dims === "insightTrafficSourceDetail") return json(table(["insightTrafficSourceDetail", "views", "estimatedMinutesWatched"], undefined));
    }
    return new Response("inesperado", { status: 404 });
  };
}

function deps(fetch: SnapshotDeps["fetch"]): SnapshotDeps & { warnings: string[] } {
  const warnings: string[] = [];
  return { fetch, now: () => NOW, log: () => {}, warn: (m) => warnings.push(m), warnings };
}

const CREDS = { clientId: "id", clientSecret: "secret", refreshToken: "refresh" };

function readLines<T>(dataRoot: string, file: string): T[] {
  const p = join(dataRoot, "youtube-analytics", file);
  return existsSync(p) ? (readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) as T[]) : [];
}

describe("#13192 runSnapshot: capa em videos.jsonl", () => {
  const reports = [
    { id: "r10", startTime: "2026-11-10T08:00:00Z", createTime: "2026-11-11T00:00:00Z", csv: [CSV_HEADER, `20261110,UC,${H},200,0.05`].join("\n") },
    { id: "r11", startTime: "2026-11-11T08:00:00Z", createTime: "2026-11-12T00:00:00Z", csv: [CSV_HEADER, `20261111,UC,${H},300,0.0`].join("\n") },
  ];

  it("grava reach-daily/reach-reports e soma impressões e taxa na linha do vídeo", async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "yt-reach-"));
    const mock = reportingMock({ jobs: [{ id: "j1", reportTypeId: YOUTUBE_REACH_REPORT_TYPE }], reports });
    const d = deps(snapshotFetch(mock));
    await runSnapshot(d, { credentials: CREDS, dataRoot, index: new Map() });
    const videos = readLines<VideoSnapshotLine>(dataRoot, "videos.jsonl");
    const h = videos.find((v) => v.videoId === H)!;
    assert.equal(h.thumbnailImpressions, 500);
    assert.equal(h.thumbnailCtr, 10 / 500);
    assert.equal(h.reachLastDay, "2026-11-11");
    const s = videos.find((v) => v.videoId === S)!;
    assert.equal(s.thumbnailImpressions, null, "vídeo sem relatório de alcance: null, não 0");
    assert.equal(readLines(dataRoot, "reach-daily.jsonl").length, 2);
    assert.equal(readLines(dataRoot, "reach-reports.jsonl").length, 2);
    const channel = readLines<ChannelSnapshotLine>(dataRoot, "channel.jsonl")[0];
    assert.equal(channel.analytics, "ok");
    assert.equal(channel.reach?.status, "ok");
    assert.deepEqual(d.warnings, []);

    const md = buildReport(dataRoot);
    assert.match(md, /Impressões da capa \| CTR da capa \|/);
    assert.match(md, new RegExp(`\\(${H}\\) .*\\| 500 \\| 2,0% \\|`));
    assert.match(md, new RegExp(`\\(${S}\\) .*\\| — \\| — \\|`));

    // 2ª execução: não re-baixa e segue somando o que já estava gravado.
    mock.calls.length = 0;
    await runSnapshot(d, { credentials: CREDS, dataRoot, index: new Map() });
    assert.ok(!mock.calls.some((c) => c.url.startsWith("https://dl.test/")), "relatórios já baixados não são baixados de novo");
    const latest = readLines<VideoSnapshotLine>(dataRoot, "videos.jsonl").filter((v) => v.videoId === H).pop()!;
    assert.equal(latest.thumbnailImpressions, 500);
  });

  it("Reporting API desligada não derruba o snapshot: Analytics segue ok, capa null e aviso", async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "yt-reach-"));
    const mock = reportingMock({ failJobs: { status: 403, body: "accessNotConfigured" } });
    const d = deps(snapshotFetch(mock));
    const res = await runSnapshot(d, { credentials: CREDS, dataRoot, index: new Map() });
    assert.equal(res.channel.analytics, "ok");
    assert.equal(res.channel.reach?.status, "api-disabled");
    assert.equal(res.videos.length, 2);
    assert.ok(res.videos.every((v) => v.thumbnailImpressions === null));
    assert.ok(d.warnings.some((w) => /YouTube Reporting API/.test(w)));
    assert.match(buildReport(dataRoot), /Aviso: impressões e taxa de cliques da capa indisponíveis/);
  });

  it("job criado nesta captura: relatório avisa que o 1º relatório sai em até 48h", async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "yt-reach-"));
    const d = deps(snapshotFetch(reportingMock({})));
    await runSnapshot(d, { credentials: CREDS, dataRoot, index: new Map() });
    assert.match(buildReport(dataRoot), /job da YouTube Reporting API criado nesta captura; o 1º relatório sai em até 48h/);
  });

  it("store anterior ao #13192 (sem campo de capa): tabela sem as colunas novas", () => {
    const v: VideoSnapshotLine = {
      capturedAt: "c", date: "2026-11-01", videoId: H, title: "t", kind: "horizontal", edition: "261101",
      startDate: "2026-10-21", endDate: "2026-10-31", views: 1, estimatedMinutesWatched: 1, averageViewDuration: 1, averageViewPercentage: 1, subscribersGained: 0, subscribersLost: 0,
    };
    const md = renderAnalyticsReport({ channel: [], daily: [], traffic: [], videos: [v] });
    assert.doesNotMatch(md, /CTR da capa/);
  });
});
