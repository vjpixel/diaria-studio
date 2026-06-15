/**
 * check-cloudflare-token.test.ts (#2286)
 *
 * Testa o preflight de auth Cloudflare/wrangler.
 *
 * HARD CONSTRAINT: NUNCA executa wrangler CLI nem chama a API Cloudflare real.
 * Toda comunicação com a API é mockada via o parâmetro fetchFn.
 *
 * Cenários:
 *   A) token ausente → status: missing
 *   B) token inválido (API retorna 401) → status: invalid
 *   C) token ativo (API retorna 200 + status: active) → status: active
 *   D) erro de rede (fetch throws) → status: error
 *   E) API retorna 200 mas status != "active" → status: invalid
 *   F) banner renderizado corretamente para missing/invalid; vazio para active
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkCloudflareToken, renderCloudflareTokenBanner } from "../scripts/check-cloudflare-token.ts";

// ── mock helper ──────────────────────────────────────────────────────────────

type FetchFn = typeof fetch;

function mockFetch(status: number, body: unknown): FetchFn {
  return async (_url, _opts) => {
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? "OK" : "Unauthorized",
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as Response;
  };
}

function throwingFetch(message: string): FetchFn {
  return async () => {
    throw new Error(message);
  };
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("checkCloudflareToken (#2286)", () => {
  it("A) token ausente → status: missing", async () => {
    // Pass empty string explicitly (env var unset)
    const health = await checkCloudflareToken("", mockFetch(401, {}));
    assert.equal(health.status, "missing");
    assert.ok(health.error?.includes("CLOUDFLARE_API_TOKEN"));
  });

  it("B) token inválido (API retorna 401) → status: invalid", async () => {
    const health = await checkCloudflareToken(
      "tok_invalid_12345",
      mockFetch(401, { success: false }),
    );
    assert.equal(health.status, "invalid");
    assert.ok(health.error?.includes("401"), `erro deve mencionar 401, got: ${health.error}`);
    // token_prefix usa só os 8 primeiros chars
    assert.equal(health.token_prefix, "tok_inva");
  });

  it("B2) token inválido (API retorna 403) → status: invalid", async () => {
    const health = await checkCloudflareToken(
      "tok_forbidden_xyz",
      mockFetch(403, { success: false }),
    );
    assert.equal(health.status, "invalid");
    assert.ok(health.error?.includes("403"));
  });

  it("C) token ativo → status: active", async () => {
    const health = await checkCloudflareToken(
      "tok_valid_abcdef12345",
      mockFetch(200, { success: true, result: { status: "active" } }),
    );
    assert.equal(health.status, "active");
    assert.equal(health.verified, true);
    assert.equal(health.token_prefix, "tok_vali");
  });

  it("D) erro de rede → status: error (não bloqueia pipeline)", async () => {
    const health = await checkCloudflareToken(
      "tok_net_error",
      throwingFetch("ECONNREFUSED"),
    );
    assert.equal(health.status, "error");
    assert.ok(health.error?.includes("ECONNREFUSED"));
  });

  it("E) API retorna 200 mas status != 'active' → status: invalid", async () => {
    const health = await checkCloudflareToken(
      "tok_expired_12345",
      mockFetch(200, { success: true, result: { status: "expired" } }),
    );
    assert.equal(health.status, "invalid");
    assert.ok(health.error?.includes("expired"), `erro deve mencionar 'expired', got: ${health.error}`);
  });

  it("E2) API retorna 200 + success:true sem result.status → status: error (API anomaly, não invalid) (#7)", async () => {
    // HTTP 200 + success:true + status field absent = transient API anomaly,
    // NOT a bad token. Must not show rotate-token banner.
    const health = await checkCloudflareToken(
      "tok_malformed_12",
      mockFetch(200, { success: true, result: {} }),
    );
    assert.equal(health.status, "error", "missing result.status with success:true must be 'error', not 'invalid'");
  });

  it("token_prefix nunca expõe mais de 8 chars do token", async () => {
    const token = "SUPERSECRETLONGTOKEN12345";
    const health = await checkCloudflareToken(token, mockFetch(401, {}));
    assert.equal(health.token_prefix?.length, 8);
    assert.equal(health.token_prefix, token.slice(0, 8));
  });
});

describe("renderCloudflareTokenBanner (#2286)", () => {
  it("F) active → banner vazio", () => {
    const banner = renderCloudflareTokenBanner({ status: "active", verified: true });
    assert.equal(banner, "");
  });

  it("F) missing → banner com instrução wrangler login", () => {
    const banner = renderCloudflareTokenBanner({
      status: "missing",
      error: "CLOUDFLARE_API_TOKEN não definida.",
    });
    assert.ok(banner.length > 0, "banner deve ser não-vazio");
    assert.ok(
      banner.includes("wrangler login") || banner.includes("CLOUDFLARE_API_TOKEN"),
      "banner deve mencionar ação de autenticação",
    );
  });

  it("F) invalid → banner com instrução de renovação", () => {
    const banner = renderCloudflareTokenBanner({
      status: "invalid",
      error: "Token inválido (HTTP 401).",
    });
    assert.ok(banner.length > 0, "banner deve ser não-vazio para invalid");
    // deve mencionar o impacto (É IA? / valid_editions)
    assert.ok(
      banner.includes("É IA?") || banner.includes("valid_editions") || banner.includes("0d.bis"),
      "banner deve mencionar impacto no É IA?",
    );
  });

  it("F) error de rede → banner VAZIO (não assusta o editor com 'INVÁLIDO') (#5)", () => {
    // status:"error" = transient network failure — the editor's token may be
    // perfectly valid. Showing the scary "INVÁLIDO/AUSENTE" banner causes
    // unnecessary token rotation. main() logs a soft note instead.
    const banner = renderCloudflareTokenBanner({
      status: "error",
      error: "ECONNREFUSED",
    });
    assert.equal(banner, "", "error de rede deve retornar banner vazio (soft note via main(), não banner de rotate-token)");
  });

  it("F) error de rede + success:true (API anomaly) → banner VAZIO (#7)", () => {
    // HTTP 200 success:true but missing result.status also maps to "error".
    // Must not show rotate-token banner.
    const banner = renderCloudflareTokenBanner({
      status: "error",
      error: "Cloudflare API retornou status ausente com success:true",
    });
    assert.equal(banner, "", "API anomaly com success:true deve retornar banner vazio");
  });
});
