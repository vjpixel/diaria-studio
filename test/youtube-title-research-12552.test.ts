/**
 * #12552 — pesquisa de títulos do D1 no YouTube (vocabulário, nunca decisão).
 * Mock da API: caso ok (ranking por views + termos de topo), sem resultado,
 * cota esgotada, sem credencial, e o gate refazendo a busca quando o D1 mudou.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildResearchQueries,
  extractProperNouns,
  formatGateBlock,
  formatViews,
  researchMatchesD1,
  runTitleResearch,
  topTerms,
  YOUTUBE_TITLE_RESEARCH_FILE,
  type ResearchVideo,
} from "../scripts/lib/diaria/youtube-title-research.ts";
import { readD1FromApproved, researchAndWrite } from "../scripts/youtube-title-research.ts";

const NOW = new Date("2026-11-09T12:00:00Z");
const D1 = { title: "Nvidia: CEO admite caso com suposta espiã", url: "https://www.bbc.com/news/articles/nvidia-ceo-affair-chinese-spy" };

type Route = (url: string) => { status: number; body: unknown };

function mockFetch(route: Route): { fetch: (url: string, init?: RequestInit) => Promise<Response>; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    fetch: async (url: string) => {
      calls.push(url);
      const r = route(url);
      return new Response(typeof r.body === "string" ? r.body : JSON.stringify(r.body), { status: r.status });
    },
  };
}

const VIDEOS = [
  { id: "a", title: "Nvidia CEO admits affair with suspected Chinese spy", channel: "BBC News", views: "1600000", lang: "en" },
  { id: "b", title: "Jensen Huang admits affair, suspected spy probe", channel: "CBS News", views: "820000", lang: "en" },
  { id: "c", title: "CEO da Nvidia admite caso com suposta espiã chinesa", channel: "CNN Brasil", views: "45000", lang: "pt-BR" },
  { id: "d", title: "Suspected Chinese spy: what Nvidia knew", channel: "DW News", views: "400000", lang: "en" },
];

const okRoute: Route = (url) => {
  if (url.includes("oauth2.googleapis.com")) return { status: 200, body: { access_token: "tok" } };
  if (url.includes("/search?")) return { status: 200, body: { items: VIDEOS.map((v) => ({ id: { videoId: v.id } })) } };
  if (url.includes("/videos?")) {
    return {
      status: 200,
      body: {
        items: VIDEOS.map((v) => ({
          id: v.id,
          snippet: { title: v.title, channelTitle: v.channel, defaultAudioLanguage: v.lang, publishedAt: "2026-11-08T10:00:00Z" },
          statistics: { viewCount: v.views },
          contentDetails: { duration: "PT2M10S" },
        })),
      },
    };
  }
  return { status: 404, body: "?" };
};

const CREDS = { credentials: { clientId: "c", clientSecret: "s", refreshToken: "r" }, missing: [] as string[] };

test("queries: nomes próprios do título + termo principal (PT) + slug da URL (EN), teto de 3", () => {
  assert.deepEqual(extractProperNouns(D1.title), ["Nvidia", "CEO"]);
  const qs = buildResearchQueries(D1);
  assert.equal(qs.length, 3);
  assert.equal(qs[0], "Nvidia CEO");
  assert.match(qs[1], /^Nvidia CEO admite caso$/);
  assert.match(qs[2], /affair/);
  assert.deepEqual(buildResearchQueries(D1, ["a", "A", "b", "c", "d"]), ["a", "b", "c"]);
});

test("pesquisa ok: ordena por views, grava campos e conta termos de topo sem os nomes próprios do D1", async () => {
  const m = mockFetch(okRoute);
  const r = await runTitleResearch(m.fetch, { d1: D1, edition: "261109", accessToken: "tok", apiBase: "https://yt", now: NOW });
  assert.equal(r.status, "ok");
  assert.deepEqual(r.videos.map((v) => v.videoId), ["a", "b", "d", "c"]);
  assert.equal(r.videos[0].views, 1_600_000);
  assert.equal(r.videos[0].durationSec, 130);
  assert.equal(r.videos[2].language, "en");
  const terms = r.top_terms.map((t) => t.term);
  assert.ok(terms.includes("suspected"));
  assert.ok(terms.includes("affair"));
  assert.ok(!terms.includes("nvidia"), "nome próprio do D1 não é vocabulário novo");
  const search = m.calls.find((u) => u.includes("/search?"))!;
  assert.match(search, /order=viewCount/);
  assert.match(search, /type=video/);
  assert.match(search, /publishedAfter=2026-11-05T12%3A00%3A00Z/);
});

test("sem resultado: status no_results, sem chamar videos.list", async () => {
  const m = mockFetch((url) => (url.includes("/search?") ? { status: 200, body: { items: [] } } : { status: 500, body: "x" }));
  const r = await runTitleResearch(m.fetch, { d1: D1, edition: null, accessToken: "tok", apiBase: "https://yt", now: NOW });
  assert.equal(r.status, "no_results");
  assert.equal(r.videos.length, 0);
  assert.ok(!m.calls.some((u) => u.includes("/videos?")));
  assert.match(formatGateBlock(r), /nenhum vídeo recente/);
});

test("cota esgotada em todas as queries: status error com motivo legível, nunca lança", async () => {
  const quota = { error: { errors: [{ reason: "quotaExceeded" }] } };
  const m = mockFetch((url) => (url.includes("/search?") ? { status: 403, body: quota } : { status: 200, body: {} }));
  const r = await runTitleResearch(m.fetch, { d1: D1, edition: null, accessToken: "tok", apiBase: "https://yt", now: NOW });
  assert.equal(r.status, "error");
  assert.match(r.reason ?? "", /cota diária/);
  assert.match(formatGateBlock(r), /^⚠️ Pesquisa de títulos no YouTube indisponível \(.*cota/);
});

test("uma query falhando não derruba as outras (vira warning)", async () => {
  let n = 0;
  const m = mockFetch((url) => {
    if (url.includes("/search?") && n++ === 0) return { status: 500, body: "boom" };
    return okRoute(url);
  });
  const r = await runTitleResearch(m.fetch, { d1: D1, edition: null, accessToken: "tok", apiBase: "https://yt", now: NOW });
  assert.equal(r.status, "ok");
  assert.equal(r.warnings.length, 1);
});

function editionWithApproved(d1 = D1): string {
  const dir = join(mkdtempSync(join(tmpdir(), "yt-research-")), "261109");
  mkdirSync(join(dir, "_internal"), { recursive: true });
  writeFileSync(join(dir, "_internal", "01-approved.json"), JSON.stringify({ highlights: [{ rank: 1, url: d1.url, article: d1 }] }));
  return dir;
}

test("CLI: sem credencial grava arquivo skipped e não chama rede (fail-soft)", async () => {
  const dir = editionWithApproved();
  const m = mockFetch(okRoute);
  const warns: string[] = [];
  const r = await researchAndWrite(
    { fetch: m.fetch, now: () => NOW, warn: (w) => warns.push(w), credentials: { credentials: null, missing: ["YOUTUBE_REFRESH_TOKEN"] } },
    { editionDir: dir, approvedPath: join(dir, "_internal", "01-approved.json") },
  );
  assert.equal(r.status, "skipped");
  assert.equal(m.calls.length, 0);
  const saved = JSON.parse(readFileSync(join(dir, YOUTUBE_TITLE_RESEARCH_FILE), "utf8"));
  assert.equal(saved.status, "skipped");
  assert.match(saved.reason, /YOUTUBE_REFRESH_TOKEN/);
  assert.ok(warns.some((w) => w.includes("skipped")));
});

test("CLI: token recusado vira status error, sem lançar", async () => {
  const dir = editionWithApproved();
  const m = mockFetch((url) => (url.includes("oauth2") ? { status: 400, body: { error: "invalid_grant" } } : okRoute(url)));
  const r = await researchAndWrite(
    { fetch: m.fetch, now: () => NOW, warn: () => {}, credentials: CREDS },
    { editionDir: dir, approvedPath: join(dir, "_internal", "01-approved.json") },
  );
  assert.equal(r.status, "error");
  assert.match(r.reason ?? "", /^token:/);
  assert.ok(existsSync(join(dir, YOUTUBE_TITLE_RESEARCH_FILE)));
});

test("CLI: pesquisa ok grava o JSON com edição e D1; o gate mostra termos e top 3", async () => {
  const dir = editionWithApproved();
  const r = await researchAndWrite(
    { fetch: mockFetch(okRoute).fetch, now: () => NOW, warn: () => {}, credentials: CREDS },
    { editionDir: dir, approvedPath: join(dir, "_internal", "01-approved.json") },
  );
  assert.equal(r.edition, "261109");
  assert.deepEqual(r.d1, D1);
  const block = formatGateBlock(r);
  assert.match(block, /Termos que mais se repetem no topo: .*suspected/);
  assert.match(block, /"Nvidia CEO admits affair with suspected Chinese spy" \(BBC News, 1,6 mi views\)/);
  assert.match(block, /1 em português/);
  assert.match(block, /Só vocabulário/);
});

test("arquivo do D1 antigo não vale para o D1 novo (gate refaz a busca)", () => {
  const d1 = readD1FromApproved(join(editionWithApproved(), "_internal", "01-approved.json"));
  assert.deepEqual(d1, D1);
  const r = { d1: D1 } as Parameters<typeof researchMatchesD1>[0];
  assert.equal(researchMatchesD1(r, { ...D1, url: D1.url + "#x" }), true);
  assert.equal(researchMatchesD1(r, { title: "outro", url: "https://example.com/outra" }), false);
  assert.equal(researchMatchesD1(null, D1), false);
});

test("formatViews e topTerms exigem repetição em 2+ títulos", () => {
  assert.equal(formatViews(1_600_000), "1,6 mi views");
  assert.equal(formatViews(2_000_000), "2 mi views");
  assert.equal(formatViews(412_300), "412 mil views");
  assert.equal(formatViews(null), "? views");
  const v = (title: string): ResearchVideo => ({ videoId: title, title, channel: "", views: 1, durationSec: null, language: null, publishedAt: null, query: "" });
  assert.deepEqual(topTerms([v("alpha beta gamma"), v("alpha delta")], []), [{ term: "alpha", count: 2 }]);
});

test("gate sem arquivo: aviso, nunca bloqueia", () => {
  assert.match(formatGateBlock(null), /indisponível \(arquivo ausente\)/);
});
