// nav-core.js (#3849) — lógica PURA do menu de navegação unificado do
// Studio: nenhuma das exportações abaixo toca `document`/`fetch` — mesmo
// padrão de `revisao-guards.js` (#3668): separado de propósito de `nav.js`
// (que faz a montagem real no DOM) pra ficar testável com fixtures puras,
// sem harness de DOM (#633).
//
// Fonte da verdade das rotas de página é `scripts/studio-ui/server.ts`
// (#3849, escopo da issue) — `test/studio-nav.test.ts` cross-checa
// `NAV_ITEMS`/`DASHBOARD_LINKS` contra o source de `server.ts` pra pegar
// drift (rota real sem entrada aqui, ou entrada aqui apontando pra rota que
// não existe).
//
// #3853: /painel/diaria passou a ser página nativa do menu (item
// "painel-diaria" em NAV_ITEMS, abaixo) — `renderDashboardHtml`
// (`workers/diaria-dashboard/src/index.ts`) agora injeta os assets
// compartilhados (tokens/nav/chat-drawer) + `#app-nav` + `window.STUDIO_PAGE`
// QUANDO `studioMode: true`, gate que só `dashboard-diaria.ts` (studio-server)
// liga — o deploy de produção do MESMO Worker (studioMode false/ausente)
// continua servindo o documento autocontido de sempre, sem esses assets.
//
// /painel/clarice CONTINUA fora de NAV_ITEMS (em DASHBOARD_LINKS abaixo) —
// mesma situação que /painel/diaria tinha antes desta issue (documento
// autocontido renderizado por dashboard-clarice.ts, sem `#app-nav`); virar
// página nativa também é um follow-up natural e idêntico, fora do escopo
// desta issue (#3853 pediu especificamente a dashboard diária).
//
// #3848: rota /integracoes agora existe (página de status de todas as
// integrações — APIs + MCPs) — incluída em NAV_ITEMS abaixo.

/** Destinos de PÁGINA do Studio (item ativo é decidido por `pageIds`,
 * comparado contra `window.STUDIO_PAGE`). `href: null` significa "resolvido
 * em runtime" (hoje só `revisao`, que depende da edição corrente — não tem
 * rota bare `/revisao`, só `/revisao/:aammdd`, #3559). */
export const NAV_ITEMS = [
  { id: "home", label: "Home", href: "/", pageIds: ["index", "edicao"] },
  { id: "rodada", label: "Rodada", href: "/rodada", pageIds: ["rodada"] },
  { id: "triagem", label: "Triagem", href: "/triagem", pageIds: ["triagem"] },
  { id: "revisao", label: "Revisão", href: null, pageIds: ["revisao"] },
  { id: "apoios", label: "Apoios", href: "/apoios", pageIds: ["apoios"] },
  { id: "relatorios", label: "Relatórios", href: "/relatorios", pageIds: ["relatorios"] },
  { id: "integracoes", label: "Integrações", href: "/integracoes", pageIds: ["integracoes"] },
  // #3853: label igual ao que já existia em DASHBOARD_LINKS (não é copy nova)
  // — mantém distinção clara do "Dashboard Clarice" que continua abaixo.
  { id: "painel-diaria", label: "Dashboard diária", href: "/painel/diaria", pageIds: ["painel-diaria"] },
];

/** Documentos autocontidos (ver docstring acima) — sempre abrem em nova aba,
 * nunca participam da detecção de item ativo. */
export const DASHBOARD_LINKS = [
  { label: "Dashboard Clarice", href: "/painel/clarice" },
];

/** Resolve qual item de NAV_ITEMS está ativo pra um dado `pageId`
 * (tipicamente `window.STUDIO_PAGE`) — pura, sem DOM, testável direto.
 * `null` quando `pageId` não corresponde a nenhum item conhecido. */
export function resolveActiveNavId(pageId) {
  const item = NAV_ITEMS.find((i) => i.pageIds.includes(pageId));
  return item ? item.id : null;
}

/** Resolve o href do item "Revisão", que depende da edição corrente — não
 * existe rota bare `/revisao` (só `/revisao/:aammdd`), então sem edição
 * corrente o link fica desabilitado (nunca aponta pra uma rota que 404).
 * Pura, testável direto. */
export function resolveRevisaoHref(currentEdition) {
  return currentEdition ? `/revisao/${currentEdition}` : null;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Monta o HTML do nav — string pura (nenhum acesso a `document`), testável
 * direto. `nav.js` só injeta o resultado via `container.innerHTML`. */
export function buildNavHtml(activeId, revisaoHref) {
  const items = NAV_ITEMS.map((item) => {
    const isActive = item.id === activeId;
    const href = item.id === "revisao" ? revisaoHref : item.href;
    if (!href) {
      // #3874: o motivo de estar desabilitado precisa estar em TEXTO VISÍVEL,
      // não só em `title=` — tooltip não existe em touch (R7 de
      // docs/studio-ui-ux-guidelines.md). `title` continua também, pro hover
      // no desktop.
      return (
        `<span class="app-nav-item app-nav-disabled" title="Nenhuma edição em andamento">` +
        `${escapeHtml(item.label)} <small class="app-nav-disabled-reason">(nenhuma edição em andamento)</small></span>`
      );
    }
    return `<a class="app-nav-item${isActive ? " active" : ""}" href="${escapeHtml(href)}"${isActive ? ' aria-current="page"' : ""}>${escapeHtml(item.label)}</a>`;
  }).join("");
  const dashboards = DASHBOARD_LINKS.map(
    (d) =>
      `<a class="app-nav-item app-nav-dashboard" href="${escapeHtml(d.href)}" target="_blank" rel="noopener">${escapeHtml(d.label)} ↗</a>`,
  ).join("");
  return (
    `<button type="button" class="app-nav-toggle" id="app-nav-toggle" aria-expanded="false" aria-controls="app-nav-list">☰ Menu</button>` +
    `<div class="app-nav-list" id="app-nav-list">${items}` +
    `<span class="app-nav-group-label">Dashboards</span>${dashboards}</div>`
  );
}
