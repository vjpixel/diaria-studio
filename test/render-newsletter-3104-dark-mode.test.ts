/**
 * test/render-newsletter-3104-dark-mode.test.ts
 *
 * #3104 — paridade de dark mode com o mensal (#2645) no caminho
 * `fullDocument` (Worker-hosted, usado no preview/test-email) da diária.
 *
 * Antes deste fix, só a MENSAL emitia `<meta name="color-scheme">` +
 * `@media (prefers-color-scheme: dark)` (via buildMensalStyleBlock, #2645).
 * A diária não tinha nenhum dos dois no seu `fullDocument`.
 *
 * Fix: `renderHTML(content, { fullDocument: true })` agora emite:
 *   - `<meta name="color-scheme" content="light">` no <head>
 *   - um `<style>` adicional (buildDarkCanvasStyleBlock) com a regra
 *     `@media (prefers-color-scheme: dark) { body, .ds-canvas { background:... } }`
 *   - a classe `.ds-canvas` no wrapper mais externo do fullDocument
 *
 * Escopo deliberado (#3104): o fragmento colado no Beehiiv (`fullDocument`
 * omitido/false) NÃO recebe nenhuma dessas 3 mudanças — o Beehiiv às vezes
 * remove o `<style>` do htmlSnippet (#260629), então qualquer media query lá
 * já é best-effort de qualquer jeito; e mexer no bloco <style> compartilhado
 * (DS_STYLE_BLOCK, usado por AMBOS os caminhos) arriscaria regressão no
 * fragmento por um ganho que não se sustenta lá. Por isso a asserção negativa
 * abaixo é tão importante quanto a positiva.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderHTML } from "../scripts/lib/newsletter-render-html.ts";
import type { NewsletterContent } from "../scripts/lib/newsletter-parse.ts";

const FIXTURE: NewsletterContent = {
  title: "Edição teste",
  subtitle: "Teste",
  coverImage: "04-d1-2x1.jpg",
  destaques: [
    {
      n: 1,
      category: "RISCO",
      title: "Modelos se replicam sozinhos",
      body: "Parágrafo 1.\nParágrafo 2.",
      why: "Por que importa.",
      url: "https://example.com/d1",
      emoji: "⚠️",
      imageFile: "04-d1-2x1.jpg",
    },
  ],
  eia: { credit: "Foto: x.", imageA: "01-eia-A.jpg", imageB: "01-eia-B.jpg", edition: "260999" },
  sections: [],
};

describe("#3104 — dark mode: fullDocument ganha paridade com o mensal (#2645)", () => {
  it("fullDocument: true emite meta color-scheme=light no <head>", () => {
    const full = renderHTML(FIXTURE, { fullDocument: true });
    assert.match(full, /<meta name="color-scheme" content="light" \/>/);
  });

  it("fullDocument: true emite a regra de dark-canvas (@media prefers-color-scheme: dark)", () => {
    const full = renderHTML(FIXTURE, { fullDocument: true });
    assert.match(full, /@media \(prefers-color-scheme: dark\)/);
    assert.match(full, /body, \.ds-canvas \{ background:#171411 !important; \}/);
  });

  it("fullDocument: true aplica a classe .ds-canvas no wrapper mais externo", () => {
    const full = renderHTML(FIXTURE, { fullDocument: true });
    assert.match(full, /<table role="presentation" class="ds-canvas"/);
  });

  it("fragmento (fullDocument omitido/false) NÃO recebe meta color-scheme nem dark-canvas", () => {
    const frag = renderHTML(FIXTURE); // fullDocument: false (default)
    assert.doesNotMatch(frag, /color-scheme/);
    assert.doesNotMatch(frag, /prefers-color-scheme/);
    assert.doesNotMatch(frag, /ds-canvas/);
  });

  it("fragmento continua byte-idêntico em estrutura — DS_STYLE_BLOCK inalterado", () => {
    // Guard indireto: o fragmento não deve ganhar NENHUM <style> extra além do
    // bloco DS_STYLE_BLOCK único já existente (buildDiariaStyleBlock).
    const frag = renderHTML(FIXTURE);
    const styleTagCount = (frag.match(/<style>/g) || []).length;
    assert.equal(styleTagCount, 1, "fragmento deve ter exatamente 1 <style> (DS_STYLE_BLOCK)");
  });

  it("fullDocument tem 2 <style> — DS_STYLE_BLOCK + dark-canvas standalone", () => {
    const full = renderHTML(FIXTURE, { fullDocument: true });
    const styleTagCount = (full.match(/<style>/g) || []).length;
    assert.equal(styleTagCount, 2, "fullDocument deve ter DS_STYLE_BLOCK + o <style> de dark-canvas");
  });
});
