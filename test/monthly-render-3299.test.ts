/**
 * test/monthly-render-3299.test.ts
 *
 * Regressão #3299: `monthly-render.ts` (`renderInline`) é uma reimplementação
 * PARALELA e independente do tokenizer `[label](url)` da diária
 * (`tokenizeInline` em `scripts/lib/newsletter-render-html.ts`) e nunca tinha
 * recebido o merge bold+link do #3220 (nem o fix de 2+ links do #3280/#3284).
 *
 * Cenário concreto da issue: `**[Livro Incrível](https://ex.com)**, recomendo`
 * (bold envolvendo link) fazia `renderInline` dividir o texto em segmentos
 * antes/depois do link, chamando `renderTextInline` separadamente — os `**`
 * órfãos em cada segmento nunca casavam com o regex de bold e vazavam como
 * asterisco literal no HTML final do Brevo, violando "Output final sem
 * markdown" (CLAUDE.md).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderInline } from "../scripts/lib/mensal/monthly-render.ts";

describe("#3299 — renderInline (mensal): **[label](url)** vira <strong><a>, sem ** literal", () => {
  it("cenário exato da issue: '**[Livro Incrível](https://ex.com)**, recomendo'", () => {
    const out = renderInline("**[Livro Incrível](https://ex.com)**, recomendo");
    assert.doesNotMatch(out, /\*\*/, `asterisco literal vazou: ${out}`);
    assert.match(
      out,
      /<strong><a href="https:\/\/ex\.com"[^>]*>Livro Incrível<\/a><\/strong>/,
      `link não saiu envolto em <strong>: ${out}`,
    );
    assert.match(out, /, recomendo/, `texto após o link ausente: ${out}`);
  });

  it("link SEM ** colado continua sem bold (comportamento normal preservado)", () => {
    const out = renderInline("Veja [este artigo](https://ex.com/a) sobre o tema.");
    assert.doesNotMatch(out, /<strong>/, `não deveria haver <strong>: ${out}`);
    assert.match(out, /<a href="https:\/\/ex\.com\/a"[^>]*>este artigo<\/a>/);
  });

  it("#3280 (portado): bolds INDEPENDENTES colados ao link não se fundem com o link", () => {
    // Mesmo input que trava o comportamento correto na diária (test/ds-email-2004-2005-2008.test.ts).
    const out = renderInline(
      "**Atenção:**[link](https://example.com)**hoje** foi importante.",
    );
    assert.doesNotMatch(out, /\*\*/, `asterisco literal vazou: ${out}`);
    assert.match(out, /<strong>Atenção:<\/strong>/, `'Atenção:' deveria ser <strong> próprio: ${out}`);
    assert.match(out, /<strong>hoje<\/strong>/, `'hoje' deveria ser <strong> próprio: ${out}`);
    assert.doesNotMatch(
      out,
      /<strong><a href="https:\/\/example\.com"/,
      `link não deveria sair envolto em <strong> (bolds são independentes): ${out}`,
    );
    assert.match(out, /<a href="https:\/\/example\.com"[^>]*>link<\/a>/, `href/label do link ausentes: ${out}`);
  });

  it("#3284/#3316 (portado): 2+ links bold-wrapped consecutivos no mesmo parágrafo continuam fundindo", () => {
    const out = renderInline(
      "Confira **[Link A](https://a.example.com)** e também **[Link B](https://b.example.com)**.",
    );
    assert.doesNotMatch(out, /\*\*/, `asterisco literal vazou: ${out}`);
    assert.match(
      out,
      /<strong><a href="https:\/\/a\.example\.com"[^>]*>Link A<\/a><\/strong>/,
      `Link A não fundiu: ${out}`,
    );
    assert.match(
      out,
      /<strong><a href="https:\/\/b\.example\.com"[^>]*>Link B<\/a><\/strong>/,
      `Link B não fundiu: ${out}`,
    );
    // Texto conector entre os 2 links não deve virar <strong> por engano.
    assert.match(out, /<\/strong> e também <strong>/, `conector 'e também' deveria ficar plano entre os 2 links: ${out}`);
  });

  it("normalização de URL (#2261) e wordmark (#2532/#template-branding) continuam funcionando dentro do bold-wrap", () => {
    const out = renderInline("**[Cursos](https://diaria.beehiiv.com/cursos-gratuitos-de-ia)**");
    // #3698: domínio de marca (era cursos.diaria.workers.dev).
    assert.match(out, /href="https:\/\/cursos\.diar\.ia\.br"/, `normalização de URL legada não aplicada: ${out}`);
    assert.match(out, /<strong><a/, `bold-wrap não aplicado: ${out}`);
  });
});
