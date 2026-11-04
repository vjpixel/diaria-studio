/**
 * #12075 — snapshot diário do YouTube Analytics do @diariabr.
 *
 * Cobre o miolo puro (`scripts/lib/diaria/youtube-analytics.ts`), o fluxo do
 * snapshot com fetch mockado (`runSnapshot`, nunca rede real), o fail-soft do
 * token sem `yt-analytics.readonly`, o índice vídeo → edição e o registro da
 * task agendada.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  YOUTUBE_ANALYTICS_SCOPE,
  addDays,
  brtIsoDate,
  buildAnalyticsQueryUrl,
  classifyAnalyticsFailure,
  fmtSec,
  latestByKey,
  parseChannelStatistics,
  parseIsoDuration,
  parseResultTable,
  renderAnalyticsReport,
  resolveDailyWindow,
  toVideoSnapshotLines,
  type ChannelSnapshotLine,
  type VideoSnapshotLine,
} from "../scripts/lib/diaria/youtube-analytics.ts";
import { buildEditionVideoIndex, buildReport, runSnapshot, type SnapshotDeps } from "../scripts/youtube-analytics-snapshot.ts";
import { YOUTUBE_OAUTH_SCOPES, missingGrantedScopes, missingOptionalScopes } from "../scripts/lib/youtube-oauth.ts";
import { getScheduledTaskByName } from "../scripts/lib/scheduled-tasks.ts";

const H = "HHHHHHHHHH1"; // horizontal da edição 261103
const S = "SSSSSSSSSS1"; // Short da edição 261103
const X = "XXXXXXXXXX1"; // corte extra, sem registro de edição

const NOW = new Date("2026-11-04T14:35:00Z"); // 11:35 BRT

function table(headers: string[], rows: unknown[][] | undefined) {
  return { kind: "youtubeAnalytics#resultTable", columnHeaders: headers.map((name) => ({ name })), ...(rows ? { rows } : {}) };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** Fetch mockado: responde por URL; `analyticsStatus` força falha na Analytics API. */
function mockFetch(opts: { analyticsStatus?: number; analyticsBody?: string; retentionFail?: Record<string, { status: number; body: string }> } = {}) {
  const calls: string[] = [];
  const fetch = async (url: string): Promise<Response> => {
    calls.push(url);
    if (url.startsWith("https://oauth2.googleapis.com/token")) return json({ access_token: "tok" });
    if (url.includes("/youtube/v3/channels")) return json({ items: [{ id: "UC", statistics: { subscriberCount: "41", viewCount: "900", videoCount: "20" } }] });
    if (url.includes("/youtube/v3/videos")) {
      return json({
        items: [
          { id: H, snippet: { title: "Horizontal 261103" }, contentDetails: { duration: "PT6M10S" } },
          { id: S, snippet: { title: "Short 261103" }, contentDetails: { duration: "PT58S" } },
          { id: X, snippet: { title: "Corte extra" }, contentDetails: { duration: "PT1M30S" } },
        ],
      });
    }
    if (url.startsWith("https://youtubeanalytics.googleapis.com/v2/reports")) {
      if (opts.analyticsStatus) return new Response(opts.analyticsBody ?? "", { status: opts.analyticsStatus });
      const p = new URL(url).searchParams;
      const dims = p.get("dimensions");
      if (dims === "day") return json(table(["day", "views", "estimatedMinutesWatched", "subscribersGained", "subscribersLost"], [["2026-11-02", 120, 300, 3, 1], ["2026-11-03", 80, 200, 1, 0]]));
      if (dims === "day,insightTrafficSourceType") return json(table(["day", "insightTrafficSourceType", "views"], [["2026-11-02", "SHORTS", 90], ["2026-11-02", "EXT_URL", 30]]));
      if (dims === "video") {
        return json(
          table(["video", "views", "estimatedMinutesWatched", "averageViewDuration", "averageViewPercentage", "subscribersGained", "subscribersLost"], [
            [S, 500, 400, 48, 82.5, 6, 1],
            [H, 150, 600, 240, 40.1, 2, 0],
            [X, 90, 60, 40, 44.0, 0, 0],
          ]),
        );
      }
      if (dims === "elapsedVideoTimeRatio") {
        const vid = (p.get("filters") ?? "").replace("video==", "");
        const fail = opts.retentionFail?.[vid];
        if (fail) return new Response(fail.body, { status: fail.status });
        return json(table(["elapsedVideoTimeRatio", "audienceWatchRatio"], vid === X ? undefined : [[0.5, 0.4], [0.01, 1.0]]));
      }
    }
    return new Response("inesperado", { status: 404 });
  };
  return { fetch, calls };
}

function deps(fetch: SnapshotDeps["fetch"]): SnapshotDeps & { warnings: string[] } {
  const warnings: string[] = [];
  return { fetch, now: () => NOW, log: () => {}, warn: (m) => warnings.push(m), warnings };
}

const CREDS = { clientId: "id", clientSecret: "secret", refreshToken: "refresh" };

function readLines(dataRoot: string, file: string): unknown[] {
  const p = join(dataRoot, "youtube-analytics", file);
  return existsSync(p) ? readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
}

describe("#12075 escopo yt-analytics.readonly", () => {
  it("é pedido no setup e é OPCIONAL (token antigo segue servindo para o vídeo)", () => {
    assert.ok((YOUTUBE_OAUTH_SCOPES as readonly string[]).includes(YOUTUBE_ANALYTICS_SCOPE));
    const old = "https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/youtube.force-ssl";
    assert.deepEqual(missingGrantedScopes(old), []);
    assert.deepEqual(missingOptionalScopes(old), [YOUTUBE_ANALYTICS_SCOPE]);
  });
});

describe("#12075 miolo puro", () => {
  it("datas BRT e soma de dias", () => {
    assert.equal(brtIsoDate(new Date("2026-11-04T02:00:00Z")), "2026-11-03");
    assert.equal(addDays("2026-10-31", 1), "2026-11-01");
    assert.throws(() => addDays("261031", 1));
  });

  it("janela diária: sem histórico desde 21/10; com histórico re-busca 7 dias; --since vence", () => {
    assert.deepEqual(resolveDailyWindow({ now: NOW, lastStoredDay: null }), { startDate: "2026-10-21", endDate: "2026-11-03" });
    assert.deepEqual(resolveDailyWindow({ now: NOW, lastStoredDay: "2026-11-02" }), { startDate: "2026-10-26", endDate: "2026-11-03" });
    assert.deepEqual(resolveDailyWindow({ now: NOW, lastStoredDay: "2026-10-22" }), { startDate: "2026-10-21", endDate: "2026-11-03" });
    assert.deepEqual(resolveDailyWindow({ now: NOW, lastStoredDay: "2026-11-02", since: "2026-10-25" }), { startDate: "2026-10-25", endDate: "2026-11-03" });
  });

  it("URL da consulta leva ids=channel==MINE e os parâmetros", () => {
    const u = new URL(buildAnalyticsQueryUrl({ startDate: "2026-10-21", endDate: "2026-11-03", metrics: ["views"], dimensions: ["video"], sort: "-views", maxResults: 200 }));
    assert.equal(u.searchParams.get("ids"), "channel==MINE");
    assert.equal(u.searchParams.get("dimensions"), "video");
    assert.equal(u.searchParams.get("maxResults"), "200");
  });

  it("resultTable: sem rows é vazia; sem columnHeaders lança", () => {
    assert.deepEqual(parseResultTable(table(["day", "views"], undefined)), []);
    assert.deepEqual(parseResultTable(table(["day", "views"], [["2026-11-01", 3]])), [{ day: "2026-11-01", views: 3 }]);
    assert.throws(() => parseResultTable({ rows: [] }), /columnHeaders/);
  });

  it("classifica a falha: escopo ausente, API desligada, resto", () => {
    assert.equal(classifyAnalyticsFailure(403, '{"error":{"status":"PERMISSION_DENIED","details":[{"reason":"ACCESS_TOKEN_SCOPE_INSUFFICIENT"}]}}'), "missing-scope");
    assert.equal(classifyAnalyticsFailure(403, "Request had insufficient authentication scopes."), "missing-scope");
    assert.equal(classifyAnalyticsFailure(403, "YouTube Analytics API has not been used in project 123 before or it is disabled"), "api-disabled");
    assert.equal(classifyAnalyticsFailure(403, '{"reason":"forbidden"}'), "error");
    assert.equal(classifyAnalyticsFailure(500, "boom"), "error");
  });

  it("duração ISO e estatísticas do canal", () => {
    assert.equal(parseIsoDuration("PT58S"), 58);
    assert.equal(parseIsoDuration("PT1H2M3S"), 3723);
    assert.equal(parseIsoDuration("PT"), null);
    assert.equal(parseIsoDuration(null), null);
    assert.deepEqual(parseChannelStatistics({ items: [{ statistics: { subscriberCount: "40" } }] }), { subscriberCount: 40, viewCount: null, videoCount: null });
    assert.deepEqual(parseChannelStatistics({}), { subscriberCount: null, viewCount: null, videoCount: null });
  });

  it("tipo do vídeo: o registro da edição vence; sem ele a duração decide (≤ 3 min = Short)", () => {
    const lines = toVideoSnapshotLines({
      rows: [{ video: H, views: 1 }, { video: X, views: 1 }, { video: "ZZZZZZZZZZ1", views: 1 }],
      capturedAt: "c", date: "2026-11-04", startDate: "2026-10-21", endDate: "2026-11-03",
      index: new Map([[H, { edition: "261103", kind: "horizontal" as const }]]),
      meta: new Map([[H, { title: "h", durationSec: 30 }], [X, { title: "x", durationSec: 90 }]]),
    });
    assert.deepEqual(lines.map((l) => [l.videoId, l.kind, l.edition]), [[H, "horizontal", "261103"], [X, "short", null], ["ZZZZZZZZZZ1", "desconhecido", null]]);
  });

  it("fmtSec arredonda o total antes de dividir: nunca \"0:60\" (review #12137)", () => {
    assert.equal(fmtSec(59.6), "1:00");
    assert.equal(fmtSec(119.5), "2:00");
    assert.equal(fmtSec(48), "0:48");
    assert.equal(fmtSec(240.4), "4:00");
    assert.equal(fmtSec(0), "0:00");
  });

  it("latestByKey: a captura mais recente vence", () => {
    const out = latestByKey([{ capturedAt: "1", day: "d", v: 1 }, { capturedAt: "2", day: "d", v: 2 }, { capturedAt: "1", day: "e", v: 3 }], (l) => l.day);
    assert.deepEqual(out.map((l) => l.v).sort(), [2, 3]);
  });
});

describe("#12075 runSnapshot (fetch mockado)", () => {
  it("grava as 5 séries; Short e horizontal saem com a edição; corte extra pela duração", async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "yta-"));
    const { fetch } = mockFetch();
    const index = new Map([[H, { edition: "261103", kind: "horizontal" as const }], [S, { edition: "261103", kind: "short" as const }]]);
    const r = await runSnapshot(deps(fetch), { credentials: CREDS, dataRoot, index });
    assert.equal(r.channel.analytics, "ok");
    assert.equal(r.channel.subscriberCount, 41);
    const ch = readLines(dataRoot, "channel.jsonl") as ChannelSnapshotLine[];
    assert.equal(ch.length, 1);
    assert.equal(ch[0].date, "2026-11-04");
    assert.equal(readLines(dataRoot, "channel-daily.jsonl").length, 2);
    assert.equal(readLines(dataRoot, "traffic-sources.jsonl").length, 2);
    const videos = readLines(dataRoot, "videos.jsonl") as VideoSnapshotLine[];
    assert.deepEqual(videos.map((v) => [v.videoId, v.kind, v.edition, v.subscribersGained]), [[S, "short", "261103", 6], [H, "horizontal", "261103", 2], [X, "short", null, 0]]);
    const ret = readLines(dataRoot, "retention.jsonl") as Array<{ videoId: string; points: number[][] }>;
    assert.deepEqual(ret.map((l) => l.videoId), [S, H], "vídeo sem curva não grava linha");
    assert.deepEqual(ret[0].points, [[0.01, 1.0], [0.5, 0.4]], "curva ordenada pelo tempo");

    const md = buildReport(dataRoot);
    const shorts = md.indexOf("### Shorts");
    const horiz = md.indexOf("### Horizontais");
    assert.ok(shorts >= 0 && horiz > shorts, "Shorts e horizontais em tabelas separadas");
    assert.match(md, /\| 261103 \| Short 261103 \(SSSSSSSSSS1\) \| 500 \|/);
    assert.match(md, /\| 2026-11-04 \| 41 \|/);
    assert.match(md, /SHORTS/);
  });

  it("2ª execução re-busca só a janela recente e o relatório deduplica", async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "yta-"));
    const first = mockFetch();
    await runSnapshot(deps(first.fetch), { credentials: CREDS, dataRoot, index: new Map() });
    const second = mockFetch();
    await runSnapshot(deps(second.fetch), { credentials: CREDS, dataRoot, index: new Map() });
    const daily = second.calls.find((u) => new URL(u).searchParams.get("dimensions") === "day");
    assert.equal(new URL(daily!).searchParams.get("startDate"), "2026-10-27", "último dia gravado (03/11) − 7");
    assert.equal(readLines(dataRoot, "channel-daily.jsonl").length, 4, "append-only");
    const md = buildReport(dataRoot);
    assert.equal(md.split("\n").filter((l) => l.startsWith("| 2026-11-02 |")).length, 1, "dia repetido aparece uma vez");
  });

  it("token sem yt-analytics.readonly: não lança, grava só o total do canal e avisa (fail-soft)", async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "yta-"));
    const { fetch } = mockFetch({ analyticsStatus: 403, analyticsBody: "Request had insufficient authentication scopes." });
    const d = deps(fetch);
    const r = await runSnapshot(d, { credentials: CREDS, dataRoot, index: new Map() });
    assert.equal(r.channel.analytics, "missing-scope");
    assert.equal(r.channel.subscriberCount, 41);
    assert.equal(readLines(dataRoot, "channel.jsonl").length, 1);
    assert.equal(readLines(dataRoot, "videos.jsonl").length, 0);
    assert.ok(d.warnings.some((w) => /youtube-oauth-setup\.ts/.test(w)));
    assert.match(buildReport(dataRoot), /Aviso: última captura/);
  });

  it("erro real da Analytics API (500) lança e não grava nada", async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "yta-"));
    const { fetch } = mockFetch({ analyticsStatus: 500, analyticsBody: "boom" });
    await assert.rejects(runSnapshot(deps(fetch), { credentials: CREDS, dataRoot, index: new Map() }), /respondeu 500/);
    assert.equal(existsSync(join(dataRoot, "youtube-analytics")), false);
  });

  it("falha real na retenção de UM vídeo vira aviso; total do canal e demais séries são gravados (review #12137)", async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "yta-"));
    const { fetch } = mockFetch({ retentionFail: { [S]: { status: 400, body: "no curve" } } });
    const d = deps(fetch);
    const r = await runSnapshot(d, { credentials: CREDS, dataRoot, index: new Map() });
    assert.equal(r.channel.analytics, "ok");
    assert.equal(readLines(dataRoot, "channel.jsonl").length, 1);
    assert.equal(readLines(dataRoot, "channel-daily.jsonl").length, 2);
    assert.equal(readLines(dataRoot, "videos.jsonl").length, 3);
    const ret = readLines(dataRoot, "retention.jsonl") as Array<{ videoId: string }>;
    assert.deepEqual(ret.map((l) => l.videoId), [H], "a curva que falhou fica de fora, as outras seguem");
    assert.ok(d.warnings.some((w) => w.includes(S) && /respondeu 400/.test(w)));
  });

  it("escopo ausente detectado só na retenção ainda cai no fail-soft do canal inteiro", async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "yta-"));
    const { fetch } = mockFetch({ retentionFail: { [S]: { status: 403, body: "Request had insufficient authentication scopes." } } });
    const r = await runSnapshot(deps(fetch), { credentials: CREDS, dataRoot, index: new Map() });
    assert.equal(r.channel.analytics, "missing-scope");
    assert.equal(readLines(dataRoot, "channel.jsonl").length, 1);
    assert.equal(readLines(dataRoot, "retention.jsonl").length, 0);
  });

  it("--dry-run busca e não grava", async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "yta-"));
    const r = await runSnapshot(deps(mockFetch().fetch), { credentials: CREDS, dataRoot, index: new Map(), dryRun: true });
    assert.equal(r.written, false);
    assert.equal(existsSync(join(dataRoot, "youtube-analytics")), false);
  });
});

describe("#12075 índice vídeo → edição", () => {
  it("lê o registro do horizontal e o do Short; edição anterior ao corte fica de fora; ilegível vira aviso", () => {
    const root = mkdtempSync(join(tmpdir(), "yta-ed-"));
    const ed = (aammdd: string) => {
      const dir = join(root, aammdd.slice(0, 4), aammdd, "_internal");
      mkdirSync(dir, { recursive: true });
      return dir;
    };
    writeFileSync(join(ed("261103"), "05-youtube-published.json"), JSON.stringify({ videoId: H, url: `https://youtu.be/${H}`, status: "uploaded" }));
    writeFileSync(
      join(ed("261103"), "06-shorts-published.json"),
      JSON.stringify({ aammdd: "261103", entries: [{ destination: "youtube_shorts", id: S, url: `https://youtube.com/shorts/${S}`, status: "published", at: "2026-11-03T15:00:00Z" }] }),
    );
    writeFileSync(join(ed("261020"), "05-youtube-published.json"), JSON.stringify({ videoId: "OLDOLDOLD01" }));
    writeFileSync(join(ed("261104"), "05-youtube-published.json"), "{quebrado");
    const { index, warnings } = buildEditionVideoIndex(root, "261021");
    assert.deepEqual(index.get(H), { edition: "261103", kind: "horizontal" });
    assert.deepEqual(index.get(S), { edition: "261103", kind: "short" });
    assert.equal(index.has("OLDOLDOLD01"), false);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /^261104:/);
  });

  it("sem data/editions: índice vazio com aviso, sem lançar", () => {
    const { index, warnings } = buildEditionVideoIndex(join(tmpdir(), "nao-existe-12075"), "261021");
    assert.equal(index.size, 0);
    assert.equal(warnings.length, 1);
  });
});

describe("#12075 task agendada", () => {
  it("Diaria-YouTube-Analytics-Snapshot roda o script, diária, com guard de data/editions", () => {
    const t = getScheduledTaskByName("Diaria-YouTube-Analytics-Snapshot");
    assert.ok(t);
    assert.deepEqual(t!.steps.map((s) => s.script), ["scripts/youtube-analytics-snapshot.ts"]);
    assert.equal(t!.schedule.kind, "daily");
    assert.equal(t!.guard?.requiredFile, "editions");
    assert.notEqual(t!.enabled, false);
  });
});

describe("#12075 relatório sem dado", () => {
  it("store vazio não lança", () => {
    const md = renderAnalyticsReport({ channel: [], daily: [], traffic: [], videos: [] });
    assert.match(md, /Sem snapshot por vídeo/);
  });
});
