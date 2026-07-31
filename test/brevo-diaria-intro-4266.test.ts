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

describe("renderPendingIntroHtml — #4266", () => {
  it(`lê ${PENDING_INTRO_SNIPPET_FILENAME} e renderiza HTML não-vazio`, () => {
    const html = renderPendingIntroHtml();
    assert.ok(html, "snippet deve existir e renderizar (bloqueante pro publisher se ausente)");
    assert.ok(html!.length > 0);
  });

  it("CTA vira link (shouldForceCtaPill via renderBoxDivulgacao)", () => {
    const html = renderPendingIntroHtml();
    assert.match(html!, /<a[^>]+href="https:\/\/diar\.ia\.br/);
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
