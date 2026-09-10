/**
 * test/meta-leads-redact-name-7897.test.ts (#7897)
 *
 * `redactPii` cobria e-mail e telefone via regex, mas nome não tem formato
 * reconhecível por regex — se o Kit ecoasse o nome do lead num corpo de
 * erro, ele passaria sem redação pro log (`head_sampling_rate = 1`, 100%
 * retido). Cobre o parâmetro `knownNames` adicionado para fechar essa
 * lacuna, e confirma que `createKitSubscriberFromLead` passa `contact.name`
 * nos dois pontos onde o corpo de resposta de terceiro é logado.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { redactPii } from "../workers/meta-leads/src/redact.ts";
import { createKitSubscriberFromLead } from "../workers/meta-leads/src/kit.ts";

describe("redactPii — knownNames (#7897)", () => {
  it("redige e-mail e telefone sem knownNames (comportamento pré-existente)", () => {
    const out = redactPii("email: 'lead@example.com' is invalid, phone 11987654321 too");
    assert.equal(out.includes("lead@example.com"), false);
    assert.equal(out.includes("11987654321"), false);
    assert.match(out, /\[email redigido\]/);
    assert.match(out, /\[telefone redigido\]/);
  });

  it("redige nome conhecido quando passado em knownNames", () => {
    const out = redactPii("field 'name': 'Maria da Silva' is invalid", ["Maria da Silva"]);
    assert.equal(out.includes("Maria da Silva"), false);
    assert.match(out, /\[nome redigido\]/);
  });

  it("é case-insensitive e ignora nomes vazios/whitespace", () => {
    const out = redactPii("erro: joão pereira não permitido", ["  João Pereira  ", "", "   "]);
    assert.equal(out.includes("joão pereira"), false);
    assert.match(out, /\[nome redigido\]/);
  });

  it("escapa metacaracteres de regex no nome (nunca lança, nunca casa demais)", () => {
    const out = redactPii("nome inválido: 'A+B (C)' recusado", ["A+B (C)"]);
    assert.equal(out.includes("A+B (C)"), false);
    assert.match(out, /\[nome redigido\]/);
  });

  it("sem knownNames continua funcionando (compat — parâmetro é opcional)", () => {
    const out = redactPii("sem PII aqui");
    assert.equal(out, "sem PII aqui");
  });
});

describe("createKitSubscriberFromLead — propaga contact.name pro redactPii (#7897)", () => {
  it("redige o nome do lead ecoado no corpo de erro do Kit", async () => {
    const fetchImpl = (async () =>
      new Response("field 'first_name': 'Fulano de Tal' rejected by validator", {
        status: 422,
      })) as unknown as typeof fetch;

    const result = await createKitSubscriberFromLead(
      { KIT_API_KEY: "key" },
      { email: "lead@example.com", name: "Fulano de Tal" },
      { source: "", medium: "", campaign: "", referringSite: "" },
      fetchImpl,
    );

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason.includes("Fulano de Tal"), false);
    assert.match(result.reason, /\[nome redigido\]/);
  });

  it("redige o nome do lead ecoado numa exceção de fetch", async () => {
    const fetchImpl = (async () => {
      throw new Error("network error for Fulano de Tal");
    }) as unknown as typeof fetch;

    const result = await createKitSubscriberFromLead(
      { KIT_API_KEY: "key" },
      { email: "lead@example.com", name: "Fulano de Tal" },
      { source: "", medium: "", campaign: "", referringSite: "" },
      fetchImpl,
    );

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason.includes("Fulano de Tal"), false);
    assert.match(result.reason, /\[nome redigido\]/);
  });
});
