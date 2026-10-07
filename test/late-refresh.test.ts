import { test } from "node:test";
import assert from "node:assert/strict";
import {
  IMPRECISE_DATE_LOOKBACK_MS,
  LATE_REFRESH_FEEDS,
  LATE_REFRESH_UNCOVERED_LABS,
  isOfficialHost,
  canonicalUrlSet,
  filterLateArticles,
  formatLateRefreshBlock,
  isImpreciseTimestamp,
  resolveCutoffs,
  selectSitemapEntries,
  suggestSubstitution,
  summarizeLateThreads,
  filterGithubReleases,
  parseGithubNewRepos,
  parseGithubReleaseUrl,
  type LateArticle,
  type LateRefreshReport,
} from "../scripts/lib/late-refresh.ts";
import { threadsToLateInputs } from "../scripts/late-refresh-candidates.ts";
import { parseFeed } from "../scripts/fetch-rss.ts";
import { isOfficialLancamentoUrl } from "../scripts/lib/launch-heuristics.ts";

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

// #9515: post do próprio feed oficial nunca pode cair como "fonte não oficial".
test("LATE_REFRESH_FEEDS: todo host de feed satisfaz isOfficialHost (#9515)", () => {
  for (const f of LATE_REFRESH_FEEDS) {
    const u = new URL(f.url);
    // #9424: feeds do GitHub emitem URL de release/repo da org, não do host do feed.
    const post =
      f.method === "github-releases"
        ? f.url.replace(/\/releases\.atom$/, "/releases/tag/v1.0.0")
        : f.method === "github-new-repos"
          ? `https://github.com/${f.org}/repo-exemplo`
          : `${u.protocol}//${u.host}${f.pathPrefix ?? "/"}post-exemplo`;
    assert.equal(isOfficialHost(post), true, `${f.name}: ${post} deveria ser oficial`);
  }
  assert.equal(isOfficialHost("https://microsoft.ai/news/introducing-mai-voice-2/"), true);
});

// ---------------------------------------------------------------------------
// #9424 — GitHub oficial das orgs (xAI, DeepSeek, Qwen)
// ---------------------------------------------------------------------------

/** Fixture no formato real do Atom de releases do GitHub (estrutura do qwen-code, 07/10/2026). */
const GITHUB_RELEASES_ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/" xml:lang="en-US">
  <id>tag:github.com,2008:https://github.com/QwenLM/qwen-code/releases</id>
  <link type="text/html" rel="alternate" href="https://github.com/QwenLM/qwen-code/releases"/>
  <link type="application/atom+xml" rel="self" href="https://github.com/QwenLM/qwen-code/releases.atom"/>
  <title>Release notes from qwen-code</title>
  <updated>2026-10-06T18:45:47Z</updated>
  ${[
    ["v0.25.1-preview.0", "Release v0.25.1-preview.0", "2026-10-06T18:45:47Z"],
    ["v0.25.0", "Release v0.25.0", "2026-10-05T10:01:23Z"],
    ["sdk-typescript-v0.1.18", "SDK TypeScript Release v0.1.18", "2026-10-05T10:23:32Z"],
    ["desktop-v0.25.0", "Qwen Code Desktop v0.25.0", "2026-10-05T10:45:59Z"],
    ["v0.24.7-nightly.20261004.9915c7ff8f", "Release v0.24.7-nightly.20261004.9915c7ff8f", "2026-10-04T22:14:03Z"],
    ["v0.24.7", "Release v0.24.7", "2026-09-29T14:24:45Z"],
  ]
    .map(
      ([tag, title, updated]) => `<entry>
    <id>tag:github.com,2008:Repository/1008713177/${tag}</id>
    <updated>${updated}</updated>
    <link rel="alternate" type="text/html" href="https://github.com/QwenLM/qwen-code/releases/tag/${tag}"/>
    <title>${title}</title>
    <content type="html">&lt;h2&gt;Changes&lt;/h2&gt;</content>
    <author><name>github-actions[bot]</name></author>
  </entry>`,
    )
    .join("\n  ")}
</feed>`;

test("#9424: parseGithubReleaseUrl extrai repo e tag; fora de /releases/tag/ → null", () => {
  assert.deepEqual(parseGithubReleaseUrl("https://github.com/QwenLM/qwen-code/releases/tag/v0.25.0"), { repo: "QwenLM/qwen-code", tag: "v0.25.0" });
  assert.deepEqual(parseGithubReleaseUrl("https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.0"), { repo: "deepseek-ai/deepseek-harness", tag: "dsh-v0.2.0" });
  assert.equal(parseGithubReleaseUrl("https://github.com/QwenLM/qwen-code/releases"), null);
  assert.equal(parseGithubReleaseUrl("https://github.com/QwenLM/qwen-code"), null);
  assert.equal(parseGithubReleaseUrl("https://gitlab.com/a/b/releases/tag/v1.0.0"), null);
  assert.equal(parseGithubReleaseUrl("não é url"), null);
});

test("#9424: Atom de releases do GitHub → só release estável de minor/major, título com o repo", () => {
  const { articles, kind } = parseFeed(GITHUB_RELEASES_ATOM);
  assert.equal(kind, "atom");
  assert.equal(articles.length, 6, "parser lê todas as entradas do Atom do GitHub");
  const late: LateArticle[] = articles.map((a) => ({ ...a, published_at: a.published_at ?? null, lab: "Qwen", source: "Qwen Code (releases)" }));
  const feed = LATE_REFRESH_FEEDS.find((f) => f.url === "https://github.com/QwenLM/qwen-code/releases.atom");
  assert.ok(feed, "feed de releases do qwen-code ausente");
  const kept = filterGithubReleases(late, feed.tagPattern);
  assert.deepEqual(kept.map((a) => a.url), ["https://github.com/QwenLM/qwen-code/releases/tag/v0.25.0"], "preview, nightly, sdk, desktop e patch saem");
  assert.equal(kept[0].title, "QwenLM/qwen-code: Release v0.25.0");
  assert.equal(kept[0].published_at, "2026-10-05T10:01:23.000Z");
  // Sem padrão, nada é filtrado (só o que não é /releases/tag/ sai).
  assert.equal(filterGithubReleases(late, undefined).length, 6);
});

test("#9424: tagPattern do DeepSeek Harness corta alpha/rc e aceita a estável", () => {
  const feed = LATE_REFRESH_FEEDS.find((f) => f.url.endsWith("/deepseek-harness/releases.atom"));
  assert.ok(feed?.tagPattern);
  for (const t of ["dsh-v0.2.1-alpha.1", "dsh-v0.2.0-rc.2", "dsh-v0.1.5-rc.3", "v0.1.7-alpha.1", "dsh-v0.2.1"]) assert.equal(feed.tagPattern.test(t), false, t);
  for (const t of ["dsh-v0.2.0", "dsh-v1.0.0"]) assert.equal(feed.tagPattern.test(t), true, t);
});

test("#9424: parseGithubNewRepos tira fork, arquivado, privado e repo interno; resposta de erro lança", () => {
  const feed = { lab: "DeepSeek", name: "DeepSeek GitHub (repos novos)" };
  const out = parseGithubNewRepos(
    [
      { name: "DeepGEMM-Ascend", full_name: "deepseek-ai/DeepGEMM-Ascend", html_url: "https://github.com/deepseek-ai/DeepGEMM-Ascend", description: "Matrix multiplication kernels for Ascend NPUs", created_at: "2026-09-29T15:49:55Z", fork: false },
      { name: "DeepSeek-V4", full_name: "deepseek-ai/DeepSeek-V4", html_url: "https://github.com/deepseek-ai/DeepSeek-V4", description: null, created_at: "2026-10-07T01:00:00Z", fork: false },
      { name: "vllm", full_name: "deepseek-ai/vllm", html_url: "https://github.com/deepseek-ai/vllm", description: "fork", created_at: "2026-10-07T01:00:00Z", fork: true },
      { name: "old", full_name: "deepseek-ai/old", html_url: "https://github.com/deepseek-ai/old", created_at: "2026-10-07T01:00:00Z", archived: true },
      { name: "priv", full_name: "deepseek-ai/priv", html_url: "https://github.com/deepseek-ai/priv", created_at: "2026-10-07T01:00:00Z", private: true },
      { name: "dsh-libreoffice-kit", full_name: "deepseek-ai/dsh-libreoffice-kit", html_url: "https://github.com/deepseek-ai/dsh-libreoffice-kit", description: "An internal component used by DeepSeek Harness", created_at: "2026-09-30T06:28:16Z" },
      { name: "sem-data", html_url: "https://github.com/deepseek-ai/sem-data" },
    ],
    feed,
  );
  assert.deepEqual(out.map((a) => a.url), ["https://github.com/deepseek-ai/DeepGEMM-Ascend", "https://github.com/deepseek-ai/DeepSeek-V4"]);
  assert.equal(out[0].title, "Novo repositório deepseek-ai/DeepGEMM-Ascend: Matrix multiplication kernels for Ascend NPUs");
  assert.equal(out[1].title, "Novo repositório deepseek-ai/DeepSeek-V4");
  assert.equal(out[1].published_at, "2026-10-07T01:00:00Z");
  assert.equal(out[1].lab, "DeepSeek");
  assert.throws(() => parseGithubNewRepos({ message: "API rate limit exceeded" }, feed), /rate limit/);
});

test("#9424: repo novo entra pelo corte de data do filterLateArticles (created_at preciso)", () => {
  const repos = parseGithubNewRepos(
    [
      { full_name: "QwenLM/antes", html_url: "https://github.com/QwenLM/antes", created_at: "2026-09-29T19:12:34Z" },
      { full_name: "QwenLM/Qwen4", html_url: "https://github.com/QwenLM/Qwen4", created_at: "2026-09-29T23:10:00Z" },
    ],
    { lab: "Qwen", name: "Qwen GitHub (repos novos)" },
  );
  const r = filterLateArticles(repos, CUTOFF, new Set(), new Set());
  assert.deepEqual(r.fresh.map((a) => a.url), ["https://github.com/QwenLM/Qwen4"]);
});

test("#9424: mapeamento lab → feed — xAI, DeepSeek e Qwen têm repos novos + releases da org oficial; ninguém fica sem cobertura", () => {
  const expected: Record<string, string> = { xAI: "xai-org", DeepSeek: "deepseek-ai", Qwen: "QwenLM" };
  for (const [lab, org] of Object.entries(expected)) {
    const feeds = LATE_REFRESH_FEEDS.filter((f) => f.lab === lab);
    const repos = feeds.find((f) => f.method === "github-new-repos");
    const releases = feeds.find((f) => f.method === "github-releases");
    assert.ok(repos, `${lab}: feed de repos novos ausente`);
    assert.equal(repos.org, org);
    assert.equal(repos.url, `https://api.github.com/orgs/${org}/repos?sort=created&direction=desc&per_page=30&type=public`);
    assert.ok(releases, `${lab}: feed de releases ausente`);
    assert.match(releases.url, new RegExp(`^https://github\\.com/${org}/[^/]+/releases\\.atom$`));
    assert.ok(releases.tagPattern, `${lab}: release sem filtro de ruído`);
  }
  assert.deepEqual([...LATE_REFRESH_UNCOVERED_LABS], []);
});

test("#9424: release/repo da org oficial no GitHub é link oficial (#160) → LANÇAMENTOS; org alheia não", () => {
  for (const url of [
    "https://github.com/QwenLM/qwen-code/releases/tag/v0.25.0",
    "https://github.com/deepseek-ai/DeepSeek-V4",
    "https://github.com/xai-org/xai-sdk-python/releases/tag/v1.20.0",
  ]) {
    assert.equal(isOfficialHost(url), true, url);
    assert.equal(isOfficialLancamentoUrl(url), true, `validate-lancamentos aceita ${url}`);
    assert.equal(suggestSubstitution({ url, title: "Novo repositório x" }, []).slot, "LANÇAMENTOS", url);
  }
  for (const url of ["https://github.com/someone/qwen-fork/releases/tag/v1.0.0", "https://github.com/deepseek-ai/DeepSeek-V3/issues/1", "https://github.com/xai-org"]) {
    assert.equal(isOfficialHost(url), false, url);
    assert.equal(suggestSubstitution({ url, title: "Release v1.0.0" }, []).slot, "RADAR", url);
  }
});
