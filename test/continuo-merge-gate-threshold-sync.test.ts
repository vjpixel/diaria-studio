import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EFFORT_DIFF_LINE_THRESHOLD as GATE_THRESHOLD } from "../scripts/check-continuo-merge-gate.ts";
import { EFFORT_DIFF_LINE_THRESHOLD as HOOK_THRESHOLD } from "../.claude/hooks/pr-create-review.mjs";

// #6926: scripts/check-continuo-merge-gate.ts DUPLICA (não importa, ver
// docstring dele — .claude/hooks/pr-create-review.mjs é .mjs sem
// declaração de tipos, e tsconfig.json só inclui scripts/**/*.ts)
// EFFORT_DIFF_LINE_THRESHOLD de .claude/hooks/pr-create-review.mjs
// (#4813/#6393) — decisão do editor de reusar o mesmo limiar de diff, não
// inventar um novo pro gate de merge do contínuo. Mesmo padrão de guard do
// #6820 pro SELF_REVIEW_MARKER: cada arquivo isolado só compararia a
// própria cópia contra um literal hardcoded — este teste importa AS DUAS e
// compara, pegando as duas cópias divergindo entre si.
describe("EFFORT_DIFF_LINE_THRESHOLD — as duas cópias duplicadas nunca divergem (#6926)", () => {
  it("scripts/check-continuo-merge-gate.ts e .claude/hooks/pr-create-review.mjs concordam", () => {
    assert.equal(GATE_THRESHOLD, HOOK_THRESHOLD);
  });
});
