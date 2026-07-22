// tablist-core.js (#3874) — lógica PURA de navegação por teclado em
// WAI-ARIA APG tabs (role="tab"/role="tablist"), compartilhada por
// revisao.js (2 tablists: `#rv-tabs`/`#rv-side-tabs`) e rodada.js (1
// tablist: `#tab-overnight`/`#tab-develop`). Nenhuma das exportações toca
// `document` — mesmo padrão de nav-core.js/revisao-guards.js (#633):
// testável direto com fixtures puras, sem harness de DOM.
//
// Referência: WAI-ARIA Authoring Practices Guide (APG) — padrão "Tabs" com
// ativação automática (ArrowLeft/ArrowRight/Home/End movem o foco E ativam a
// aba, sem exigir Enter/Espaço extra) — mais simples de implementar
// corretamente e adequado aqui (trocar de aba é uma ação barata/reversível,
// nenhuma razão pra ativação manual). R13 de docs/studio-ui-ux-guidelines.md.

/** Dado a tecla pressionada, o índice da aba com foco e o total de abas,
 * devolve o índice a focar/ativar em seguida — ou `null` se a tecla não for
 * de navegação de tabs (o caller não faz nada nesse caso, deixando o
 * comportamento default do browser intacto). Wrap-around nas pontas
 * (ArrowRight na última aba volta pra primeira, e vice-versa — padrão APG). */
export function nextTabIndex(key, currentIndex, count) {
  if (!Number.isInteger(count) || count <= 0) return null;
  switch (key) {
    case "ArrowRight":
    case "Down": // alguns browsers antigos mandam o nome longo
      return (currentIndex + 1 + count) % count;
    case "ArrowLeft":
      return (currentIndex - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

/** Aplica `aria-selected`/`tabindex` (roving tabindex — só a aba ativa é
 * alcançável via Tab, as outras só via seta, padrão APG) a uma lista de
 * elementos `role="tab"`, a partir de um predicado `isActive(el) -> boolean`.
 * Pura o bastante pra testar com objetos stub (`{dataset, setAttribute}` já
 * cobre o suficiente) sem precisar de DOM real. */
export function syncTabAria(tabEls, isActive) {
  for (const el of tabEls) {
    const active = isActive(el);
    el.setAttribute("aria-selected", String(active));
    el.tabIndex = active ? 0 : -1;
  }
}
