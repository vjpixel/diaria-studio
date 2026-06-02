/**
 * test/lint-test-email-image-freshness.test.ts (#1212)
 *
 * Cobre as funções puras de extração de URL e resolução pra arquivo local.
 * A função checkImageFreshness (que faz fetch) requer rede e arquivos —
 * coberta por smoke test separado.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractImageUrls,
  resolveExpectedLocalFile,
} from "../scripts/lint-test-email-image-freshness.ts";

describe("extractImageUrls (#1212)", () => {
  it("extrai URL de <img src>", () => {
    const html = '<p>texto</p><img src="https://example.com/foo.jpg" alt="">';
    assert.deepEqual(extractImageUrls(html), ["https://example.com/foo.jpg"]);
  });

  it("extrai URL nua de plain text", () => {
    const text = "Veja a imagem em https://example.com/foo.png aqui";
    assert.deepEqual(extractImageUrls(text), ["https://example.com/foo.png"]);
  });

  it("extrai múltiplas URLs sem duplicar", () => {
    const html = `
      <img src="https://example.com/a.jpg">
      <img src="https://example.com/a.jpg"> <!-- duplicada -->
      <img src="https://example.com/b.png">
    `;
    const r = extractImageUrls(html);
    assert.equal(r.length, 2);
    assert.ok(r.includes("https://example.com/a.jpg"));
    assert.ok(r.includes("https://example.com/b.png"));
  });

  it("ignora URLs sem extensão de imagem", () => {
    const text = "Link: https://example.com/article-text";
    assert.deepEqual(extractImageUrls(text), []);
  });

  it("retorna [] pra string vazia", () => {
    assert.deepEqual(extractImageUrls(""), []);
  });

  it("aceita jpeg, webp", () => {
    const html = '<img src="https://example.com/x.jpeg"> <img src="https://example.com/y.webp">';
    const r = extractImageUrls(html);
    assert.equal(r.length, 2);
  });
});

describe("resolveExpectedLocalFile (#1212)", () => {
  it("Worker URL padrão → strip img-{AAMMDD}- prefix", () => {
    const r = resolveExpectedLocalFile(
      "https://poll.diaria.workers.dev/img/img-260514-04-d1-2x1.jpg",
    );
    assert.equal(r, "04-d1-2x1.jpg");
  });

  it("Worker URL com cache-bust suffix -v2 → strip", () => {
    const r = resolveExpectedLocalFile(
      "https://poll.diaria.workers.dev/img/img-260514-04-d1-2x1-v2.jpg",
    );
    assert.equal(r, "04-d1-2x1.jpg");
  });

  it("#1714: Worker URL com sufixo md5short (8 hex, #1584) → strip pro nome local", () => {
    // cover/d1 são gravados como `...-{md5.slice(0,8)}.jpg` (cloudflareKvKey).
    // Sem stripar o md5, a freshness lint pulava cover/d1 silenciosamente.
    const r = resolveExpectedLocalFile(
      "https://poll.diaria.workers.dev/img/img-260602-04-d1-2x1-8ff353aa.jpg",
    );
    assert.equal(r, "04-d1-2x1.jpg");
  });

  it("#1714: md5short em d2/d3 1x1 também resolve", () => {
    assert.equal(
      resolveExpectedLocalFile("https://poll.diaria.workers.dev/img/img-260602-04-d2-1x1-503c963f.jpg"),
      "04-d2-1x1.jpg",
    );
  });

  it("#1714: não estripa nome legítimo (sem sufixo hex de 8) — 04-d1-2x1 intacto", () => {
    // `2x1` não é 8 hex → o strip não toca; já coberto pelo 1º teste, mas
    // garante que a alternância -v\d+|[0-9a-f]{8} não over-fire.
    const r = resolveExpectedLocalFile(
      "https://poll.diaria.workers.dev/img/img-260514-04-d1-2x1.jpg",
    );
    assert.equal(r, "04-d1-2x1.jpg");
  });

  it("Worker URL eia → strip prefix", () => {
    const r = resolveExpectedLocalFile(
      "https://poll.diaria.workers.dev/img/img-260514-01-eia-A.jpg",
    );
    assert.equal(r, "01-eia-A.jpg");
  });

  it("URL direta com nome canônico → retorna nome", () => {
    const r = resolveExpectedLocalFile("https://cdn.example.com/path/04-d1-2x1.jpg");
    assert.equal(r, "04-d1-2x1.jpg");
  });

  it("URL com query string ignora ? em diante", () => {
    const r = resolveExpectedLocalFile(
      "https://cdn.example.com/04-d1-2x1.jpg?t=12345",
    );
    assert.equal(r, "04-d1-2x1.jpg");
  });

  it("URL não-canônica → null (não tenta mapear)", () => {
    assert.equal(resolveExpectedLocalFile("https://example.com/random.jpg"), null);
    assert.equal(resolveExpectedLocalFile("https://drive.google.com/uc?id=abc"), null);
  });

  it("URL sem extensão → null", () => {
    assert.equal(resolveExpectedLocalFile("https://example.com/article"), null);
  });

  it("aceita variante de extensão", () => {
    assert.equal(
      resolveExpectedLocalFile("https://poll.diaria.workers.dev/img/img-260514-04-d2-1x1.jpeg"),
      "04-d2-1x1.jpeg",
    );
  });
});
