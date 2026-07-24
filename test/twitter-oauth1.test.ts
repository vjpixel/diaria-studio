/**
 * twitter-oauth1.test.ts (#3994)
 *
 * Testa o helper de assinatura OAuth 1.0a usado por publish-twitter.ts.
 * Sem ground-truth externo memorizado (nenhum vetor de exemplo copiado de
 * cabeça) — cada teste ou verifica uma propriedade determinística do
 * algoritmo (RFC 5849/3986), ou cross-checa contra uma implementação
 * independente escrita no próprio teste (não reaproveita o código da lib).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  percentEncode,
  buildSignatureBaseString,
  buildSigningKey,
  signHmacSha1,
  generateOAuth1AuthHeader,
} from "../scripts/lib/twitter-oauth1.ts";

describe("percentEncode (RFC 3986)", () => {
  it("codifica espaço como %20 (não '+')", () => {
    assert.equal(percentEncode("a b"), "a%20b");
  });

  it("codifica '+' como %2B", () => {
    assert.equal(percentEncode("a+b"), "a%2Bb");
  });

  it("codifica '!' '*' \"'\" '(' ')' — encodeURIComponent nativo NÃO escapa esses", () => {
    // Confirma que o replace extra da lib cobre exatamente o gap do encodeURIComponent nativo.
    assert.equal(encodeURIComponent("!*'()"), "!*'()", "sanity: JS nativo não escapa esses chars");
    assert.equal(percentEncode("!"), "%21");
    assert.equal(percentEncode("*"), "%2A");
    assert.equal(percentEncode("'"), "%27");
    assert.equal(percentEncode("("), "%28");
    assert.equal(percentEncode(")"), "%29");
  });

  it("preserva chars unreserved (A-Z a-z 0-9 - _ . ~)", () => {
    const unreserved = "ABCabc123-_.~";
    assert.equal(percentEncode(unreserved), unreserved);
  });

  it("codifica UTF-8 multi-byte (acentos) como sequência de %XX", () => {
    assert.equal(percentEncode("é"), "%C3%A9");
  });

  it("round-trip: decodeURIComponent(percentEncode(x)) === x para string com múltiplos chars especiais", () => {
    const original = "Hello Ladies + Gentlemen, a signed OAuth request!";
    assert.equal(decodeURIComponent(percentEncode(original)), original);
  });
});

describe("buildSignatureBaseString", () => {
  it("ordena params alfabeticamente por chave antes de concatenar", () => {
    const base = buildSignatureBaseString("POST", "https://api.x.com/2/tweets", {
      oauth_token: "tok",
      oauth_consumer_key: "key",
    });
    // Cross-check independente: monta a string esperada manualmente, ordenando
    // por chave, sem reusar percentEncode da lib.
    const expectedParamString = "oauth_consumer_key=key&oauth_token=tok";
    const expected = [
      "POST",
      encodeURIComponent("https://api.x.com/2/tweets"),
      encodeURIComponent(expectedParamString),
    ].join("&");
    assert.equal(base, expected);
  });

  it("uppercase do método HTTP", () => {
    const base = buildSignatureBaseString("post", "https://api.x.com/2/tweets", {});
    assert.ok(base.startsWith("POST&"));
  });

  it("percent-encode duplo: params concatenados são re-encoded como um bloco", () => {
    // O '&' entre pares chave=valor deve estar percent-encoded (%26) na base
    // string final, já que o parâmetro concatenado inteiro é encodado de novo.
    const base = buildSignatureBaseString("GET", "https://x.test/", { a: "1", b: "2" });
    assert.ok(base.includes("a%3D1%26b%3D2"), `esperado 'a%3D1%26b%3D2' em: ${base}`);
  });

  it("params vazios produzem base string com paramString vazia", () => {
    const base = buildSignatureBaseString("GET", "https://x.test/", {});
    assert.equal(base, `GET&${encodeURIComponent("https://x.test/")}&`);
  });
});

describe("buildSigningKey", () => {
  it("concatena consumerSecret + '&' + tokenSecret, ambos percent-encoded", () => {
    const key = buildSigningKey("secret+with+plus", "token secret");
    assert.equal(key, `${percentEncode("secret+with+plus")}&${percentEncode("token secret")}`);
  });

  it("token secret vazio (fluxo request-token) ainda produz key válida com '&' final", () => {
    const key = buildSigningKey("consumer-secret", "");
    assert.equal(key, "consumer-secret&");
  });
});

describe("signHmacSha1", () => {
  it("cross-check: produz o mesmo valor que node:crypto chamado diretamente com os mesmos argumentos", () => {
    const baseString = "POST&https%3A%2F%2Fx.test%2F&a%3D1";
    const signingKey = "key&secret";
    const expected = createHmac("sha1", signingKey).update(baseString).digest("base64");
    assert.equal(signHmacSha1(baseString, signingKey), expected);
  });

  it("é determinístico — mesma entrada produz sempre a mesma assinatura", () => {
    const a = signHmacSha1("base", "key&secret");
    const b = signHmacSha1("base", "key&secret");
    assert.equal(a, b);
  });

  it("assinaturas diferem quando a chave difere", () => {
    const a = signHmacSha1("base", "key1&secret1");
    const b = signHmacSha1("base", "key2&secret2");
    assert.notEqual(a, b);
  });

  it("retorna base64 válido (regex de charset)", () => {
    const sig = signHmacSha1("qualquer coisa", "k&s");
    assert.match(sig, /^[A-Za-z0-9+/]+=*$/);
  });
});

describe("generateOAuth1AuthHeader", () => {
  const baseInput = {
    method: "POST",
    url: "https://api.x.com/2/tweets",
    consumerKey: "consumer-key-123",
    consumerSecret: "consumer-secret-456",
    token: "token-789",
    tokenSecret: "token-secret-abc",
  };

  it("header começa com 'OAuth ' e contém todos os campos oauth_* obrigatórios", () => {
    const header = generateOAuth1AuthHeader({ ...baseInput, nonce: "fixednonce", timestampSec: 1700000000 });
    assert.ok(header.startsWith("OAuth "));
    for (const field of [
      "oauth_consumer_key",
      "oauth_nonce",
      "oauth_signature",
      "oauth_signature_method",
      "oauth_timestamp",
      "oauth_token",
      "oauth_version",
    ]) {
      assert.ok(header.includes(field), `header deve conter ${field}: ${header}`);
    }
  });

  it("oauth_signature_method é sempre HMAC-SHA1", () => {
    const header = generateOAuth1AuthHeader({ ...baseInput, nonce: "n", timestampSec: 1 });
    assert.match(header, /oauth_signature_method="HMAC-SHA1"/);
  });

  it("oauth_version é sempre 1.0", () => {
    const header = generateOAuth1AuthHeader({ ...baseInput, nonce: "n", timestampSec: 1 });
    assert.match(header, /oauth_version="1\.0"/);
  });

  it("determinístico: mesmo nonce+timestamp+inputs produz o mesmo header (mesma assinatura)", () => {
    const h1 = generateOAuth1AuthHeader({ ...baseInput, nonce: "fixed", timestampSec: 42 });
    const h2 = generateOAuth1AuthHeader({ ...baseInput, nonce: "fixed", timestampSec: 42 });
    assert.equal(h1, h2);
  });

  it("nonce diferente produz oauth_signature diferente", () => {
    const h1 = generateOAuth1AuthHeader({ ...baseInput, nonce: "nonce-a", timestampSec: 42 });
    const h2 = generateOAuth1AuthHeader({ ...baseInput, nonce: "nonce-b", timestampSec: 42 });
    const sigOf = (h: string) => h.match(/oauth_signature="([^"]+)"/)?.[1];
    assert.notEqual(sigOf(h1), sigOf(h2));
  });

  it("sem nonce/timestampSec explícitos, gera valores (não lança, não fica undefined)", () => {
    const header = generateOAuth1AuthHeader(baseInput);
    assert.match(header, /oauth_nonce="[0-9a-f]{32}"/, "nonce default deve ser hex de 32 chars (16 bytes)");
    assert.match(header, /oauth_timestamp="\d+"/);
  });

  it("extraParams (ex: query string de GET) entram na assinatura — mudar extraParams muda oauth_signature", () => {
    const h1 = generateOAuth1AuthHeader({
      ...baseInput,
      nonce: "n",
      timestampSec: 1,
      extraParams: { foo: "bar" },
    });
    const h2 = generateOAuth1AuthHeader({
      ...baseInput,
      nonce: "n",
      timestampSec: 1,
      extraParams: { foo: "baz" },
    });
    const sigOf = (h: string) => h.match(/oauth_signature="([^"]+)"/)?.[1];
    assert.notEqual(sigOf(h1), sigOf(h2));
  });

  it("valores do header estão percent-encoded (aspas dentro do valor não quebram o parsing)", () => {
    const header = generateOAuth1AuthHeader({ ...baseInput, nonce: "n", timestampSec: 1 });
    // Nenhum valor deve conter aspas duplas não-escapadas além dos delimitadores do header.
    const pairs = header.replace(/^OAuth /, "").split(", ");
    for (const pair of pairs) {
      assert.match(pair, /^[a-z_]+="[^"]*"$/, `par malformado: ${pair}`);
    }
  });
});
