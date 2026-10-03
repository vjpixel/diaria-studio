/** #9527 — regressão: o par efetivo (model × perTurnEffort) vem do transcript, não do frontmatter. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  EXPECTED_EFFORT,
  EXPECTED_MODEL,
  parseAssistantPairs,
  probe,
  resolveTranscriptPath,
  tallyPairs,
} from "../scripts/lib/effective-model-probe.ts";

const e = (model: string, eff: string, type = "assistant") =>
  JSON.stringify({ type, message: { model }, perTurnEffort: eff });

describe("effective-model-probe (#9527)", () => {
  it("par-alvo é claude-sonnet-5-5/medium (#9530)", () => {
    assert.equal(EXPECTED_MODEL, "claude-sonnet-5-5");
    assert.equal(EXPECTED_EFFORT, "medium");
  });
  it("1º turno no pin, turno pós task-notification no par da sessão → diverge (o bug)", () => {
    const j = [e("claude-sonnet-5-5", "medium"), e("claude-opus-5-5", "xhigh")].join("\n");
    const r = probe(j);
    assert.equal(r.ok, false);
    assert.deepEqual(r.effective, { model: "claude-opus-5-5", effort: "xhigh" });
  });
  it("último turno sonnet-5-5/medium → ok", () => {
    assert.equal(probe([e("claude-opus-5-5", "low"), e("claude-sonnet-5-5", "medium")].join("\n")).ok, true);
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

describe("resolveTranscriptPath (#9527, review do PR #9529)", () => {
  const deps = { findTranscript: (sid: string) => `/p/${sid}.jsonl`, newest: () => "/p/OUTRA-SESSAO.jsonl" };
  it("sem flags → null: nunca cai no .jsonl mais recente (podia ser de outra sessão)", () => {
    assert.equal(resolveTranscriptPath([], deps), null);
  });
  it("ignora env CLAUDE_SESSION_ID (não existe no harness)", () => {
    process.env.CLAUDE_SESSION_ID = "x";
    try {
      assert.equal(resolveTranscriptPath([], deps), null);
    } finally {
      delete process.env.CLAUDE_SESSION_ID;
    }
  });
  it("--session-id (injetado pelo hook) resolve o transcript da própria sessão", () => {
    assert.equal(resolveTranscriptPath(["--session-id", "abc"], deps), "/p/abc.jsonl");
  });
  it("--transcript vence --session-id injetado", () => {
    assert.equal(resolveTranscriptPath(["--transcript", "/t.jsonl", "--session-id", "abc"], deps), "/t.jsonl");
  });
  it("--newest é opt-in explícito", () => {
    assert.equal(resolveTranscriptPath(["--newest"], deps), "/p/OUTRA-SESSAO.jsonl");
  });
});
