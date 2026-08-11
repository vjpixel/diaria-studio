/**
 * test/check-overnight-token-instrumentation.test.ts (#5009)
 *
 * Cobertura de `scripts/check-overnight-token-instrumentation.ts`: contagem
 * pura dos 3 tipos de evento (`subagent_metrics`, `coordinator_tokens_estimate`,
 * `review_metrics`), o veredito derivado, a seção markdown pronta pro
 * relatório, e a orquestração fail-soft com fixtures em tmpdir (mesmo padrão
 * de `test/pending-scheduled-tasks.test.ts`).
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  countTokenInstrumentationEvents,
  resolveTokenInstrumentationVerdict,
  buildTokenInstrumentationSection,
  resolveEditionFromArgs,
  checkOvernightTokenInstrumentation,
  TRACKED_TOKEN_INSTRUMENTATION_MESSAGES,
} from "../scripts/check-overnight-token-instrumentation.ts";

let root: string | null = null;
afterEach(() => {
  if (root) {
    rmSync(root, { recursive: true, force: true });
    root = null;
  }
});

function makeRoot(): string {
  root = mkdtempSync(join(tmpdir(), "check-overnight-token-instrumentation-"));
  return root;
}

function writeRunLog(rootDir: string, lines: string[]): void {
  const dataDir = join(rootDir, "data");
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, "run-log.jsonl"), lines.join("\n") + "\n", "utf8");
}

function evt(edition: string, message: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    timestamp: "2026-08-11T03:00:00.000Z",
    edition,
    stage: null,
    agent: "overnight",
    level: "info",
    message,
    details: null,
    ...extra,
  });
}

describe("countTokenInstrumentationEvents — contagem pura", () => {
  it("conta os 3 tipos rastreados, filtrando por edição", () => {
    const lines = [
      evt("260811", "subagent_metrics"),
      evt("260811", "subagent_metrics"),
      evt("260811", "coordinator_tokens_estimate"),
      evt("260811", "review_metrics"),
      evt("260810b", "subagent_metrics"), // edição diferente — não conta
      evt("260811", "outro_evento_qualquer"), // mensagem não rastreada — ignorada
    ];
    const counts = countTokenInstrumentationEvents(lines, "260811");
    assert.deepEqual(counts, {
      subagent_metrics: 2,
      coordinator_tokens_estimate: 1,
      review_metrics: 1,
    });
  });

  it("ignora linhas malformadas (JSON inválido) sem lançar", () => {
    const lines = ["não é json", evt("260811", "subagent_metrics"), "{quebrado"];
    const counts = countTokenInstrumentationEvents(lines, "260811");
    assert.equal(counts.subagent_metrics, 1);
  });

  it("array vazio produz contagem zerada pros 3 tipos", () => {
    const counts = countTokenInstrumentationEvents([], "260811");
    for (const m of TRACKED_TOKEN_INSTRUMENTATION_MESSAGES) {
      assert.equal(counts[m], 0);
    }
  });
});

describe("resolveTokenInstrumentationVerdict — veredito puro", () => {
  it("ok quando os 3 tipos têm >= 1 evento", () => {
    const verdict = resolveTokenInstrumentationVerdict({
      subagent_metrics: 3,
      coordinator_tokens_estimate: 1,
      review_metrics: 2,
    });
    assert.deepEqual(verdict, { status: "ok" });
  });

  it("warning nomeando TODOS os 3 tipos quando nenhum foi emitido", () => {
    const verdict = resolveTokenInstrumentationVerdict({
      subagent_metrics: 0,
      coordinator_tokens_estimate: 0,
      review_metrics: 0,
    });
    assert.equal(verdict.status, "warning");
    assert.deepEqual(
      (verdict as { status: "warning"; missing: string[] }).missing.slice().sort(),
      [...TRACKED_TOKEN_INSTRUMENTATION_MESSAGES].sort(),
    );
  });

  it("warning nomeando SÓ os tipos ausentes quando é parcial (1 de 3 presente)", () => {
    const verdict = resolveTokenInstrumentationVerdict({
      subagent_metrics: 5,
      coordinator_tokens_estimate: 0,
      review_metrics: 0,
    });
    assert.equal(verdict.status, "warning");
    assert.deepEqual((verdict as { status: "warning"; missing: string[] }).missing.slice().sort(), [
      "coordinator_tokens_estimate",
      "review_metrics",
    ]);
  });
});

describe("buildTokenInstrumentationSection — texto pronto pro relatório", () => {
  it("ok: menciona OK e as contagens, sem a frase de aviso", () => {
    const section = buildTokenInstrumentationSection("260811", {
      subagent_metrics: 3,
      coordinator_tokens_estimate: 1,
      review_metrics: 2,
    }, { status: "ok" });
    assert.match(section, /OK/);
    assert.match(section, /subagent_metrics: 3/);
    assert.doesNotMatch(section, /esqueceu os checkpoints/);
  });

  it("warning: usa a frase explícita mandatada pela issue #5009, nunca 'unavailable' ambíguo", () => {
    const section = buildTokenInstrumentationSection("260811", {
      subagent_metrics: 0,
      coordinator_tokens_estimate: 0,
      review_metrics: 0,
    }, { status: "warning", missing: [...TRACKED_TOKEN_INSTRUMENTATION_MESSAGES] });
    assert.match(section, /instrumentação de token não foi emitida nesta rodada \(coordenador esqueceu os checkpoints\)/);
    assert.doesNotMatch(section, /\bunavailable\b/);
  });
});

describe("resolveEditionFromArgs", () => {
  it("--edition tem prioridade direta", () => {
    assert.equal(resolveEditionFromArgs({ edition: "260811" }), "260811");
  });

  it("--run-dir deriva do basename do path", () => {
    assert.equal(resolveEditionFromArgs({ "run-dir": "data/overnight/260811" }), "260811");
  });

  it("--run-dir tolera barra final", () => {
    assert.equal(resolveEditionFromArgs({ "run-dir": "data/overnight/260811/" }), "260811");
  });

  it("--edition tem prioridade sobre --run-dir quando ambos presentes", () => {
    assert.equal(
      resolveEditionFromArgs({ edition: "260811", "run-dir": "data/overnight/999999" }),
      "260811",
    );
  });

  it("nenhum dos dois -> null", () => {
    assert.equal(resolveEditionFromArgs({}), null);
  });
});

describe("checkOvernightTokenInstrumentation — orquestração fail-soft (fixtures dos 3 cenários da issue)", () => {
  it("fixture com os 3 tipos presentes -> ok", () => {
    const rootDir = makeRoot();
    writeRunLog(rootDir, [
      evt("260811", "subagent_metrics"),
      evt("260811", "coordinator_tokens_estimate"),
      evt("260811", "review_metrics"),
    ]);
    const result = checkOvernightTokenInstrumentation("260811", rootDir);
    assert.deepEqual(result.verdict, { status: "ok" });
    assert.match(result.section, /OK/);
  });

  it("fixture sem nenhum dos 3 tipos -> warning nomeando os 3 tipos ausentes", () => {
    const rootDir = makeRoot();
    writeRunLog(rootDir, [evt("260811", "algum_outro_evento"), evt("260810b", "subagent_metrics")]);
    const result = checkOvernightTokenInstrumentation("260811", rootDir);
    assert.equal(result.verdict.status, "warning");
    assert.deepEqual(
      (result.verdict as { status: "warning"; missing: string[] }).missing.slice().sort(),
      [...TRACKED_TOKEN_INSTRUMENTATION_MESSAGES].sort(),
    );
    assert.match(result.section, /esqueceu os checkpoints/);
  });

  it("fixture parcial (só 1 dos 3 tipos presente) -> warning nomeando só os ausentes", () => {
    const rootDir = makeRoot();
    writeRunLog(rootDir, [
      evt("260811", "subagent_metrics"),
      evt("260811", "subagent_metrics"),
    ]);
    const result = checkOvernightTokenInstrumentation("260811", rootDir);
    assert.equal(result.verdict.status, "warning");
    assert.deepEqual((result.verdict as { status: "warning"; missing: string[] }).missing.slice().sort(), [
      "coordinator_tokens_estimate",
      "review_metrics",
    ]);
    assert.equal(result.counts.subagent_metrics, 2);
  });

  it("run-log.jsonl ausente -> tratado como 0 eventos (warning), nunca lança", () => {
    const rootDir = makeRoot();
    // nenhum data/run-log.jsonl criado
    const result = checkOvernightTokenInstrumentation("260811", rootDir);
    assert.equal(result.verdict.status, "warning");
  });
});
