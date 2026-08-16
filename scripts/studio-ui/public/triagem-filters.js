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
 * `selectValue` carrega o prefixo do grupo de origem (`issue:overnight`,
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

/**
 * #5212: qual tabela o filtro de Classificação (`<select
 * id="filter-dispatch-track">`) atualmente ativo afeta — `"issues"` (via
 * `filters.dispatch`), `"prs"` (via `filters.track`), ou `null` (nenhum dos
 * dois setado, opção "Todas"). Lê o mesmo par de campos MUTUAMENTE
 * EXCLUSIVOS que `applyDispatchTrackFilterValue` escreve — nunca os dois ao
 * mesmo tempo, então checar `dispatch` primeiro é suficiente.
 *
 * Existe pra affordance visual (#5212): o `<select>` consolidado (#5175)
 * perde o contexto de qual tabela é afetada quando fechado — este predicado
 * alimenta o chip no `<h2>` da tabela afetada e o aviso "não afeta esta
 * lista" na tabela oposta (`classificationScopeNotice` abaixo).
 */
export function classificationFilterScope(filters) {
  if (filters.dispatch) return "issues";
  if (filters.track) return "prs";
  return null;
}

/**
 * #5212: texto do aviso "Classificação (X) ativa — não afeta esta lista",
 * mostrado na tabela OPOSTA à afetada pelo filtro de Classificação
 * selecionado. `null` quando não há filtro de Classificação ativo, ou quando
 * `table` é justamente a tabela afetada (o aviso não se aplica a si mesma —
 * ali quem mostra o filtro ativo é o chip, não este aviso).
 */
export function classificationScopeNotice(filters, table) {
  const scope = classificationFilterScope(filters);
  if (!scope || scope === table) return null;
  const label = scope === "prs" ? "PRs" : "Issues";
  return `Classificação (${label}) ativa — não afeta esta lista.`;
}

/**
 * #5212: resume, em texto curto, qual filtro está ativo pra tabela `table`
 * ("issues" | "prs") — usado no estado-vazio "sem efeito" quando o total já
 * era 0 antes de qualquer filtro (`emptyStateMessage` abaixo). Prioriza o
 * filtro de Classificação (o mais provável de causar a confusão de escopo
 * que esta issue endereça, já que só afeta 1 das 2 tabelas); cai pra
 * prioridade e depois labels, que afetam as duas tabelas igualmente.
 */
export function activeFilterSummary(filters, table) {
  if (table === "issues" && filters.dispatch) return filters.dispatch;
  if (table === "prs" && filters.track) return filters.track;
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
