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

/** Texto do estado de carregamento, compartilhado pelas duas tabelas.
 * Constante exportada (em vez de literal solto) pra que o teste trave o
 * contrato sem repetir a string. */
export const LOADING_MESSAGE = "carregando…";

/** Placeholder do contador enquanto o fetch não voltou. Não é `0`: `0` é uma
 * AFIRMAÇÃO ("não há nada"), e antes do dado chegar isso é desconhecido. */
export const LOADING_COUNT = "…";

/**
 * Texto do contador de uma tabela. Pura.
 *
 * O placeholder só aparece quando **não há linha nenhuma pra mostrar**. Com
 * linhas já renderizadas (refresh manual sobre dado existente), o contador
 * mantém o número real: dizer "…" sobre uma tabela que exibe 5 linhas concretas
 * é um cabeçalho afirmando "não sei quantas" logo acima das que ele sabe.
 *
 * Mesma precedência de `emptyStateMessage` — as duas respondem à pergunta "já
 * tenho algo a mostrar?" antes de considerar o carregamento.
 */
export function countLabel({ filteredCount, loading }) {
  return loading && filteredCount === 0 ? LOADING_COUNT : String(filteredCount);
}

/** Filtros que a tabela de ISSUES aplica: prioridade, classificação, labels. @pure */
export function issuesFilterActive(filters) {
  return Boolean(filters.priority || filters.dispatch || filters.labels?.size > 0);
}

/** Filtros que a tabela de PRs aplica: prioridade, labels. @pure */
export function prsFilterActive(filters) {
  return Boolean(filters.priority || filters.labels?.size > 0);
}

/**
 * #5175: aplica o valor do `<select id="filter-dispatch-track">` (as opções
 * carregam o prefixo `issue:`, único grupo restante desde que o grupo "PRs"
 * — filtro por trilha de PR — foi removido) a `filters.dispatch`. Pura —
 * devolve um objeto NOVO (não muta `filters`), mesmo padrão de
 * `issuesFilterActive`/`prsFilterActive` acima, pra ser testável sem harness
 * de DOM. `""` (opção "Todas") zera o campo.
 */
export function applyDispatchTrackFilterValue(filters, selectValue) {
  const [group, value] = String(selectValue).split(":");
  return {
    ...filters,
    dispatch: group === "issue" ? value : "",
  };
}

/**
 * #5212: se o filtro de Classificação (`<select id="filter-dispatch-track">`)
 * está ativo — sempre afeta só a tabela de issues (via `filters.dispatch`),
 * já que o filtro por trilha de PR foi removido. `null` quando não há
 * filtro ativo (opção "Todas").
 *
 * Existe pra affordance visual (#5212): alimenta o chip no `<h2>` da tabela
 * de issues e o aviso "não afeta esta lista" na tabela de PRs
 * (`classificationScopeNotice` abaixo).
 */
export function classificationFilterScope(filters) {
  return filters.dispatch ? "issues" : null;
}

/**
 * #5212: texto do aviso "Classificação (Issues) ativa — não afeta esta
 * lista", mostrado na tabela de PRs quando o filtro de Classificação está
 * ativo (ele só afeta a tabela de issues). `null` quando não há filtro
 * ativo, ou quando `table` é a própria tabela de issues (ali quem mostra o
 * filtro ativo é o chip, não este aviso).
 */
export function classificationScopeNotice(filters, table) {
  const scope = classificationFilterScope(filters);
  if (!scope || scope === table) return null;
  return "Classificação (Issues) ativa — não afeta esta lista.";
}

/**
 * #5212: resume, em texto curto, qual filtro está ativo pra tabela `table`
 * ("issues" | "prs") — usado no estado-vazio "sem efeito" quando o total já
 * era 0 antes de qualquer filtro (`emptyStateMessage` abaixo). Prioriza o
 * filtro de Classificação (só afeta a tabela de issues); cai pra prioridade
 * e depois labels, que afetam as duas tabelas igualmente.
 */
export function activeFilterSummary(filters, table) {
  if (table === "issues" && filters.dispatch) return filters.dispatch;
  if (filters.priority) return filters.priority;
  if (filters.labels && filters.labels.size > 0) return [...filters.labels].join(", ");
  return null;
}

/**
 * #5212: mensagem de estado-vazio de uma tabela filtrável, com 3 casos (a
 * versão anterior só tinha 2 — ver `updateEmptyState` em triagem.js/rodada.js):
 * (a) sem filtro ativo → `emptyLabel` genérico ("Nenhum PR aberto.");
 * (b) filtro ativo E havia registros ANTES do filtro (`totalCount > 0`) mas a
 *     lista filtrada zerou → "0 resultados para este filtro." (comportamento
 *     já existente, preservado);
 * (c) filtro ativo mas o total JÁ era 0 antes de qualquer filtro
 *     (`totalCount === 0`) → variante que deixa claro que o filtro não é a
 *     causa da lista vazia (nem faz qualquer diferença aqui) — ex: "Nenhum PR
 *     aberto (filtro `overnight` ativo, sem efeito)." Sem isso, um filtro de
 *     Classificação (issues) ativo junto de uma tabela de PRs genuinamente
 *     vazia lia como "o filtro escondeu tudo", quando na verdade não havia
 *     nada pra esconder.
 */
export function emptyStateMessage({ filteredCount, totalCount, filterActive, filterSummary, emptyLabel, loading }) {
  if (filteredCount > 0) return null;
  // `loading` vence os demais casos de ZERO RESULTADO (#5472) — não vence o
  // `filteredCount > 0` acima, de propósito: se já há linhas na tela, elas
  // continuam valendo e uma mensagem sobreposta seria ruído. Antes do 1º fetch voltar,
  // `filteredCount`/`totalCount` são 0 porque o dado ainda não chegou — não
  // porque não existe. Dizer "Nenhuma issue aberta." ali é afirmar como fato
  // algo que ainda não se sabe, e foi exatamente o que fez a página quebrada
  // do #5468 parecer uma página vazia legítima: sem estado de carregamento,
  // "buscando" e "quebrado" são pixel a pixel a mesma tela.
  if (loading) return LOADING_MESSAGE;
  if (!filterActive) return emptyLabel;
  if (totalCount === 0) {
    if (!filterSummary) return emptyLabel;
    const base = emptyLabel.replace(/\.\s*$/, "");
    return `${base} (filtro \`${filterSummary}\` ativo, sem efeito).`;
  }
  return "0 resultados para este filtro.";
}
