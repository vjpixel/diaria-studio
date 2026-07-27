/**
 * lint-social-md-no-xml-artifacts.test.ts (#4118 finding 2, #4077)
 *
 * Regressão: `03-social.md` terminando com tag(s) de tool-call crua(s)
 * (`</content>`, `</invoke>`, `</function_calls>`) deve disparar o check
 * `--check no-xml-artifacts`, o mesmo backstop GATE-BLOCKING que já existia
 * só para `02-reviewed.md` (via lint-newsletter-md.ts) — 03-social.md tinha
 * sua própria seção de lints gate-blocking no Stage 4 (§4c.2b) mas ficava
 * sem essa rede de segurança específica. Reusa `checkNoXmlArtifacts` de
 * `scripts/lib/lint-checks/no-xml-artifacts.ts` (mesma definição de padrão,
 * sem duplicar a regex).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkNoXmlArtifacts } from "../scripts/lint-social-md.ts";

const NORMAL_SOCIAL_MD = [
  "# LinkedIn",
  "",
  "## d1",
  "",
  "IA chega às fábricas brasileiras — automatização industrial tem impacto direto no emprego.",
  "",
  "Saiba mais em diar.ia.br",
  "",
].join("\n");

describe("lint-social-md.ts — checkNoXmlArtifacts (#4118 finding 2, #4077)", () => {
  it("acusa 03-social.md terminando em </content>\\n</invoke> (mesmo padrão real de 260727, agora no social)", () => {
    const md = `${NORMAL_SOCIAL_MD}\n</content>\n</invoke>`;
    const result = checkNoXmlArtifacts(md);
    assert.equal(result.ok, false);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0].artifact, /<\/content>/);
    assert.match(result.errors[0].artifact, /<\/invoke>/);
  });

  it("acusa uma tag solta (</function_calls>) no fim do arquivo social", () => {
    const result = checkNoXmlArtifacts(`${NORMAL_SOCIAL_MD}\n</function_calls>`);
    assert.equal(result.ok, false);
    assert.equal(result.errors.length, 1);
  });

  it("passa em 03-social.md normal, sem qualquer artefato", () => {
    const result = checkNoXmlArtifacts(NORMAL_SOCIAL_MD);
    assert.equal(result.ok, true);
    assert.equal(result.errors.length, 0);
  });

  it("NÃO acusa quando o texto menciona <content>/</content> no meio de uma frase, não no fim (mesmo cuidado de falso-positivo do #4077 original)", () => {
    const md = `${NORMAL_SOCIAL_MD}\nExemplo técnico: a API retorna um bloco <content>...</content> antes de fechar a resposta.\n`;
    const result = checkNoXmlArtifacts(md);
    assert.equal(result.ok, true);
  });
});
