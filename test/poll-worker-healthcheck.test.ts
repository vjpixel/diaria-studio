/**
 * test/poll-worker-healthcheck.test.ts (#1411, #1412, #1415, #1420)
 *
 * Cobre o classifier puro `classifyVoteResponse` — coração da diagnose
 * de healthcheck. Não testa endpoints reais (network calls); pra isso
 * o script tem fallback de DoH testado em test/doh-fetch.test.ts.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyVoteResponse } from "../scripts/poll-worker-healthcheck.ts";

describe("classifyVoteResponse (#1420)", () => {
  it("403 (sig inválida) → ok: Worker está saudável", () => {
    const r = classifyVoteResponse(403, "forbidden");
    assert.deepEqual(r, { ok: true });
  });

  it("410 (edição não-listada) → ok: Worker está saudável, só edição expirou", () => {
    const r = classifyVoteResponse(410, "Essa edição não aceita mais votos.");
    assert.deepEqual(r, { ok: true });
  });

  it("#1420: 503 com missing_secrets → kind=secrets_missing", () => {
    const body = '{"error":"server_misconfigured","missing_secrets":["POLL_SECRET"]}';
    const r = classifyVoteResponse(503, body);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.kind, "secrets_missing");
    assert.match(r.detail, /wrangler secret put/);
    assert.match(r.detail, /POLL_SECRET/);
  });

  it("503 sem missing_secrets payload → kind=secrets_missing mas com detail genérico", () => {
    const r = classifyVoteResponse(503, "service unavailable");
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.kind, "secrets_missing");
    assert.match(r.detail, /503 sem missing_secrets/);
  });

  it("#1420: 500 (Worker legacy crashed) → kind=legacy_crash com instrução de redeploy", () => {
    const r = classifyVoteResponse(500, "error code: 1101");
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.kind, "legacy_crash");
    assert.match(r.detail, /Worker crash/);
    assert.match(r.detail, /wrangler secret put/);
  });

  it("status anômalo (204, 502, 504) → kind=anomaly", () => {
    for (const s of [204, 502, 504]) {
      const r = classifyVoteResponse(s, "anything");
      assert.equal(r.ok, false);
      if (r.ok) continue;
      assert.equal(r.kind, "anomaly");
      assert.match(r.detail, new RegExp(`status ${s} inesperado`));
    }
  });
});
