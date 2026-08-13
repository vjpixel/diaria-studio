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
import {
  issuesFilterActive,
  prsFilterActive,
  applyDispatchTrackFilterValue,
} from "../scripts/studio-ui/public/triagem-filters.js";

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

describe("applyDispatchTrackFilterValue (#5175)", () => {
  it("escolher opção do grupo Issues seta dispatch e ZERA track (mesmo se track tinha valor antigo)", () => {
    const before = { ...none(), track: "overnight" };
    const after = applyDispatchTrackFilterValue(before, "issue:bloqueada");
    assert.equal(after.dispatch, "bloqueada");
    assert.equal(after.track, "", "nenhum filtro fantasma preso do grupo PRs");
  });

  it("escolher opção do grupo PRs seta track e ZERA dispatch (mesmo se dispatch tinha valor antigo)", () => {
    const before = { ...none(), dispatch: "elegivel" };
    const after = applyDispatchTrackFilterValue(before, "pr:develop");
    assert.equal(after.track, "develop");
    assert.equal(after.dispatch, "", "nenhum filtro fantasma preso do grupo Issues");
  });

  it("'Todas' (valor vazio) limpa os dois campos", () => {
    const before = { ...none(), dispatch: "elegivel", track: "overnight" };
    const after = applyDispatchTrackFilterValue(before, "");
    assert.equal(after.dispatch, "");
    assert.equal(after.track, "");
  });

  it("não muta o objeto `filters` original (pura)", () => {
    const before = { ...none(), track: "overnight" };
    applyDispatchTrackFilterValue(before, "issue:ambigua");
    assert.equal(before.track, "overnight", "argumento original não deve ser alterado");
  });

  it("preserva os demais campos de filters (priority, labels) intactos", () => {
    const before = { priority: "P0", dispatch: "", track: "", labels: new Set(["bug"]) };
    const after = applyDispatchTrackFilterValue(before, "issue:elegivel");
    assert.equal(after.priority, "P0");
    assert.deepEqual(after.labels, new Set(["bug"]));
  });

  it("issuesFilterActive/prsFilterActive continuam corretos depois de passar pelo select unificado", () => {
    // #5175: escolher 'bloqueada' (grupo Issues) deve filtrar a tabela de
    // issues e deixar a de PRs intacta — e vice-versa (comportamento de
    // antes, preservado com o controle único).
    const afterIssue = applyDispatchTrackFilterValue(none(), "issue:bloqueada");
    assert.equal(issuesFilterActive(afterIssue), true);
    assert.equal(prsFilterActive(afterIssue), false);

    const afterPr = applyDispatchTrackFilterValue(none(), "pr:other");
    assert.equal(prsFilterActive(afterPr), true);
    assert.equal(issuesFilterActive(afterPr), false);
  });
});
