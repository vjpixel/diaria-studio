/**
 * #10012 — `classifyPoolTextEdit` devolve `"outro"` quando a diferença numa
 * seção de pool está só no tracking/query da URL do MESMO artigo ou numa
 * linha fora dos itens (cabeçalho). Isso não é edição de texto de item: o
 * pedido mantém o tipo padrão da seção (`link-swap` em RADAR/LANÇAMENTOS,
 * `destaque-promote` em USE MELHOR) em vez de virar `pool-text-edit` e contar
 * como recorrência do `writer.md` que não houve. Os casos de título/descrição
 * do #9989 continuam `pool-text-edit`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyNewsletterDiff, classifyPoolTextEdit } from "../scripts/derive-editor-requests.ts";

function item(title: string, url: string, desc: string): string {
  return [`**[${title}](${url})**  `, desc, ""].join("\n");
}
function section(header: string, items: string[]): string {
  return ["---", "", header, "", ...items, "---", ""].join("\n");
}

const URL_A = "https://querobolsa.com.br/revista/como-usar-ia";
const URL_A_UTM = "https://querobolsa.com.br/revista/como-usar-ia?utm_source=diaria&utm_medium=email";
const URL_B = "https://www.techtudo.com.br/guia/2026/10/mochila.ghtml";
const DESC_A = "Guia com usos de ChatGPT, Claude e Gemini em tarefas do dia a dia profissional. (10 min)";
const DESC_B = "Entenda como funciona a trend que está bombando nas redes sociais e crie a sua. (15 min)";
const A = item("Como usar IA para produtividade", URL_A, DESC_A);
const A_UTM = item("Como usar IA para produtividade", URL_A_UTM, DESC_A);
const B = item("Ideias de mochila maluca infantil", URL_B, DESC_B);
const A_TITLE = item("IA no trabalho: guia prático", URL_A, DESC_A);
const NEW_DESC = "Guia de usos de ChatGPT, Claude e Gemini no trabalho do dia a dia, com exemplos. (10 min)";
const A_DESC = item("Como usar IA para produtividade", URL_A, NEW_DESC);
const A_BOTH = item("IA no trabalho: guia prático", URL_A, NEW_DESC);

const kinds = (a: string, b: string) =>
  classifyNewsletterDiff(a, b).map((r) => `${r.target}:${r.request_type}:${(r.context as any)?.change_kind ?? ""}`);

const RADAR = "**📡 RADAR**";

describe("#10012 — pool com diferença 'outro' mantém o tipo padrão da seção", () => {
  it("pré-condição: troca só de utm no mesmo artigo é 'outro' para classifyPoolTextEdit", () => {
    assert.equal(classifyPoolTextEdit([A, B].join("\n"), [A_UTM, B].join("\n")), "outro");
  });

  it("RADAR: troca só de utm continua link-swap (nunca pool-text-edit)", () => {
    assert.deepEqual(kinds(section(RADAR, [A, B]), section(RADAR, [A_UTM, B])), ["radar:link-swap:"]);
  });

  it("os 3 casos de texto do #9989 continuam pool-text-edit", () => {
    assert.deepEqual(kinds(section(RADAR, [A, B]), section(RADAR, [A_TITLE, B])), ["radar:pool-text-edit:titulo"]);
    assert.deepEqual(kinds(section(RADAR, [A, B]), section(RADAR, [A_DESC, B])), ["radar:pool-text-edit:descricao"]);
    assert.deepEqual(kinds(section(RADAR, [A, B]), section(RADAR, [A_BOTH, B])), ["radar:pool-text-edit:titulo-e-descricao"]);
  });
});
