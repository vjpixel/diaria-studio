/**
 * test/onboarding-form-persona2-12715.test.ts (#12715)
 *
 * Resultado parcial do formulário no Studio: marcação da persona 2 ("Quem já
 * paga para aprender") e ordem por potencial de compra de quem topou a
 * conversa. Trava:
 *
 *  1. `isPersona2`: os três critérios juntos (maior gasto declarado e não
 *     "nenhum"/"prefiro não dizer"; paga do bolso ou dividido com a empresa;
 *     não marcou "Nada disso").
 *  2. `spendBandRank`/`comparePurchasePotential`: persona 2 primeiro, depois
 *     a faixa do maior gasto, depois a do gasto mensal; sem informação fica
 *     abaixo da menor faixa conhecida; empate total mantém o mais recente
 *     primeiro.
 *  3. `buildFormPartialResults`: `conversa.pessoas` sai nessa ordem, com as
 *     duas faixas, e `persona2` conta todos os respondentes (não só quem topou).
 *  4. `conversaHtml`/`formSummaryHtml`: marcação, faixas e a contagem "N de total".
 *
 * Fixtures sintéticas (`@x.com`); nada lido de `data/`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildFormPartialResults,
  comparePurchasePotential,
  FORM_MAIOR_GASTO_NAO_DIZ,
  FORM_MAIOR_GASTO_NENHUM,
  isPersona2,
  spendBandRank,
} from "../scripts/lib/onboarding-form-partial-results.ts";
import {
  FORM_CONVERSA_SIM,
  FORM_MULTI_SEPARATOR,
  FORM_NADA_DISSO,
  FORM_PAGA_DO_BOLSO,
  FORM_QUESTIONS,
  FORM_VERSION,
  type FormResponse,
} from "../scripts/lib/onboarding-form-contract.ts";
import { conversaHtml, formSummaryHtml } from "../scripts/studio-ui/public/formulario-parcial.js";

function optionsOf(id: string): readonly string[] {
  const q = FORM_QUESTIONS.find((x) => x.id === id) as { options?: readonly string[] } | undefined;
  assert.ok(q?.options, `pergunta ${id} existe no contrato`);
  return q.options;
}

const MAIOR = optionsOf("maior_gasto");
const MENSAL = optionsOf("gasto_mensal");
const CURSO = optionsOf("produto_formato")[0]!;
const EMPRESA = "A empresa ou instituição onde trabalho ou estudo";

/** Respondente que se encaixa na persona 2; `over` troca um critério. */
function p2(over: Record<string, string> = {}): Record<string, string> {
  return {
    maior_gasto: "De R$ 301 a R$ 1.000",
    quem_paga: FORM_PAGA_DO_BOLSO[0],
    gasto_mensal: "De R$ 51 a R$ 150",
    produto_formato: CURSO,
    ...over,
  };
}

function resp(email: string, at: string, answers: Record<string, string>): FormResponse {
  return { email, submitted_at: at, answers, form_version: FORM_VERSION };
}

describe("#12715 as opções que a regra cita existem no contrato", () => {
  it("maior_gasto, quem_paga e produto_formato", () => {
    assert.ok(MAIOR.includes(FORM_MAIOR_GASTO_NENHUM));
    assert.ok(MAIOR.includes(FORM_MAIOR_GASTO_NAO_DIZ));
    for (const o of FORM_PAGA_DO_BOLSO) assert.ok(optionsOf("quem_paga").includes(o));
    assert.ok(optionsOf("quem_paga").includes(EMPRESA));
    assert.ok(optionsOf("produto_formato").includes(FORM_NADA_DISSO));
  });
});

describe("#12715 isPersona2", () => {
  it("os três critérios juntos: entra", () => {
    assert.equal(isPersona2(p2()), true);
    assert.equal(isPersona2(p2({ quem_paga: FORM_PAGA_DO_BOLSO[1] })), true, "dividido com a empresa conta");
    assert.equal(isPersona2(p2({ maior_gasto: "Até R$ 100" })), true, "menor faixa paga conta");
    assert.equal(isPersona2(p2({ gasto_mensal: "" })), true, "gasto mensal não é critério");
  });

  it("maior_gasto em branco, 'nenhum' ou 'prefiro não dizer': fora", () => {
    assert.equal(isPersona2(p2({ maior_gasto: "" })), false);
    assert.equal(isPersona2(p2({ maior_gasto: FORM_MAIOR_GASTO_NENHUM })), false);
    assert.equal(isPersona2(p2({ maior_gasto: FORM_MAIOR_GASTO_NAO_DIZ })), false);
    const { maior_gasto: _m, ...semMaior } = p2();
    assert.equal(isPersona2(semMaior), false);
  });

  it("quem paga é a empresa, ninguém ou em branco: fora", () => {
    assert.equal(isPersona2(p2({ quem_paga: EMPRESA })), false);
    assert.equal(isPersona2(p2({ quem_paga: "Ninguém: só uso versões gratuitas" })), false);
    assert.equal(isPersona2(p2({ quem_paga: "" })), false);
  });

  it("'Nada disso' em produto_formato: fora, mesmo junto de outra opção", () => {
    assert.equal(isPersona2(p2({ produto_formato: FORM_NADA_DISSO })), false);
    assert.equal(isPersona2(p2({ produto_formato: [CURSO, FORM_NADA_DISSO].join(FORM_MULTI_SEPARATOR) })), false);
    assert.equal(isPersona2(p2({ produto_formato: "" })), true, "em branco não é 'Nada disso'");
  });
});

describe("#12715 spendBandRank", () => {
  it("segue a ordem crescente das opções do contrato", () => {
    for (let i = 1; i < MENSAL.length; i++) assert.ok(spendBandRank("gasto_mensal", MENSAL[i]) > spendBandRank("gasto_mensal", MENSAL[i - 1]));
    assert.ok(spendBandRank("maior_gasto", "Mais de R$ 3.000") > spendBandRank("maior_gasto", "Até R$ 100"));
    assert.ok(spendBandRank("maior_gasto", "Até R$ 100") > spendBandRank("maior_gasto", FORM_MAIOR_GASTO_NENHUM));
  });

  it("sem informação fica abaixo de tudo, inclusive de 'Não paguei por nenhum'", () => {
    const nenhum = spendBandRank("maior_gasto", FORM_MAIOR_GASTO_NENHUM);
    for (const v of [null, undefined, "", "  ", FORM_MAIOR_GASTO_NAO_DIZ, "valor de versão antiga"]) {
      assert.equal(spendBandRank("maior_gasto", v), -1, String(v));
      assert.ok(spendBandRank("maior_gasto", v) < nenhum);
    }
    assert.equal(spendBandRank("gasto_mensal", null), -1);
  });
});

describe("#12715 comparePurchasePotential", () => {
  const base = { persona2: false, maior_gasto: null, gasto_mensal: null };

  it("persona 2 vem antes, mesmo com faixa menor", () => {
    const a = { persona2: true, maior_gasto: "Até R$ 100", gasto_mensal: null };
    const b = { persona2: false, maior_gasto: "Mais de R$ 3.000", gasto_mensal: "Mais de R$ 900" };
    assert.ok(comparePurchasePotential(a, b) < 0);
    assert.ok(comparePurchasePotential(b, a) > 0);
  });

  it("dentro do grupo, maior faixa de maior_gasto antes; gasto mensal só desempata", () => {
    const alto = { ...base, maior_gasto: "De R$ 1.001 a R$ 3.000", gasto_mensal: "Até R$ 50" };
    const baixo = { ...base, maior_gasto: "Até R$ 100", gasto_mensal: "Mais de R$ 900" };
    assert.ok(comparePurchasePotential(alto, baixo) < 0);
    const empMaisMensal = { ...base, maior_gasto: "Até R$ 100", gasto_mensal: "De R$ 151 a R$ 400" };
    assert.ok(comparePurchasePotential(empMaisMensal, { ...baixo, gasto_mensal: "Até R$ 50" }) < 0);
    assert.ok(comparePurchasePotential({ ...base, gasto_mensal: "Até R$ 50" }, base) < 0, "mensal declarado vence em branco");
  });

  it("empate total devolve 0", () => {
    assert.equal(comparePurchasePotential({ ...base, maior_gasto: "Até R$ 100" }, { ...base, maior_gasto: "Até R$ 100" }), 0);
    assert.equal(comparePurchasePotential(base, { ...base, maior_gasto: FORM_MAIOR_GASTO_NAO_DIZ }), 0);
  });
});

describe("#12715 buildFormPartialResults: ordem da conversa e contagem da persona 2", () => {
  const sim = { conversa: FORM_CONVERSA_SIM };
  const RESPONSES: FormResponse[] = [
    // Mais recente, mas fora da persona 2 (empresa paga): vai depois das persona 2.
    resp("empresa@x.com", "2026-11-10T12:00:00.000Z", { ...p2({ quem_paga: EMPRESA, maior_gasto: "Mais de R$ 3.000" }), gasto_mensal: "", ...sim }),
    // Persona 2, faixa baixa.
    resp("p2baixo@x.com", "2026-11-10T11:00:00.000Z", { ...p2({ maior_gasto: "Até R$ 100", gasto_mensal: "Mais de R$ 900" }), ...sim }),
    // Persona 2, faixa alta: primeiro da lista.
    resp("p2alto@x.com", "2026-11-09T10:00:00.000Z", { ...p2({ maior_gasto: "De R$ 1.001 a R$ 3.000" }), ...sim }),
    // Persona 2, mesma faixa de maior gasto do p2baixo e gasto mensal menor: vem depois dele, apesar de mais recente.
    resp("p2baixo-mensal@x.com", "2026-11-10T13:00:00.000Z", { ...p2({ maior_gasto: "Até R$ 100", gasto_mensal: "Até R$ 50" }), ...sim }),
    // Persona 1 (usa e nunca pagou para aprender), dois com o mesmo perfil: o mais recente antes.
    resp("p1-velho@x.com", "2026-11-09T08:00:00.000Z", { ...p2({ maior_gasto: FORM_MAIOR_GASTO_NENHUM }), ...sim }),
    resp("p1-novo@x.com", "2026-11-09T09:00:00.000Z", { ...p2({ maior_gasto: FORM_MAIOR_GASTO_NENHUM }), ...sim }),
    // Prefere não dizer: abaixo de "Não paguei por nenhum".
    resp("naodiz@x.com", "2026-11-10T14:00:00.000Z", { ...p2({ maior_gasto: FORM_MAIOR_GASTO_NAO_DIZ }), ...sim }),
    // Persona 2 que NÃO topou a conversa: conta no total da persona 2, fora da lista.
    resp("p2-sem-conversa@x.com", "2026-11-09T07:00:00.000Z", p2()),
    // Fora da persona 2 e sem conversa.
    resp("nada@x.com", "2026-11-09T06:00:00.000Z", p2({ produto_formato: FORM_NADA_DISSO })),
  ];
  const r = buildFormPartialResults(RESPONSES, { testEmails: [] });

  it("persona 2 primeiro, depois maior gasto, depois gasto mensal, depois mais recente", () => {
    assert.deepEqual(
      r.conversa.pessoas.map((p) => p.email),
      ["p2alto@x.com", "p2baixo@x.com", "p2baixo-mensal@x.com", "empresa@x.com", "p1-novo@x.com", "p1-velho@x.com", "naodiz@x.com"],
    );
    assert.deepEqual(
      r.conversa.pessoas.map((p) => p.persona2),
      [true, true, true, false, false, false, false],
    );
  });

  it("cada pessoa carrega as duas faixas, como respondidas (em branco = null)", () => {
    const empresa = r.conversa.pessoas.find((p) => p.email === "empresa@x.com")!;
    assert.equal(empresa.maior_gasto, "Mais de R$ 3.000");
    assert.equal(empresa.gasto_mensal, null);
    const alto = r.conversa.pessoas.find((p) => p.email === "p2alto@x.com")!;
    assert.equal(alto.maior_gasto, "De R$ 1.001 a R$ 3.000");
    assert.equal(alto.gasto_mensal, "De R$ 51 a R$ 150");
  });

  it("persona2 conta todos os respondentes, não só quem topou a conversa", () => {
    assert.equal(r.total, 9);
    assert.equal(r.persona2, 4);
    assert.equal(r.conversa.toparam, 7);
  });

  it("HTML: marcação persona 2, faixas e a explicação da ordem", () => {
    const html = conversaHtml(r.conversa);
    assert.equal((html.match(/>persona 2</g) ?? []).length, 3, "uma marcação por persona 2");
    assert.ok(html.includes("Maior gasto"));
    assert.ok(html.includes("Gasto mensal"));
    assert.ok(html.includes("De R$ 1.001 a R$ 3.000"));
    assert.match(html, /potencial de compra/);
    assert.ok(html.indexOf("p2alto@x.com") < html.indexOf("empresa@x.com"), "a página mantém a ordem do servidor");
  });

  it("HTML: resumo mostra persona 2 sobre o total", () => {
    const view = { ...r, available: true as const, geradoEm: "2026-11-10T15:00:00.000Z", storeLido: true };
    const html = formSummaryHtml(view);
    assert.match(html, /Persona 2/);
    assert.ok(html.includes("4 de 9"));
    assert.ok(!html.includes("@"), "resumo sem e-mail");
  });
});
