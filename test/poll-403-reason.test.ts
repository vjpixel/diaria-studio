/**
 * test/poll-403-reason.test.ts (#1468)
 *
 * Cobre o classifier puro `classify403Reason` — distingue sig_empty
 * (cenário do #1186 que motivou a instrumentação) de sig_invalid.
 *
 * Não testa a integração com /vote (handleVote) — esses paths usam crypto.subtle
 * do Worker runtime; classify403Reason é puro e testável standalone.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classify403Reason } from "../workers/poll/src/lib.ts";

describe("classify403Reason (#1468)", () => {
  it("sig vazio (subscriber sem poll_sig populado) → sig_empty", () => {
    assert.equal(classify403Reason(""), "sig_empty");
  });

  it("sig com valor (HMAC inválido) → sig_invalid", () => {
    assert.equal(classify403Reason("abc123"), "sig_invalid");
    assert.equal(classify403Reason("0".repeat(64)), "sig_invalid");
  });

  it("sig com 1 char ainda é sig_invalid (não vazio)", () => {
    assert.equal(classify403Reason("x"), "sig_invalid");
  });
});
