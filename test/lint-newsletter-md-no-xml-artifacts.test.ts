/**
 * lint-newsletter-md-no-xml-artifacts.test.ts (#4077)
 *
 * Regressão: `02-reviewed.md` terminando com tag(s) de tool-call crua(s)
 * (`</content>`, `</invoke>`, `</function_calls>`) deve disparar o check
 * `--check no-xml-artifacts` (GATE-BLOCKING).
 *
 * Caso real (edição 260727): `02-reviewed.md` apareceu com 21 bytes de
 * `</content>\n</invoke>` grudados após o último parágrafo do PARA ENCERRAR
 * — texto que teria ido pro e-mail publicado. Nenhum dos 15 invariantes do
 * Stage 4 nem dos 10 lints de newsletter pré-existentes pegou; o gate ficou
 * verde com a corrupção presente.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkNoXmlArtifacts } from "../scripts/lint-newsletter-md.ts";
import {
  detectTrailingToolCallArtifact,
  stripTrailingToolCallArtifact,
} from "../scripts/lib/lint-checks/no-xml-artifacts.ts";

const NORMAL_MD = [
  "**DESTAQUE 1 | LANÇAMENTO**",
  "",
  "**[IA chega às fábricas brasileiras](https://example.com/1)**",
  "",
  "Corpo do destaque com contexto suficiente.",
  "",
  "Por que isso importa: automatização industrial tem impacto direto no emprego.",
  "",
].join("\n");

describe("checkNoXmlArtifacts — CENÁRIO REAL #4077", () => {
  it("acusa 02-reviewed.md terminando em </content>\\n</invoke> (caso real 260727)", () => {
    const md =
      "Agora que chegou ao final da edição, siga a diar.ia.br no Instagram para não perder as 3 principais notícias.\n</content>\n</invoke>";
    const result = checkNoXmlArtifacts(md);
    assert.equal(result.ok, false);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0].artifact, /<\/content>/);
    assert.match(result.errors[0].artifact, /<\/invoke>/);
  });

  it("acusa uma tag solta (</invoke>) no fim do arquivo", () => {
    const result = checkNoXmlArtifacts(`${NORMAL_MD}\n</invoke>`);
    assert.equal(result.ok, false);
    assert.equal(result.errors.length, 1);
  });

  it("acusa </function_calls> no fim do arquivo", () => {
    const result = checkNoXmlArtifacts(`${NORMAL_MD}\n</function_calls>`);
    assert.equal(result.ok, false);
  });

  it("passa em markdown editorial normal, sem qualquer artefato", () => {
    const result = checkNoXmlArtifacts(NORMAL_MD);
    assert.equal(result.ok, true);
    assert.equal(result.errors.length, 0);
  });
});

describe("checkNoXmlArtifacts — falso-positivo: tags no MEIO do texto (#4077, cuidado explícito na issue)", () => {
  it("NÃO acusa quando o texto menciona <content>/</content> no meio de uma frase, não no fim", () => {
    const md =
      `${NORMAL_MD}\nA API retorna um bloco <content>...</content> antes de fechar a resposta, e o editor revisou esse trecho como exemplo técnico legítimo.\n`;
    const result = checkNoXmlArtifacts(md);
    assert.equal(result.ok, true);
  });

  it("NÃO acusa comparações genéricas com < e > que não formam as tags vigiadas", () => {
    const md = `${NORMAL_MD}\nO modelo novo é 2x mais rápido: X < Y e Y > Z em todos os benchmarks.\n`;
    const result = checkNoXmlArtifacts(md);
    assert.equal(result.ok, true);
  });

  it("NÃO acusa uma tag HTML legítima e comum no fim do arquivo (ex: </p>, não vigiada)", () => {
    const md = `${NORMAL_MD}\n<p>Parágrafo final com marcação inline.</p>`;
    const result = checkNoXmlArtifacts(md);
    assert.equal(result.ok, true);
  });
});

describe("detectTrailingToolCallArtifact / stripTrailingToolCallArtifact (#4077)", () => {
  it("detecta e retorna o artefato exato, sem alterar o conteúdo original", () => {
    const md = `${NORMAL_MD}\n</content>\n</invoke>`;
    const found = detectTrailingToolCallArtifact(md);
    assert.ok(found);
    assert.match(found!.artifact, /<\/content>/);
    assert.match(found!.artifact, /<\/invoke>/);
  });

  it("retorna null quando não há artefato", () => {
    assert.equal(detectTrailingToolCallArtifact(NORMAL_MD), null);
  });

  it("strippa o artefato preservando o conteúdo editorial legítimo antes dele", () => {
    const md = `${NORMAL_MD}\n</content>\n</invoke>`;
    const { content, stripped } = stripTrailingToolCallArtifact(md);
    assert.ok(stripped);
    // O texto editorial em si (sem o whitespace de separação consumido junto
    // com o artefato) permanece intacto — só a tag crua + o espaço em branco
    // que a separa do texto são removidos, nunca conteúdo de verdade.
    assert.equal(content, NORMAL_MD.replace(/\s+$/, ""));
    assert.match(content, /Por que isso importa: automatização industrial tem impacto direto no emprego\./);
    assert.doesNotMatch(content, /<\/content>|<\/invoke>/);
  });

  it("idempotente: conteúdo sem artefato volta inalterado, stripped:null", () => {
    const { content, stripped } = stripTrailingToolCallArtifact(NORMAL_MD);
    assert.equal(content, NORMAL_MD);
    assert.equal(stripped, null);
  });

  it("strippar 2x seguidas não remove nada a mais na 2ª vez", () => {
    const md = `${NORMAL_MD}\n</content>\n</invoke>`;
    const first = stripTrailingToolCallArtifact(md);
    const second = stripTrailingToolCallArtifact(first.content);
    assert.equal(second.stripped, null);
    assert.equal(second.content, first.content);
  });
});
