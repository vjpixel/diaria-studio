// chat-badge.js (#3888) — lógica PURA do badge GLOBAL de "algo pendente",
// sempre visível no header do chat drawer (`chat-drawer.js`) em TODAS as 8
// páginas do Studio (index/edicao/triagem/apoios/revisao/rodada/relatorios/
// integracoes — todas injetam `<script src="/chat-drawer.js">`).
//
// Achado #3888: `studio-state.ts` expõe DOIS campos de "coisa pendente" —
// `gatesPending` (gates REAIS do pipeline: Stage 4 revisão / Stage 6
// agendamento, `Array<{edition,stage}>`, um por edição) e
// `chatPermissionsPending` (perguntas/permissões da sessão de chat,
// `PendingPermissionSummary[]`). O badge do drawer, antes deste fix, só lia
// `chatPermissionsPending` — uma edição com gate 4/6 pendente mas sem
// pergunta aberta NESTA sessão de chat (ex: a sessão que rodou o stage já
// terminou, ou está rodando no terminal, não no chat desta página) ficava
// SEM NENHUM SINAL em 6 das 8 telas (só "/" e o cockpit "/edicao/:aammdd"
// resolvem isso por conta própria — "/" via `pickCurrentEdition` priorizando
// gatesPending, o cockpit via o banner do #3870).
//
// Extraído como módulo PURO (sem tocar `document`/`fetch`) pelo mesmo motivo
// de `gate-chat-bridge.js`/`chat-hydration.js` (#3617/#3870): este projeto
// não tem harness de DOM (sem jsdom/happy-dom, ver
// `test/studio-edicao-page.test.ts`) — `chat-drawer.js` só importa e liga ao
// DOM real, nenhuma lógica de decisão mora lá.
//
// Nota de escopo (#3888): o formato de `gatesPending` aqui é o GLOBAL
// (`state.gatesPending`, `Array<{edition,stage}>`, de `studio-state.ts`) —
// DIFERENTE do formato usado por `gate-chat-bridge.js`
// (`detail.gatesPending`, `number[]`, escopado a UMA edição já carregada pelo
// cockpit). Os dois módulos coexistem de propósito: `gate-chat-bridge.js`
// decide a ponte DENTRO do cockpit de uma edição já aberta; este módulo
// decide o sinal GLOBAL (contagem + ação de clique) que precisa funcionar
// em qualquer página, sem saber qual edição está sendo olhada.

/**
 * Contagem total pro badge global: gates de pipeline pendentes (Stage 4/6,
 * qualquer edição) + perguntas do chat aguardando resposta. Pura, defensiva
 * — input malformado (não-array) conta como 0 em vez de lançar, mesma
 * disciplina fail-soft do resto do drawer.
 */
export function computeGlobalBadgeCount(gatesPending, chatPermissionsPending) {
  const gates = Array.isArray(gatesPending) ? gatesPending.length : 0;
  const chat = Array.isArray(chatPermissionsPending) ? chatPermissionsPending.length : 0;
  return gates + chat;
}

/**
 * Decide a ação do clique no badge/toggle do drawer, dados os 3 campos já
 * expostos por `GET /api/state`/SSE `state` (`gatesPending`,
 * `chatPermissionsPending`, `currentEdition`):
 *
 *   - `{ action: "scroll" }` — há card de chat pendente (qualquer
 *     `kind` — pergunta ou tool-decision, #3557/#3804) NESTA sessão de chat:
 *     mesmo comportamento de sempre, abrir/rolar até o card
 *     (`scrollToPendingCard()` em chat-drawer.js).
 *   - `{ action: "navigate", href }` — há gate de pipeline pendente MAS
 *     nenhum card no chat (a sessão que originou o gate já terminou ou roda
 *     no terminal, não no chat desta página — "sessão terminal"): leva ao
 *     cockpit da edição com o gate pendente (`currentEdition` — já resolvido
 *     com a MESMA prioridade de `pickCurrentEdition`/studio-state.ts, que
 *     escolhe a edição com gate pendente antes de qualquer outra), onde o
 *     banner do #3870 explica o estado.
 *   - `{ action: "toggle" }` — nada pendente: comportamento pré-#3888,
 *     só expande/recolhe o painel.
 *
 * Pura, defensiva — nunca lança com input malformado.
 */
export function resolveBadgeClickAction(gatesPending, chatPermissionsPending, currentEdition) {
  const gatesCount = Array.isArray(gatesPending) ? gatesPending.length : 0;
  const chatCount = Array.isArray(chatPermissionsPending) ? chatPermissionsPending.length : 0;
  if (chatCount > 0) return { action: "scroll" };
  if (gatesCount > 0 && typeof currentEdition === "string" && currentEdition) {
    return { action: "navigate", href: `/edicao/${encodeURIComponent(currentEdition)}` };
  }
  return { action: "toggle" };
}
