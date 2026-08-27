/**
 * test/kit-fixture-patterns.test.ts (#6336)
 *
 * Cobre o detector puro de e-mail de fixture — regressão do incidente ao
 * vivo 26/08/2026 (`ana@example.com` ativo na base Kit de produção).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { matchFixtureEmail } from "../scripts/lib/kit-fixture-patterns.ts";

describe("matchFixtureEmail (#6336)", () => {
  it("detecta o caso real do incidente — ana@example.com", () => {
    const reason = matchFixtureEmail("ana@example.com");
    assert.ok(reason, "esperava match para ana@example.com");
    assert.match(reason!, /example\.com/);
  });

  it("detecta domínios reservados RFC 2606 (example.com/org/net)", () => {
    assert.ok(matchFixtureEmail("x@example.com"));
    assert.ok(matchFixtureEmail("x@example.org"));
    assert.ok(matchFixtureEmail("x@example.net"));
  });

  it("é case-insensitive no domínio", () => {
    assert.ok(matchFixtureEmail("Ana@EXAMPLE.COM"));
  });

  it("detecta TLDs/sufixos reservados: .test, .invalid, .local, .localhost", () => {
    assert.ok(matchFixtureEmail("a@foo.test"));
    assert.ok(matchFixtureEmail("a@foo.invalid"));
    assert.ok(matchFixtureEmail("a@foo.local"));
    assert.ok(matchFixtureEmail("a@foo.localhost"));
  });

  it("detecta marcador +kittest no local-part, convivendo com prefixo real", () => {
    const reason = matchFixtureEmail("vjpixel+kittest@gmail.com");
    assert.ok(reason);
    assert.match(reason!, /kittest/);
  });

  it("detecta marcador +utmprobe no local-part", () => {
    const reason = matchFixtureEmail("vjpixel+utmprobe@gmail.com");
    assert.ok(reason);
    assert.match(reason!, /utmprobe/);
  });

  it("detecta prefixo teste- no local-part", () => {
    const reason = matchFixtureEmail("teste-1@gmail.com");
    assert.ok(reason);
    assert.match(reason!, /teste-/);
  });

  it("prefixo teste- é case-insensitive", () => {
    assert.ok(matchFixtureEmail("TESTE-abc@gmail.com"));
  });

  it("NÃO reconhece a convenção correta de probe ao vivo (vjpixel+probe-...@gmail.com)", () => {
    assert.equal(matchFixtureEmail("vjpixel+probe-6336-260826@gmail.com"), null);
  });

  it("NÃO reconhece e-mail real de assinante", () => {
    assert.equal(matchFixtureEmail("leitor.real@empresa.com.br"), null);
    assert.equal(matchFixtureEmail("vjpixel@gmail.com"), null);
  });

  it("não confunde 'teste' no meio do local-part com o prefixo teste-", () => {
    assert.equal(matchFixtureEmail("naoteste-real@gmail.com"), null);
  });

  it("devolve null para e-mail sem @ (fora de escopo — não valida formato)", () => {
    assert.equal(matchFixtureEmail("nao-e-email"), null);
  });

  it("devolve null quando @ é o último caractere", () => {
    assert.equal(matchFixtureEmail("foo@"), null);
  });
});
