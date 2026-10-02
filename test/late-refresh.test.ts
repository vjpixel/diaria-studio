import { test } from "node:test";
import assert from "node:assert/strict";
import {
  IMPRECISE_DATE_LOOKBACK_MS,
  LATE_REFRESH_FEEDS,
  LATE_REFRESH_UNCOVERED_LABS,
  canonicalUrlSet,
  filterLateArticles,
  formatLateRefreshBlock,
  isImpreciseTimestamp,
  resolveCutoffs,
  selectSitemapEntries,
  suggestSubstitution,
  summarizeLateThreads,
  type LateArticle,
  type LateRefreshReport,
} from "../scripts/lib/late-refresh.ts";
import { threadsToLateInputs } from "../scripts/late-refresh-candidates.ts";

const CUTOFF = "2026-09-29T19:42:10.973Z";

function art(url: string, published_at: string | null, title = "Post"): LateArticle {
  return { url, title, published_at, lab: "OpenAI", source: "OpenAI News" };
}

test("resolveCutoffs: usa start do Stage 1 e do Stage 0 do stage-status.json", () => {
  const r = resolveCutoffs(
    { rows: [{ stage: 0, start: "2026-09-29T19:40:15.539Z" }, { stage: 1, start: CUTOFF }] },
    { completed_at: "2026-09-29T20:00:00.000Z" },
  );
  assert.deepEqual(r, { research_cutoff: CUTOFF, newsletter_cutoff: "2026-09-29T19:40:15.539Z", origin: "stage-status" });
});

test("resolveCutoffs: fallback .step-1-done.json; nada → origin none", () => {
  assert.equal(resolveCutoffs(undefined, { completed_at: "2026-09-29T20:00:00Z" }).origin, "step-1-done");
  assert.equal(resolveCutoffs({ rows: [{ stage: 1, start: "lixo" }] }, undefined).origin, "none");
});

test("isImpreciseTimestamp: hora cheia é imprecisa, minuto quebrado não", () => {
  assert.equal(isImpreciseTimestamp("2026-09-29T10:00:00.000Z"), true);
  assert.equal(isImpreciseTimestamp("2026-09-30T10:30:00.000Z"), false);
  assert.equal(isImpreciseTimestamp("2026-09-30T20:01:45.000Z"), false);
});

test("filterLateArticles: caso real 260930 — GPT-6.1 Sol com pubDate arredondado ANTES do corte entra", () => {
  // RSS da OpenAI: "Introducing GPT-6.1 Sol" = 29/09 10:00 GMT; a pesquisa da
  // 260930 começou 29/09 19:42Z e o item virou inclusão manual na 261001.
  const sol = art("https://openai.com/index/introducing-gpt-6-1-sol", "2026-09-29T10:00:00.000Z", "Introducing GPT-6.1 Sol");
  const r = filterLateArticles([sol], CUTOFF, new Set(), new Set(), "2026-09-29T22:00:00Z");
  assert.deepEqual(r.fresh.map((a) => a.url), [sol.url]);
});

test("filterLateArticles: data precisa antes do corte sai; hora cheia além da folga sai; depois de now sai", () => {
  const precise = art("https://openai.com/index/a", "2026-09-29T19:00:01.000Z");
  const tooOld = art("https://openai.com/index/b", new Date(new Date(CUTOFF).getTime() - IMPRECISE_DATE_LOOKBACK_MS - 3600_000).toISOString().replace(/\d\d:\d\d\.\d+Z$/, "00:00.000Z"));
  const future = art("https://openai.com/index/c", "2026-09-30T05:00:00.000Z");
  const late = art("https://openai.com/index/d", "2026-09-29T21:15:33.000Z");
  const noDate = art("https://openai.com/index/e", null);
  const r = filterLateArticles([precise, tooOld, future, late, noDate], CUTOFF, new Set(), new Set(), "2026-09-29T22:00:00Z");
  assert.deepEqual(r.fresh.map((a) => a.url), [late.url]);
});

test("filterLateArticles: dedup separa edição atual, edições anteriores e novo (URL canonicalizada)", () => {
  const inEd = art("https://openai.com/index/introducing-dots/", "2026-09-29T21:00:00Z");
  const past = art("https://openai.com/index/old?utm_source=x", "2026-09-29T21:00:00Z");
  const fresh = art("https://openai.com/index/new", "2026-09-29T21:00:00Z");
  const inEdition = canonicalUrlSet("D2 https://openai.com/index/introducing-dots");
  const published = canonicalUrlSet("- https://openai.com/index/old");
  const r = filterLateArticles([inEd, past, fresh, fresh], CUTOFF, inEdition, published);
  assert.equal(r.already_in_edition.length, 1);
  assert.equal(r.already_published.length, 1);
  assert.deepEqual(r.fresh.map((a) => a.url), [fresh.url]);
});

test("summarizeLateThreads: pula thread já capturada, anterior ao corte ou sem URL nova", () => {
  const base = { sender: "TLDR AI <dan@tldrnewsletter.com>", subject: "OpenAI Dots, GPT-6.1 Sol", date: "2026-09-29T21:00:00Z" };
  const out = summarizeLateThreads(
    [
      { ...base, thread_id: "captured", urls: ["https://x.com/a"] },
      { ...base, thread_id: "early", date: "2026-09-29T18:00:00Z", urls: ["https://x.com/b"] },
      { ...base, thread_id: "stale", urls: ["https://openai.com/index/introducing-dots"] },
      { ...base, thread_id: "late", urls: ["https://openai.com/index/introducing-gpt-6-1-sol", "https://example.com/z"] },
      { ...base, thread_id: "after-now", date: "2026-09-30T13:48:53Z", urls: ["https://example.com/y"] },
    ],
    new Set(["captured"]),
    CUTOFF,
    canonicalUrlSet("https://openai.com/index/introducing-dots"),
    new Set(),
    "2026-09-29T23:00:00Z",
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].sender, "TLDR AI");
  assert.equal(out[0].new_urls, 2);
  assert.deepEqual(out[0].lab_urls, ["https://openai.com/index/introducing-gpt-6-1-sol"]);
  assert.equal(out[0].mentions_flagship, true);
});

test("threadsToLateInputs: reusa processThreads sem consumir cursor nenhum", () => {
  const inputs = threadsToLateInputs([
    { thread_id: "t1", sender: "TLDR AI <dan@tldrnewsletter.com>", subject: "s", date: "2026-09-29T21:00:00Z", body: "Leia https://openai.com/index/introducing-gpt-6-1-sol hoje" },
  ]);
  assert.equal(inputs.length, 1);
  assert.ok(inputs[0].urls.some((u) => u.includes("introducing-gpt-6-1-sol")));
});

test("suggestSubstitution: lançamento oficial de modelo → D de menor score, protegendo manual e único negativo", () => {
  const highlights = [
    { rank: 1, score: 50, bucket: "noticias", negative_impact: true, url: "https://a" },
    { rank: 2, score: 65, bucket: "lancamento", url: "https://b" },
    { rank: 3, score: null, bucket: "manual", url: "https://c" },
  ];
  const s = suggestSubstitution({ url: "https://openai.com/index/introducing-gpt-6-1-sol", title: "Introducing GPT-6.1 Sol" }, highlights);
  assert.equal(s.target, "destaque");
  assert.equal(s.slot, "D2");
});

test("suggestSubstitution: sem D substituível → slot '?'; post oficial sem anúncio → RADAR; anúncio → LANÇAMENTOS", () => {
  const onlyManual = [{ rank: 1, score: null, bucket: "manual" }];
  assert.equal(suggestSubstitution({ url: "https://openai.com/index/introducing-gpt-6-1-sol", title: "Introducing GPT-6.1 Sol" }, onlyManual).slot, "?");
  assert.equal(suggestSubstitution({ url: "https://openai.com/index/albertsons", title: "How Albertsons is reimagining retail" }, []).slot, "RADAR");
  assert.equal(suggestSubstitution({ url: "https://openai.com/index/introducing-dots", title: "Introducing dots" }, []).slot, "LANÇAMENTOS");
  assert.equal(suggestSubstitution({ url: "https://example.com/x", title: "Algo" }, []).reason, "fonte não oficial");
});

test("formatLateRefreshBlock: skipped, vazio e com candidatos — sem markdown", () => {
  const base: LateRefreshReport = {
    generated_at: "2026-09-29T22:00:00Z",
    cutoffs: { research_cutoff: CUTOFF, newsletter_cutoff: CUTOFF, origin: "stage-status" },
    feeds: [{ name: "OpenAI News", lab: "OpenAI", ok: false, items_after_cutoff: 0, error: "HTTP 500" }],
    uncovered_labs: ["Meta"],
    candidates: [],
    already_in_edition: 0,
    already_published: 0,
    newsletters: [],
  };
  assert.match(formatLateRefreshBlock({ ...base, skipped_reason: "x" }), /indisponível: x/);
  const empty = formatLateRefreshBlock(base);
  assert.match(empty, /Nada novo/);
  assert.match(empty, /feeds com falha: OpenAI News/);
  assert.match(empty, /29\/09 16:42 BRT/);
  const full = formatLateRefreshBlock({
    ...base,
    candidates: [{ ...art("https://openai.com/index/introducing-gpt-6-1-sol", "2026-09-29T10:00:00Z", "Introducing GPT-6.1 Sol"), suggestion: { target: "destaque", slot: "D2", reason: "r" } }],
    newsletters: [{ sender: "TLDR AI", subject: "s", date: "2026-09-29T21:00:00Z", new_urls: 3, lab_urls: [], mentions_flagship: true }],
  });
  assert.match(full, /substituir D2/);
  assert.match(full, /⚡ TLDR AI/);
  assert.doesNotMatch(full, /\*\*|^#|^- /m);
});

test("LATE_REFRESH_FEEDS: todo feed é de host de laboratório conhecido e sitemap sempre tem pathPrefix", () => {
  for (const f of LATE_REFRESH_FEEDS) {
    assert.ok(/^https:\/\//.test(f.url), f.name);
    if (f.method === "sitemap") assert.ok(f.pathPrefix, `${f.name} sem pathPrefix`);
  }
});

test("suggestSubstitution: editor REORDENOU os destaques no Stage 4 — slot vem da ordem do 02-reviewed.md, não do rank", () => {
  // approved: D1=a(80) D2=b(65) D3=c(70). Editor trocou: agora D1=b, D2=c, D3=a.
  const highlights = [
    { rank: 1, score: 80, bucket: "noticias", url: "https://a.com/x" },
    { rank: 2, score: 65, bucket: "lancamento", url: "https://b.com/y" },
    { rank: 3, score: 70, bucket: "noticias", url: "https://c.com/z" },
  ];
  const sol = { url: "https://openai.com/index/introducing-gpt-6-1-sol", title: "Introducing GPT-6.1 Sol" };
  // Sem ordem atual (fallback): b é o rank 2.
  assert.equal(suggestSubstitution(sol, highlights).slot, "D2");
  // Com a ordem atual: b (menor score) está em D1 agora.
  const s = suggestSubstitution(sol, highlights, ["https://b.com/y/", "https://c.com/z", "https://a.com/x"]);
  assert.equal(s.slot, "D1");
  assert.match(s.reason, /D1 tem o menor score do pipeline \(65\)/);
});

test("suggestSubstitution: destaque TROCADO pelo editor (sem par no approved) é protegido como manual", () => {
  const highlights = [
    { rank: 1, score: 80, bucket: "noticias", url: "https://a.com/x" },
    { rank: 2, score: 65, bucket: "lancamento", url: "https://b.com/y" },
    { rank: 3, score: 70, bucket: "noticias", url: "https://c.com/z" },
  ];
  const sol = { url: "https://openai.com/index/introducing-gpt-6-1-sol", title: "Introducing GPT-6.1 Sol" };
  // Editor tirou b e pôs n (manual) em D2 → o de menor score restante é c, em D3.
  const s = suggestSubstitution(sol, highlights, ["https://a.com/x", "https://n.com/novo", "https://c.com/z"]);
  assert.equal(s.slot, "D3");
});

test("selectSitemapEntries: ordena por lastmod desc ANTES do corte (cap não descarta a mais nova)", () => {
  const entries = [
    { loc: "https://www.anthropic.com/news/old", lastmod: "2026-09-29T20:00:00Z" },
    { loc: "https://www.anthropic.com/news/mid", lastmod: "2026-09-29T21:00:00Z" },
    { loc: "https://www.anthropic.com/solutions/x", lastmod: "2026-09-29T23:00:00Z" },
    { loc: "https://www.anthropic.com/news/newest", lastmod: "2026-09-29T22:30:00Z" },
    { loc: "https://www.anthropic.com/news/before", lastmod: "2026-09-29T10:00:00Z" },
    { loc: "https://www.anthropic.com/news/nodate", lastmod: null },
  ];
  const out = selectSitemapEntries(entries, CUTOFF, "/news/", 2);
  assert.deepEqual(out.map((e) => e.loc), ["https://www.anthropic.com/news/newest", "https://www.anthropic.com/news/mid"]);
});

test("#9424: Mistral tem feed RSS oficial e sai da lista de labs sem cobertura", () => {
  const m = LATE_REFRESH_FEEDS.find((f) => f.lab === "Mistral");
  assert.ok(m, "feed Mistral ausente");
  assert.equal(m.url, "https://mistral.ai/news/rss");
  assert.equal(m.method, "rss");
  assert.ok(!LATE_REFRESH_UNCOVERED_LABS.includes("Mistral"));
  for (const lab of ["xAI", "DeepSeek", "Qwen"]) assert.ok(LATE_REFRESH_UNCOVERED_LABS.includes(lab), lab);
});

test("#9424: Meta tem feed RSS oficial (tag AI do Newsroom) e sai da lista de labs sem cobertura", () => {
  const m = LATE_REFRESH_FEEDS.find((f) => f.lab === "Meta");
  assert.ok(m, "feed Meta ausente");
  assert.equal(m.url, "https://about.fb.com/news/tag/ai/feed/");
  assert.equal(m.method, "rss");
  assert.ok(!LATE_REFRESH_UNCOVERED_LABS.includes("Meta"));
});

test("#9457: posts oficiais de Meta (about.fb.com) e Mistral anunciando lançamento → LANÇAMENTOS, não 'fonte não oficial'", () => {
  const meta = suggestSubstitution({ url: "https://about.fb.com/news/2026/10/introducing-new-ai-glasses/", title: "Introducing new AI glasses" }, []);
  assert.equal(meta.slot, "LANÇAMENTOS");
  const mistral = suggestSubstitution({ url: "https://mistral.ai/news/mistral-medium-4", title: "Mistral launches Medium 4" }, []);
  assert.equal(mistral.slot, "LANÇAMENTOS");
  const essay = suggestSubstitution({ url: "https://mistral.ai/news/our-values", title: "Our values" }, []);
  assert.equal(essay.slot, "RADAR");
  assert.equal(essay.reason, "post oficial que não anuncia lançamento");
  assert.equal(suggestSubstitution({ url: "https://techcrunch.com/x", title: "Mistral launches Medium 4" }, []).reason, "fonte não oficial");
});
