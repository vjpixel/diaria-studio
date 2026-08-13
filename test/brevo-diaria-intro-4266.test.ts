/**
 * test/brevo-diaria-intro-4266.test.ts (#4266)
 *
 * Bloco de intro obrigatório do segmento Pending: leitura do snippet real
 * (garante que o arquivo existe e renderiza, sem travar no conteúdo exato —
 * a cópia é rascunho e pode mudar) + injeção pura no HTML fullDocument.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderPendingIntroHtml, injectPendingIntro, PENDING_INTRO_SNIPPET_FILENAME } from "../scripts/lib/brevo-diaria-intro.ts";
import { isCtaOnlyParagraph, renderBarePillButton } from "../scripts/lib/newsletter-render-html.ts";

describe("renderPendingIntroHtml — #4266", () => {
  it(`lê ${PENDING_INTRO_SNIPPET_FILENAME} e renderiza HTML não-vazio`, () => {
    const html = renderPendingIntroHtml();
    assert.ok(html, "snippet deve existir e renderizar (bloqueante pro publisher se ausente)");
    assert.ok(html!.length > 0);
  });

  it("CTA vira botão pill (bare, via renderBarePillButton), apontando pro link personalizado do worker reativar (#4476 item 3, achado 260803 4ª rodada — não mais o formulário genérico)", () => {
    const html = renderPendingIntroHtml();
    assert.match(html!, /<a[^>]+href="https:\/\/reativar\.diaria\.workers\.dev\/\?email=\{\{ contact\.EMAIL \}\}"/);
    assert.match(html!, /border-radius:999px/);
  });

  it("sem título: 1º parágrafo NÃO vira heading serif 26px", () => {
    const html = renderPendingIntroHtml();
    assert.doesNotMatch(html!, /font-size:26px/, "1º parágrafo não deveria renderizar como título serif grande");
  });

  it("sem caixa/cartão bege ao redor (achado 260803, pedido do editor: 'tira o texto dessa caixa') — texto e botão soltos no fluxo, não dentro de <table style=\"background:#EBE5D0...\">", () => {
    const html = renderPendingIntroHtml();
    assert.doesNotMatch(html!, /background:#EBE5D0/, "não deveria ter fundo de cartão — nem no texto, nem no botão");
  });

  it("disclosure de descadastro renderiza como parágrafo solto (renderCoverageTrailer), não dentro de td com padding de card", () => {
    const html = renderPendingIntroHtml();
    assert.match(html!, /pode se <a href="\{\{ unsubscribe \}\}"/);
  });

  it("embrulha os <tr> soltos numa <table> própria (achado 260803, 2ª rodada — órfãos quebravam o topo do e-mail: injectPendingIntro insere ANTES do <table class=\"ds-canvas\"> que renderHTML abre, então <tr> sem tabela própria ficava sem contexto de tabela válido)", () => {
    const html = renderPendingIntroHtml()!;
    const tableOpenIdx = html.indexOf("<table");
    const firstTrIdx = html.indexOf("<tr");
    assert.ok(tableOpenIdx !== -1, "deve ter uma <table> própria");
    assert.ok(tableOpenIdx < firstTrIdx, "a <table> deve abrir ANTES do 1º <tr>");
    assert.match(html, /<\/table>\s*(<!--\[if mso\]><\/td><\/tr><\/table><!\[endif\]-->\s*)?$/, "deve fechar a <table> (e o wrapper MSO, se presente) no final do HTML");
  });

  it("embrulha num conditional MSO (review PR #4522 — Outlook desktop ignora max-width e honra só o atributo width=\"100%\", reproduzindo a mesma quebra de largura que a nota 3ª rodada corrigiu pros outros clientes; mesmo padrão de newsletter-render-html.ts innerTable/container)", () => {
    const html = renderPendingIntroHtml()!;
    // #5176 (260813): container calibrado 600 → 656.
    assert.match(html, /<!--\[if mso\]><table[^>]*width="656"[^>]*><tr><td width="656"><!\[endif\]-->/);
    assert.match(html, /<!--\[if mso\]><\/td><\/tr><\/table><!\[endif\]-->/);
  });

  it("a <table> própria tem fundo branco EXPLÍCITO (achado 260803, 3ª rodada — dark mode: injectPendingIntro insere na zona 'canvas externo' que darkCanvasMediaRule escurece de propósito; texto ink sobre fundo herdado escuro = invisível; PAGE_BG explícito isola do dark-mode do body, sem reintroduzir cartão visível — mesma cor do container real ao redor)", () => {
    const html = renderPendingIntroHtml()!;
    assert.match(html, /<table[^>]*style="[^"]*background:#FFFFFF;"/, "table wrapper deve ter background explícito, não herdado");
  });

  it("a <table> própria tem max-width:656px + class=\"container\" (achado 260803, 4ª rodada — pós-envio: width=\"100%\" sem teto virava 100% do CLIENTE DE E-MAIL inteiro, não do container real, porque esta tabela fica fora do .ds-canvas; linha de texto saía larga demais em clientes desktop)", () => {
    const html = renderPendingIntroHtml()!;
    // #5176 (260813): container calibrado 600 → 656.
    assert.match(html, /<table[^>]*class="container"[^>]*max-width:656px/, "deve ter o mesmo teto de largura do container real");
  });

  it("a <table> própria é centralizada (align + margin:0 auto — email-safe pros dois casos: clientes antigos via atributo, modernos via margin)", () => {
    const html = renderPendingIntroHtml()!;
    assert.match(html, /<table[^>]*align="center"/);
    assert.match(html, /<table[^>]*style="[^"]*margin:0 auto/);
  });
});

describe("isCtaOnlyParagraph — extraído de shouldForceCtaPill (achado 260803)", () => {
  it("→ [texto](url) → true", () => {
    assert.equal(isCtaOnlyParagraph("→ [Fazer meu cadastro de novo](https://diar.ia.br/?x=1)"), true);
  });

  it("parágrafo com texto além do link → false", () => {
    assert.equal(isCtaOnlyParagraph("Veja mais em [este link](https://diar.ia.br) e confira."), false);
  });

  it("parágrafo sem link nenhum → false", () => {
    assert.equal(isCtaOnlyParagraph("Só um parágrafo de texto comum."), false);
  });
});

describe("renderBarePillButton — botão sem caixa/cartão ao redor (achado 260803)", () => {
  it("renderiza <a> com pill styling, sem background de cartão", () => {
    const html = renderBarePillButton("https://diar.ia.br/x", "Clique aqui");
    assert.match(html, /border-radius:999px/);
    assert.match(html, /href="https:\/\/diar\.ia\.br\/x"/);
    assert.match(html, />Clique aqui<\/a>/);
    assert.doesNotMatch(html, /background:#EBE5D0/);
  });

  it("escapa URL e label (XSS-safe, mesma disciplina do resto do render)", () => {
    const html = renderBarePillButton('https://x.com/"><script>', 'a & b <script>');
    assert.doesNotMatch(html, /<script>/);
  });
});

describe("injectPendingIntro — inserção pura pós <body> (#4266)", () => {
  it("insere logo após a abertura de <body ...>", () => {
    const doc = "<!doctype html><html><head></head><body style=\"margin:0\"><p>conteúdo</p></body></html>";
    const out = injectPendingIntro(doc, "<div>INTRO</div>");
    const bodyOpenEnd = out.indexOf('style="margin:0">') + 'style="margin:0">'.length;
    assert.equal(out.slice(bodyOpenEnd, bodyOpenEnd + "<div>INTRO</div>".length), "<div>INTRO</div>");
    assert.match(out, /<body[^>]*><div>INTRO<\/div><p>conteúdo<\/p><\/body>/);
  });

  it("sem tag <body> → lança (nunca insere silenciosamente no lugar errado)", () => {
    assert.throws(() => injectPendingIntro("<div>fragmento sem body</div>", "<div>INTRO</div>"), /não tem tag <body>/);
  });

  it("<body malformado (sem '>') → lança", () => {
    assert.throws(() => injectPendingIntro("<html><body style=\"x\"", "<div>INTRO</div>"), /malformada/);
  });
});
