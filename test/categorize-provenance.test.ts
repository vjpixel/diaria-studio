/**
 * #6647: instrumentação de proveniência do categorizador — categorize()
 * segue devolvendo EXATAMENTE o mesmo bucket de antes (prova de
 * byte-identidade), e categorizeWithRule()/isFallbackCategorizationRule()
 * expõem qual regra decidiu (ou o fallback) sem alterar essa decisão.
 */
import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  categorize,
  categorizeWithRule,
  isFallbackCategorizationRule,
  categorizeArticles,
  categoryToBucket,
  type Article,
} from "../scripts/categorize.ts";
import {
  collectRuleUsage,
  summarizeRuleUsage,
} from "../scripts/analyze-bucket-overrides.ts";

// Amostra deliberadamente diversa — cobre sinal forte de várias categorias
// (domínio de tutorial, pesquisa arXiv, video, type_hint do agent) e os
// dois pontos de fallback verdadeiros (lancamento-default/noticias-default).
const SAMPLE_ARTICLES: Article[] = [
  { url: "https://www.youtube.com/watch?v=abc123", title: "Como usar IA" },
  { url: "https://cookbook.openai.com/examples/how_to_stream", title: "How to stream completions" },
  {
    url: "https://arxiv.org/abs/2501.12345",
    title: "Scaling Laws for Large Language Models",
  },
  { url: "https://openai.com/index/introducing-gpt-6/", title: "Introducing GPT-6" },
  { url: "https://openai.com/index/gpt-6", title: "GPT-6", type_hint: "lancamento" },
  // Sem verbo de anúncio, sem type_hint, sem nenhum override — cai no
  // default `lancamento` do bloco (LANCAMENTO_DOMAINS) — fallback.
  { url: "https://openai.com/index/omni-3", title: "Omni 3" },
  // Fora de qualquer domínio/pattern dedicado, sem type_hint — default final.
  { url: "https://techcrunch.com/2026/01/01/random-ai-story", title: "Random AI story" },
  { url: "https://blog.google/technology/ai/some-launch/", title: "Google announces something new" },
];

describe("categorize() vs categorizeWithRule() — byte-identidade (#6647)", () => {
  it("categorize(article) === categorizeWithRule(article).category para toda a amostra", () => {
    for (const article of SAMPLE_ARTICLES) {
      const direct = categorize(article);
      const { category } = categorizeWithRule(article);
      assert.equal(category, direct, `divergência para ${article.url}`);
    }
  });

  it("categorize() é wrapper fino — categoria nunca diverge por construção (mesma função interna)", () => {
    // Não é apenas uma coincidência da amostra: categorize() delega
    // literalmente para categorizeWithRule().category (ver
    // scripts/lib/launch-heuristics.ts) — este teste trava esse contrato.
    const article: Article = { url: "https://example.com/whatever", title: "X" };
    assert.equal(categorize(article), categorizeWithRule(article).category);
  });
});

describe("categorizeWithRule() — rule ids esperados por caso", () => {
  it("vídeo → video-url", () => {
    const r = categorizeWithRule({ url: "https://www.youtube.com/watch?v=abc123" });
    assert.equal(r.category, "video");
    assert.equal(r.rule, "video-url");
  });

  it("domínio de tutorial dedicado → tutorial-domain", () => {
    const r = categorizeWithRule({ url: "https://cookbook.openai.com/examples/how_to_stream", title: "How to stream" });
    assert.equal(r.category, "tutorial");
    assert.equal(r.rule, "tutorial-domain");
  });

  it("arXiv relevante → pesquisa-domain", () => {
    const r = categorizeWithRule({ url: "https://arxiv.org/abs/2501.12345", title: "Scaling Laws for Large Language Models" });
    assert.equal(r.category, "pesquisa");
    assert.equal(r.rule, "pesquisa-domain");
  });

  it("type_hint=lancamento em domínio oficial → lancamento-type-hint", () => {
    const r = categorizeWithRule({ url: "https://openai.com/index/gpt-6", title: "GPT-6", type_hint: "lancamento" });
    assert.equal(r.category, "lancamento");
    assert.equal(r.rule, "lancamento-type-hint");
  });

  it("domínio oficial sem nenhum override → lancamento-default (fallback)", () => {
    const r = categorizeWithRule({ url: "https://openai.com/index/omni-3", title: "Omni 3" });
    assert.equal(r.category, "lancamento");
    assert.equal(r.rule, "lancamento-default");
    assert.equal(isFallbackCategorizationRule(r.rule), true);
  });

  it("fora de qualquer domínio/pattern dedicado → noticias-default (fallback)", () => {
    const r = categorizeWithRule({ url: "https://techcrunch.com/2026/01/01/random-ai-story", title: "Random AI story" });
    assert.equal(r.category, "noticias");
    assert.equal(r.rule, "noticias-default");
    assert.equal(isFallbackCategorizationRule(r.rule), true);
  });
});

describe("isFallbackCategorizationRule()", () => {
  it("true só para os 2 defaults do motor", () => {
    assert.equal(isFallbackCategorizationRule("lancamento-default"), true);
    assert.equal(isFallbackCategorizationRule("noticias-default"), true);
  });

  it("false para qualquer regra com sinal concreto", () => {
    assert.equal(isFallbackCategorizationRule("video-url"), false);
    assert.equal(isFallbackCategorizationRule("tutorial-domain"), false);
    assert.equal(isFallbackCategorizationRule("pesquisa-domain"), false);
    assert.equal(isFallbackCategorizationRule("lancamento-type-hint"), false);
    assert.equal(isFallbackCategorizationRule("lancamento-business-deal"), false);
  });
});

describe("categorizeArticles() — category_rule é aditivo, bucket idêntico (#6647)", () => {
  it("cada artigo recebe category_rule sem mudar o bucket resultante", () => {
    const result = categorizeArticles(SAMPLE_ARTICLES);
    for (const bucket of Object.keys(result) as Array<keyof typeof result>) {
      for (const article of result[bucket]) {
        // #6647: o bucket em que o artigo pousou é o MESMO que categorize()
        // (pré-#6647) já teria escolhido — category_rule só documenta o porquê.
        assert.ok((article as any).category, `artigo sem category: ${article.url}`);
        assert.ok((article as any).category_rule, `artigo sem category_rule: ${article.url}`);
        assert.equal(
          typeof isFallbackCategorizationRule((article as any).category_rule),
          "boolean",
        );
      }
    }
    // Nenhum artigo da amostra foi perdido (vídeo incluso, sem truncamento —
    // amostra tem só 1 vídeo, bem abaixo do teto de 2).
    const total = Object.values(result).reduce((acc, arr) => acc + arr.length, 0);
    assert.equal(total, SAMPLE_ARTICLES.length);
  });

  it("bucket de cada artigo bate com categorize() chamado direto (regressão de byte-identidade)", () => {
    const result = categorizeArticles(SAMPLE_ARTICLES);
    const bucketByUrl = new Map<string, string>();
    for (const bucket of Object.keys(result) as Array<keyof typeof result>) {
      for (const article of result[bucket]) {
        bucketByUrl.set(article.url, bucket as string);
      }
    }
    for (const article of SAMPLE_ARTICLES) {
      const expectedCategory = categorize(article);
      const expectedBucket = categoryToBucket(expectedCategory);
      assert.equal(bucketByUrl.get(article.url), expectedBucket, `bucket divergente para ${article.url}`);
    }
  });
});

describe("analyze-bucket-overrides.ts --rules (#6647)", () => {
  it("collectRuleUsage/summarizeRuleUsage agregam category_rule de 01-categorized.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "bucket-rules-"));
    try {
      const editionDir = join(dir, "260901");
      mkdirSync(join(editionDir, "_internal"), { recursive: true });
      writeFileSync(
        join(editionDir, "_internal", "01-categorized.json"),
        JSON.stringify({
          lancamento: [
            { url: "https://openai.com/index/a", category_rule: "lancamento-type-hint" },
            { url: "https://openai.com/index/b", category_rule: "lancamento-default" },
          ],
          radar: [
            { url: "https://techcrunch.com/c", category_rule: "noticias-default" },
          ],
          use_melhor: [
            { url: "https://cookbook.openai.com/d", category_rule: "tutorial-domain" },
          ],
          video: [],
        }),
        "utf8",
      );

      const entries = collectRuleUsage(dir);
      assert.equal(entries.length, 4);

      const summary = summarizeRuleUsage(entries);
      assert.equal(summary.editionsWithRuleData, 1);
      assert.equal(summary.articlesWithRule, 4);
      assert.equal(summary.fallbackArticles, 2); // lancamento-default + noticias-default
      assert.equal(summary.fallbackPct, 50);

      const lancamentoBucket = summary.byBucket.find((b) => b.bucket === "lancamento");
      assert.ok(lancamentoBucket);
      assert.equal(lancamentoBucket!.total, 2);
      assert.equal(lancamentoBucket!.fallback, 1);

      const defaultRule = summary.byRule.find((r) => r.rule === "lancamento-default");
      assert.ok(defaultRule);
      assert.equal(defaultRule!.fallback, true);
      assert.equal(defaultRule!.count, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("artigo sem category_rule (edição pré-#6647) é ignorado, não conta como fallback", () => {
    const dir = mkdtempSync(join(tmpdir(), "bucket-rules-legacy-"));
    try {
      const editionDir = join(dir, "260801");
      mkdirSync(join(editionDir, "_internal"), { recursive: true });
      writeFileSync(
        join(editionDir, "_internal", "01-categorized.json"),
        JSON.stringify({
          lancamento: [{ url: "https://openai.com/index/legacy" }], // sem category_rule
          radar: [],
          use_melhor: [],
          video: [],
        }),
        "utf8",
      );

      const entries = collectRuleUsage(dir);
      assert.equal(entries.length, 0);

      const summary = summarizeRuleUsage(entries);
      assert.equal(summary.articlesWithRule, 0);
      assert.equal(summary.fallbackPct, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
