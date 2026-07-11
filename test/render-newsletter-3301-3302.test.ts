/**
 * test/render-newsletter-3301-3302.test.ts
 *
 * Lote #3299→#3220/#3280/#3284 — dois achados menores na diária
 * (newsletter-render-html.ts):
 *
 *   #3301 — `escText` (o `onText` de `renderBodyInline`, corpo de destaque, e
 *     também usado por `renderWhyBoxInner`/`renderCoverage`) nunca chamava
 *     `applyInlineBold` — `**bold**` solto (sem link por perto) sobrevivia
 *     literal no HTML final, diferente de `processInlineLinks`
 *     (callouts/boxes), que sempre aplica bold. Investigação (ver PR): o
 *     template (`context/templates/newsletter.md`) e o humanizador
 *     (`context/publishers/humanizador-rubric.md`) proíbem `**` fora de
 *     headers/títulos no corpo — mas nenhum lint estrutural garante isso
 *     linha a linha, então o gap era real ainda que raro. Fix: `escText`
 *     passa a chamar `applyInlineBold`.
 *
 *   #3302 item 2 — quando o LABEL de um link bold-wrapped já é inteiramente
 *     bold (`**[**Título**](url)**`), o merge do #3220 produzia
 *     `<strong><a><strong>Título</strong></a></strong>` (negrito duplicado,
 *     markup frágil embora não quebre visualmente). Fix: `tokenizeInline`
 *     detecta label totalmente bold e omite o `<strong>` externo redundante
 *     (os `**` externos continuam sendo CONSUMIDOS/reconhecidos
 *     estruturalmente — só a duplicação de markup é evitada).
 *
 * #3302 item 1 (countDoubleAsterisk não distingue itálico de bold) foi
 * avaliado e DEIXADO DE FORA deste lote — ver nota no PR: exigiria
 * distinguir semanticamente `*single*` de `**duplo**` na contagem de
 * paridade, o que aproximaria de uma reescrita como parser/state-machine
 * (explicitamente fora de escopo do lote).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  renderBodyParasInner,
  renderWhyBoxInner,
  renderCoverage,
  processInlineLinks,
} from "../scripts/lib/newsletter-render-html.ts";

describe("#3301 — escText aplica applyInlineBold: **bold** solto no corpo de destaque vira <strong>", () => {
  it("cenário exato da issue: renderBodyParasInner('**bold** puro') produz <strong>bold</strong>, não ** literal", () => {
    const html = renderBodyParasInner("**bold** puro");
    assert.doesNotMatch(html, /\*\*/, `asterisco literal vazou: ${html}`);
    assert.match(html, /<strong>bold<\/strong> puro/, `bold não convertido: ${html}`);
  });

  it("bold + itálico no mesmo parágrafo do corpo: ambos convertem corretamente (ordem italic->bold não conflita)", () => {
    const html = renderBodyParasInner("Isto é **importante** e isto é *sutil*.");
    assert.doesNotMatch(html, /\*/, `asterisco literal vazou: ${html}`);
    assert.match(html, /<strong>importante<\/strong>/, `bold ausente: ${html}`);
    assert.match(html, /<em style="font-style:italic;">sutil<\/em>/, `itálico ausente: ${html}`);
  });

  it("link + bold puro no mesmo parágrafo do corpo (via renderBodyInline/tokenizeInline): ambos funcionam, sem ** literal", () => {
    const html = renderBodyParasInner(
      "Veja **isto é bold** e também [este link](https://example.com/x).",
    );
    assert.doesNotMatch(html, /\*\*/, `asterisco literal vazou: ${html}`);
    assert.match(html, /<strong>isto é bold<\/strong>/, `bold do texto puro ausente: ${html}`);
    assert.match(html, /<a href="https:\/\/example\.com\/x"[^>]*>este link<\/a>/, `link ausente/corrompido: ${html}`);
  });

  it("renderWhyBoxInner ('Por que isso importa'): ** solto também converte (mesmo escText)", () => {
    const html = renderWhyBoxInner("Isso é **muito** relevante.");
    assert.doesNotMatch(html, /\*\*/, `asterisco literal vazou: ${html}`);
    assert.match(html, /<strong>muito<\/strong>/);
  });

  it("renderCoverage (linha de cobertura): ** solto também converte (mesmo escText)", () => {
    const html = renderCoverage("Selecionamos os **9 mais relevantes** desta edição.");
    assert.doesNotMatch(html, /\*\*/, `asterisco literal vazou: ${html}`);
    assert.match(html, /<strong>9 mais relevantes<\/strong>/);
  });

  it("texto sem ** nenhum continua intacto (não regressão no caso comum)", () => {
    const html = renderBodyParasInner("Parágrafo comum, sem nenhuma marcação especial.");
    assert.doesNotMatch(html, /<strong>|<em/);
    assert.match(html, /Parágrafo comum, sem nenhuma marcação especial\./);
  });
});

describe("#3302 item 2 — tokenizeInline: label do link inteiramente bold não duplica <strong>", () => {
  it("'**[**Título**](url)**' produz <strong><a>...</a></strong> SEM strong aninhado, sem ** literal", () => {
    const out = processInlineLinks("**[**Título**](https://example.com)**");
    assert.doesNotMatch(out, /\*\*/, `asterisco literal vazou: ${out}`);
    // Exatamente 1 <strong> de abertura e 1 de fechamento — não aninhado.
    const opens = (out.match(/<strong>/g) || []).length;
    const closes = (out.match(/<\/strong>/g) || []).length;
    assert.equal(opens, 1, `esperava 1 <strong> de abertura, achou ${opens}: ${out}`);
    assert.equal(closes, 1, `esperava 1 </strong> de fechamento, achou ${closes}: ${out}`);
    // O <strong> vem de dentro do <a> (via applyInlineBold no label) — SEM o
    // wrap externo redundante que o fix de #3302 item 2 evita.
    assert.match(
      out,
      /^<a href="https:\/\/example\.com"[^>]*><strong>Título<\/strong><\/a>$/,
      `estrutura inesperada: ${out}`,
    );
  });

  it("regressão #3220 preservada: label SEM bold interno ainda funde normalmente em <strong><a>", () => {
    const out = processInlineLinks(
      "**[2041: Como a IA...](https://example.com/livro)**, de Kai-Fu Lee",
    );
    assert.doesNotMatch(out, /\*\*/, `asterisco literal vazou: ${out}`);
    assert.match(
      out,
      /<strong><a href="https:\/\/example\.com\/livro"[^>]*>2041: Como a IA\.\.\.<\/a><\/strong>/,
      `link não saiu envolto em <strong>: ${out}`,
    );
  });

  it("label parcialmente bold ('**A**B') NÃO é tratado como fully-bold — continua envolvendo em <strong> externo (comportamento anterior preservado)", () => {
    const out = processInlineLinks("**[**A**B](https://example.com)**");
    assert.doesNotMatch(out, /\*\*/, `asterisco literal vazou: ${out}`);
    // Não é fully-bold (sobra "B" fora do primeiro par de **) — wrapBold continua true.
    assert.match(out, /<strong><a href="https:\/\/example\.com"/, `deveria continuar com <strong> externo: ${out}`);
  });
});
