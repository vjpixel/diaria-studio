/**
 * test/continuo-cost-summary.test.ts (#5293 item 6, correção #5344 Parte B0)
 *
 * Cobre `scripts/continuo-cost-summary.ts` — agregação de
 * `coordinator_tokens_estimate` (categoria "Coordenador") E `subagent_metrics`
 * (categoria "Implementação", #5344 Parte B0), ambos `agent="continuo"`,
 * através de TODOS os dias rotacionados de uma sessão `/diaria-continuo`.
 * Isolado em tmpdir — nunca toca `data/` real do repo.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  sumContinuoTokenEstimates,
  computeContinuoCostSummary,
  formatContinuoCostSummary,
} from "../scripts/continuo-cost-summary.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "continuo-cost-"));
}

describe("sumContinuoTokenEstimates (#5293 item 6)", () => {
  it("soma tokens só de eventos agent=continuo + message=coordinator_tokens_estimate", () => {
    const lines = [
      JSON.stringify({ agent: "continuo", edition: "260814", message: "coordinator_tokens_estimate", details: { tokens: 1000, source: "harness_usage" } }),
      JSON.stringify({ agent: "overnight", edition: "260814", message: "coordinator_tokens_estimate", details: { tokens: 5000, source: "harness_usage" } }),
      JSON.stringify({ agent: "continuo", edition: "260814", message: "outra_coisa", details: { tokens: 999 } }),
      JSON.stringify({ agent: "continuo", edition: "260815", message: "coordinator_tokens_estimate", details: { tokens: 2000, source: "harness_usage" } }),
    ];
    const summary = sumContinuoTokenEstimates(lines, new Set(["260814", "260815"]));
    assert.equal(summary.coordinatorTokens, 3000);
    assert.equal(summary.totalTokens, 3000);
    assert.deepEqual(summary.perEdition, { "260814": 1000, "260815": 2000 });
    assert.equal(summary.eventCount, 2);
  });

  it("ignora edições fora do set 'editions' passado (ex: fora do --since)", () => {
    const lines = [
      JSON.stringify({ agent: "continuo", edition: "260813", message: "coordinator_tokens_estimate", details: { tokens: 500 } }),
      JSON.stringify({ agent: "continuo", edition: "260814", message: "coordinator_tokens_estimate", details: { tokens: 1000 } }),
    ];
    const summary = sumContinuoTokenEstimates(lines, new Set(["260814"]));
    assert.equal(summary.totalTokens, 1000);
    assert.deepEqual(summary.editions, ["260814"]);
  });

  it("tokens: null (harness não expôs) → contado em unavailableCount, NUNCA somado como 0", () => {
    const lines = [
      JSON.stringify({ agent: "continuo", edition: "260814", message: "coordinator_tokens_estimate", details: { tokens: null, source: "unavailable" } }),
      JSON.stringify({ agent: "continuo", edition: "260814", message: "coordinator_tokens_estimate", details: { tokens: 100, source: "harness_usage" } }),
    ];
    const summary = sumContinuoTokenEstimates(lines, new Set(["260814"]));
    assert.equal(summary.totalTokens, 100);
    assert.equal(summary.unavailableCount, 1);
    assert.equal(summary.eventCount, 2);
  });

  it("linhas malformadas são ignoradas sem crashar", () => {
    const lines = ["{ isto não é json", "", JSON.stringify({ agent: "continuo", edition: "260814", message: "coordinator_tokens_estimate", details: { tokens: 10 } })];
    const summary = sumContinuoTokenEstimates(lines, new Set(["260814"]));
    assert.equal(summary.totalTokens, 10);
  });

  it("bySource agrega contagem por fonte (harness_usage vs context_size_proxy vs unavailable) — só coordinator_tokens_estimate", () => {
    const lines = [
      JSON.stringify({ agent: "continuo", edition: "260814", message: "coordinator_tokens_estimate", details: { tokens: 10, source: "harness_usage" } }),
      JSON.stringify({ agent: "continuo", edition: "260814", message: "coordinator_tokens_estimate", details: { tokens: 20, source: "context_size_proxy" } }),
      JSON.stringify({ agent: "continuo", edition: "260814", message: "coordinator_tokens_estimate", details: { tokens: null, source: "unavailable" } }),
    ];
    const summary = sumContinuoTokenEstimates(lines, new Set(["260814"]));
    assert.deepEqual(summary.bySource, { harness_usage: 1, context_size_proxy: 1, unavailable: 1 });
  });
});

describe("sumContinuoTokenEstimates — subagent_metrics (#5344 Parte B0)", () => {
  it("soma details.subagent_tokens de eventos agent=continuo + message=subagent_metrics como categoria implementationTokens", () => {
    const lines = [
      JSON.stringify({ agent: "continuo", edition: "260815", message: "subagent_metrics", details: { subagent_tokens: 50000, tool_uses: 12, duration_ms: 900000, source: "harness_usage" } }),
      JSON.stringify({ agent: "continuo", edition: "260815", message: "subagent_metrics", details: { subagent_tokens: 30000, tool_uses: 8, duration_ms: 600000, source: "harness_usage" } }),
    ];
    const summary = sumContinuoTokenEstimates(lines, new Set(["260815"]));
    assert.equal(summary.implementationTokens, 80000);
    assert.equal(summary.implementationEventCount, 2);
    assert.equal(summary.implementationUnavailableCount, 0);
  });

  it("coordinatorTokens + implementationTokens = totalTokens — a correção central da #5344 Parte B0", () => {
    const lines = [
      JSON.stringify({ agent: "continuo", edition: "260815", message: "coordinator_tokens_estimate", details: { tokens: 5000, source: "harness_usage" } }),
      JSON.stringify({ agent: "continuo", edition: "260815", message: "subagent_metrics", details: { subagent_tokens: 60000, source: "harness_usage" } }),
    ];
    const summary = sumContinuoTokenEstimates(lines, new Set(["260815"]));
    assert.equal(summary.coordinatorTokens, 5000);
    assert.equal(summary.implementationTokens, 60000);
    assert.equal(summary.totalTokens, 65000);
    // Antes da correção o script só somava coordinatorTokens — este assert falharia (65000 vs 5000).
    assert.notEqual(summary.totalTokens, summary.coordinatorTokens);
  });

  it("subagent_tokens: null (harness não expôs por invocação) → implementationUnavailableCount, nunca somado como 0", () => {
    const lines = [
      JSON.stringify({ agent: "continuo", edition: "260815", message: "subagent_metrics", details: { subagent_tokens: null, source: "unavailable" } }),
      JSON.stringify({ agent: "continuo", edition: "260815", message: "subagent_metrics", details: { subagent_tokens: 1000, source: "harness_usage" } }),
    ];
    const summary = sumContinuoTokenEstimates(lines, new Set(["260815"]));
    assert.equal(summary.implementationTokens, 1000);
    assert.equal(summary.implementationUnavailableCount, 1);
    assert.equal(summary.implementationEventCount, 2);
  });

  it("perEdition combina coordenador + implementação no mesmo dia", () => {
    const lines = [
      JSON.stringify({ agent: "continuo", edition: "260815", message: "coordinator_tokens_estimate", details: { tokens: 1000 } }),
      JSON.stringify({ agent: "continuo", edition: "260815", message: "subagent_metrics", details: { subagent_tokens: 4000 } }),
    ];
    const summary = sumContinuoTokenEstimates(lines, new Set(["260815"]));
    assert.deepEqual(summary.perEdition, { "260815": 5000 });
  });

  it("agent=overnight em subagent_metrics é ignorado (filtro estrito, mesmo padrão da categoria coordenador)", () => {
    const lines = [
      JSON.stringify({ agent: "overnight", edition: "260815", message: "subagent_metrics", details: { subagent_tokens: 999999 } }),
      JSON.stringify({ agent: "continuo", edition: "260815", message: "subagent_metrics", details: { subagent_tokens: 100 } }),
    ];
    const summary = sumContinuoTokenEstimates(lines, new Set(["260815"]));
    assert.equal(summary.implementationTokens, 100);
  });
});

describe("computeContinuoCostSummary (#5293 item 6) — I/O", () => {
  it("data/continuo/ e run-log.jsonl ausentes → summary zerado, nunca lança", () => {
    const dir = tmp();
    try {
      const summary = computeContinuoCostSummary(dir);
      assert.deepEqual(summary.editions, []);
      assert.equal(summary.totalTokens, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("soma através de múltiplos dias rotacionados de data/continuo/", () => {
    const dir = tmp();
    try {
      for (const aammdd of ["260813", "260814"]) {
        mkdirSync(join(dir, "data", "continuo", aammdd), { recursive: true });
        writeFileSync(join(dir, "data", "continuo", aammdd, "plan.json"), "{}");
      }
      mkdirSync(join(dir, "data"), { recursive: true });
      const lines = [
        JSON.stringify({ agent: "continuo", edition: "260813", message: "coordinator_tokens_estimate", details: { tokens: 1000 } }),
        JSON.stringify({ agent: "continuo", edition: "260814", message: "coordinator_tokens_estimate", details: { tokens: 2000 } }),
      ];
      writeFileSync(join(dir, "data", "run-log.jsonl"), lines.join("\n") + "\n");

      const summary = computeContinuoCostSummary(dir);
      assert.equal(summary.totalTokens, 3000);
      assert.deepEqual(summary.editions, ["260813", "260814"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--since (segundo argumento) restringe a dias >= o valor dado", () => {
    const dir = tmp();
    try {
      for (const aammdd of ["260812", "260813", "260814"]) {
        mkdirSync(join(dir, "data", "continuo", aammdd), { recursive: true });
        writeFileSync(join(dir, "data", "continuo", aammdd, "plan.json"), "{}");
      }
      mkdirSync(join(dir, "data"), { recursive: true });
      const lines = ["260812", "260813", "260814"].map((edition) =>
        JSON.stringify({ agent: "continuo", edition, message: "coordinator_tokens_estimate", details: { tokens: 1000 } }),
      );
      writeFileSync(join(dir, "data", "run-log.jsonl"), lines.join("\n") + "\n");

      const summary = computeContinuoCostSummary(dir, "260813");
      assert.deepEqual(summary.editions, ["260813", "260814"]);
      assert.equal(summary.totalTokens, 2000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("formatContinuoCostSummary (#5293 item 6, correção #5344 Parte B0)", () => {
  it("nenhum dia → mensagem explícita, sem crashar em divisão/index de array vazio", () => {
    const text = formatContinuoCostSummary({
      editions: [],
      totalTokens: 0,
      coordinatorTokens: 0,
      implementationTokens: 0,
      unavailableCount: 0,
      implementationUnavailableCount: 0,
      eventCount: 0,
      implementationEventCount: 0,
      perEdition: {},
      bySource: {},
    });
    assert.match(text, /nenhum dia/);
  });

  it("com dados, inclui total combinado, breakdown coordenador/implementação e por dia", () => {
    const text = formatContinuoCostSummary({
      editions: ["260813", "260814"],
      totalTokens: 83000,
      coordinatorTokens: 3000,
      implementationTokens: 80000,
      unavailableCount: 1,
      implementationUnavailableCount: 0,
      eventCount: 3,
      implementationEventCount: 2,
      perEdition: { "260813": 1000, "260814": 82000 },
      bySource: { harness_usage: 2, unavailable: 1 },
    });
    assert.match(text, /83\.000|83000/); // total combinado — toLocaleString pt-BR usa ponto como separador de milhar
    assert.match(text, /Coordenador/);
    assert.match(text, /Implementação/);
    assert.match(text, /260813/);
    assert.match(text, /260814/);
    assert.match(text, /1 sem valor/);
  });
});
