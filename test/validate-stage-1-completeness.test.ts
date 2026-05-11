/**
 * Test: validate-stage-1-completeness.ts (#1091)
 *
 * Garante que o validador detecta o caso "passo 1f skipado" — orchestrator
 * pulou source-researcher + discovery e seguiu só com RSS.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkResearcherCompleteness } from "../scripts/validate-stage-1-completeness.ts";

describe("checkResearcherCompleteness", () => {
  it("detecta 1f skipado: só entries RSS", () => {
    const runs = [
      { source: "Canaltech (IA)", outcome: "ok" as const, method: "rss", articles: [] },
      { source: "Exame (IA)", outcome: "ok" as const, method: "rss", articles: [] },
    ];
    const result = checkResearcherCompleteness(runs);
    assert.equal(result.ok, false);
    assert.match(result.reason!, /passo 1f não rodou/);
    assert.equal(result.stats.rss, 2);
    assert.equal(result.stats.researcher, 0);
    assert.equal(result.stats.discovery, 0);
  });

  it("aceita: tem entries de source-researcher (sem method ou method!=rss)", () => {
    const runs = [
      { source: "Canaltech (IA)", outcome: "ok" as const, method: "rss", articles: [] },
      { source: "MIT Technology Review", outcome: "ok" as const, articles: [] }, // sem method
    ];
    const result = checkResearcherCompleteness(runs);
    assert.equal(result.ok, true);
    assert.equal(result.stats.researcher, 1);
  });

  it("aceita: tem entries de discovery (source prefix discovery:)", () => {
    const runs = [
      { source: "Canaltech (IA)", outcome: "ok" as const, method: "rss", articles: [] },
      { source: "discovery:ai-regulation-brazil", outcome: "ok" as const, articles: [] },
    ];
    const result = checkResearcherCompleteness(runs);
    assert.equal(result.ok, true);
    assert.equal(result.stats.discovery, 1);
  });

  it("rejeita: 0 runs (researcher-results vazio)", () => {
    const result = checkResearcherCompleteness([]);
    assert.equal(result.ok, false);
    assert.equal(result.stats.total, 0);
  });

  it("aceita: mix completo (rss + researcher + discovery)", () => {
    const runs = [
      { source: "Canaltech (IA)", outcome: "ok" as const, method: "rss", articles: [] },
      { source: "MIT Technology Review", outcome: "ok" as const, articles: [] },
      { source: "discovery:ai-brazil", outcome: "ok" as const, articles: [] },
    ];
    const result = checkResearcherCompleteness(runs);
    assert.equal(result.ok, true);
    assert.equal(result.stats.rss, 1);
    assert.equal(result.stats.researcher, 1);
    assert.equal(result.stats.discovery, 1);
  });

  it("aceita: method=websearch (formato real do source-researcher)", () => {
    // Validado em data/editions/260508/_internal/researcher-results.json
    // (5 entries com method: "websearch" quando 1f rodou).
    const runs = [
      { source: "G1 Tecnologia (IA)", outcome: "ok" as const, method: "websearch", articles: [] },
    ];
    const result = checkResearcherCompleteness(runs);
    assert.equal(result.ok, true);
    assert.equal(result.stats.researcher, 1);
  });

  it("aceita: method=discovery (formato real do discovery-searcher)", () => {
    // Validado em data/editions/260508 (10 entries com method: "discovery"
    // e source prefix "discovery:").
    const runs = [
      { source: "discovery:regulacao-ia-brasil", outcome: "ok" as const, method: "discovery", articles: [] },
    ];
    const result = checkResearcherCompleteness(runs);
    assert.equal(result.ok, true);
    assert.equal(result.stats.discovery, 1);
  });

  it("trata sitemap como RSS (não conta como researcher)", () => {
    const runs = [
      { source: "Perplexity Research", outcome: "ok" as const, method: "sitemap", articles: [] },
    ];
    const result = checkResearcherCompleteness(runs);
    assert.equal(result.ok, false, "sitemap-only sem researcher deve falhar");
    assert.equal(result.stats.rss, 1);
  });
});
