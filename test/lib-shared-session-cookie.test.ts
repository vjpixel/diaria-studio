/**
 * lib-shared-session-cookie.test.ts (#4052)
 *
 * Cobre `scripts/lib/shared/session-cookie.ts`: sign/verify HMAC + TTL +
 * construção do header Set-Cookie. Extraído pra shared/ (#4054 briefing) —
 * este teste cobre o primitivo genérico, não um worker específico.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildClearCookieHeader,
  buildSetCookieHeader,
  parseCookieHeader,
  signSessionCookie,
  verifySessionCookie,
} from "../scripts/lib/shared/session-cookie.ts";

describe("session-cookie (#4052)", () => {
  it("assinatura válida é aceita e devolve o email", async () => {
    const value = await signSessionCookie("secret-1", "leitor@example.com", 3600);
    const result = await verifySessionCookie("secret-1", value);
    assert.deepEqual(result, { ok: true, email: "leitor@example.com" });
  });

  it("assinatura adulterada (email trocado) é rejeitada", async () => {
    const value = await signSessionCookie("secret-1", "leitor@example.com", 3600);
    const [, expiresAt, sig] = value.split("|");
    const tampered = `attacker@evil.com|${expiresAt}|${sig}`;
    const result = await verifySessionCookie("secret-1", tampered);
    assert.equal(result.ok, false);
    assert.equal((result as { reason: string }).reason, "bad_signature");
  });

  it("assinatura com secret errado é rejeitada", async () => {
    const value = await signSessionCookie("secret-1", "leitor@example.com", 3600);
    const result = await verifySessionCookie("secret-DIFERENTE", value);
    assert.equal(result.ok, false);
    assert.equal((result as { reason: string }).reason, "bad_signature");
  });

  it("cookie expirado é rejeitado mesmo com assinatura válida", async () => {
    let now = 1_000_000_000; // epoch ms fixo
    const value = await signSessionCookie("secret-1", "leitor@example.com", 60, () => now);
    now += 61_000; // avança 61s — TTL era 60s
    const result = await verifySessionCookie("secret-1", value, () => now);
    assert.equal(result.ok, false);
    assert.equal((result as { reason: string }).reason, "expired");
  });

  it("cookie 1s antes de expirar ainda é válido", async () => {
    let now = 1_000_000_000;
    const value = await signSessionCookie("secret-1", "leitor@example.com", 60, () => now);
    now += 59_000;
    const result = await verifySessionCookie("secret-1", value, () => now);
    assert.equal(result.ok, true);
  });

  it("valor malformado (sem 3 partes) nunca lança, só retorna reason=malformed", async () => {
    const result = await verifySessionCookie("secret-1", "lixo-sem-pipe");
    assert.deepEqual(result, { ok: false, reason: "malformed" });
  });

  it("valor vazio nunca lança", async () => {
    const result = await verifySessionCookie("secret-1", "");
    assert.equal(result.ok, false);
  });

  it("email com caractere reservado '|' é rejeitado ao assinar", async () => {
    await assert.rejects(() => signSessionCookie("secret-1", "a|b@example.com", 3600));
  });

  it("buildSetCookieHeader inclui HttpOnly, Secure, SameSite=Lax", () => {
    const header = buildSetCookieHeader("my_cookie", "abc", 3600);
    assert.match(header, /HttpOnly/);
    assert.match(header, /Secure/);
    assert.match(header, /SameSite=Lax/);
    assert.match(header, /Max-Age=3600/);
    assert.match(header, /^my_cookie=abc;/);
  });

  it("buildClearCookieHeader zera Max-Age", () => {
    const header = buildClearCookieHeader("my_cookie");
    assert.match(header, /Max-Age=0/);
  });

  it("parseCookieHeader extrai o valor do cookie nomeado entre outros", () => {
    const raw = "foo=bar; my_cookie=hello%20world; baz=qux";
    assert.equal(parseCookieHeader(raw, "my_cookie"), "hello world");
  });

  it("parseCookieHeader retorna null quando ausente ou header vazio", () => {
    assert.equal(parseCookieHeader("foo=bar", "my_cookie"), null);
    assert.equal(parseCookieHeader(null, "my_cookie"), null);
    assert.equal(parseCookieHeader(undefined, "my_cookie"), null);
  });

  it("round-trip completo: sign -> Set-Cookie header -> parse -> verify", async () => {
    const value = await signSessionCookie("secret-1", "leitor@example.com", 3600);
    const setCookieHeader = buildSetCookieHeader("sess", value, 3600);
    // Simula o browser reenviando só "name=value" no header Cookie.
    const cookiePair = setCookieHeader.split(";")[0];
    const parsed = parseCookieHeader(cookiePair, "sess");
    assert.ok(parsed);
    const result = await verifySessionCookie("secret-1", parsed!);
    assert.deepEqual(result, { ok: true, email: "leitor@example.com" });
  });
});
