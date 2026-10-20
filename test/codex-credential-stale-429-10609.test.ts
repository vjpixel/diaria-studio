/**
 * Regressão #10609: 429 velho no pool do Hermes não pode ser afirmado como
 * esgotamento (caso memelab, 20/10/2026 — 429 de 03:06Z lido às 13:50Z).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyCodexCredential, CODEX_STALE_429_HOURS } from "../scripts/lib/codex-credential-pool.ts";

const NOW = "2026-10-20T13:50:00.000Z";
const RESET = Date.parse("2026-11-16T21:36:00Z") / 1000;
const base = {
  label: "memelab",
  last_status: "exhausted",
  last_error_reason: "usage_limit_reached",
  last_error_code: 429,
  last_error_reset_at: RESET,
};

describe("classifyCodexCredential — 429 velho (#10609)", () => {
  it("429 gravado há 10h vira indeterminada (não reconfirmado)", () => {
    const v = classifyCodexCredential({ ...base, last_status_at: Date.parse("2026-10-20T03:06:00Z") / 1000 }, NOW);
    assert.equal(v.state, "indeterminada");
    assert.match(v.reason, /não foi reconfirmado/);
  });
  it("aceita last_status_at em ISO", () => {
    const v = classifyCodexCredential({ ...base, last_status_at: "2026-10-20T03:06:00Z" }, NOW);
    assert.equal(v.state, "indeterminada");
  });
  it("429 recente continua esgotada", () => {
    const at = Date.parse(NOW) / 1000 - (CODEX_STALE_429_HOURS - 1) * 3600;
    assert.equal(classifyCodexCredential({ ...base, last_status_at: at }, NOW).state, "esgotada");
  });
  it("sem last_status_at legível continua esgotada", () => {
    assert.equal(classifyCodexCredential(base, NOW).state, "esgotada");
    assert.equal(classifyCodexCredential({ ...base, last_status_at: "lixo" }, NOW).state, "esgotada");
  });
});
