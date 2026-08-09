/**
 * test/studio-triagem-filters.test.ts (#4809) — cobertura dos predicados PUROS
 * de "há filtro ativo?" do cockpit de triagem
 * (`scripts/studio-ui/public/triagem-filters.js`). Mesmo padrão de
 * `test/studio-utms-sort-4463.test.ts` (#4463): a lógica testável foi separada
 * de `triagem.js` justamente porque a página em si roda no browser sem harness
 * de DOM neste projeto.
 *
 * Regressão travada aqui (#633 — bugfix exige teste): `prsFilterActive`
 * ignorava `filters.priority`, embora `renderPrsTable` APLIQUE o filtro de
 * prioridade. Com uma prioridade selecionada que zera os PRs, a tabela mostrava
 * "Nenhum PR aberto." em vez de "0 resultados para este filtro." — o editor lia
 * "não há PR" quando na verdade o próprio filtro tinha escondido tudo.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { issuesFilterActive, prsFilterActive } from "../scripts/studio-ui/public/triagem-filters.js";

const none = () => ({ priority: "", track: "", dispatch: "", labels: new Set<string>() });

describe("triagem-filters", () => {
  it("nenhum filtro selecionado → inativo nas duas tabelas", () => {
    assert.equal(issuesFilterActive(none()), false);
    assert.equal(prsFilterActive(none()), false);
  });

  it("#4809 (regressão): prioridade conta como filtro ativo na tabela de PRs", () => {
    // `renderPrsTable` filtra por prioridade — o predicado precisa concordar,
    // senão o estado-vazio mente dizendo "Nenhum PR aberto.".
    assert.equal(prsFilterActive({ ...none(), priority: "P1" }), true);
  });

  it("trilha ativa PRs mas não issues; classificação ativa issues mas não PRs", () => {
    assert.equal(prsFilterActive({ ...none(), track: "overnight" }), true);
    assert.equal(issuesFilterActive({ ...none(), track: "overnight" }), false);
    assert.equal(issuesFilterActive({ ...none(), dispatch: "elegivel" }), true);
    assert.equal(prsFilterActive({ ...none(), dispatch: "elegivel" }), false);
  });

  it("prioridade e labels contam nas duas tabelas", () => {
    assert.equal(issuesFilterActive({ ...none(), priority: "P0" }), true);
    assert.equal(issuesFilterActive({ ...none(), labels: new Set(["bug"]) }), true);
    assert.equal(prsFilterActive({ ...none(), labels: new Set(["bug"]) }), true);
  });

  it("labels vazio (Set sem itens) não conta como filtro ativo", () => {
    assert.equal(issuesFilterActive({ ...none(), labels: new Set() }), false);
    assert.equal(prsFilterActive({ ...none(), labels: new Set() }), false);
  });
});
