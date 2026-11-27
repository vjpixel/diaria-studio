/**
 * test/onboarding-form-open-question-a11y-14349.test.ts (#14349)
 *
 * A v4 do formulário (#14330) trouxe a primeira pergunta aberta NUMERADA
 * (`apoio_decisao`). O ramo de pergunta aberta de `renderQuestion` gerava um
 * `<fieldset>` sem `<legend>` (o leitor de tela anunciava um grupo sem nome),
 * e a ajuda e o erro não se ligavam ao campo. Agora a pergunta aberta tem
 * `<legend>` com o `<label>` do campo dentro, e o campo aponta para a ajuda e
 * para o erro por `aria-describedby`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FORM_QUESTIONS, numberedQuestions, type FormQuestion } from "../scripts/lib/onboarding-form-contract.ts";
import { escapeHtml, renderFormHtml } from "../workers/onboarding-form/src/render.ts";

const q = FORM_QUESTIONS.find((x) => x.id === "apoio_decisao")!;
const number = numberedQuestions(FORM_QUESTIONS).findIndex((x) => x.id === "apoio_decisao") + 1;

/** O fieldset inteiro da pergunta, do `<fieldset` ao `</fieldset>`. */
function fieldsetOf(html: string, id: string): string {
  const at = html.indexOf(`<textarea id="${id}"`);
  assert.ok(at > 0, `campo ${id} presente`);
  const start = html.lastIndexOf("<fieldset", at);
  const end = html.indexOf("</fieldset>", at);
  return html.slice(start, end + "</fieldset>".length);
}

describe("#14349 pergunta aberta numerada", () => {
  it("premissa: apoio_decisao é textarea opcional, numerada e com ajuda", () => {
    assert.equal(q.kind, "textarea");
    assert.equal(q.required, undefined);
    assert.equal(q.subOf, undefined);
    assert.ok(q.help);
    assert.ok(number > 0);
  });

  const html = renderFormHtml("a@x.com", "S");
  const fs = fieldsetOf(html, "apoio_decisao");

  it("tem legend com o número e o label do campo dentro", () => {
    assert.ok(
      fs.includes(
        `<legend><label for="apoio_decisao"><span class="n">${number}</span>${escapeHtml(q.label)} <span class="req">opcional</span></label></legend>`,
      ),
      fs,
    );
    assert.ok(!fs.includes(`<label class="q"`), "sem o rótulo solto de antes");
  });

  it("textarea sem required e ligado à ajuda", () => {
    const ta = fs.match(/<textarea [^>]*>/)![0];
    assert.ok(!/\brequired\b/.test(ta), ta);
    assert.match(ta, / aria-describedby="apoio_decisao-help"/);
    assert.ok(fs.includes(`<p class="help" id="apoio_decisao-help">${escapeHtml(q.help!)}</p>`));
  });

  it("preenche a partir do rascunho (escapado)", () => {
    const filled = fieldsetOf(renderFormHtml("a@x.com", "S", FORM_QUESTIONS, null, { prefill: { apoio_decisao: "Falta <saber>" } }), "apoio_decisao");
    assert.match(filled, /<textarea [^>]*>Falta &lt;saber&gt;<\/textarea>/);
  });

  it("com erro, o campo aponta para o erro e para a ajuda", () => {
    const err = renderFormHtml("a@x.com", "S", FORM_QUESTIONS, null, { error: { message: "texto longo demais", questionId: "apoio_decisao" } });
    const efs = fieldsetOf(err, "apoio_decisao");
    assert.match(efs, /^<fieldset id="q-apoio_decisao">/);
    assert.ok(efs.includes(`<p class="erro" id="apoio_decisao-erro" role="alert">texto longo demais</p>`));
    assert.match(efs, /<textarea [^>]*aria-describedby="apoio_decisao-erro apoio_decisao-help"/);
  });

  it("pergunta aberta sem ajuda não ganha aria-describedby vazio; obrigatória mantém required", () => {
    const qs: FormQuestion[] = [{ id: "livre", label: "Livre", kind: "text", required: true } as FormQuestion];
    const h = renderFormHtml("a@x.com", "S", qs, null, { autosave: false });
    assert.ok(h.includes(`<legend><label for="livre"><span class="n">1</span>Livre</label></legend>`), h);
    const input = h.match(/<input id="livre"[^>]*>/)![0];
    assert.ok(!input.includes("aria-describedby"), input);
    assert.match(input, / required/);
  });

  it("toda pergunta numerada do formulário tem legend", () => {
    const legends = html.match(/<legend>(?:<label for="[^"]+">)?<span class="n">\d+<\/span>/g) ?? [];
    assert.equal(legends.length, numberedQuestions(FORM_QUESTIONS).length);
  });
});
