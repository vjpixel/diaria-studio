// gate-badge.js (#7050) — lógica PURA do badge global de "gate de pipeline
// pendente" (Stage 4 revisão / Stage 6 agendamento), injetado por `nav.js`
// em TODAS as páginas do Studio que montam o menu compartilhado.
//
// Sucessor do `chat-badge.js` removido no #6942 (o chat do Studio foi
// descontinuado por inteiro — gate voltou a ser só terminal). O #3888 tinha
// corrigido uma lacuna real: uma edição com gate 4/6 pendente ficava sem
// nenhum sinal em 6 das (então) 8 telas do Studio, fora de "/" (que resolve
// via `pickCurrentEdition` priorizando `gatesPending`) e do cockpit
// "/edicao/:aammdd" (banner do #3870). Remover o chat por inteiro (#6942)
// levou `chat-badge.js` junto e reabriu essa mesma lacuna por acidente —
// este módulo a fecha de novo, só que agora alimentado unicamente por
// `state.gatesPending`: não existe mais `chatPermissionsPending` nem sessão
// de chat pra somar ao total.
//
// Extraído como módulo PURO (sem tocar `document`/`fetch`) — mesmo padrão
// de `nav-core.js` e do antigo `chat-badge.js`: este projeto não tem
// harness de DOM (sem jsdom/happy-dom, ver `test/studio-edicao-page.test.ts`)
// — `nav.js` só chama e liga ao DOM real, nenhuma lógica de decisão mora lá.

/**
 * Contagem pro badge: total de gates de pipeline pendentes (Stage 4/6,
 * qualquer edição). Pura, defensiva — input malformado (não-array) conta
 * como 0 em vez de lançar.
 */
export function computeGateBadgeCount(gatesPending) {
  return Array.isArray(gatesPending) ? gatesPending.length : 0;
}

/**
 * Resolve o href do badge: leva ao cockpit da edição corrente (mesma
 * prioridade de `pickCurrentEdition`/`studio-state.ts`, que já escolhe a
 * edição com gate pendente antes de qualquer outra) — só quando há gate
 * pendente E uma edição corrente resolvida. `null` nos dois casos
 * contrários (badge não deve aparecer/ser clicável). Pura, defensiva —
 * nunca lança com input malformado.
 */
export function resolveGateBadgeHref(gatesPending, currentEdition) {
  const count = computeGateBadgeCount(gatesPending);
  if (count > 0 && typeof currentEdition === "string" && currentEdition) {
    return `/edicao/${encodeURIComponent(currentEdition)}`;
  }
  return null;
}

/**
 * Monta o HTML do badge — string pura (nenhum acesso a `document`),
 * testável direto, mesmo padrão de `buildNavHtml` (nav-core.js). String
 * vazia quando não há gate pendente com edição resolvida (nada a mostrar).
 * `encodeURIComponent` em `resolveGateBadgeHref` já garante que `href`
 * nunca carrega caractere HTML-significativo sem escapar — não precisa de
 * `escapeHtml` adicional aqui (R7 de docs/studio-ui-ux-guidelines.md: o
 * motivo/contagem é sempre TEXTO VISÍVEL, nunca só `title=`).
 */
export function renderGateBadgeHtml(gatesPending, currentEdition) {
  const count = computeGateBadgeCount(gatesPending);
  const href = resolveGateBadgeHref(gatesPending, currentEdition);
  if (!href) return "";
  const label = count === 1 ? "1 gate pendente" : `${count} gates pendentes`;
  return `<a class="app-gate-badge" href="${href}" title="Revisão/agendamento aguardando aprovação">⚠ ${label}</a>`;
}
