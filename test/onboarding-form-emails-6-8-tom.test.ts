// E-mails 6 a 8 do formulário (#10605): texto aprovado pelo editor em
// 09/11/2026 no tom dos outros e-mails do formulário. Trava a regressão para
// o rascunho do overnight, que abria com "Pixel aqui" e dizia "uns dois minutos".
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { formAnnualContentGate, formResultsContentGate, parseFollowupSnippet } from "../scripts/lib/onboarding-followup.ts";
import { resolveFormResults } from "../scripts/lib/onboarding-form-contract.ts";

const DIR = join(import.meta.dirname, "..", "context", "templates", "onboarding-followup");
const FILES = ["formulario-anual.md", "formulario-anual-lembrete.md", "formulario-resultados.md"];

function parts(file: string): { head: string; body: string } {
  const raw = readFileSync(join(DIR, file), "utf8");
  const end = raw.indexOf("-->");
  assert.ok(end > 0, `${file}: sem bloco de comentário`);
  return { head: raw.slice(0, end), body: raw.slice(end + 3).trim() };
}

for (const file of FILES) {
  test(`${file}: abre com "Olá! Tudo bem?" e segue o tom aprovado`, () => {
    const { head, body } = parts(file);
    assert.ok(body.startsWith("<p>Olá! Tudo bem?</p>"), `${file}: corpo não abre com a saudação`);
    assert.doesNotMatch(body, /Pixel aqui|Pixel de novo|Eu sou o Pixel|Sou o Pixel/i);
    assert.doesNotMatch(body + head, /dois minutos/i);
    assert.doesNotMatch(body, /→|←/);
    assert.match(body, /Pixel<\/p>\s*$/);
    // O marcador continua na fonte versionada: o envio só destrava em data/snippets.
    assert.match(head, /ONBOARDING-CORPO-PENDENTE/);
  });
}

test("os três passam pelo parser real e destravam nos gates sem o marcador", () => {
  const load = (file: string) => {
    const raw = readFileSync(join(DIR, file), "utf8");
    const snip = parseFollowupSnippet(raw.replace(/^.*ONBOARDING-CORPO-PENDENTE.*\n/m, ""));
    assert.ok(snip, `${file}: parser devolveu null`);
    assert.ok(snip.assunto, `${file}: sem assunto`);
    assert.ok(snip.previewText, `${file}: sem preview_text`);
    assert.doesNotMatch(snip.body, /\*\*|^#|^- /m);
    return snip;
  };
  const anual = { form_anual: load("formulario-anual.md"), form_anual_lembrete: load("formulario-anual-lembrete.md") };
  assert.deepEqual(formAnnualContentGate(anual), { blocked: false });
  const results = resolveFormResults("https://example.com/resultados", "2026-11-09T12:00:00.000Z");
  assert.ok(results, "resolveFormResults devolveu null para valores válidos");
  assert.deepEqual(formResultsContentGate({ form_resultados: load("formulario-resultados.md") }, { results }), { blocked: false });
});

test("formulario-resultados.md: sem a frase que explicava o mecanismo do link", () => {
  const { body } = parts("formulario-resultados.md");
  assert.doesNotMatch(body, /não aparece no site/);
  assert.match(body, /\{\{RESULTADOS_URL\}\}/);
  assert.doesNotMatch(body, /\{\{FORM_URL\}\}/);
});

test("formulario-anual*.md: mantêm o link do formulário e a data da resposta", () => {
  for (const file of ["formulario-anual.md", "formulario-anual-lembrete.md"]) {
    const { body } = parts(file);
    assert.match(body, /\{\{FORM_URL\}\}/);
    assert.match(body, /\{\{RESPONDEU_EM\}\}/);
  }
});
