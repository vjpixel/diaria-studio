/**
 * test/jev-eval.test.ts (#8413 — Fase 0 do epic #8412)
 *
 * Cobre `scripts/jev-eval.ts`: matriz de confusão, curva confiança×acerto, e
 * `evaluateFeature` fim-a-fim contra uma amostra gerada em disco (tmpdir) com
 * `fetchImpl` stubado — nenhum teste chama a rede real.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildConfusionMatrix,
  confidenceAccuracyCurve,
  renderMarkdownReport,
  evaluateFeature,
  type EvalItemResult,
} from "../scripts/jev-eval.ts";
import { generate, record, type FeatureDef, type PoolItem } from "../scripts/lib/blind-label-core.ts";
import { JEV_QUESTION_REGISTRY } from "../scripts/lib/jev-questions.ts";

describe("buildConfusionMatrix", () => {
  it("conta pares (label, guess)", () => {
    const m = buildConfusionMatrix([
      { label: "a", guess: "a" },
      { label: "a", guess: "b" },
      { label: "b", guess: "b" },
    ]);
    assert.equal(m.get("a")?.get("a"), 1);
    assert.equal(m.get("a")?.get("b"), 1);
    assert.equal(m.get("b")?.get("b"), 1);
  });
});

describe("confidenceAccuracyCurve", () => {
  it("distribui em 5 baldes de 0.2 e calcula acerto por balde", () => {
    const items = [
      { confidence: 0.05, correct: true },
      { confidence: 0.15, correct: false },
      { confidence: 0.95, correct: true },
      { confidence: 0.99, correct: true },
    ];
    const curve = confidenceAccuracyCurve(items);
    assert.equal(curve.length, 5);
    assert.equal(curve[0].n, 2); // [0, 0.2)
    assert.equal(curve[0].correct, 1);
    assert.equal(curve[4].n, 2); // [0.8, 1.0]
    assert.equal(curve[4].correct, 2);
  });

  it("balde vazio tem accuracy NaN, n=0", () => {
    const curve = confidenceAccuracyCurve([{ confidence: 0.9, correct: true }]);
    assert.equal(curve[0].n, 0);
    assert.ok(Number.isNaN(curve[0].accuracy));
  });

  it("confidence exatamente 1.0 cai no último balde", () => {
    const curve = confidenceAccuracyCurve([{ confidence: 1.0, correct: true }]);
    assert.equal(curve[4].n, 1);
  });
});

describe("renderMarkdownReport", () => {
  it("produz markdown com título, acurácia e n", () => {
    const results: EvalItemResult[] = [
      { id: "1", label: "a", mechanismGuess: "a", jevAnswer: null, jevGuess: "a", jevConfidence: 0.9, mechanismCorrect: true, jevCorrect: true },
      { id: "2", label: "b", mechanismGuess: "a", jevAnswer: null, jevGuess: "b", jevConfidence: 0.8, mechanismCorrect: false, jevCorrect: true },
    ];
    const md = renderMarkdownReport("bucket-tiebreaker-8211", results, 0);
    assert.match(md, /# Jev eval — feature `bucket-tiebreaker-8211`/);
    assert.match(md, /n=2/);
    assert.match(md, /atual \| 1\/2/);
    assert.match(md, /Jev \| 2\/2/);
    assert.match(md, /McNemar/);
    assert.match(md, /Curva confiança/);
  });
});

describe("evaluateFeature — fim-a-fim contra amostra em disco (fetch stubado)", () => {
  let rootDir: string;
  const FEATURE_ID = "bucket-tiebreaker-8211";

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), "jev-eval-test-"));
  });
  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  function pool(): PoolItem[] {
    return [
      {
        id: "https://a.com/1",
        display: { url: "https://a.com/1", title: "t1" },
        jevState: { title: "t1", url: "https://a.com/1", summary: "s1" },
        stratum: "lancamento",
        hiddenGuess: "lancamento",
        hiddenRule: "lancamento-default",
      },
      {
        id: "https://a.com/2",
        display: { url: "https://a.com/2", title: "t2" },
        jevState: { title: "t2", url: "https://a.com/2", summary: "s2" },
        stratum: "radar",
        hiddenGuess: "radar",
        hiddenRule: "noticias-default",
      },
    ];
  }

  it("roda Jev sobre a amostra rotulada e casa por id", async () => {
    const def: FeatureDef = { id: FEATURE_ID, labels: ["lancamento", "radar", "nao_pertence"], collectPool: () => ({ pool: pool(), skipped: [] }) };
    generate(rootDir, def, 10);
    // item 1: rótulo do editor concorda com o mecanismo (lancamento).
    // item 2: rótulo do editor DISCORDA do mecanismo (mecanismo disse radar, editor disse lancamento).
    record(rootDir, def, "https://a.com/1", "lancamento");
    record(rootDir, def, "https://a.com/2", "lancamento");

    assert.ok(JEV_QUESTION_REGISTRY[FEATURE_ID], "fixture pressupõe a entrada real do registry");

    const fetchImpl = (async () => {
      // Jev "acerta" sempre neste stub (sempre responde `lancamento`) — simula
      // um classificador melhor que o mecanismo no item 2.
      return new Response(
        JSON.stringify({ answers: { bucket: { type: "choice", choice: "lancamento", confidence: 0.95 } } }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const { results, errors } = await evaluateFeature(FEATURE_ID, { apiKey: "k", fetchImpl, rootDir });
    assert.equal(errors.size, 0);
    assert.equal(results.length, 2);

    const r1 = results.find((r) => r.id === "https://a.com/1")!;
    const r2 = results.find((r) => r.id === "https://a.com/2")!;
    assert.equal(r1.mechanismCorrect, true);
    assert.equal(r1.jevCorrect, true);
    assert.equal(r2.mechanismCorrect, false); // mecanismo disse radar, editor rotulou lancamento
    assert.equal(r2.jevCorrect, true); // Jev disse lancamento, bate com o rótulo

    const md = renderMarkdownReport(FEATURE_ID, results, errors.size);
    assert.match(md, /atual \| 1\/2/);
    assert.match(md, /Jev \| 2\/2/);
  });

  it("item rotulado `nao_pertence` fica de fora da avaliação (nenhum classificador tem essa opção)", async () => {
    const def: FeatureDef = { id: FEATURE_ID, labels: ["lancamento", "radar", "nao_pertence"], collectPool: () => ({ pool: pool(), skipped: [] }) };
    generate(rootDir, def, 10);
    record(rootDir, def, "https://a.com/1", "nao_pertence");
    record(rootDir, def, "https://a.com/2", "radar");

    const fetchImpl = (async () =>
      new Response(JSON.stringify({ answers: { bucket: { type: "choice", choice: "radar", confidence: 0.9 } } }), { status: 200 })) as unknown as typeof fetch;

    const { results } = await evaluateFeature(FEATURE_ID, { apiKey: "k", fetchImpl, rootDir });
    assert.equal(results.length, 1);
    assert.equal(results[0].id, "https://a.com/2");
  });
});
