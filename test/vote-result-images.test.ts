/**
 * test/vote-result-images.test.ts (#1351)
 *
 * Cobre renderResultImagesHtml — função pure que renderiza o HTML das duas
 * imagens A/B na página de resultado do vote, com labels e highlight da
 * clicada.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderResultImagesHtml } from "../workers/poll/src/index.ts";

describe("renderResultImagesHtml (#1351)", () => {
  it("retorna '' quando resultImages é null", () => {
    assert.equal(renderResultImagesHtml(null), "");
  });

  it("retorna '' quando resultImages é undefined", () => {
    assert.equal(renderResultImagesHtml(undefined), "");
  });

  it("renderiza duas imagens A e B com URLs corretas", () => {
    const html = renderResultImagesHtml({
      edition: "260519",
      aiSide: "A",
      clickedSide: "A",
    });
    assert.match(html, /\/img\/img-260519-01-eia-A\.jpg/);
    assert.match(html, /\/img\/img-260519-01-eia-B\.jpg/);
  });

  it("highlight (class='clicked') na imagem que o leitor clicou", () => {
    const htmlClickedA = renderResultImagesHtml({
      edition: "260519",
      aiSide: "B",
      clickedSide: "A",
    });
    // A é clicked → class="result-image clicked"
    assert.match(htmlClickedA, /<div class="result-image clicked">[\s\S]*?img-260519-01-eia-A/);
    // B sem clicked
    assert.match(htmlClickedA, /<div class="result-image">[\s\S]*?img-260519-01-eia-B/);
  });

  it('badge "Você clicou" aparece exatamente uma vez (na clickedSide)', () => {
    const html = renderResultImagesHtml({
      edition: "260519",
      aiSide: "A",
      clickedSide: "B",
    });
    const matches = html.match(/Você clicou/g) || [];
    assert.equal(matches.length, 1, "exatamente um badge esperado");
  });

  it("label '🤖 Gerada por IA' aparece exatamente uma vez (no aiSide)", () => {
    const html = renderResultImagesHtml({
      edition: "260519",
      aiSide: "A",
      clickedSide: "B",
    });
    const aiLabels = (html.match(/🤖 Gerada por IA/g) || []).length;
    const realLabels = (html.match(/📷 Foto real/g) || []).length;
    assert.equal(aiLabels, 1, "exatamente 1 label IA");
    assert.equal(realLabels, 1, "exatamente 1 label Real");
  });

  it("ordem A primeiro, B segundo (consistência visual)", () => {
    const html = renderResultImagesHtml({
      edition: "260519",
      aiSide: "B",
      clickedSide: "A",
    });
    const aIdx = html.indexOf("eia-A.jpg");
    const bIdx = html.indexOf("eia-B.jpg");
    assert.ok(aIdx >= 0 && bIdx >= 0);
    assert.ok(aIdx < bIdx, "A deve aparecer antes de B no HTML");
  });

  it("usa loading='lazy' nas imagens (perf mobile)", () => {
    const html = renderResultImagesHtml({
      edition: "260519",
      aiSide: "A",
      clickedSide: "A",
    });
    const lazyCount = (html.match(/loading="lazy"/g) || []).length;
    assert.equal(lazyCount, 2);
  });

  it("alt text 'Imagem A' / 'Imagem B' (accessibility)", () => {
    const html = renderResultImagesHtml({
      edition: "260519",
      aiSide: "A",
      clickedSide: "B",
    });
    assert.match(html, /alt="Imagem A"/);
    assert.match(html, /alt="Imagem B"/);
  });
});
