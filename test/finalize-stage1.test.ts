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
  finalizeStage1,
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
      pesquisa: [],
      noticias: [{ url: truncUrl, title: "Foo product" }],
    };
    const scored = makeScoredOutput([{ url: truncUrl, score: 75, title: "Foo product" }]);

    const { buckets, url_mismatches } = finalizeStage1(categorized, scored);

    assert.equal(url_mismatches.length, 0, "sem mismatch quando URL é exata");
    assert.equal(buckets.noticias[0].url, truncUrl, "URL deve ser preservada");
    assert.equal(buckets.noticias[0].score, 75);
  });

  it("#720 — recovery via título quando URLs diferem", () => {
    const poolUrl = "https://a.com/x";
    const scoredUrl = "https://a.com/y";
    const title = "AI makes coding 10x faster";

    const categorized: CategorizedBuckets = {
      lancamento: [],
      pesquisa: [],
      noticias: [{ url: poolUrl, title }],
    };
    const scored = makeScoredOutput([{ url: scoredUrl, score: 65, title }]);

    const { buckets, url_mismatches } = finalizeStage1(categorized, scored);

    assert.equal(url_mismatches.length, 1, "mismatch detectado");
    assert.equal(buckets.noticias[0].url, poolUrl, "URL do pool preservada");
    assert.equal(buckets.noticias[0].score, 65, "score recuperado via título");
    assert.equal(buckets.noticias[0].score_recovered, true);
  });

  it("#721 — '(inbox)' title incluído mas marcado placeholder", () => {
    const url = "https://x.com/article";
    const categorized: CategorizedBuckets = {
      lancamento: [],
      pesquisa: [],
      noticias: [{ url, title: "(inbox)", flag: "editor_submitted", score: 5 }],
    };
    // Scorer não tem score pra essa URL (mismatch total)
    const scored = makeScoredOutput([]);

    const { buckets, bypass_placeholders } = finalizeStage1(categorized, scored);

    // Artigo com score null mas flag editor_submitted → bypass tentado
    // título "(inbox)" → bypass falha → placeholder
    assert.equal(buckets.noticias.length, 1, "artigo incluído");
    assert.equal(buckets.noticias[0].editor_submitted_placeholder, true);
    assert.equal(bypass_placeholders.length, 1);
  });

  it("#721 — título válido de editor_submitted passa sem flag", () => {
    const url = "https://x.com/valid";
    const categorized: CategorizedBuckets = {
      lancamento: [],
      pesquisa: [],
      noticias: [{
        url,
        title: "OpenAI lança GPT-5 para todos os usuários",
        flag: "editor_submitted",
      }],
    };
    const scored = makeScoredOutput([{ url, score: 10, title: "OpenAI lança GPT-5 para todos os usuários" }]);

    const { buckets, bypass_placeholders } = finalizeStage1(categorized, scored);

    assert.equal(buckets.noticias.length, 1);
    assert.equal(buckets.noticias[0].editor_submitted_placeholder, undefined);
    assert.equal(bypass_placeholders.length, 0);
  });

  it("artigo com score >= 40 passa normalmente", () => {
    const url = "https://ok.com/article";
    const categorized: CategorizedBuckets = {
      lancamento: [],
      pesquisa: [],
      noticias: [{ url, title: "Good article", score: 60 }],
    };
    const scored = makeScoredOutput([{ url, score: 60, title: "Good article" }]);

    const { buckets, removed_total } = finalizeStage1(categorized, scored);

    assert.equal(buckets.noticias.length, 1);
    assert.equal(removed_total, 0);
  });

  it("artigo sem score (não em all_scored) e sem flag é removido", () => {
    const url = "https://noscored.com/x";
    const categorized: CategorizedBuckets = {
      lancamento: [],
      pesquisa: [],
      noticias: [{ url, title: "Unscored article" }],
    };
    const scored = makeScoredOutput([]); // scorer não pontuou este artigo

    const { buckets, removed_total } = finalizeStage1(categorized, scored);

    // score = null → abaixo do threshold 40 → removido
    assert.equal(buckets.noticias.length, 0);
    assert.equal(removed_total, 1);
  });
});
