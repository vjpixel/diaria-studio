/**
 * test/ds-email-2004-2005-2008.test.ts
 *
 * Testes de regressão para o lote ds-email:
 *   #2004 — sem font-weight:bold em links inline de corpo (só underline teal)
 *   #2005 — token paperEmail (#FFFFFF) documentado em design-tokens.ts
 *   #2008 — word-joiner anti auto-linkify pra "clarice.ai" em texto puro da diária
 *   #3220 — `**[label](url)**` (negrito colado ao link) em corpo de
 *     callout/box: exceção ESCOPADA a #2004 — vira `<strong><a>` em vez de
 *     vazar `**` literal. Link sem `**` colado continua sem bold (#2004 intacto).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { COLORS } from "../scripts/lib/shared/design-tokens.ts";
import {
  processInlineLinks,
  mdInlineToHtml,
  renderBodyParasInner,
} from "../scripts/lib/newsletter-render-html.ts";

// ---------------------------------------------------------------------------
// #2004 — links inline de corpo: underline teal, SEM font-weight:bold
// ---------------------------------------------------------------------------
describe("#2004 — processInlineLinks: underline teal sem bold", () => {
  it("link inline NÃO tem font-weight:bold", () => {
    const out = processInlineLinks("[Acesse aqui](https://example.com)");
    assert.doesNotMatch(out, /font-weight:bold/, `font-weight:bold presente: ${out}`);
  });

  it("link inline tem text-decoration:underline", () => {
    const out = processInlineLinks("[Acesse aqui](https://example.com)");
    assert.match(out, /text-decoration:underline/, `text-decoration:underline ausente: ${out}`);
  });

  it("link inline tem text-decoration-color teal (#00A0A0)", () => {
    const out = processInlineLinks("[Acesse aqui](https://example.com)");
    assert.match(out, /text-decoration-color:#00A0A0/, `text-decoration-color teal ausente: ${out}`);
  });

  it("href e label preservados (não regride funcionalidade)", () => {
    const out = processInlineLinks("[Claude](https://anthropic.com)");
    assert.match(out, /href="https:\/\/anthropic\.com"/, `href ausente: ${out}`);
    assert.match(out, />Claude<\/a>/, `label ausente: ${out}`);
  });

  it("processInlineLinks em callout/body: link não tem font-weight:bold (múltiplos links)", () => {
    // Verifica que qualquer link produzido por processInlineLinks nunca carrega bold.
    const out = processInlineLinks(
      "Leia [artigo A](https://a.example.com) e também [artigo B](https://b.example.com)."
    );
    // nenhum <a> no output deve ter font-weight:bold
    const aTagsWithBold = (out.match(/<a [^>]*>/g) ?? []).filter((tag) =>
      tag.includes("font-weight:bold"),
    );
    assert.deepEqual(aTagsWithBold, [], `<a> com bold: ${aTagsWithBold.join(", ")}`);
    // ambos os links têm teal underline
    assert.equal(
      (out.match(/text-decoration-color:#00A0A0/g) ?? []).length,
      2,
      `esperado 2 × text-decoration-color teal: ${out}`,
    );
  });
});

// ---------------------------------------------------------------------------
// #3220 — **[label](url)** em corpo de callout/box vira <strong><a>, em vez
// de vazar "**" literal. Exceção ESCOPADA a #2004: só dispara quando os DOIS
// lados do link têm o marcador `**` colado; link sem marcador continua sem
// bold (decisão #2004 preservada pro caso comum).
// ---------------------------------------------------------------------------
describe("#3220 — processInlineLinks: **[label](url)** vira <strong><a> (exceção escopada a #2004)", () => {
  it("** colado nos dois lados do link vira <strong><a>...</a></strong>, sem ** literal no HTML", () => {
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

  it("link SEM ** ao redor continua sem <strong> (decisão #2004 preservada — exceção é escopada)", () => {
    const out = processInlineLinks(
      "[2041: Como a IA...](https://example.com/livro), de Kai-Fu Lee",
    );
    assert.doesNotMatch(out, /<strong>/, `link sem ** não deveria ter <strong>: ${out}`);
    assert.match(
      out,
      /<a href="https:\/\/example\.com\/livro"[^>]*>2041: Como a IA\.\.\.<\/a>/,
      `href/label do link ausentes: ${out}`,
    );
  });

  it("bold legítimo longe do link continua bold normal (detecção de boldLink não interfere)", () => {
    const out = processInlineLinks(
      "**Atenção**: veja [este artigo](https://example.com/artigo) com calma.",
    );
    assert.match(out, /<strong>Atenção<\/strong>/, `bold legítimo não aplicado: ${out}`);
    assert.doesNotMatch(
      out,
      /<strong><a/,
      `link não deveria estar em <strong> (** não está colado ao link): ${out}`,
    );
    assert.match(out, /<a href="https:\/\/example\.com\/artigo"[^>]*>este artigo<\/a>/);
    assert.doesNotMatch(out, /\*\*/, `asterisco literal vazou: ${out}`);
  });
});

// ---------------------------------------------------------------------------
// #3280 — dois bolds INDEPENDENTES colados ao link (um de cada lado) NÃO
// devem ser tratados como bold-wrap do link (#3220). O heurístico original só
// checava `endsWith("**")`/`startsWith("**")`, sem verificar se esse `**` já
// estava auto-pareado no texto adjacente — em `**Atenção:**[link](url)**hoje**`
// isso consumia o `**` de fechamento de "Atenção:" e o `**` de abertura de
// "hoje", deixando cada um com um `**` órfão que vazava literal no HTML.
// ---------------------------------------------------------------------------
describe("#3280 — processInlineLinks: bolds independentes colados ao link não se fundem com o link", () => {
  it("input exato da issue: 'Atenção:' e 'hoje' saem como <strong> próprio, sem ** vazando, link plano", () => {
    const out = processInlineLinks(
      "**Atenção:**[link](https://example.com)**hoje** foi importante.",
    );
    assert.doesNotMatch(out, /\*\*/, `asterisco literal vazou: ${out}`);
    assert.match(out, /<strong>Atenção:<\/strong>/, `"Atenção:" deveria ser <strong> próprio: ${out}`);
    assert.match(out, /<strong>hoje<\/strong>/, `"hoje" deveria ser <strong> próprio: ${out}`);
    assert.doesNotMatch(
      out,
      /<strong><a/,
      `link não deveria sair envolto em <strong> (bolds são independentes, não um wrap): ${out}`,
    );
    assert.match(
      out,
      /<a href="https:\/\/example\.com"[^>]*>link<\/a>/,
      `href/label do link ausentes: ${out}`,
    );
  });

  it("regressão #3220: '**[label](url)**' genuíno (sem texto bold independente ao redor) continua fundindo em <strong><a>", () => {
    const out = processInlineLinks(
      "**[2041: Como a IA...](https://example.com/livro)**, de Kai-Fu Lee",
    );
    assert.doesNotMatch(out, /\*\*/, `asterisco literal vazou: ${out}`);
    assert.match(
      out,
      /<strong><a href="https:\/\/example\.com\/livro"[^>]*>2041: Como a IA\.\.\.<\/a><\/strong>/,
      `link não saiu envolto em <strong> (regressão #3220): ${out}`,
    );
  });
});

// ---------------------------------------------------------------------------
// #2005 — token paperEmail documentado em design-tokens.ts
// ---------------------------------------------------------------------------
describe("#2005 — design-tokens: token paperEmail (#FFFFFF)", () => {
  it("COLORS.paperEmail existe e é #FFFFFF (branco e-mail)", () => {
    assert.equal((COLORS as Record<string, string>).paperEmail, "#FFFFFF",
      "COLORS.paperEmail deve ser #FFFFFF (e-mail override oficial)");
  });

  it("COLORS.paper continua #FBFAF6 (token web — não alterado)", () => {
    assert.equal(COLORS.paper, "#FBFAF6",
      "COLORS.paper web não deve mudar");
  });
});

// ---------------------------------------------------------------------------
// #2008 — word-joiner anti auto-linkify pra "clarice.ai" na diária
// ---------------------------------------------------------------------------
describe("#2008 — word-joiner anti auto-linkify pra 'clarice.ai' (diária)", () => {
  it("'Clarice.ai' em texto puro recebe word-joiner via renderBodyParasInner", () => {
    const out = renderBodyParasInner("Use a Clarice.ai para revisar.");
    // &#8288; = WORD JOINER U+2060 (HTML entity)
    assert.match(out, /Clarice\.&#8288;ai/, `word-joiner ausente em renderBodyParasInner: ${out}`);
    assert.doesNotMatch(out, /Clarice\.ai\b/, `Clarice.ai sem word-joiner ainda presente: ${out}`);
  });

  it("'clarice.ai' (minúsculo) também recebe word-joiner", () => {
    const out = renderBodyParasInner("Acesse clarice.ai agora.");
    assert.match(out, /clarice\.&#8288;ai/, `word-joiner ausente (minúsculo): ${out}`);
  });

  it("link markdown [Clarice](https://clarice.ai) NÃO recebe word-joiner no href", () => {
    // Links explícitos têm href controlado — word-joiner só deve afetar texto puro
    const out = processInlineLinks("[Clarice](https://clarice.ai/?via=diaria)");
    assert.match(out, /href="https:\/\/clarice\.ai\/\?via=diaria"/, `href corrompido: ${out}`);
    assert.doesNotMatch(out, /href="[^"]*&#8288;/, `word-joiner dentro do href: ${out}`);
  });

  it("word-joiner aplicado em mdInlineToHtml (segmento texto — SORTEIO/ENCERRAR)", () => {
    const out = mdInlineToHtml("Use Clarice.ai pra revisar antes de enviar.");
    assert.match(out, /Clarice\.&#8288;ai/, `word-joiner ausente em mdInlineToHtml: ${out}`);
  });

  it("link markdown em mdInlineToHtml — href clarice.ai não é corrompido", () => {
    const out = mdInlineToHtml("Veja [Clarice](https://clarice.ai/?via=diaria) agora.");
    assert.match(out, /href="https:\/\/clarice\.ai\/\?via=diaria"/, `href corrompido: ${out}`);
    assert.doesNotMatch(out, /href="[^"]*&#8288;/, `word-joiner dentro do href: ${out}`);
  });
});
