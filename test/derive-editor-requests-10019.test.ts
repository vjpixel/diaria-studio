/**
 * #10019 — no USE MELHOR, uma diferença `outro` (só tracking/query da URL do
 * mesmo artigo, ou só a linha de cabeçalho) herdava o tipo padrão da seção,
 * `destaque-promote`. Isso virava recorrência falsa de `scorer-select.md` em
 * `collect-edition-signals.ts` (nada foi promovido). Agora o pedido sai como
 * `other`, fora da detecção de recorrência. RADAR segue `link-swap` (#10012).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyNewsletterDiff } from "../scripts/derive-editor-requests.ts";

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

const kinds = (a: string, b: string) =>
  classifyNewsletterDiff(a, b).map((r) => `${r.target}:${r.request_type}:${(r.context as any)?.change_kind ?? ""}`);

const UM = "**🛠️ USE MELHOR**";

describe("#10019 — USE MELHOR com diferença 'outro' não vira destaque-promote", () => {
  it("troca só de utm no mesmo artigo sai como other", () => {
    const out = kinds(section(UM, [A, B]), section(UM, [A_UTM, B]));
    assert.deepEqual(out, ["use-melhor:other:"]);
  });

  it("nenhum pedido do cenário é destaque-promote", () => {
    const reqs = classifyNewsletterDiff(section(UM, [A, B]), section(UM, [A_UTM, B]));
    assert.ok(reqs.every((r) => r.request_type !== "destaque-promote"));
  });

  it("edição real de título no USE MELHOR continua pool-text-edit", () => {
    assert.deepEqual(kinds(section(UM, [A, B]), section(UM, [A_TITLE, B])), ["use-melhor:pool-text-edit:titulo"]);
  });

  it("RADAR com troca só de utm continua link-swap (#10012 intacto)", () => {
    assert.deepEqual(kinds(section("**📡 RADAR**", [A, B]), section("**📡 RADAR**", [A_UTM, B])), ["radar:link-swap:"]);
  });
});
