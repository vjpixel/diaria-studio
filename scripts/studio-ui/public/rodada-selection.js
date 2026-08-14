// rodada-selection.js (#5210) — lógica PURA de seleção/accordion do
// acompanhamento de rodada (rodada.js): decide quando uma entrada colapsa/
// expande e quando `fetchRoundsList()` pode auto-selecionar a rodada mais
// recente. Mesmo padrão de rodada-round-age.js (#3889) — nenhuma chamada a
// document/fetch aqui, testável com fixtures puras via node:test.
//
// Bug corrigido (#5210): `fetchRoundsList()` reauto-selecionava `rounds[0]`
// em TODA chamada — o guard era `!selected`, não "é a 1ª carga da página?".
// Um editor que colapsava a entrada de propósito (`toggleRound` seta
// `selected = null`) era revertido no refresh seguinte: o handler SSE do
// evento `plan` (disparado a cada escrita em `plan.json` — ou seja, A CADA
// unidade da própria rodada overnight/develop em curso) chamava
// `fetchRoundsList()`, que via `!selected` e re-selecionava/re-expandia
// `rounds[0]` — o clique de colapso parecia não ter feito nada.
//
// O fix separa duas decisões que antes compartilhavam o mesmo guard:
// (1) alternar seleção por clique explícito do editor (`decideToggle`) —
//     sempre respeitada, inclusive colapsar pra `null`, nunca revertida por
//     um refresh subsequente;
// (2) auto-seleção da rodada mais recente (`decideAutoSelect`) — só
//     permitida na 1ª carga da página, nunca em refresh subsequente (SSE ou
//     botão "Atualizar").

/**
 * Decide o novo `selected` a partir de um clique explícito numa entrada da
 * lista (`toggleRound` em rodada.js). Clicar na entrada já selecionada
 * colapsa (retorna `null` — accordion, só 1 expandida por vez); clicar em
 * qualquer OUTRA entrada substitui a seleção por ela, mesmo que uma entrada
 * diferente já estivesse expandida (colapsar a entrada N nunca expande a
 * entrada 0 por engano).
 */
export function decideToggle(selected, kind, sessionId) {
  if (selected && selected.kind === kind && selected.sessionId === sessionId) {
    return null;
  }
  return { kind, sessionId };
}

/**
 * Decide se `fetchRoundsList()` deve auto-selecionar a rodada mais recente
 * (`rounds[0]`). Só faz isso na 1ª carga da página (`isInitialLoad === true`)
 * — em qualquer chamada subsequente (refresh via SSE `plan` ou botão
 * "Atualizar"), `selected === null` significa que o editor colapsou de
 * propósito, e esse estado precisa sobreviver ao refresh (regressão central
 * da #5210).
 *
 * Retorna o novo `selected` a usar: `{kind, sessionId}` da mais recente
 * quando a auto-seleção se aplica, ou o `selected` atual inalterado
 * (incluindo `null`) quando não há motivo pra auto-selecionar.
 */
export function decideAutoSelect({ selected, rounds, isInitialLoad }) {
  if (selected) return selected;
  if (!isInitialLoad) return null;
  if (!Array.isArray(rounds) || rounds.length === 0) return null;
  return { kind: rounds[0].kind, sessionId: rounds[0].sessionId };
}
