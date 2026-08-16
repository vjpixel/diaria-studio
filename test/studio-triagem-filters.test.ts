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
  LOADING_MESSAGE,
  LOADING_COUNT,
  countLabel,
  classificationFilterScope,
  classificationScopeNotice,
  activeFilterSummary,
  emptyStateMessage,
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

describe("classificationFilterScope (#5212)", () => {
  it("valor do grupo `pr:` ⇒ afeta PRs", () => {
    assert.equal(classificationFilterScope({ ...none(), track: "overnight" }), "prs");
  });

  it("valor do grupo `issue:` ⇒ afeta Issues", () => {
    assert.equal(classificationFilterScope({ ...none(), dispatch: "elegivel" }), "issues");
  });

  it('"" (nenhum grupo, opção Todas) não afeta nenhuma tabela', () => {
    assert.equal(classificationFilterScope(none()), null);
  });
});

describe("classificationScopeNotice (#5212)", () => {
  it("filtro de PRs ativo → aviso aparece pra issues, não pra prs", () => {
    const filters = { ...none(), track: "overnight" };
    assert.match(classificationScopeNotice(filters, "issues") ?? "", /PRs.*não afeta esta lista/);
    assert.equal(classificationScopeNotice(filters, "prs"), null);
  });

  it("filtro de Issues ativo → aviso aparece pra prs, não pra issues", () => {
    const filters = { ...none(), dispatch: "bloqueada" };
    assert.match(classificationScopeNotice(filters, "prs") ?? "", /Issues.*não afeta esta lista/);
    assert.equal(classificationScopeNotice(filters, "issues"), null);
  });

  it("nenhum filtro de Classificação ativo → sem aviso em nenhuma tabela", () => {
    assert.equal(classificationScopeNotice(none(), "issues"), null);
    assert.equal(classificationScopeNotice(none(), "prs"), null);
  });
});

describe("activeFilterSummary (#5212)", () => {
  it("tabela prs com track setado → resume o valor do track", () => {
    assert.equal(activeFilterSummary({ ...none(), track: "overnight" }, "prs"), "overnight");
  });

  it("tabela issues com dispatch setado → resume o valor do dispatch", () => {
    assert.equal(activeFilterSummary({ ...none(), dispatch: "elegivel" }, "issues"), "elegivel");
  });

  it("track setado mas pedindo resumo da tabela issues → ignora track (fora de escopo), cai pro próximo filtro", () => {
    assert.equal(activeFilterSummary({ ...none(), track: "overnight" }, "issues"), null);
  });

  it("sem filtro de Classificação, cai pra prioridade", () => {
    assert.equal(activeFilterSummary({ ...none(), priority: "P0" }, "prs"), "P0");
  });

  it("sem Classificação nem prioridade, cai pras labels", () => {
    assert.equal(activeFilterSummary({ ...none(), labels: new Set(["bug", "P1"]) }, "issues"), "bug, P1");
  });

  it("nenhum filtro ativo → null", () => {
    assert.equal(activeFilterSummary(none(), "prs"), null);
  });
});

describe("emptyStateMessage (#5212)", () => {
  it("filteredCount > 0 → null (tabela tem linhas, nada a mostrar)", () => {
    const result = emptyStateMessage({ filteredCount: 3, totalCount: 3, filterActive: false, filterSummary: null, emptyLabel: "Nenhum PR aberto." });
    assert.equal(result, null);
  });

  it("sem filtro ativo e 0 total → emptyLabel genérico", () => {
    const result = emptyStateMessage({ filteredCount: 0, totalCount: 0, filterActive: false, filterSummary: null, emptyLabel: "Nenhum PR aberto." });
    assert.equal(result, "Nenhum PR aberto.");
  });

  it("filtro ativo, total > 0, filtrado zerou → '0 resultados para este filtro.'", () => {
    const result = emptyStateMessage({ filteredCount: 0, totalCount: 5, filterActive: true, filterSummary: "P0", emptyLabel: "Nenhum PR aberto." });
    assert.equal(result, "0 resultados para este filtro.");
  });

  it("(#5212 caso central) track setado e prs:[] (total 0) → diz que há filtro ativo, mensagem 'sem efeito'", () => {
    const result = emptyStateMessage({ filteredCount: 0, totalCount: 0, filterActive: true, filterSummary: "overnight", emptyLabel: "Nenhum PR aberto." });
    assert.equal(result, "Nenhum PR aberto (filtro `overnight` ativo, sem efeito).");
  });

  it("filtro ativo, total 0, mas sem filterSummary disponível (filtro fora de escopo) → cai pro emptyLabel genérico", () => {
    const result = emptyStateMessage({ filteredCount: 0, totalCount: 0, filterActive: true, filterSummary: null, emptyLabel: "Nenhuma issue aberta." });
    assert.equal(result, "Nenhuma issue aberta.");
  });
});

describe("emptyStateMessage — estado de carregamento (#5472)", () => {
  // `loading` precede TODOS os outros casos. Antes do 1º fetch voltar,
  // filteredCount/totalCount são 0 porque o dado não chegou — não porque não
  // existe. Sem isto, "buscando" e "vazio" (e, como o #5468 mostrou ao vivo,
  // "quebrado") são a mesma tela.
  const base = { filteredCount: 0, totalCount: 0, filterActive: false, filterSummary: null, emptyLabel: "Nenhuma issue aberta." };

  it("carregando vence o estado-vazio genérico", () => {
    assert.equal(emptyStateMessage({ ...base, loading: true }), LOADING_MESSAGE);
  });

  it("carregando vence '0 resultados para este filtro'", () => {
    assert.equal(
      emptyStateMessage({ ...base, totalCount: 12, filterActive: true, filterSummary: "overnight", loading: true }),
      LOADING_MESSAGE,
    );
  });

  it("carregando vence o aviso de 'filtro sem efeito'", () => {
    assert.equal(
      emptyStateMessage({ ...base, filterActive: true, filterSummary: "overnight", loading: true }),
      LOADING_MESSAGE,
    );
  });

  it("com resultados já renderizados, carregando não mostra mensagem nenhuma", () => {
    // Refresh manual sobre uma tabela já populada: as linhas antigas seguem
    // visíveis, então um "carregando…" sobreposto seria ruído.
    assert.equal(emptyStateMessage({ ...base, filteredCount: 3, loading: true }), null);
  });

  it("loading ausente/false preserva o comportamento anterior", () => {
    assert.equal(emptyStateMessage({ ...base }), "Nenhuma issue aberta.");
    assert.equal(emptyStateMessage({ ...base, loading: false }), "Nenhuma issue aberta.");
    assert.equal(
      emptyStateMessage({ ...base, totalCount: 12, filterActive: true, filterSummary: "x", loading: false }),
      "0 resultados para este filtro.",
    );
  });
});

describe("countLabel — placeholder só quando não há o que mostrar (#5478 review)", () => {
  it("carregando sem linhas → placeholder", () => {
    assert.equal(countLabel({ filteredCount: 0, loading: true }), LOADING_COUNT);
  });

  it("carregando COM linhas visíveis → número real, não placeholder", () => {
    // Refresh manual sobre dado existente: as linhas antigas continuam na
    // tela. Um cabeçalho "Issues abertas (…)" sobre 5 linhas concretas é o
    // contador dizendo "não sei quantas" logo acima das que ele sabe.
    assert.equal(countLabel({ filteredCount: 5, loading: true }), "5");
  });

  it("sem carregar → sempre o número, inclusive zero", () => {
    assert.equal(countLabel({ filteredCount: 0, loading: false }), "0");
    assert.equal(countLabel({ filteredCount: 7, loading: false }), "7");
  });

  it("mesma precedência de emptyStateMessage — as duas olham 'já tenho algo?' primeiro", () => {
    const args = { filteredCount: 5, loading: true };
    assert.equal(countLabel(args), "5");
    assert.equal(
      emptyStateMessage({ ...args, totalCount: 5, filterActive: false, filterSummary: null, emptyLabel: "x" }),
      null,
    );
  });
});
