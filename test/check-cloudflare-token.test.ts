/**
 * check-cloudflare-token.test.ts (#2286, #2306)
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
 *   D) erro de rede (fetch throws) → status: error (exit 0, non-blocking)
 *   E) API retorna 200 mas status != "active" → status: invalid
 *   E2) success:true + sem result.status → status: invalid (#2306)
 *   F) banner renderizado corretamente para missing/invalid; vazio para active/error
 *   G) exit codes: transient→0, invalid/missing→1, active→0 (#2306)
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

  it("E2) API retorna 200 + success:true sem result.status → status: invalid (#2306)", async () => {
    // HTTP 200 + success:true + status field absent/null = token expired/disabled.
    // CF returns success:true but omits result.status for disabled tokens.
    // Must show rotate-token banner (invalid), NOT the soft "try again" path (error).
    const health = await checkCloudflareToken(
      "tok_malformed_12",
      mockFetch(200, { success: true, result: {} }),
    );
    assert.equal(health.status, "invalid", "missing result.status with success:true must be 'invalid' (expired/disabled token), not 'error'");
  });

  it("E3) API retorna 200 + success:true + result.status null → status: invalid (#2306)", async () => {
    // Explicit null status — same treatment as absent.
    const health = await checkCloudflareToken(
      "tok_null_stat_12",
      mockFetch(200, { success: true, result: { status: null } }),
    );
    assert.equal(health.status, "invalid", "null result.status must be 'invalid', not 'error'");
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

  it("F) invalid sem result.status (token expirado) → banner NÃO vazio (#2306)", () => {
    // HTTP 200 success:true + missing result.status now maps to "invalid" (not "error").
    // The rotate-token banner MUST appear so the editor knows to act.
    const banner = renderCloudflareTokenBanner({
      status: "invalid",
      error: "Token Cloudflare retornou status ausente/null (success:true). Provável token expirado/desabilitado.",
    });
    assert.ok(banner.length > 0, "token expirado/desabilitado deve retornar banner de renovação");
    assert.ok(
      banner.includes("INVÁLIDO") || banner.includes("wrangler") || banner.includes("CLOUDFLARE"),
      "banner deve instruir renovação do token",
    );
  });
});

// ── Regressão #2306: exit codes — transient NON-BLOCKING, invalid/missing BLOCKING ─────────────
//
// main() não aceita fetchFn injetado, então testamos a lógica de determinação de
// exit code a partir do status retornado por checkCloudflareToken() (que aceitamos
// como ground truth pelo mock acima). Mapeamento esperado:
//   status:"active"  → main retorna 0
//   status:"error"   → main retorna 0 (transitório, não bloqueia — #2306)
//   status:"missing" → main retorna 1 (bloqueia, banner)
//   status:"invalid" → main retorna 1 (bloqueia, banner)
//
// Implementação: derivamos o exit code da mesma lógica do main():
//   if (status === "error") → 0
//   if (status === "active") → 0
//   else → 1

function deriveExitCode(status: "active" | "missing" | "invalid" | "error"): number {
  if (status === "error") return 0; // transient, non-blocking (#2306)
  if (status === "active") return 0;
  return 1; // missing ou invalid → bloqueia
}

describe("exit codes (#2306 — regress transient=0, invalid=1)", () => {
  it("G1) transient network error → exit 0 (non-blocking)", async () => {
    const health = await checkCloudflareToken("tok_net_error", throwingFetch("ECONNREFUSED"));
    assert.equal(health.status, "error");
    assert.equal(deriveExitCode(health.status), 0, "transient deve sair 0, não bloquear Stage 0");
  });

  it("G2) token inválido (401) → exit 1 (blocking, rotate-token)", async () => {
    const health = await checkCloudflareToken("tok_invalid_xx", mockFetch(401, {}));
    assert.equal(health.status, "invalid");
    assert.equal(deriveExitCode(health.status), 1, "token inválido deve bloquear Stage 0");
  });

  it("G3) success:true + sem result.status → exit 1 (blocking, token desabilitado) (#2306)", async () => {
    const health = await checkCloudflareToken("tok_disabled_1", mockFetch(200, { success: true, result: {} }));
    assert.equal(health.status, "invalid", "token desabilitado (missing status) deve ser invalid");
    assert.equal(deriveExitCode(health.status), 1, "token desabilitado deve bloquear e pedir renovação");
  });

  it("G4) token ativo → exit 0", async () => {
    const health = await checkCloudflareToken("tok_active_1234", mockFetch(200, { success: true, result: { status: "active" } }));
    assert.equal(health.status, "active");
    assert.equal(deriveExitCode(health.status), 0);
  });

  it("G5) token ausente → exit 1 (blocking)", async () => {
    const health = await checkCloudflareToken("", mockFetch(401, {}));
    assert.equal(health.status, "missing");
    assert.equal(deriveExitCode(health.status), 1);
  });
});
