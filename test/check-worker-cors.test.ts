/**
 * check-worker-cors.test.ts (#1132 P2.4)
 *
 * Cobre `evaluateCorsResponse` (pure helper) que decide se uma resposta
 * do Worker satisfaz critério CORS pro paste flow.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { evaluateCorsResponse } from "../scripts/check-worker-cors.ts";

describe("evaluateCorsResponse (#1132 P2.4)", () => {
  it("aceita CORS '*' com status 200", () => {
    const r = evaluateCorsResponse(200, "*");
    assert.equal(r.ok, true);
    assert.equal(r.reason, undefined);
  });

  it("aceita CORS '*' com status 404 (handler retorna img-not-found mas com CORS)", () => {
    // 404 com CORS é ok pro propósito do check (paste flow consegue read status)
    const r = evaluateCorsResponse(404, "*");
    assert.equal(r.ok, true);
  });

  it("rejeita header ausente (null)", () => {
    const r = evaluateCorsResponse(200, null);
    assert.equal(r.ok, false);
    assert.match(r.reason ?? "", /ausente/);
  });

  it("rejeita header com origem específica (não '*')", () => {
    const r = evaluateCorsResponse(200, "https://diar.ia.br");
    assert.equal(r.ok, false);
    assert.match(r.reason ?? "", /esperado '\*'/);
  });

  it("rejeita header vazio", () => {
    const r = evaluateCorsResponse(200, "");
    assert.equal(r.ok, false);
  });

  it("rejeita header com lista de origens (não '*')", () => {
    const r = evaluateCorsResponse(200, "https://diar.ia.br, https://app.beehiiv.com");
    assert.equal(r.ok, false);
  });
});

import { workerResponded } from "../scripts/lib/worker-reachability.ts";

describe("workerResponded (#9116)", () => {
  it("404 conta como Worker respondendo (rota /health inexistente)", () => {
    assert.equal(workerResponded({ up: false, local_dns_filtered: false, via: "direct", status: 404 }), true);
  });
  it("5xx e sem status não contam", () => {
    assert.equal(workerResponded({ up: false, local_dns_filtered: false, via: "direct", status: 503 }), false);
    assert.equal(workerResponded({ up: false, local_dns_filtered: false, via: "none" }), false);
  });
});
