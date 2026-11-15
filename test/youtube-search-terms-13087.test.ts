/**
 * #13087 — termos de busca do YouTube no snapshot diário (`search-terms.jsonl`).
 *
 * Fetch sempre mockado (nunca a API real). Cobre: a consulta
 * (`insightTrafficSourceDetail` + `YT_SEARCH`, canal e `video==ID`, 25 termos,
 * 28 dias), a gravação append-only, a lista vazia como resultado válido
 * (limiar de privacidade), falha de uma consulta como aviso, o fail-soft do
 * escopo ausente e a tabela do `--report` com a dedup por execução.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  YOUTUBE_ANALYTICS_FILES,
  YOUTUBE_SEARCH_TERMS_MAX_RESULTS,
  buildAnalyticsQueryUrl,
  latestSearchTerms,
  renderAnalyticsReport,
  resolveSearchTermsWindow,
  searchTermsQuery,
  toSearchTermLines,
  type ChannelSnapshotLine,
  type SearchTermLine,
} from "../scripts/lib/diaria/youtube-analytics.ts";
import { buildReport, runSnapshot, type SnapshotDeps } from "../scripts/youtube-analytics-snapshot.ts";

const H = "HHHHHHHHHH1";
const S = "SSSSSSSSSS1";
const NOW = new Date("2026-11-15T14:35:00Z"); // 11:35 BRT

function table(headers: string[], rows: unknown[][] | undefined) {
  return { kind: "youtubeAnalytics#resultTable", columnHeaders: headers.map((name) => ({ name })), ...(rows ? { rows } : {}) };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

type TermsResponse = { status: number; body: string } | unknown[][] | undefined;

/**
 * Fetch mockado. `terms` responde a consulta de termos por chave (`channel` ou
 * o id do vídeo): linhas, `undefined` (resposta sem `rows`, o caso do limiar de
 * privacidade) ou `{status, body}` para falha.
 */
function mockFetch(terms: Record<string, TermsResponse>) {
  const calls: string[] = [];
  const fetch = async (url: string): Promise<Response> => {
    calls.push(url);
    if (url.startsWith("https://oauth2.googleapis.com/token")) return json({ access_token: "tok" });
    if (url.includes("/youtube/v3/channels")) return json({ items: [{ statistics: { subscriberCount: "50" } }] });
    if (url.includes("/youtube/v3/videos")) {
      return json({
        items: [
          { id: H, snippet: { title: "Horizontal | 261114" }, contentDetails: { duration: "PT6M" } },
          { id: S, snippet: { title: "Short 261114" }, contentDetails: { duration: "PT50S" } },
        ],
      });
    }
    if (url.startsWith("https://youtubeanalytics.googleapis.com/v2/reports")) {
      const p = new URL(url).searchParams;
      const dims = p.get("dimensions");
      if (dims === "day") return json(table(["day", "views", "estimatedMinutesWatched", "subscribersGained", "subscribersLost"], [["2026-11-14", 10, 20, 1, 0]]));
      if (dims === "day,insightTrafficSourceType") return json(table(["day", "insightTrafficSourceType", "views"], [["2026-11-14", "YT_SEARCH", 4]]));
      if (dims === "video") {
        return json(
          table(["video", "views", "estimatedMinutesWatched", "averageViewDuration", "averageViewPercentage", "subscribersGained", "subscribersLost"], [
            [S, 300, 200, 40, 80, 3, 0],
            [H, 100, 400, 200, 40, 1, 0],
          ]),
        );
      }
      if (dims === "elapsedVideoTimeRatio") return json(table(["elapsedVideoTimeRatio", "audienceWatchRatio"], [[0.5, 0.5]]));
      if (dims === "insightTrafficSourceDetail") {
        const filters = p.get("filters") ?? "";
        const m = /video==([^;]+)/.exec(filters);
        const r = terms[m ? m[1] : "channel"];
        if (r && !Array.isArray(r)) return new Response((r as { body: string }).body, { status: (r as { status: number }).status });
        return json(table(["insightTrafficSourceDetail", "views", "estimatedMinutesWatched"], r as unknown[][] | undefined));
      }
    }
    return new Response("inesperado", { status: 404 });
  };
  return { fetch, calls };
}

function deps(fetch: SnapshotDeps["fetch"], now = NOW): SnapshotDeps & { warnings: string[] } {
  const warnings: string[] = [];
  return { fetch, now: () => now, log: () => {}, warn: (m) => warnings.push(m), warnings };
}

const CREDS = { clientId: "id", clientSecret: "secret", refreshToken: "refresh" };

function readLines<T>(dataRoot: string, file: string): T[] {
  const p = join(dataRoot, "youtube-analytics", file);
  return existsSync(p) ? readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as T) : [];
}

const termCalls = (calls: string[]) => calls.filter((u) => u.includes("analytics") && new URL(u).searchParams.get("dimensions") === "insightTrafficSourceDetail");

describe("#13087 consulta de termos de busca", () => {
  it("janela móvel de 28 dias terminando ontem (BRT)", () => {
    assert.deepEqual(resolveSearchTermsWindow(NOW), { startDate: "2026-10-18", endDate: "2026-11-14" });
    // 01:00 UTC ainda é o dia anterior em BRT.
    assert.deepEqual(resolveSearchTermsWindow(new Date("2026-11-15T01:00:00Z")), { startDate: "2026-10-17", endDate: "2026-11-13" });
  });

  it("canal: YT_SEARCH, insightTrafficSourceDetail, -views, até 25; vídeo acrescenta video==ID", () => {
    const w = { startDate: "2026-10-18", endDate: "2026-11-14" };
    const chan = new URL(buildAnalyticsQueryUrl(searchTermsQuery(w))).searchParams;
    assert.equal(chan.get("dimensions"), "insightTrafficSourceDetail");
    assert.equal(chan.get("filters"), "insightTrafficSourceType==YT_SEARCH");
    assert.equal(chan.get("sort"), "-views");
    assert.equal(chan.get("maxResults"), "25");
    assert.equal(YOUTUBE_SEARCH_TERMS_MAX_RESULTS, 25);
    assert.equal(chan.get("metrics"), "views,estimatedMinutesWatched");
    assert.equal(chan.get("startDate"), "2026-10-18");
    const vid = new URL(buildAnalyticsQueryUrl(searchTermsQuery(w, H))).searchParams;
    assert.equal(vid.get("filters"), `insightTrafficSourceType==YT_SEARCH;video==${H}`);
  });

  it("linhas: escopo pelo videoId, termo vazio fica de fora, resposta vazia vira lista vazia", () => {
    const base = { capturedAt: "c", date: "2026-11-15", startDate: "2026-10-18", endDate: "2026-11-14" };
    const rows = [
      { insightTrafficSourceDetail: "ia", views: 5, estimatedMinutesWatched: 3 },
      { insightTrafficSourceDetail: "  ", views: 1, estimatedMinutesWatched: 1 },
      { insightTrafficSourceDetail: null, views: 1, estimatedMinutesWatched: 1 },
    ];
    const chan = toSearchTermLines({ ...base, rows });
    assert.deepEqual(chan.map((l) => [l.scope, l.videoId, l.term, l.views]), [["channel", null, "ia", 5]]);
    const vid = toSearchTermLines({ ...base, rows, videoId: H });
    assert.deepEqual(vid.map((l) => [l.scope, l.videoId]), [["video", H]]);
    assert.deepEqual(toSearchTermLines({ ...base, rows: [] }), []);
  });
});

describe("#13087 runSnapshot grava search-terms.jsonl (fetch mockado)", () => {
  it("canal + cada vídeo, com termo, views, minutos, escopo e janela; resumo na linha do canal", async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "yst-"));
    const { fetch, calls } = mockFetch({
      channel: [["inteligencia artificial", 12, 30], ["chatgpt", 7, 10]],
      [S]: [["chatgpt", 4, 2]],
      [H]: undefined,
    });
    const d = deps(fetch);
    const r = await runSnapshot(d, { credentials: CREDS, dataRoot, index: new Map() });
    assert.equal(termCalls(calls).length, 3, "1 do canal + 1 por vídeo");
    const lines = readLines<SearchTermLine>(dataRoot, YOUTUBE_ANALYTICS_FILES.searchTerms);
    assert.equal(YOUTUBE_ANALYTICS_FILES.searchTerms, "search-terms.jsonl");
    assert.deepEqual(
      lines.map((l) => [l.scope, l.videoId, l.term, l.views, l.estimatedMinutesWatched, l.startDate, l.endDate, l.date]),
      [
        ["channel", null, "inteligencia artificial", 12, 30, "2026-10-18", "2026-11-14", "2026-11-15"],
        ["channel", null, "chatgpt", 7, 10, "2026-10-18", "2026-11-14", "2026-11-15"],
        ["video", S, "chatgpt", 4, 2, "2026-10-18", "2026-11-14", "2026-11-15"],
      ],
    );
    assert.ok(lines.every((l) => l.capturedAt === r.channel.capturedAt), "mesma execução, mesmo capturedAt");
    const ch = readLines<ChannelSnapshotLine>(dataRoot, YOUTUBE_ANALYTICS_FILES.channel);
    assert.deepEqual(ch[0].searchTerms, { startDate: "2026-10-18", endDate: "2026-11-14", channelTerms: 2, videosQueried: 2, videoTerms: 1, failures: 0 });
    assert.equal(d.warnings.length, 0, "vídeo sem termos não é aviso");

    const md = buildReport(dataRoot);
    assert.match(md, /## Termos de busca no YouTube \(2026-10-18 a 2026-11-14, captura de 2026-11-15\)/);
    assert.match(md, /\| inteligencia artificial \| 12 \| 30 \|/);
    assert.match(md, /\| Short 261114 \(SSSSSSSSSS1\) \| chatgpt \| 4 \| 2 \|/);
    assert.ok(md.indexOf("| inteligencia artificial |") < md.indexOf("| chatgpt | 7 |"), "ordenado por views");
  });

  it("lista vazia (limiar de privacidade) NÃO é falha: sem aviso, sem linha, relatório diz que é válido", async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "yst-"));
    const { fetch } = mockFetch({ channel: undefined, [S]: [], [H]: undefined });
    const d = deps(fetch);
    const r = await runSnapshot(d, { credentials: CREDS, dataRoot, index: new Map() });
    assert.equal(r.channel.analytics, "ok");
    assert.equal(d.warnings.length, 0);
    assert.deepEqual(r.searchTerms, []);
    assert.equal(existsSync(join(dataRoot, "youtube-analytics", "search-terms.jsonl")), false, "nada a anexar");
    assert.deepEqual(r.channel.searchTerms, { startDate: "2026-10-18", endDate: "2026-11-14", channelTerms: 0, videosQueried: 2, videoTerms: 0, failures: 0 });
    const md = buildReport(dataRoot);
    assert.match(md, /## Termos de busca no YouTube \(2026-10-18 a 2026-11-14, captura de 2026-11-15\)/);
    assert.match(md, /limiar de privacidade/);
    assert.match(md, /Nenhum termo acima do limiar de privacidade nesta janela/);
    assert.match(md, /Nenhum termo acima do limiar de privacidade nos 2 vídeo\(s\) consultado\(s\)/);
  });

  it("falha real de uma consulta vira aviso; o resto dos termos e do snapshot é gravado", async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "yst-"));
    const { fetch } = mockFetch({ channel: { status: 400, body: "bad request" }, [S]: [["claude", 2, 1]] });
    const d = deps(fetch);
    const r = await runSnapshot(d, { credentials: CREDS, dataRoot, index: new Map() });
    assert.equal(r.channel.analytics, "ok");
    assert.equal(readLines(dataRoot, YOUTUBE_ANALYTICS_FILES.videos).length, 2);
    assert.equal(readLines(dataRoot, YOUTUBE_ANALYTICS_FILES.retention).length, 2);
    assert.deepEqual(readLines<SearchTermLine>(dataRoot, YOUTUBE_ANALYTICS_FILES.searchTerms).map((l) => l.term), ["claude"]);
    assert.equal(r.channel.searchTerms?.channelTerms, null);
    assert.equal(r.channel.searchTerms?.failures, 1);
    assert.ok(d.warnings.some((w) => /termos de busca do canal indisponíveis/.test(w) && /respondeu 400/.test(w)));
    assert.match(buildReport(dataRoot), /Consulta do canal falhou nesta captura/);
  });

  it("escopo ausente detectado só nos termos cai no fail-soft do snapshot inteiro", async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "yst-"));
    const { fetch } = mockFetch({ channel: [["ia", 1, 1]], [S]: { status: 403, body: "Request had insufficient authentication scopes." } });
    const r = await runSnapshot(deps(fetch), { credentials: CREDS, dataRoot, index: new Map() });
    assert.equal(r.channel.analytics, "missing-scope");
    assert.equal(r.channel.searchTerms, undefined);
    assert.deepEqual(r.searchTerms, []);
    assert.equal(readLines(dataRoot, YOUTUBE_ANALYTICS_FILES.searchTerms).length, 0);
    assert.equal(readLines(dataRoot, YOUTUBE_ANALYTICS_FILES.channel).length, 1);
  });

  it("append-only entre execuções; o relatório mostra só a execução mais recente", async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "yst-"));
    await runSnapshot(deps(mockFetch({ channel: [["termo velho", 9, 9]] }).fetch, new Date("2026-11-14T14:35:00Z")), { credentials: CREDS, dataRoot, index: new Map() });
    // Mesmo dia, duas execuções: a 2ª não pode somar com a 1ª.
    await runSnapshot(deps(mockFetch({ channel: [["termo a", 3, 1]] }).fetch), { credentials: CREDS, dataRoot, index: new Map() });
    await runSnapshot(deps(mockFetch({ channel: [["termo b", 5, 2]] }).fetch, new Date("2026-11-15T16:00:00Z")), { credentials: CREDS, dataRoot, index: new Map() });
    assert.equal(readLines(dataRoot, YOUTUBE_ANALYTICS_FILES.searchTerms).length, 3, "append-only");
    const md = buildReport(dataRoot);
    assert.match(md, /\| termo b \| 5 \| 2 \|/);
    assert.doesNotMatch(md, /\| termo a \||termo velho/);
  });

  it("execução mais recente vazia mostra vazio, não a lista da anterior", async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "yst-"));
    await runSnapshot(deps(mockFetch({ channel: [["termo velho", 9, 9]] }).fetch, new Date("2026-11-14T14:35:00Z")), { credentials: CREDS, dataRoot, index: new Map() });
    await runSnapshot(deps(mockFetch({}).fetch), { credentials: CREDS, dataRoot, index: new Map() });
    const md = buildReport(dataRoot);
    assert.doesNotMatch(md, /termo velho/);
    assert.match(md, /captura de 2026-11-15/);
    assert.match(md, /Nenhum termo acima do limiar de privacidade nesta janela/);
  });

  it("--dry-run consulta os termos e não grava", async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "yst-"));
    const { fetch, calls } = mockFetch({ channel: [["ia", 1, 1]] });
    const r = await runSnapshot(deps(fetch), { credentials: CREDS, dataRoot, index: new Map(), dryRun: true });
    assert.equal(termCalls(calls).length, 3);
    assert.equal(r.searchTerms.length, 1);
    assert.equal(existsSync(join(dataRoot, "youtube-analytics")), false);
  });
});

describe("#13087 relatório", () => {
  it("store sem coleta: seção diz que ainda não há coleta; sem searchTerms a seção é omitida", () => {
    const empty = renderAnalyticsReport({ channel: [], daily: [], traffic: [], videos: [], searchTerms: [] });
    assert.match(empty, /Sem coleta de termos de busca gravada ainda/);
    const legacy = renderAnalyticsReport({ channel: [], daily: [], traffic: [], videos: [] });
    assert.doesNotMatch(legacy, /Termos de busca/);
  });

  it("store anterior ao resumo na linha do canal: último date, cada escopo na captura mais recente", () => {
    const l = (capturedAt: string, date: string, term: string, videoId: string | null = null): SearchTermLine => ({
      capturedAt, date, scope: videoId ? "video" : "channel", videoId, startDate: "a", endDate: "b", term, views: 1, estimatedMinutesWatched: 1,
    });
    const out = latestSearchTerms([l("1", "2026-11-14", "velho"), l("2", "2026-11-15", "x"), l("3", "2026-11-15", "y"), l("2", "2026-11-15", "v", H)]);
    assert.equal(out.date, "2026-11-15");
    assert.equal(out.summary, null);
    assert.deepEqual(out.lines.map((x) => x.term).sort(), ["v", "y"]);
  });

  it("termo com barra vertical não quebra a tabela", () => {
    const md = renderAnalyticsReport({
      channel: [],
      daily: [],
      traffic: [],
      videos: [],
      searchTerms: [{ capturedAt: "1", date: "2026-11-15", scope: "channel", videoId: null, startDate: "a", endDate: "b", term: "ia | claude", views: 2, estimatedMinutesWatched: 1 }],
    });
    assert.match(md, /\| ia \/ claude \| 2 \| 1 \|/);
  });
});
