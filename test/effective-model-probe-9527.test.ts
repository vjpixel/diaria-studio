/** #9527 — regressão: o par efetivo (model × perTurnEffort) vem do transcript, não do frontmatter. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseAssistantPairs, probe, tallyPairs } from "../scripts/lib/effective-model-probe.ts";

const e = (model: string, eff: string, type = "assistant") =>
  JSON.stringify({ type, message: { model }, perTurnEffort: eff });

describe("effective-model-probe (#9527)", () => {
  it("1º turno opus/low, turno pós task-notification sonnet/medium → diverge (o bug)", () => {
    const j = [e("claude-opus-5-5", "low"), e("claude-sonnet-5-5", "medium")].join("\n");
    const r = probe(j);
    assert.equal(r.ok, false);
    assert.deepEqual(r.effective, { model: "claude-sonnet-5-5", effort: "medium" });
  });
  it("último turno opus/low → ok", () => {
    assert.equal(probe([e("claude-sonnet-5-5", "medium"), e("claude-opus-5-5", "low")].join("\n")).ok, true);
  });
  it("ignora linhas inválidas, não-assistant e <synthetic>; sem assistant → effective null", () => {
    const j = ["lixo", e("x", "low", "user"), e("<synthetic>", "low")].join("\n");
    assert.equal(parseAssistantPairs(j).length, 0);
    assert.equal(probe(j).effective, null);
    assert.equal(probe(j).ok, false);
  });
  it("sinceLine pula entradas anteriores; tally conta por par", () => {
    const j = [e("claude-sonnet-5-5", "medium"), e("claude-opus-5-5", "low"), e("claude-opus-5-5", "low")].join("\n");
    assert.deepEqual(tallyPairs(parseAssistantPairs(j)), { "claude-sonnet-5-5/medium": 1, "claude-opus-5-5/low": 2 });
    assert.equal(parseAssistantPairs(j, 1).length, 2);
  });
});
