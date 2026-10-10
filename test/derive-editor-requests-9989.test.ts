/**
 * #9989 — numa seção de pool (LANÇAMENTOS, RADAR, USE MELHOR) com o MESMO
 * conjunto de itens, texto reescrito virava o tipo padrão da seção
 * (`link-swap` / `destaque-promote`), inflando esses sinais em
 * `collect-edition-signals.ts`. Agora vira `pool-text-edit` com
 * `change_kind` título/descrição. Reprodução da issue (HEAD 4e5890d85):
 *   lanc title edit:       [ 'lancamentos:link-swap:' ]
 *   radar title edit:      [ 'radar:link-swap:' ]
 *   use-melhor title edit: [ 'use-melhor:destaque-promote:' ]
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyNewsletterDiff, classifyPoolTextEdit } from "../scripts/derive-editor-requests.ts";
import { VALID_REQUEST_TYPES } from "../scripts/log-editor-request.ts";
import { REQUEST_TYPE_ARTIFACT_MAP } from "../scripts/collect-edition-signals.ts";

function item(title: string, url: string, desc: string): string {
  return [`**[${title}](${url})**  `, desc, ""].join("\n");
}
function section(header: string, items: string[]): string {
  return ["---", "", header, "", ...items, "---", ""].join("\n");
}

const URL_A = "https://querobolsa.com.br/revista/como-usar-ia";
const URL_B = "https://www.techtudo.com.br/guia/2026/10/mochila.ghtml";
const DESC_A = "Guia com usos de ChatGPT, Claude e Gemini em tarefas do dia a dia profissional. (10 min)";
const DESC_B = "Entenda como funciona a trend que está bombando nas redes sociais e crie a sua. (15 min)";
const A = item("Como usar IA para produtividade", URL_A, DESC_A);
const B = item("Ideias de mochila maluca infantil", URL_B, DESC_B);
const A_TITLE = item("IA no trabalho: guia prático", URL_A, DESC_A);
const A_DESC = item("Como usar IA para produtividade", URL_A, "Guia de usos de ChatGPT, Claude e Gemini no trabalho do dia a dia, com exemplos. (10 min)");

const kinds = (a: string, b: string) =>
  classifyNewsletterDiff(a, b).map((r) => `${r.target}:${r.request_type}:${(r.context as any)?.change_kind ?? ""}`);

const HEADERS: Array<[string, string]> = [
  ["**🚀 LANÇAMENTOS**", "lancamentos"],
  ["**📡 RADAR**", "radar"],
  ["**🛠️ USE MELHOR**", "use-melhor"],
];

describe("#9989 — edição de texto em item de pool vira pool-text-edit", () => {
  for (const [header, target] of HEADERS) {
    it(`${target}: título reescrito, mesma URL e descrição → pool-text-edit:titulo`, () => {
      assert.deepEqual(kinds(section(header, [A, B]), section(header, [A_TITLE, B])), [`${target}:pool-text-edit:titulo`]);
    });

    it(`${target}: descrição reescrita dentro de ±30% → pool-text-edit:descricao`, () => {
      assert.deepEqual(kinds(section(header, [A, B]), section(header, [A_DESC, B])), [`${target}:pool-text-edit:descricao`]);
    });
  }

  it("título e descrição reescritos → titulo-e-descricao", () => {
    const both = item("IA no trabalho: guia prático", URL_A, "Guia de usos de ChatGPT, Claude e Gemini no trabalho do dia a dia, com exemplos. (10 min)");
    assert.deepEqual(kinds(section("**📡 RADAR**", [A, B]), section("**📡 RADAR**", [both, B])), ["radar:pool-text-edit:titulo-e-descricao"]);
  });

  it("só a ordem dos itens mudou → section-order:reordenado", () => {
    assert.deepEqual(kinds(section("**📡 RADAR**", [A, B]), section("**📡 RADAR**", [B, A])), ["radar:section-order:reordenado"]);
  });

  it("descrição encurtada >30% segue length-cut (#9880 preservado)", () => {
    const longA = item("Como usar IA para produtividade", URL_A, "x".repeat(600));
    const shortA = item("Como usar IA para produtividade", URL_A, "x".repeat(100));
    assert.deepEqual(kinds(section("**🛠️ USE MELHOR**", [longA]), section("**🛠️ USE MELHOR**", [shortA])), ["use-melhor:length-cut:"]);
  });

  it("troca de item (conjunto muda) continua link-swap itens-trocados", () => {
    const D = item("Outro artigo", "https://outro.example/x", "Descrição. (5 min)");
    assert.deepEqual(kinds(section("**📡 RADAR**", [A, B]), section("**📡 RADAR**", [D, B])), ["radar:link-swap:itens-trocados"]);
  });

  it("classifyPoolTextEdit casa por URL, não por posição", () => {
    assert.equal(classifyPoolTextEdit([A, B].join("\n"), [B, A_TITLE].join("\n")), "titulo");
    assert.equal(classifyPoolTextEdit("**X**\n" + A, "**Y**\n" + A), "outro");
  });

  it("o tipo novo está na taxonomia e no mapa de artefatos", () => {
    assert.ok(VALID_REQUEST_TYPES.includes("pool-text-edit"));
    assert.match(REQUEST_TYPE_ARTIFACT_MAP["pool-text-edit"], /writer\.md/);
  });
});
