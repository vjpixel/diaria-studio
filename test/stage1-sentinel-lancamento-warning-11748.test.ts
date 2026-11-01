/**
 * test/stage1-sentinel-lancamento-warning-11748.test.ts (#11748)
 *
 * Regressão: na edição 261103 (`/diaria-1-pesquisa --no-gates`, post-gate
 * `--auto`), um item de `lancamento[]` sem sinal de produto (blog.google,
 * certificado de IA para profissionais de saúde) fez
 * `lancamento-has-product-signal` reprovar com severity `error`, e o
 * `pipeline-sentinel write --step 1` (que recusa com qualquer `error`, #6009)
 * não gravou o sentinel do Stage 1. O item só é resolvido no Stage 2 §2a
 * (`validate-lancamentos --approved` auto-demove, #4339), então a regra virou
 * `warning`: o sentinel sai, o aviso fica no relatório.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkStageInvariantsForWrite } from "../scripts/pipeline-sentinel.ts";
import { checkLancamentoHasProductSignal } from "../scripts/lib/invariant-checks/stage-1.ts";

// Mesmo formato do caso real: URL oficial (blog.google) sem sinal de produto.
const NOT_A_TOOL = {
  url: "https://blog.google/technology/health/ai-certificate-healthcare-professionals/",
  title: "A new AI certificate for healthcare professionals",
};

describe("lancamento-has-product-signal não trava o sentinel do Stage 1 (#11748)", () => {
  it("a regra ainda detecta o item, mas como warning", () => {
    const dir = mkdtempSync(join(tmpdir(), "stage1-11748-"));
    try {
      mkdirSync(join(dir, "_internal"), { recursive: true });
      writeFileSync(join(dir, "_internal", "01-approved.json"), JSON.stringify({ lancamento: [NOT_A_TOOL] }));
      const v = checkLancamentoHasProductSignal(dir);
      assert.equal(v.length, 1, "o item sem sinal de produto continua sendo apontado");
      assert.equal(v[0].severity, "warning");
      assert.match(v[0].message, /Stage 2/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("checkStageInvariantsForWrite(1) não lista a regra entre os erros que recusam o sentinel", () => {
    const dir = mkdtempSync(join(tmpdir(), "stage1-11748-write-"));
    try {
      mkdirSync(join(dir, "_internal"), { recursive: true });
      writeFileSync(join(dir, "_internal", "01-approved.json"), JSON.stringify({ lancamento: [NOT_A_TOOL] }));
      const result = checkStageInvariantsForWrite(dir, 1);
      assert.ok(
        !result.errors.some((e) => e.rule === "lancamento-has-product-signal"),
        `lancamento-has-product-signal não pode recusar o sentinel do Stage 1: ${JSON.stringify(result.errors.map((e) => e.rule))}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
