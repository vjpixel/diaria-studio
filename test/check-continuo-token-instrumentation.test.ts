/**
 * test/check-continuo-token-instrumentation.test.ts (#5344 Parte B0)
 *
 * Cobertura de `scripts/check-continuo-token-instrumentation.ts`: contagem
 * pura dos 2 tipos de evento rastreados (`coordinator_tokens_estimate`,
 * `subagent_metrics`) filtrando por `agent === "continuo"` E `edition`, o
 * veredito derivado, a seção de texto pronta pro relatório, e a orquestração
 * fail-soft com fixtures em tmpdir. Espelha
 * `test/check-overnight-token-instrumentation.test.ts` (#5009) — mesma
 * estrutura de teste, adaptada pro escopo "dia rotacionado" + filtro de
 * agent (o irmão overnight não precisa filtrar por agent porque só
 * "overnight" aparece nos fixtures dele; aqui "overnight"/"continuo"
 * coexistem no mesmo `run-log.jsonl` real, então o filtro é comportamento
 * central a testar).
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  countContinuoTokenInstrumentationEvents,
  resolveContinuoTokenInstrumentationVerdict,
  buildContinuoTokenInstrumentationSection,
  checkContinuoTokenInstrumentation,
  TRACKED_CONTINUO_TOKEN_INSTRUMENTATION_MESSAGES,
} from "../scripts/check-continuo-token-instrumentation.ts";

let root: string | null = null;
afterEach(() => {
  if (root) {
    rmSync(root, { recursive: true, force: true });
    root = null;
  }
});

function makeRoot(): string {
  root = mkdtempSync(join(tmpdir(), "check-continuo-token-instrumentation-"));
  return root;
}

function writeRunLog(rootDir: string, lines: string[]): void {
  const dataDir = join(rootDir, "data");
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, "run-log.jsonl"), lines.join("\n") + "\n", "utf8");
}

function evt(edition: string, message: string, agent = "continuo", extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    timestamp: "2026-08-15T03:00:00.000Z",
    edition,
    stage: null,
    agent,
    level: "info",
    message,
    details: null,
    ...extra,
  });
}

describe("countContinuoTokenInstrumentationEvents — contagem pura", () => {
  it("conta os 2 tipos rastreados, filtrando por edição", () => {
    const lines = [
      evt("260815", "subagent_metrics"),
      evt("260815", "subagent_metrics"),
      evt("260815", "coordinator_tokens_estimate"),
      evt("260814", "subagent_metrics"), // dia diferente — não conta
      evt("260815", "outro_evento_qualquer"), // mensagem não rastreada — ignorada
    ];
    const counts = countContinuoTokenInstrumentationEvents(lines, "260815");
    assert.deepEqual(counts, {
      coordinator_tokens_estimate: 1,
      subagent_metrics: 2,
    });
  });

  it("filtra por agent === 'continuo' — eventos agent=overnight no mesmo dia NÃO contam", () => {
    const lines = [
      evt("260815", "subagent_metrics", "overnight"),
      evt("260815", "coordinator_tokens_estimate", "overnight"),
      evt("260815", "subagent_metrics", "continuo"),
    ];
    const counts = countContinuoTokenInstrumentationEvents(lines, "260815");
    assert.deepEqual(counts, {
      coordinator_tokens_estimate: 0,
      subagent_metrics: 1,
    });
  });

  it("ignora linhas malformadas (JSON inválido) sem lançar", () => {
    const lines = ["não é json", evt("260815", "subagent_metrics"), "{quebrado"];
    const counts = countContinuoTokenInstrumentationEvents(lines, "260815");
    assert.equal(counts.subagent_metrics, 1);
  });

  it("array vazio produz contagem zerada pros 2 tipos", () => {
    const counts = countContinuoTokenInstrumentationEvents([], "260815");
    for (const m of TRACKED_CONTINUO_TOKEN_INSTRUMENTATION_MESSAGES) {
      assert.equal(counts[m], 0);
    }
  });
});

describe("resolveContinuoTokenInstrumentationVerdict — veredito puro", () => {
  it("ok quando os 2 tipos têm >= 1 evento", () => {
    const verdict = resolveContinuoTokenInstrumentationVerdict({
      coordinator_tokens_estimate: 3,
      subagent_metrics: 1,
    });
    assert.deepEqual(verdict, { status: "ok" });
  });

  it("warning nomeando os 2 tipos quando nenhum foi emitido", () => {
    const verdict = resolveContinuoTokenInstrumentationVerdict({
      coordinator_tokens_estimate: 0,
      subagent_metrics: 0,
    });
    assert.equal(verdict.status, "warning");
    assert.deepEqual(
      (verdict as { status: "warning"; missing: string[] }).missing.slice().sort(),
      [...TRACKED_CONTINUO_TOKEN_INSTRUMENTATION_MESSAGES].sort(),
    );
  });

  it("warning nomeando SÓ o tipo ausente quando é parcial (1 de 2 presente)", () => {
    const verdict = resolveContinuoTokenInstrumentationVerdict({
      coordinator_tokens_estimate: 5,
      subagent_metrics: 0,
    });
    assert.equal(verdict.status, "warning");
    assert.deepEqual((verdict as { status: "warning"; missing: string[] }).missing, ["subagent_metrics"]);
  });
});

describe("buildContinuoTokenInstrumentationSection — texto pronto pro relatório", () => {
  it("ok: menciona OK e as contagens, sem a frase de aviso", () => {
    const section = buildContinuoTokenInstrumentationSection(
      "260815",
      { coordinator_tokens_estimate: 3, subagent_metrics: 1 },
      { status: "ok" },
    );
    assert.match(section, /OK/);
    assert.match(section, /subagent_metrics: 1/);
    assert.doesNotMatch(section, /esqueceu os checkpoints/);
  });

  it("warning: usa frase explícita, nunca 'unavailable' ambíguo", () => {
    const section = buildContinuoTokenInstrumentationSection(
      "260815",
      { coordinator_tokens_estimate: 0, subagent_metrics: 0 },
      { status: "warning", missing: [...TRACKED_CONTINUO_TOKEN_INSTRUMENTATION_MESSAGES] },
    );
    assert.match(section, /instrumentação de token não foi emitida neste dia/);
    assert.doesNotMatch(section, /\bunavailable\b/);
  });
});

describe("checkContinuoTokenInstrumentation — orquestração fail-soft", () => {
  it("fixture com os 2 tipos presentes -> ok", () => {
    const rootDir = makeRoot();
    writeRunLog(rootDir, [
      evt("260815", "coordinator_tokens_estimate"),
      evt("260815", "subagent_metrics"),
    ]);
    const result = checkContinuoTokenInstrumentation("260815", rootDir);
    assert.deepEqual(result.verdict, { status: "ok" });
    assert.match(result.section, /OK/);
  });

  it("fixture sem nenhum dos 2 tipos -> warning nomeando ambos", () => {
    const rootDir = makeRoot();
    writeRunLog(rootDir, [evt("260815", "algum_outro_evento"), evt("260814", "subagent_metrics")]);
    const result = checkContinuoTokenInstrumentation("260815", rootDir);
    assert.equal(result.verdict.status, "warning");
    assert.deepEqual(
      (result.verdict as { status: "warning"; missing: string[] }).missing.slice().sort(),
      [...TRACKED_CONTINUO_TOKEN_INSTRUMENTATION_MESSAGES].sort(),
    );
    assert.match(result.section, /esqueceu os checkpoints/);
  });

  it("fixture parcial (só subagent_metrics presente) -> warning nomeando só coordinator_tokens_estimate", () => {
    const rootDir = makeRoot();
    writeRunLog(rootDir, [
      evt("260815", "subagent_metrics"),
      evt("260815", "subagent_metrics"),
    ]);
    const result = checkContinuoTokenInstrumentation("260815", rootDir);
    assert.equal(result.verdict.status, "warning");
    assert.deepEqual((result.verdict as { status: "warning"; missing: string[] }).missing, [
      "coordinator_tokens_estimate",
    ]);
    assert.equal(result.counts.subagent_metrics, 2);
  });

  it("eventos agent=overnight no mesmo dia não bastam pra dar ok numa checagem continuo", () => {
    const rootDir = makeRoot();
    writeRunLog(rootDir, [
      evt("260815", "coordinator_tokens_estimate", "overnight"),
      evt("260815", "subagent_metrics", "overnight"),
    ]);
    const result = checkContinuoTokenInstrumentation("260815", rootDir);
    assert.equal(result.verdict.status, "warning");
  });

  it("run-log.jsonl ausente -> tratado como 0 eventos (warning), nunca lança", () => {
    const rootDir = makeRoot();
    // nenhum data/run-log.jsonl criado
    const result = checkContinuoTokenInstrumentation("260815", rootDir);
    assert.equal(result.verdict.status, "warning");
  });
});
