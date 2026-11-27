/**
 * #14350 — a lista de conversas do formulário (`onboarding-form-conversas.ts`)
 * mostra as duas perguntas de apoio da v4 (#14330): `apoio_independente` e o
 * texto livre de `apoio_decisao`, por pessoa, para preparar as entrevistas
 * com potenciais apoiadores. Resposta de versão anterior (sem os campos) sai
 * sem as linhas, e `--apoio` filtra por `apoio_independente`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FORM_CONVERSA_SIM, FORM_QUESTIONS, FORM_V4_ADDED_IDS, type FormResponse } from "../scripts/lib/onboarding-form-contract.ts";
import { conversaRows, parseConversaArgs, renderConversaTable } from "../scripts/onboarding-form-conversas.ts";

const R = (email: string, at: string, answers: Record<string, string>): FormResponse => ({ email, submitted_at: at, answers });

describe("#14350 lista de conversas: respostas de apoio (v4)", () => {
  const v4 = R("a@x.com", "2026-11-28T00:00:00Z", {
    conversa: FORM_CONVERSA_SIM,
    apoio_independente: "Sim",
    apoio_decisao: "Preço justo\ne saber para onde vai o dinheiro",
  });
  const v3 = R("b@x.com", "2026-11-20T00:00:00Z", { conversa: FORM_CONVERSA_SIM, situacao: "Estudante" });

  it("os ids que a lista lê são os da v4 do contrato", () => {
    const ids = new Set(FORM_QUESTIONS.map((f) => f.id));
    for (const id of ["apoio_independente", "apoio_decisao"]) {
      assert.ok(ids.has(id), `${id} existe no contrato`);
      assert.ok(FORM_V4_ADDED_IDS.includes(id), `${id} é pergunta da v4`);
    }
  });

  it("a linha da pessoa traz os dois campos; resposta antiga sai com eles vazios", () => {
    const rows = conversaRows([v4, v3]);
    assert.equal(rows[0].email, "a@x.com");
    assert.equal(rows[0].apoio_independente, "Sim");
    assert.equal(rows[0].apoio_decisao, "Preço justo\ne saber para onde vai o dinheiro");
    assert.equal(rows[1].apoio_independente, "");
    assert.equal(rows[1].apoio_decisao, "");
  });

  it("a tabela mostra 'já apoiou' e o texto livre numa linha; resposta antiga sem as linhas", () => {
    const table = renderConversaTable(conversaRows([v4, v3]));
    assert.match(table, /já apoiou: {4}Sim/);
    assert.match(table, /o que pesa: {3}Preço justo \/ e saber para onde vai o dinheiro/);
    const blockB = table.slice(table.indexOf("b@x.com"));
    assert.doesNotMatch(blockB, /já apoiou|o que pesa/);
  });

  it("--apoio filtra por apoio_independente, por trecho e sem acento", () => {
    assert.deepEqual(parseConversaArgs(["--apoio", "nao"]), { filters: { apoio_independente: "nao" }, json: false });
    const nao = R("c@x.com", "2026-11-27T00:00:00Z", { conversa: FORM_CONVERSA_SIM, apoio_independente: "Não" });
    assert.deepEqual(conversaRows([v4, v3, nao], { apoio_independente: "nao" }).map((r) => r.email), ["c@x.com"]);
    assert.deepEqual(conversaRows([v4, v3, nao], { apoio_independente: "SIM" }).map((r) => r.email), ["a@x.com"]);
  });
});
