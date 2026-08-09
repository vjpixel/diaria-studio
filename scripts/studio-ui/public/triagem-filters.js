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
