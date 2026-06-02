/**
 * test/finalize-stage1.test.ts
 *
 * Testes de regressão para #720 (scorer URL opacity) e #721 (editor_submitted bypass).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeTitle,
  joinScore,
  buildScoreIndexes,
  checkEditorSubmittedBypass,
  applyScoreFilter,
  applyDomainCap,
  applyPastSecondaryFilter,
  finalizeStage1,
  unwrapCategorizedInput,
  DEFAULT_DOMAIN_CAP,
  type Article,
  type ScoredEntry,
  type ScoredOutput,
  type CategorizedBuckets,
} from "../scripts/finalize-stage1.ts";

// ---------------------------------------------------------------------------
// normalizeTitle
// ---------------------------------------------------------------------------

describe("normalizeTitle", () => {
  it("lowercasa e remove pontuação", () => {
    assert.equal(normalizeTitle("Hello, World!"), "hello world");
  });

  it("colapsa espaços", () => {
    assert.equal(normalizeTitle("  foo   bar  "), "foo bar");
  });

  it("trata string vazia", () => {
    assert.equal(normalizeTitle(""), "");
  });
});

// ---------------------------------------------------------------------------
// #720 — URL opacity: joinScore deve preservar URL exata
// ---------------------------------------------------------------------------

describe("#720 — joinScore URL opacity", () => {
  it("preserva URL truncada exata no output", () => {
    // Caso do bug: scorer "corrige" URL truncada, mas o pool tem a URL original
    const truncUrl = "https://canaltech.com.br/produtos/foo-";
    const article: Article = {
      url: truncUrl,
      title: "Foo product launch",
    };
    const scored: ScoredEntry = { url: truncUrl, score: 75, title: "Foo product launch" };
    const { scoreMap, titleIndex } = buildScoreIndexes([scored]);

    const result = joinScore(article, scoreMap, [scored], titleIndex);

    assert.equal(result.article.url, truncUrl, "URL deve ser preservada exata");
    assert.equal(result.article.score, 75);
    assert.equal(result.url_mismatch, false);
    assert.equal(result.article.score_recovered, undefined);
  });

  it("não canonicaliza URL para fazer join (igualdade de string)", () => {
    // URL no pool tem trailing slash; scored não tem — mismatch intencional
    const poolUrl = "https://example.com/article/";
    const scoredUrl = "https://example.com/article"; // sem trailing slash
    const article: Article = { url: poolUrl, title: "My Article" };
    const scored: ScoredEntry = { url: scoredUrl, score: 80, title: "My Article" };
    const { scoreMap, titleIndex } = buildScoreIndexes([scored]);

    const result = joinScore(article, scoreMap, [scored], titleIndex);

    // Join por URL falha (strings diferentes), mas título bate → recovery
    assert.equal(result.url_mismatch, true, "deve detectar URL mismatch");
    assert.equal(result.article.score_recovered, true, "deve marcar score_recovered");
    assert.equal(result.article.score, 80);
  });

  it("recovery via título normalizado quando URL difere", () => {
    // Scorer "corrigiu" URL mas título é igual
    const poolUrl = "https://a.com/x";
    const scoredUrl = "https://a.com/y"; // URL diferente (mismatch)
    const title = "AI makes coding 10x faster";

    const article: Article = { url: poolUrl, title };
    const scored: ScoredEntry = { url: scoredUrl, score: 65, title };
    const { scoreMap, titleIndex } = buildScoreIndexes([scored]);

    const result = joinScore(article, scoreMap, [scored], titleIndex);

    assert.equal(result.url_mismatch, true, "URL mismatch detectado");
    assert.equal(result.article.score, 65, "score recuperado por título");
    assert.equal(result.article.score_recovered, true);
    // URL do artigo deve permanecer a original (do pool), não a do scorer
    assert.equal(result.article.url, poolUrl, "URL do pool preservada");
  });

  it("score null quando URL e título não batem", () => {
    const article: Article = { url: "https://unknown.com/z", title: "Completely different" };
    const scored: ScoredEntry = { url: "https://other.com/a", score: 90, title: "Other title" };
    const { scoreMap, titleIndex } = buildScoreIndexes([scored]);

    const result = joinScore(article, scoreMap, [scored], titleIndex);

    assert.equal(result.url_mismatch, true);
    assert.equal(result.article.score, null);
    assert.equal(result.article.score_recovered, undefined);
  });
});

// ---------------------------------------------------------------------------
// #721 — editor_submitted bypass
// ---------------------------------------------------------------------------

describe("#721 — checkEditorSubmittedBypass", () => {
  it("título '(inbox)' falha o bypass", () => {
    const result = checkEditorSubmittedBypass({ url: "https://x.com", title: "(inbox)" });
    assert.equal(result.bypass, false);
    if (!result.bypass) assert.equal(result.reason, "title_empty_or_placeholder");
  });

  it("título '(INBOX)' case-insensitive falha o bypass", () => {
    const result = checkEditorSubmittedBypass({ url: "https://x.com", title: "(INBOX)" });
    assert.equal(result.bypass, false);
  });

  it("título vazio falha o bypass", () => {
    const result = checkEditorSubmittedBypass({ url: "https://x.com", title: "" });
    assert.equal(result.bypass, false);
    if (!result.bypass) assert.equal(result.reason, "title_empty_or_placeholder");
  });

  it("título sem flag title mas ausente falha o bypass", () => {
    const result = checkEditorSubmittedBypass({ url: "https://x.com" });
    assert.equal(result.bypass, false);
  });

  it("título curto (< 15 chars) falha o bypass", () => {
    // "7min.ai" = 7 chars — curto demais
    const result = checkEditorSubmittedBypass({ url: "https://x.com", title: "7min.ai" });
    assert.equal(result.bypass, false);
    if (!result.bypass) assert.equal(result.reason, "title_too_short");
  });

  it("'7min.ai • Buttondown' falha por padrão buttondown", () => {
    const result = checkEditorSubmittedBypass({ url: "https://x.com", title: "7min.ai • Buttondown" });
    assert.equal(result.bypass, false);
    if (!result.bypass) assert.equal(result.reason, "title_matches_signup_meta");
  });

  it("título com 'subscribe' falha o bypass", () => {
    const result = checkEditorSubmittedBypass({ url: "https://x.com", title: "Subscribe to our newsletter today" });
    assert.equal(result.bypass, false);
    if (!result.bypass) assert.equal(result.reason, "title_matches_signup_meta");
  });

  it("título com 'sign up' falha o bypass", () => {
    const result = checkEditorSubmittedBypass({ url: "https://x.com", title: "Sign up for AI weekly digest" });
    assert.equal(result.bypass, false);
  });

  it("título válido de 20 chars concede bypass", () => {
    const result = checkEditorSubmittedBypass({
      url: "https://x.com",
      title: "OpenAI lança GPT-5 para todos",
    });
    assert.equal(result.bypass, true);
  });

  it("título exatamente 15 chars concede bypass", () => {
    const result = checkEditorSubmittedBypass({
      url: "https://x.com",
      title: "123456789012345", // 15 chars
    });
    assert.equal(result.bypass, true);
  });
});

// ---------------------------------------------------------------------------
// applyScoreFilter com casos do #721
// ---------------------------------------------------------------------------

describe("#721 — applyScoreFilter", () => {
  const empty = new Set<string>();

  it("título placeholder '(inbox)' → inclui mas marca editor_submitted_placeholder", () => {
    const article: Article = {
      url: "https://x.com/article",
      title: "(inbox)",
      flag: "editor_submitted",
      score: 10, // abaixo do threshold
    };
    const { kept, removed, bypassed_placeholders } = applyScoreFilter(
      [article],
      40,
      empty,
      empty,
    );

    assert.equal(kept.length, 1, "artigo deve ser incluído");
    assert.equal(removed.length, 0, "não deve ser removido");
    assert.equal(bypassed_placeholders.length, 1, "deve ser marcado como placeholder");
    assert.equal(kept[0].editor_submitted_placeholder, true);
  });

  it("título válido de 20+ chars → inclui normalmente sem flag", () => {
    const article: Article = {
      url: "https://x.com/article",
      title: "OpenAI lança GPT-5 para todos agora",
      flag: "editor_submitted",
      score: 5, // abaixo do threshold
    };
    const { kept, removed, bypassed_placeholders } = applyScoreFilter(
      [article],
      40,
      empty,
      empty,
    );

    assert.equal(kept.length, 1);
    assert.equal(removed.length, 0);
    assert.equal(bypassed_placeholders.length, 0, "não deve ser placeholder");
    assert.equal(kept[0].editor_submitted_placeholder, undefined);
  });

  it("'7min.ai • Buttondown' → incluído mas marcado placeholder", () => {
    const article: Article = {
      url: "https://buttondown.email/signup",
      title: "7min.ai • Buttondown",
      flag: "editor_submitted",
      score: 20,
    };
    const { kept, bypassed_placeholders } = applyScoreFilter(
      [article],
      40,
      empty,
      empty,
    );

    assert.equal(kept.length, 1);
    assert.equal(bypassed_placeholders.length, 1);
    assert.equal(kept[0].editor_submitted_placeholder, true);
  });

  it("artigo com score >= 40 passa independente de flag", () => {
    const article: Article = {
      url: "https://x.com/ok",
      title: "(inbox)",
      flag: "editor_submitted",
      score: 42,
    };
    const { kept, bypassed_placeholders } = applyScoreFilter(
      [article],
      40,
      empty,
      empty,
    );

    assert.equal(kept.length, 1);
    assert.equal(bypassed_placeholders.length, 0, "score ok → sem placeholder");
    assert.equal(kept[0].editor_submitted_placeholder, undefined);
  });

  it("artigo sem flag, score < 40 é removido", () => {
    const article: Article = { url: "https://x.com/low", title: "Low score article", score: 15 };
    const { kept, removed } = applyScoreFilter([article], 40, empty, empty);
    assert.equal(kept.length, 0);
    assert.equal(removed.length, 1);
  });

  it("artigo em highlights é preservado mesmo com score < 40", () => {
    const url = "https://x.com/highlight";
    const article: Article = { url, title: "Highlighted article", score: 5 };
    const hlUrls = new Set([url]);
    const { kept } = applyScoreFilter([article], 40, hlUrls, empty);
    assert.equal(kept.length, 1);
  });
});

// ---------------------------------------------------------------------------
// applyDomainCap (#1067)
// ---------------------------------------------------------------------------

describe("applyDomainCap (#1067)", () => {
  const mk = (url: string, score: number): Article => ({
    url,
    title: url,
    published_at: "2026-05-11T00:00:00Z",
    score,
  });

  it("DEFAULT_DOMAIN_CAP é 3", () => {
    assert.equal(DEFAULT_DOMAIN_CAP, 3);
  });

  it("aplica cap top N por hostname; resto vai pra dropped", () => {
    const articles = [
      mk("https://exame.com/a", 90),
      mk("https://exame.com/b", 80),
      mk("https://exame.com/c", 70),
      mk("https://exame.com/d", 60),
      mk("https://exame.com/e", 50),
      mk("https://nyt.com/x", 85),
    ];
    const { kept, dropped } = applyDomainCap(articles, 3, new Set());
    assert.equal(kept.length, 4); // 3 exame + 1 nyt
    assert.equal(dropped.length, 2);
    assert.equal(dropped[0].domain, "exame.com");
    assert.equal(dropped[0].score, 60);
    assert.equal(dropped[1].score, 50);
  });

  it("www.X.com e X.com são tratados como mesmo hostname (strip www)", () => {
    const articles = [
      mk("https://www.exame.com/a", 90),
      mk("https://exame.com/b", 80),
      mk("https://www.exame.com/c", 70),
      mk("https://exame.com/d", 60),
    ];
    const { kept, dropped } = applyDomainCap(articles, 3, new Set());
    assert.equal(kept.length, 3);
    assert.equal(dropped.length, 1);
    assert.equal(dropped[0].domain, "exame.com");
  });

  it("URLs em protectedUrls bypassam o cap e não contam pro limit", () => {
    // Highlight no domínio NÃO conta — pra deixar 3 outros também
    const articles = [
      mk("https://exame.com/highlight", 95),
      mk("https://exame.com/a", 90),
      mk("https://exame.com/b", 80),
      mk("https://exame.com/c", 70),
      mk("https://exame.com/d", 60),
    ];
    const protectedUrls = new Set(["https://exame.com/highlight"]);
    const { kept, dropped } = applyDomainCap(articles, 3, protectedUrls);
    // 1 highlight + 3 outros = 4 kept
    assert.equal(kept.length, 4);
    assert.equal(dropped.length, 1);
    assert.equal(dropped[0].url, "https://exame.com/d");
  });

  it("URL inválida passa pelo defensive fallback", () => {
    const articles = [
      mk("not-a-url", 80),
      mk("https://exame.com/a", 90),
    ];
    const { kept, dropped } = applyDomainCap(articles, 3, new Set());
    assert.equal(kept.length, 2);
    assert.equal(dropped.length, 0);
  });

  it("preserva ordem original do input (assumido sorted por score desc)", () => {
    const articles = [
      mk("https://a.com/1", 100),
      mk("https://b.com/1", 90),
      mk("https://a.com/2", 80),
    ];
    const { kept } = applyDomainCap(articles, 3, new Set());
    assert.equal(kept[0].url, "https://a.com/1");
    assert.equal(kept[1].url, "https://b.com/1");
    assert.equal(kept[2].url, "https://a.com/2");
  });

  it("cap = 0 → tudo vai pra dropped (exceto protected)", () => {
    const articles = [
      mk("https://exame.com/a", 90),
      mk("https://exame.com/b", 80),
    ];
    const { kept, dropped } = applyDomainCap(articles, 0, new Set());
    assert.equal(kept.length, 0);
    assert.equal(dropped.length, 2);
  });

  it("dropped entry tem url, title, domain e score", () => {
    const articles = [
      mk("https://exame.com/a", 90),
      mk("https://exame.com/b", 80),
    ];
    articles[1].title = "Title B";
    const { dropped } = applyDomainCap(articles, 1, new Set());
    assert.equal(dropped[0].url, "https://exame.com/b");
    assert.equal(dropped[0].title, "Title B");
    assert.equal(dropped[0].domain, "exame.com");
    assert.equal(dropped[0].score, 80);
  });
});

// ---------------------------------------------------------------------------
// finalizeStage1 — integração
// ---------------------------------------------------------------------------

describe("finalizeStage1", () => {
  function makeScoredOutput(entries: Array<{ url: string; score: number; title?: string }>): ScoredOutput {
    return {
      highlights: [],
      runners_up: [],
      all_scored: entries.map((e) => ({ url: e.url, score: e.score, title: e.title })),
    };
  }

  it("#720 — URL truncada preservada end-to-end", () => {
    const truncUrl = "https://canaltech.com.br/produtos/foo-";
    const categorized: CategorizedBuckets = {
      lancamento: [],
      radar: [
        { url: truncUrl, title: "Foo product" }
      ],
    };
    const scored = makeScoredOutput([{ url: truncUrl, score: 75, title: "Foo product" }]);

    const { buckets, url_mismatches } = finalizeStage1(categorized, scored);

    assert.equal(url_mismatches.length, 0, "sem mismatch quando URL é exata");
    assert.equal(buckets.radar[0].url, truncUrl, "URL deve ser preservada");
    assert.equal(buckets.radar[0].score, 75);
  });

  it("#720 — recovery via título quando URLs diferem", () => {
    const poolUrl = "https://a.com/x";
    const scoredUrl = "https://a.com/y";
    const title = "AI makes coding 10x faster";

    const categorized: CategorizedBuckets = {
      lancamento: [],
      radar: [
        { url: poolUrl, title }
      ],
    };
    const scored = makeScoredOutput([{ url: scoredUrl, score: 65, title }]);

    const { buckets, url_mismatches } = finalizeStage1(categorized, scored);

    assert.equal(url_mismatches.length, 1, "mismatch detectado");
    assert.equal(buckets.radar[0].url, poolUrl, "URL do pool preservada");
    assert.equal(buckets.radar[0].score, 65, "score recuperado via título");
    assert.equal(buckets.radar[0].score_recovered, true);
  });

  it("#721 — '(inbox)' title incluído mas marcado placeholder", () => {
    const url = "https://x.com/article";
    const categorized: CategorizedBuckets = {
      lancamento: [],
      radar: [
        { url, title: "(inbox)", flag: "editor_submitted", score: 5 }
      ],
    };
    // Scorer não tem score pra essa URL (mismatch total)
    const scored = makeScoredOutput([]);

    const { buckets, bypass_placeholders } = finalizeStage1(categorized, scored);

    // Artigo com score null mas flag editor_submitted → bypass tentado
    // título "(inbox)" → bypass falha → placeholder
    assert.equal(buckets.radar.length, 1, "artigo incluído");
    assert.equal(buckets.radar[0].editor_submitted_placeholder, true);
    assert.equal(bypass_placeholders.length, 1);
  });

  it("#721 — título válido de editor_submitted passa sem flag", () => {
    const url = "https://x.com/valid";
    const categorized: CategorizedBuckets = {
      lancamento: [],
      radar: [
        {
        url,
        title: "OpenAI lança GPT-5 para todos os usuários",
        flag: "editor_submitted",
      }
      ],
    };
    const scored = makeScoredOutput([{ url, score: 10, title: "OpenAI lança GPT-5 para todos os usuários" }]);

    const { buckets, bypass_placeholders } = finalizeStage1(categorized, scored);

    assert.equal(buckets.radar.length, 1);
    assert.equal(buckets.radar[0].editor_submitted_placeholder, undefined);
    assert.equal(bypass_placeholders.length, 0);
  });

  it("artigo com score >= 40 passa normalmente", () => {
    const url = "https://ok.com/article";
    const categorized: CategorizedBuckets = {
      lancamento: [],
      radar: [
        { url, title: "Good article", score: 60 }
      ],
    };
    const scored = makeScoredOutput([{ url, score: 60, title: "Good article" }]);

    const { buckets, removed_total } = finalizeStage1(categorized, scored);

    assert.equal(buckets.radar.length, 1);
    assert.equal(removed_total, 0);
  });

  it("artigo sem score (não em all_scored) e sem flag é removido", () => {
    const url = "https://noscored.com/x";
    const categorized: CategorizedBuckets = {
      lancamento: [],
      radar: [
        { url, title: "Unscored article" }
      ],
    };
    const scored = makeScoredOutput([]); // scorer não pontuou este artigo

    const { buckets, removed_total } = finalizeStage1(categorized, scored);

    // score = null → abaixo do threshold 40 → removido
    assert.equal(buckets.radar.length, 0);
    assert.equal(removed_total, 1);
  });
});

describe("finalizeStage1 — domain cap GLOBAL (#1067)", () => {
  function mkOutput(entries: Array<{ url: string; score: number }>): ScoredOutput {
    return {
      highlights: [],
      runners_up: [],
      all_scored: entries.map((e) => ({ url: e.url, score: e.score })),
    };
  }

  it("cap aplica cross-bucket — 6 exame.com (3 em radar + 3 em lancamento) → drop 3", () => {
    const categorized: CategorizedBuckets = {
      lancamento: [
        { url: "https://exame.com/l1" },
        { url: "https://exame.com/l2" },
        { url: "https://exame.com/l3" },
      ],
      radar: [
        { url: "https://exame.com/n1" },
        { url: "https://exame.com/n2" },
        { url: "https://exame.com/n3" }
      ],
    };
    const scored = mkOutput([
      { url: "https://exame.com/l1", score: 95 },
      { url: "https://exame.com/l2", score: 90 },
      { url: "https://exame.com/l3", score: 85 },
      { url: "https://exame.com/n1", score: 80 },
      { url: "https://exame.com/n2", score: 75 },
      { url: "https://exame.com/n3", score: 70 },
    ]);
    const { buckets, domain_capped } = finalizeStage1(categorized, scored);
    const totalKept =
      (buckets.lancamento?.length ?? 0) + (buckets.radar?.length ?? 0);
    assert.equal(totalKept, 3); // só top 3 globais do domínio
    assert.equal(domain_capped.length, 3);
    // Os top 3 por score vencem (l1=95, l2=90, l3=85)
    assert.equal(buckets.lancamento.length, 3);
    assert.equal(buckets.radar.length, 0);
  });

  it("highlights bypassam cap mesmo cross-bucket", () => {
    const categorized: CategorizedBuckets = {
      lancamento: [],
      radar: [
        { url: "https://exame.com/highlight" },
        { url: "https://exame.com/a" },
        { url: "https://exame.com/b" },
        { url: "https://exame.com/c" },
        { url: "https://exame.com/d" }, // 5º, deveria ser droppado pelo cap
      ],
    };
    const scored: ScoredOutput = {
      highlights: [{ url: "https://exame.com/highlight" } as any],
      runners_up: [],
      all_scored: [
        { url: "https://exame.com/highlight", score: 95 },
        { url: "https://exame.com/a", score: 90 },
        { url: "https://exame.com/b", score: 80 },
        { url: "https://exame.com/c", score: 70 },
        { url: "https://exame.com/d", score: 60 },
      ],
    };
    const { buckets, domain_capped } = finalizeStage1(categorized, scored);
    // highlight + top 3 não-highlight do domínio = 4 kept; d droppado
    assert.equal(buckets.radar.length, 4);
    assert.equal(domain_capped.length, 1);
    assert.equal(domain_capped[0].url, "https://exame.com/d");
  });

  it("domínios diferentes não competem por cap", () => {
    const categorized: CategorizedBuckets = {
      lancamento: [],
      radar: [
        { url: "https://a.com/1" },
        { url: "https://b.com/1" },
        { url: "https://c.com/1" },
        { url: "https://d.com/1" }
      ],
    };
    const scored = mkOutput([
      { url: "https://a.com/1", score: 90 },
      { url: "https://b.com/1", score: 80 },
      { url: "https://c.com/1", score: 70 },
      { url: "https://d.com/1", score: 60 },
    ]);
    const { buckets, domain_capped } = finalizeStage1(categorized, scored);
    assert.equal(buckets.radar.length, 4);
    assert.equal(domain_capped.length, 0);
  });
});

describe("applyPastSecondaryFilter (#1068 phase 2)", () => {
  const mk = (url: string, score = 50): Article => ({
    url,
    title: url,
    published_at: "2026-05-11T00:00:00Z",
    score,
  });

  it("URL em past-secondary que NÃO é highlight é droppada", () => {
    const articles = [
      mk("https://example.com/a"),
      mk("https://example.com/repeat"),
    ];
    const pastSecondary = new Set(["https://example.com/repeat"]);
    const highlights = new Set<string>();
    const { kept, dropped } = applyPastSecondaryFilter(articles, pastSecondary, highlights);
    assert.equal(kept.length, 1);
    assert.equal(kept[0].url, "https://example.com/a");
    assert.equal(dropped.length, 1);
    assert.equal(dropped[0].url, "https://example.com/repeat");
  });

  it("URL em past-secondary E em highlights = bypass (promoção válida)", () => {
    const articles = [
      mk("https://example.com/promoted"),
    ];
    const pastSecondary = new Set(["https://example.com/promoted"]);
    const highlights = new Set(["https://example.com/promoted"]);
    const { kept, dropped } = applyPastSecondaryFilter(articles, pastSecondary, highlights);
    assert.equal(kept.length, 1);
    assert.equal(dropped.length, 0);
  });

  it("URL nova (não em past) passa intacta", () => {
    const articles = [mk("https://example.com/NEW")];
    const pastSecondary = new Set(["https://example.com/old"]);
    const highlights = new Set<string>();
    const { kept } = applyPastSecondaryFilter(articles, pastSecondary, highlights);
    assert.equal(kept.length, 1);
  });

  it("canonicaliza URL antes da match (utm_*, fragment)", () => {
    const articles = [mk("https://example.com/x?utm_source=tw")];
    const pastSecondary = new Set(["https://example.com/x"]);
    const highlights = new Set<string>();
    const { kept, dropped } = applyPastSecondaryFilter(articles, pastSecondary, highlights);
    assert.equal(kept.length, 0);
    assert.equal(dropped.length, 1);
  });
});

describe("finalizeStage1 — past-secondary integration (#1068 phase 2)", () => {
  function mkOutput(entries: Array<{ url: string; score: number }>, highlightUrls: string[] = []): ScoredOutput {
    return {
      highlights: highlightUrls.map((u) => ({ url: u, score: 90 } as any)),
      runners_up: [],
      all_scored: entries.map((e) => ({ url: e.url, score: e.score })),
    };
  }

  it("past-secondary que não viraram highlight são droppados pós-scorer", () => {
    const categorized: CategorizedBuckets = {
      lancamento: [],
      radar: [
        { url: "https://example.com/new" },
        { url: "https://example.com/past-secondary-repeat" }
      ],
    };
    const scored = mkOutput([
      { url: "https://example.com/new", score: 90 },
      { url: "https://example.com/past-secondary-repeat", score: 80 },
    ]);
    const pastSecondaryUrls = new Set(["https://example.com/past-secondary-repeat"]);
    const { buckets, past_secondary_dropped } = finalizeStage1(categorized, scored, {
      pastSecondaryUrls,
    });
    assert.equal(buckets.radar.length, 1);
    assert.equal(buckets.radar[0].url, "https://example.com/new");
    assert.equal(past_secondary_dropped.length, 1);
  });

  it("past-secondary que VIROU highlight passa (promoção permitida)", () => {
    const categorized: CategorizedBuckets = {
      lancamento: [],
      radar: [
        { url: "https://example.com/promoted" }
      ],
    };
    const scored = mkOutput(
      [{ url: "https://example.com/promoted", score: 95 }],
      ["https://example.com/promoted"],
    );
    const pastSecondaryUrls = new Set(["https://example.com/promoted"]);
    const { buckets, past_secondary_dropped } = finalizeStage1(categorized, scored, {
      pastSecondaryUrls,
    });
    assert.equal(buckets.radar.length, 1);
    assert.equal(past_secondary_dropped.length, 0);
  });

  it("sem pastSecondaryUrls (back-compat): nada é droppado por essa razão", () => {
    const categorized: CategorizedBuckets = {
      lancamento: [],
      radar: [
        { url: "https://example.com/x" }
      ],
    };
    const scored = mkOutput([{ url: "https://example.com/x", score: 80 }]);
    const { buckets, past_secondary_dropped } = finalizeStage1(categorized, scored);
    assert.equal(buckets.radar.length, 1);
    assert.equal(past_secondary_dropped.length, 0);
  });
});

describe("DEFAULT_PAST_WINDOW (#1086 regression)", () => {
  it("dedup e finalize compartilham a mesma janela", async () => {
    const dedupMod = await import("../scripts/dedup.ts");
    // DEFAULT_PAST_WINDOW exportado por dedup é usado por finalize-stage1.
    // Se este export sumir ou divergir, o CLI default de finalize sai de
    // alinhamento com dedup — past-secondary dropa fora da janela de phase 1.
    assert.equal(typeof dedupMod.DEFAULT_PAST_WINDOW, "number");
    assert.ok(dedupMod.DEFAULT_PAST_WINDOW >= 1);
  });
});

// ---------------------------------------------------------------------------
// #1567 audit (finding D) — o pool passado a finalizeStage1 deve ser o pool que
// o scorer pontuou (tmp-dates-reviewed), NÃO o superset pré-review (tmp-clustered).
// Documenta por que o orchestrator (step 1s) passa tmp-dates-reviewed: passar o
// superset gera url_mismatches espúrios que soterram os mismatches reais (#720).
// ---------------------------------------------------------------------------

describe("#1567 finding D — join pool == scored pool ⇒ sem url_mismatch espúrio", () => {
  const scoredOutput: ScoredOutput = {
    highlights: [],
    runners_up: [],
    // all_scored carrega só {url, score} (sem título) — como na produção real
    all_scored: [
      { url: "https://a.com/1", score: 80 },
      { url: "https://b.com/2", score: 75 },
      { url: "https://c.com/3", score: 60 },
    ],
  };

  it("pool == scored (dates-reviewed): zero url_mismatches numa edição saudável", () => {
    const categorized: CategorizedBuckets = {
      lancamento: [{ url: "https://a.com/1", title: "Lançamento A com título longo o suficiente" }],
      radar: [
        { url: "https://b.com/2", title: "Pesquisa B com título longo o suficiente" },
        { url: "https://c.com/3", title: "Notícia C com título longo o suficiente" }
      ],
    };
    const r = finalizeStage1(categorized, scoredOutput);
    assert.equal(r.url_mismatches.length, 0);
  });

  it("pool superset (clustered): cada extra não-pontuado vira mismatch espúrio (#720 ruído)", () => {
    // 2 artigos extras (removidos pela janela de datas) que NÃO foram pontuados —
    // exatamente o que tmp-clustered teria a mais que tmp-dates-reviewed.
    const categorized: CategorizedBuckets = {
      lancamento: [
        { url: "https://a.com/1", title: "Lançamento A com título longo o suficiente" },
        { url: "https://extra1.com/x", title: "Removida por data 1 título longo o suficiente" },
      ],
      radar: [
        { url: "https://b.com/2", title: "Pesquisa B com título longo o suficiente" },
        { url: "https://c.com/3", title: "Notícia C com título longo o suficiente" },
        { url: "https://extra2.com/y", title: "Removida por data 2 título longo o suficiente" }
      ],
    };
    const r = finalizeStage1(categorized, scoredOutput);
    // exatamente os 2 extras não-pontuados — false positives que o orchestrator evita
    // passando tmp-dates-reviewed em vez de tmp-clustered.
    assert.equal(r.url_mismatches.length, 2);
    const urls = r.url_mismatches.map((m) => m.article_url).sort();
    assert.deepEqual(urls, ["https://extra1.com/x", "https://extra2.com/y"]);
  });
});

describe("#1642 — unwrapCategorizedInput (perda silenciosa de artigos)", () => {
  const buckets = {
    lancamento: [{ url: "https://a.com/1", title: "Lançamento A título longo o suficiente" }],
    radar: [{ url: "https://b.com/2", title: "Notícia B título longo o suficiente" }],
    use_melhor: [],
    video: [],
  };

  it("desembrulha wrapper { categorized: {...} } (output de research-review-dates) — o bug do #1642", () => {
    // research-review-dates.ts grava { categorized: filterResult.kept, stats }.
    // Antes do fix, raw.kept ?? raw caía em raw → buckets vazios silenciosos.
    const raw = { categorized: buckets, stats: { total_input: 2, total_output: 2 } };
    const out = unwrapCategorizedInput(raw);
    assert.equal(out.lancamento.length, 1);
    assert.equal(out.radar.length, 1);
    assert.equal(out.lancamento[0].url, "https://a.com/1");
  });

  it("desembrulha wrapper { kept: {...} } (output de filter-date-window)", () => {
    const raw = { kept: buckets, removed: [] };
    const out = unwrapCategorizedInput(raw);
    assert.equal(out.lancamento.length, 1);
    assert.equal(out.radar.length, 1);
  });

  it("aceita shape flat { lancamento, radar, ... }", () => {
    const out = unwrapCategorizedInput(buckets);
    assert.equal(out.lancamento.length, 1);
    assert.equal(out.radar.length, 1);
  });

  it("prefere wrapper .kept sobre flat quando ambos existem", () => {
    // top-level tem chaves de bucket espúrias, mas .kept é o container real.
    const raw = { kept: buckets, lancamento: [] };
    const out = unwrapCategorizedInput(raw);
    assert.equal(out.lancamento.length, 1);
  });

  it("reconhece buckets legados (pesquisa/noticias/tutorial) sob .categorized", () => {
    const legacy = { categorized: { pesquisa: [{ url: "https://x/1" }], noticias: [] } };
    const out = unwrapCategorizedInput(legacy);
    assert.equal((out as Record<string, unknown[]>).pesquisa.length, 1);
  });

  it("#1670: remapeia legacy pesquisa+noticias→radar, tutorial→use_melhor (não somem no loop de bucketNames)", () => {
    const legacy = {
      categorized: {
        lancamento: [{ url: "https://x/l" }],
        pesquisa: [{ url: "https://x/p" }],
        noticias: [{ url: "https://x/n" }],
        tutorial: [{ url: "https://x/t" }],
      },
    };
    const out = unwrapCategorizedInput(legacy);
    // O loop de finalizeStage1 itera [lancamento, radar, use_melhor, video] —
    // os artigos legacy precisam estar sob esses nomes ou somem (#1642 class).
    assert.deepEqual((out.radar as Array<{ url: string }>).map((a) => a.url), ["https://x/p", "https://x/n"]);
    assert.deepEqual((out.use_melhor as Array<{ url: string }>).map((a) => a.url), ["https://x/t"]);
    assert.equal(out.lancamento.length, 1);
  });

  it("FALHA ALTO em schema mismatch (nenhum bucket reconhecível) — não retorna vazio silencioso", () => {
    // Exatamente o cenário do #1642 sem o fix: buckets aninhados num wrapper
    // desconhecido. Antes: buckets vazios. Agora: throw explícito.
    const bogus = { resultado: { lancamento: [{ url: "https://x/1" }] }, stats: {} };
    assert.throws(() => unwrapCategorizedInput(bogus), /schema mismatch/);
  });

  it("rejeita input não-objeto", () => {
    assert.throws(() => unwrapCategorizedInput(null), /não é objeto/);
    assert.throws(() => unwrapCategorizedInput("foo"), /não é objeto/);
  });
});
