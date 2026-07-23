import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  assemble,
  applyNegativeImpactBackstop,
  type Selection,
  type AllScoredFile,
  type AssembledOutput,
} from "../scripts/assemble-scored.ts";
import type { FinalistLike } from "../scripts/lib/negative-impact-promotion.ts";

const ALL: AllScoredFile = {
  all_scored: [
    { url: "a", score: 90 },
    { url: "b", score: 80 },
    { url: "c", score: 70 },
  ],
};

describe("assemble", () => {
  it("combina seleção + all_scored no contrato tmp-scored", () => {
    const sel: Selection = {
      highlights: [
        { score: 90, bucket: "noticias", reason: "r1", article: { url: "a" } },
        { score: 80, bucket: "pesquisa", reason: "r2", article: { url: "b" } },
      ],
      runners_up: [{ score: 70, article: { url: "c" } }],
    };
    const out = assemble(sel, ALL);
    assert.equal(out.highlights.length, 2);
    assert.equal(out.runners_up.length, 1);
    assert.equal(out.all_scored.length, 3);
    assert.deepEqual(out.all_scored, ALL.all_scored);
  });

  it("re-numera ranks 1..N preservando ordem editorial do array", () => {
    const sel: Selection = {
      highlights: [
        { score: 50, article: { url: "x" } }, // ordem editorial decidida pelo agent
        { score: 99, article: { url: "y" } },
      ],
    };
    const out = assemble(sel, ALL);
    assert.deepEqual(out.highlights.map((h) => h.rank), [1, 2]);
    // ordem do array preservada (não reordena por score)
    assert.deepEqual(out.highlights.map((h) => h.article?.url), ["x", "y"]);
  });

  it("campos ausentes viram arrays vazios", () => {
    const out = assemble({}, {});
    assert.deepEqual(out.highlights, []);
    assert.deepEqual(out.runners_up, []);
    assert.deepEqual(out.all_scored, []);
  });

  it("propaga warning_pool_too_small", () => {
    const out = assemble({ warning_pool_too_small: true }, ALL);
    assert.equal(out.warning_pool_too_small, true);
  });

  it("não inclui warning_pool_too_small quando ausente", () => {
    const out = assemble({ highlights: [] }, ALL);
    assert.ok(!("warning_pool_too_small" in out));
  });

  // #3916/#3918 — promoção de destaque de impacto-negativo
  it("propaga negative_impact_promoted quando presente", () => {
    const sel: Selection = {
      highlights: [{ score: 90, article: { url: "a" } }],
      negative_impact_promoted: {
        promoted_url: "https://x.com/harm",
        demoted_url: "https://y.com/low-score",
        reason: "nenhum dos top-6 tinha negative_impact:true",
      },
    };
    const out = assemble(sel, ALL);
    assert.deepEqual(out.negative_impact_promoted, sel.negative_impact_promoted);
  });

  it("não inclui negative_impact_promoted quando ausente", () => {
    const out = assemble({ highlights: [] }, ALL);
    assert.ok(!("negative_impact_promoted" in out));
  });
});

// #3916/#3918 — backstop determinístico invocado após a seleção do agent
describe("applyNegativeImpactBackstop", () => {
  const finalists: FinalistLike[] = [
    { url: "a", score: 90, bucket: "radar", article: { url: "a" } },
    { url: "harm", score: 60, bucket: "radar", article: { url: "harm", negative_impact: true } },
  ];

  it("no-op quando o assembled já tem ≥1 highlight tagueado", () => {
    const assembled: AssembledOutput = {
      highlights: [{ rank: 1, url: "a", score: 90, negative_impact: true }],
      runners_up: [],
      all_scored: [],
    };
    const out = applyNegativeImpactBackstop(assembled, finalists);
    assert.equal(out, assembled, "deve retornar a MESMA referência quando não promove (no-op)");
  });

  it("promove e seta negative_impact_promoted quando o agent não cumpriu a regra", () => {
    const assembled: AssembledOutput = {
      highlights: [{ rank: 1, url: "a", score: 90 }],
      runners_up: [],
      all_scored: [],
    };
    const out = applyNegativeImpactBackstop(assembled, finalists);
    assert.ok(out.negative_impact_promoted, "backstop deve ter promovido");
    assert.equal(out.negative_impact_promoted!.promoted_url, "harm");
    assert.equal(out.highlights[0].url, "harm");
  });

  it("no-op quando nenhum finalista tem a tag (pool sem candidato)", () => {
    const assembled: AssembledOutput = {
      highlights: [{ rank: 1, url: "a", score: 90 }],
      runners_up: [],
      all_scored: [],
    };
    const noTagFinalists: FinalistLike[] = [{ url: "a", score: 90, article: { url: "a" } }];
    const out = applyNegativeImpactBackstop(assembled, noTagFinalists);
    assert.equal(out, assembled);
    assert.equal(out.negative_impact_promoted, undefined);
  });
});
