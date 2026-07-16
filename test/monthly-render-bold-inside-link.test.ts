/**
 * test/monthly-render-bold-inside-link.test.ts
 *
 * Regressão (ciclo 2606-07): `renderInline` (mensal) só ESCAPAVA o rótulo do
 * link (`escHtml(m[1])`), sem processar `**bold**` DENTRO do rótulo. Então o
 * box de recomendação de leitura, cujo snippet usa `[**Título**](url)` (título
 * de livro em negrito-com-link, mesmo formato do diário), saía com os `**`
 * LITERAIS no HTML do Brevo — violando "Output final sem markdown" (CLAUDE.md).
 *
 * Distinto do #3299 (`**[label](url)**`, bold ENVOLVENDO o link): aqui o `**`
 * está DENTRO dos colchetes. Fix: o rótulo passa por `escHtmlWithEmphasis`
 * (escHtml + bold/italic, sem wordmark — que aninharia `<a>`).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderInline } from "../scripts/lib/mensal/monthly-render.ts";

describe("renderInline (mensal): **bold** DENTRO do rótulo do link vira <strong>, sem ** literal", () => {
  it("título de livro: '[**2041: Como a IA...**](url), de Kai-Fu Lee'", () => {
    const out = renderInline(
      "[**2041: Como a Inteligência Artificial Vai Mudar Sua Vida**](https://link.amazon/B05FlAaJ7), de Kai-Fu Lee e Chen Qiufan.",
    );
    assert.doesNotMatch(out, /\*\*/, `asterisco literal vazou: ${out}`);
    assert.match(
      out,
      /<a href="https:\/\/link\.amazon\/B05FlAaJ7"[^>]*><strong>2041: Como a Inteligência Artificial Vai Mudar Sua Vida<\/strong><\/a>/,
      `título do livro não virou <strong> dentro do <a>: ${out}`,
    );
    assert.match(out, /, de Kai-Fu Lee e Chen Qiufan\./, `texto após o link ausente: ${out}`);
  });

  it("rótulo SEM ** continua idêntico ao escape puro (sem <strong> espúrio)", () => {
    const out = renderInline("Veja [este artigo](https://ex.com/a) sobre o tema.");
    assert.doesNotMatch(out, /<strong>/, `não deveria haver <strong>: ${out}`);
    assert.match(out, /<a href="https:\/\/ex\.com\/a"[^>]*>este artigo<\/a>/, `link simples quebrou: ${out}`);
  });

  it("rótulo com ** NÃO recebe wordmark/link aninhado (evita <a> dentro de <a>)", () => {
    // `diar.ia.br` no rótulo não deve virar link Beehiiv aninhado — o rótulo usa
    // escHtmlWithEmphasis (sem applyBrandWordmark), diferente do texto ao redor.
    const out = renderInline("[**diar.ia.br**](https://ex.com/x)");
    assert.doesNotMatch(out, /<a[^>]*>[^<]*<a /, `<a> aninhado no rótulo: ${out}`);
    assert.match(out, /<a href="https:\/\/ex\.com\/x"[^>]*><strong>/, `bold no rótulo ausente: ${out}`);
  });
});
