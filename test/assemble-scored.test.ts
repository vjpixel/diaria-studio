import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assemble, type Selection, type AllScoredFile } from "../scripts/assemble-scored.ts";

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
});
