// triagem-filters.js (#4809) — predicados PUROS de "há filtro ativo?" das duas
// tabelas do cockpit de triagem (`triagem.html`/`triagem.js`). Separado de
// propósito de `triagem.js`: nada aqui toca `document` — testável com fixtures
// puras, sem harness de DOM (mesmo padrão de `utms-sort.js`, #4463, e
// `revisao-guards.js`, #3668/#633).
//
// Por que existe: cada predicado precisa listar EXATAMENTE os mesmos filtros
// que o `.filter()` da sua tabela aplica. Quando divergem, a tabela fica vazia
// mas a mensagem de estado-vazio diz "Nenhum PR aberto." em vez de "0
// resultados para este filtro." — o editor lê isso como "não há PR", não como
// "meu filtro escondeu tudo". Foi o que aconteceu com `prioridade` na tabela de
// PRs: o filtro era aplicado (`renderPrsTable`) mas ficou de fora da checagem.

/** Filtros que a tabela de ISSUES aplica: prioridade, classificação, labels. @pure */
export function issuesFilterActive(filters) {
  return Boolean(filters.priority || filters.dispatch || filters.labels?.size > 0);
}

/** Filtros que a tabela de PRs aplica: prioridade, trilha, labels. @pure */
export function prsFilterActive(filters) {
  return Boolean(filters.priority || filters.track || filters.labels?.size > 0);
}

/**
 * #5175: aplica o valor do `<select id="filter-dispatch-track">` (1 único
 * controle, 2 `<optgroup>` — Issues/PRs — substituindo os 2 `<select>`
 * separados de antes) aos 2 campos de estado MUTUAMENTE EXCLUSIVOS
 * (`filters.dispatch`, da tabela de issues; `filters.track`, da tabela de
 * PRs). Pura — devolve um objeto NOVO (não muta `filters`), mesmo padrão de
 * `issuesFilterActive`/`prsFilterActive` acima, pra ser testável sem harness
 * de DOM.
 *
 * `selectValue` carrega o prefixo do grupo de origem (`issue:elegivel`,
 * `pr:overnight`) — o grupo decide qual dos 2 campos recebe o valor; o OUTRO
 * é SEMPRE zerado no mesmo update, nunca fica preso a um valor antigo de um
 * grupo diferente do recém-selecionado (o risco que colapsar os 2 controles
 * num só introduz, ver docstring do arquivo). `""` (opção "Todas") não casa
 * nenhum grupo conhecido — zera os dois.
 */
export function applyDispatchTrackFilterValue(filters, selectValue) {
  const [group, value] = String(selectValue).split(":");
  return {
    ...filters,
    dispatch: group === "issue" ? value : "",
    track: group === "pr" ? value : "",
  };
}
