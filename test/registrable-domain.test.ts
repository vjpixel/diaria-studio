/**
 * test/registrable-domain.test.ts (#5735)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  registrableDomain,
  registrableDomainFromHostname,
  extractHostname,
} from "../scripts/lib/registrable-domain.ts";

describe("extractHostname", () => {
  it("extrai hostname minúsculo de uma URL http(s)", () => {
    assert.equal(extractHostname("https://Blog.OpenAI.com/foo"), "blog.openai.com");
  });

  it("retorna null pra URL inválida", () => {
    assert.equal(extractHostname("not a url"), null);
  });
});

describe("registrableDomainFromHostname", () => {
  it("hostname de 2 labels é devolvido como está", () => {
    assert.equal(registrableDomainFromHostname("openai.com"), "openai.com");
  });

  it("subdomínio comum colapsa pro domínio de 2 labels", () => {
    assert.equal(registrableDomainFromHostname("blog.openai.com"), "openai.com");
  });

  it("hostname de 1 label é devolvido como está (ex: localhost)", () => {
    assert.equal(registrableDomainFromHostname("localhost"), "localhost");
  });

  it("sufixo de 2 níveis (.com.br) usa 3 labels", () => {
    assert.equal(registrableDomainFromHostname("canaltech.com.br"), "canaltech.com.br");
    assert.equal(registrableDomainFromHostname("www.canaltech.com.br"), "canaltech.com.br");
  });

  it(".com.br não é confundido com domínio .com de 2 labels vindo de corte errado (tecnoblog.net vs canaltech.com.br)", () => {
    assert.equal(registrableDomainFromHostname("tecnoblog.net"), "tecnoblog.net");
    assert.equal(registrableDomainFromHostname("canaltech.com.br"), "canaltech.com.br");
    assert.notEqual(registrableDomainFromHostname("tecnoblog.net"), registrableDomainFromHostname("canaltech.com.br"));
  });

  it("sufixo .co.uk usa 3 labels", () => {
    assert.equal(registrableDomainFromHostname("www.bbc.co.uk"), "bbc.co.uk");
  });
});

describe("registrableDomain (a partir de URL completa)", () => {
  it("blog.openai.com e openai.com contam como o mesmo domínio", () => {
    assert.equal(registrableDomain("https://blog.openai.com/foo"), registrableDomain("https://openai.com/bar"));
  });

  it("blog.x.com + x.com + www.x.com contam como o mesmo domínio (achado do plano de testes da issue)", () => {
    const a = registrableDomain("https://blog.x.com/a");
    const b = registrableDomain("https://x.com/b");
    const c = registrableDomain("https://www.x.com/c");
    assert.equal(a, b);
    assert.equal(b, c);
  });

  it("null pra URL inválida", () => {
    assert.equal(registrableDomain("nope"), null);
  });
});
