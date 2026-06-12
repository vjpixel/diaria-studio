/**
 * intentional-error-safety.test.ts (#2149)
 *
 * Teste de regressão para `checkIntentionalErrorSafety`:
 * categorias de risco de desinformação (numeric, factual, data) emitem warn;
 * categorias seguras (attribution, version_inconsistency, ortografico,
 * factual_synthetic) retornam safe=true.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  checkIntentionalErrorSafety,
} from "../scripts/lib/lint-checks/intentional-error.ts";

describe("checkIntentionalErrorSafety (#2149 — regras do concurso)", () => {
  it("category=numeric → safe=false com warn (#2149 Regra 2)", () => {
    const result = checkIntentionalErrorSafety("numeric");
    assert.equal(result.safe, false, "numeric é categoria de risco de desinformação");
    assert.ok(result.warn, "deve conter mensagem de aviso");
    assert.ok(result.warn!.includes("numeric"), "warn deve citar a categoria");
    assert.ok(result.warn!.includes("#2149"), "warn deve referenciar a issue");
  });

  it("category=data → safe=false com warn", () => {
    const result = checkIntentionalErrorSafety("data");
    assert.equal(result.safe, false);
    assert.ok(result.warn?.includes("data"));
  });

  it("category=factual → safe=false com warn", () => {
    const result = checkIntentionalErrorSafety("factual");
    assert.equal(result.safe, false);
    assert.ok(result.warn?.includes("factual"));
  });

  it("category=attribution → safe=true (conhecimento comum)", () => {
    const result = checkIntentionalErrorSafety("attribution");
    assert.equal(result.safe, true);
    assert.equal(result.warn, undefined);
  });

  it("category=version_inconsistency → safe=true (inconsistência interna)", () => {
    const result = checkIntentionalErrorSafety("version_inconsistency");
    assert.equal(result.safe, true);
    assert.equal(result.warn, undefined);
  });

  it("category=ortografico → safe=true", () => {
    const result = checkIntentionalErrorSafety("ortografico");
    assert.equal(result.safe, true);
  });

  it("category=factual_synthetic → safe=true (inconsistência fabricada não-plausível)", () => {
    const result = checkIntentionalErrorSafety("factual_synthetic");
    assert.equal(result.safe, true);
  });

  it("category undefined → safe=true (sem categoria declarada)", () => {
    const result = checkIntentionalErrorSafety(undefined);
    assert.equal(result.safe, true);
    assert.equal(result.warn, undefined);
  });

  it("category vazia → safe=true (tratado como ausente)", () => {
    const result = checkIntentionalErrorSafety("");
    assert.equal(result.safe, true);
  });

  it("category em MAIÚSCULAS normalizada corretamente (NUMERIC → risco)", () => {
    const result = checkIntentionalErrorSafety("NUMERIC");
    assert.equal(result.safe, false, "deve normalizar para lowercase antes de checar");
  });

  it("category com espaços extras normalizada (numeric com trailing space → risco)", () => {
    const result = checkIntentionalErrorSafety("  numeric  ");
    assert.equal(result.safe, false, "deve fazer trim antes de checar");
  });
});
