/**
 * test/capture-verified-request-types.test.ts (#7981)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CAPTURE_VERIFIED_REQUEST_TYPES, isCaptureVerifiedRequestType } from "../scripts/lib/capture-verified-request-types.ts";
import { VALID_REQUEST_TYPES } from "../scripts/log-editor-request.ts";

describe("CAPTURE_VERIFIED_REQUEST_TYPES (#7981)", () => {
  it("todo tipo listado é um RequestType válido de verdade (nunca um typo)", () => {
    for (const t of CAPTURE_VERIFIED_REQUEST_TYPES) {
      assert.ok(VALID_REQUEST_TYPES.includes(t), `"${t}" não é um RequestType válido`);
    }
  });

  it("exclui explicitamente link-swap e section-order (fora do escopo de prompt, #7974)", () => {
    assert.equal(CAPTURE_VERIFIED_REQUEST_TYPES.includes("link-swap" as any), false);
    assert.equal(CAPTURE_VERIFIED_REQUEST_TYPES.includes("section-order" as any), false);
  });

  it("exclui tipos de escopo de SCORING (destaque-swap/promote/cut, bucket-move, pool-cut/add) — território da Camada 2/#7990, não desta fase", () => {
    for (const t of ["destaque-swap", "destaque-promote", "destaque-cut", "bucket-move", "pool-cut", "pool-add"]) {
      assert.equal(CAPTURE_VERIFIED_REQUEST_TYPES.includes(t as any), false, `${t} não deveria estar aqui`);
    }
  });

  it("inclui eia-choice e social-rewrite (bugs de captura fixados pelo #7974)", () => {
    assert.ok(CAPTURE_VERIFIED_REQUEST_TYPES.includes("eia-choice"));
    assert.ok(CAPTURE_VERIFIED_REQUEST_TYPES.includes("social-rewrite"));
  });

  it("nunca inclui 'other' ou 'process' (nunca participam de agrupamento, mesma exclusão do resto do repo)", () => {
    assert.equal(CAPTURE_VERIFIED_REQUEST_TYPES.includes("other" as any), false);
    assert.equal(CAPTURE_VERIFIED_REQUEST_TYPES.includes("process" as any), false);
  });
});

describe("isCaptureVerifiedRequestType (#7981)", () => {
  it("true pra tipo verificado, false pra tipo não-verificado ou string arbitrária", () => {
    assert.equal(isCaptureVerifiedRequestType("title-length"), true);
    assert.equal(isCaptureVerifiedRequestType("link-swap"), false);
    assert.equal(isCaptureVerifiedRequestType("qualquer-coisa"), false);
  });
});
