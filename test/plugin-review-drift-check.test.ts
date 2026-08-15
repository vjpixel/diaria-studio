/**
 * test/plugin-review-drift-check.test.ts (#5311)
 *
 * Regressão pura pra `scripts/lib/plugin-review-drift-check.ts` — extração
 * de sinal, decisão de drift por agente, fingerprint/idempotência do
 * alarme, e o texto do e-mail. Nenhum teste toca disco/rede — conteúdo de
 * arquivo entra como string já em memória.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  PLUGIN_REVIEW_AGENTS,
  extractRelevantSignal,
  evaluateAgentDrift,
  evaluateAllAgentsDrift,
  hasPendingPluginReviewDrift,
  computePluginReviewDriftFingerprint,
  shouldAlarmPluginReviewDrift,
  advancePluginReviewDriftState,
  buildPluginReviewDriftAlarmEmail,
  emptyPluginReviewDriftState,
  type PluginReviewAgentResult,
  type PluginReviewDriftState,
} from "../scripts/lib/plugin-review-drift-check.ts";

const NOW = new Date("2026-08-15T12:00:00Z");

describe("PLUGIN_REVIEW_AGENTS (#5311)", () => {
  it("cobre exatamente os 5 agentes que DEFAULT_EFFORT=max dispara", () => {
    const names = PLUGIN_REVIEW_AGENTS.map((a) => a.agentName).sort();
    assert.deepEqual(names, [
      "code-reviewer",
      "comment-analyzer",
      "pr-test-analyzer",
      "silent-failure-hunter",
      "type-design-analyzer",
    ]);
  });
});

describe("extractRelevantSignal (#5311)", () => {
  it("captura a linha de confidence threshold real do code-reviewer.md", () => {
    const content = [
      "## Issue Confidence Scoring",
      "",
      "**Only report issues with confidence ≥ 80**",
      "",
      "Be thorough but filter aggressively - quality over quantity.",
    ].join("\n");
    const signal = extractRelevantSignal(content);
    assert.match(signal, /Only report issues with confidence ≥ 80/);
    assert.match(signal, /filter aggressively/i);
  });

  it("markdown sem vocabulário de filtro -> sinal vazio (resultado válido, não erro)", () => {
    const content = ["# Some Agent", "", "Reviews code for style.", "Reports every issue found."].join("\n");
    assert.equal(extractRelevantSignal(content), "");
  });

  it("case-insensitive — 'Confidence', 'CONFIDENCE' e 'confidence' casam igual", () => {
    const content = ["Line with Confidence here", "Line with CONFIDENCE here", "Line with confidence here"].join("\n");
    const signal = extractRelevantSignal(content);
    assert.equal(signal.split("\n").length, 3);
  });

  it("edição cosmética fora do vocabulário (reformatação, exemplo novo) não entra no sinal", () => {
    const before = ["**Only report issues with confidence ≥ 80**", "", "### Example", "Old example text here."].join("\n");
    const after = ["**Only report issues with confidence ≥ 80**", "", "### Example (revised)", "New example text here, much longer."].join("\n");
    assert.equal(extractRelevantSignal(before), extractRelevantSignal(after));
  });

  it("limiar mudando de valor (80 -> 90) MUDA o sinal — é o achado que este check existe pra pegar", () => {
    const before = extractRelevantSignal("**Only report issues with confidence ≥ 80**");
    const after = extractRelevantSignal("**Only report issues with confidence ≥ 90**");
    assert.notEqual(before, after);
  });

  it("espaço de borda por linha não conta como mudança (trim aplicado)", () => {
    const a = extractRelevantSignal("   Only report issues with confidence ≥ 80   ");
    const b = extractRelevantSignal("Only report issues with confidence ≥ 80");
    assert.equal(a, b);
  });
});

describe("evaluateAgentDrift (#5311)", () => {
  it("content null (arquivo ausente) -> missing_file, signal null", () => {
    const r = evaluateAgentDrift("code-reviewer", null, "algum sinal anterior");
    assert.equal(r.status, "missing_file");
    assert.equal(r.signal, null);
  });

  it("previousSignal null (1ª vez observado) -> no_baseline, nunca alarma sozinho", () => {
    const r = evaluateAgentDrift("code-reviewer", "Only report issues with confidence ≥ 80", null);
    assert.equal(r.status, "no_baseline");
    assert.equal(r.signal, "Only report issues with confidence ≥ 80");
  });

  it("sinal extraído bate com o baseline -> unchanged", () => {
    const content = "Only report issues with confidence ≥ 80";
    const r = evaluateAgentDrift("code-reviewer", content, extractRelevantSignal(content));
    assert.equal(r.status, "unchanged");
  });

  it("sinal extraído difere do baseline -> changed", () => {
    const r = evaluateAgentDrift("code-reviewer", "Only report issues with confidence ≥ 90", "Only report issues with confidence ≥ 80");
    assert.equal(r.status, "changed");
  });

  it("sinal continua vazio em ambas execuções -> unchanged (não 'changed' por comparar vazio com vazio)", () => {
    const r = evaluateAgentDrift("silent-failure-hunter", "# No filter language here", "");
    assert.equal(r.status, "unchanged");
  });
});

describe("evaluateAllAgentsDrift (#5311)", () => {
  it("mapeia cada agente independentemente a partir do estado anterior", () => {
    const previousState: PluginReviewDriftState = {
      agents: { "code-reviewer": { signal: "Only report issues with confidence ≥ 80", capturedAt: "2026-08-01T00:00:00Z" } },
      lastAlarmedFingerprint: null,
    };
    const contents = new Map<string, string | null>([
      ["code-reviewer", "Only report issues with confidence ≥ 90"],
      ["silent-failure-hunter", null],
      ["pr-test-analyzer", "no filter vocab here"],
      ["comment-analyzer", "no filter vocab here"],
      ["type-design-analyzer", "no filter vocab here"],
    ]);
    const results = evaluateAllAgentsDrift(PLUGIN_REVIEW_AGENTS, contents, previousState);
    const byName = Object.fromEntries(results.map((r) => [r.agentName, r.status]));
    assert.equal(byName["code-reviewer"], "changed");
    assert.equal(byName["silent-failure-hunter"], "missing_file");
    assert.equal(byName["pr-test-analyzer"], "no_baseline");
  });
});

function result(overrides: Partial<PluginReviewAgentResult>): PluginReviewAgentResult {
  return { agentName: "code-reviewer", status: "unchanged", signal: "", previousSignal: "", ...overrides };
}

describe("hasPendingPluginReviewDrift / computePluginReviewDriftFingerprint (#5311)", () => {
  it("sem nenhum 'changed' -> hasPendingPluginReviewDrift false, fingerprint vazio", () => {
    const results = [result({ status: "unchanged" }), result({ agentName: "pr-test-analyzer", status: "no_baseline" })];
    assert.equal(hasPendingPluginReviewDrift(results), false);
    assert.equal(computePluginReviewDriftFingerprint(results), "");
  });

  it("com 1+ 'changed' -> hasPendingPluginReviewDrift true, fingerprint não-vazio e determinístico", () => {
    const results = [
      result({ agentName: "type-design-analyzer", status: "changed", signal: "novo sinal" }),
      result({ agentName: "code-reviewer", status: "changed", signal: "outro sinal" }),
    ];
    assert.equal(hasPendingPluginReviewDrift(results), true);
    const fp1 = computePluginReviewDriftFingerprint(results);
    const fp2 = computePluginReviewDriftFingerprint([...results].reverse());
    assert.equal(fp1, fp2); // ordem-independente
    assert.notEqual(fp1, "");
  });
});

describe("shouldAlarmPluginReviewDrift (#5311)", () => {
  it("sem drift pendente -> nunca alarma", () => {
    const state = emptyPluginReviewDriftState();
    assert.equal(shouldAlarmPluginReviewDrift(state, [result({ status: "unchanged" })]), false);
  });

  it("1ª ocorrência de drift (state vazio) -> alarma", () => {
    const state = emptyPluginReviewDriftState();
    const results = [result({ status: "changed", signal: "novo" })];
    assert.equal(shouldAlarmPluginReviewDrift(state, results), true);
  });

  it("MESMO drift já alarmado -> não realarma", () => {
    const results = [result({ status: "changed", signal: "novo" })];
    const state: PluginReviewDriftState = { agents: {}, lastAlarmedFingerprint: computePluginReviewDriftFingerprint(results) };
    assert.equal(shouldAlarmPluginReviewDrift(state, results), false);
  });

  it("drift MUDOU de novo (sinal diferente do já alarmado) -> alarma de novo", () => {
    const oldResults = [result({ status: "changed", signal: "sinal A" })];
    const state: PluginReviewDriftState = { agents: {}, lastAlarmedFingerprint: computePluginReviewDriftFingerprint(oldResults) };
    const newResults = [result({ status: "changed", signal: "sinal B" })];
    assert.equal(shouldAlarmPluginReviewDrift(state, newResults), true);
  });
});

describe("advancePluginReviewDriftState (#5311)", () => {
  it("agente com content lido ganha entry nova; missing_file preserva a entry anterior", () => {
    const state: PluginReviewDriftState = {
      agents: { "silent-failure-hunter": { signal: "sinal antigo", capturedAt: "2026-08-01T00:00:00Z" } },
      lastAlarmedFingerprint: null,
    };
    const results = [
      result({ agentName: "code-reviewer", status: "no_baseline", signal: "novo sinal", previousSignal: null }),
      result({ agentName: "silent-failure-hunter", status: "missing_file", signal: null, previousSignal: "sinal antigo" }),
    ];
    const next = advancePluginReviewDriftState(state, results, NOW);
    assert.equal(next.agents["code-reviewer"].signal, "novo sinal");
    assert.equal(next.agents["code-reviewer"].capturedAt, NOW.toISOString());
    assert.equal(next.agents["silent-failure-hunter"].signal, "sinal antigo"); // preservado, não apagado
  });

  it("lastAlarmedFingerprint avança quando há drift pendente nesta rodada", () => {
    const state = emptyPluginReviewDriftState();
    const results = [result({ status: "changed", signal: "x" })];
    const next = advancePluginReviewDriftState(state, results, NOW);
    assert.equal(next.lastAlarmedFingerprint, computePluginReviewDriftFingerprint(results));
  });

  it("sem drift pendente -> lastAlarmedFingerprint preserva o valor anterior (re-armado)", () => {
    const state: PluginReviewDriftState = { agents: {}, lastAlarmedFingerprint: null };
    const results = [result({ status: "unchanged" })];
    const next = advancePluginReviewDriftState(state, results, NOW);
    assert.equal(next.lastAlarmedFingerprint, null);
  });
});

describe("buildPluginReviewDriftAlarmEmail (#5311)", () => {
  it("lista o(s) agente(s) com sinal alterado, antes e depois", () => {
    const results = [
      result({ agentName: "code-reviewer", status: "changed", signal: "confidence ≥ 90", previousSignal: "confidence ≥ 80" }),
      result({ agentName: "pr-test-analyzer", status: "unchanged" }),
    ];
    const { subject, body } = buildPluginReviewDriftAlarmEmail(results, NOW);
    assert.match(subject, /1 agente\(s\)/);
    assert.match(body, /pr-review-toolkit:code-reviewer/);
    assert.match(body, /confidence ≥ 80/);
    assert.match(body, /confidence ≥ 90/);
    assert.doesNotMatch(body, /pr-test-analyzer/); // só o agente changed entra na lista
  });
});
