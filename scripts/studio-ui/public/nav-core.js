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

// #4002: menu reagrupado por fluxo de trabalho (era flat, ordem de criação)
// — 4 grupos visuais, cada `NAV_ITEMS`/`DASHBOARD_LINKS` ganha um campo
// `group` que aponta pra um id de `NAV_GROUPS`. Nenhum `href`/`id` mudou
// (bookmarks e deep-links continuam válidos) — só apresentação e ordem.

/** Grupos visuais do menu, na ordem em que aparecem. */
export const NAV_GROUPS = [
  { id: "edicao", label: "📰 Edição" },
  { id: "operacao", label: "⚙️ Operação" },
  { id: "negocio", label: "📊 Negócio" },
  { id: "sistema", label: "🔌 Sistema" },
];

/** Destinos de PÁGINA do Studio (item ativo é decidido por `pageIds`,
 * comparado contra `window.STUDIO_PAGE`). `href: null` significa "resolvido
 * em runtime" (hoje só `revisao`, que depende da edição corrente — não tem
 * rota bare `/revisao`, só `/revisao/:aammdd`, #3559). */
export const NAV_ITEMS = [
  // 📰 Edição — uso diário, primeiro.
  { id: "home", label: "Home", href: "/", pageIds: ["index", "edicao"], group: "edicao" },
  { id: "revisao", label: "Revisão", href: null, pageIds: ["revisao"], group: "edicao" },
  // #3924: "Caixas" — listar/editar os snippets de caixa de divulgação
  // (context/snippets/*.md).
  { id: "caixas", label: "Caixas", href: "/caixas", pageIds: ["caixas"], group: "edicao" },
  // ⚙️ Operação — sessões de dev/backlog.
  { id: "rodada", label: "Rodada", href: "/rodada", pageIds: ["rodada"], group: "operacao" },
  { id: "triagem", label: "Triagem", href: "/triagem", pageIds: ["triagem"], group: "operacao" },
  { id: "relatorios", label: "Relatórios", href: "/relatorios", pageIds: ["relatorios"], group: "operacao" },
  // 📊 Negócio.
  { id: "apoios", label: "Apoios", href: "/apoios", pageIds: ["apoios"], group: "negocio" },
  // #3853: label igual ao que já existia em DASHBOARD_LINKS (não é copy nova)
  // — mantém distinção clara do "Dashboard Clarice" que continua abaixo.
  { id: "painel-diaria", label: "Dashboard diária", href: "/painel/diaria", pageIds: ["painel-diaria"], group: "negocio" },
  // 🔌 Sistema.
  { id: "integracoes", label: "Integrações", href: "/integracoes", pageIds: ["integracoes"], group: "sistema" },
];

/** Documentos autocontidos (ver docstring acima) — sempre abrem em nova aba,
 * nunca participam da detecção de item ativo. Ganha `group` também (#4002)
 * pra entrar na mesma lista visual agrupada — "Dashboard Clarice" cai junto
 * de Apoios/Dashboard diária em 📊 Negócio, como pedido pelo editor. */
export const DASHBOARD_LINKS = [
  { label: "Dashboard Clarice", href: "/painel/clarice", group: "negocio" },
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

function renderNavItem(item, activeId, revisaoHref) {
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
}

function renderDashboardLink(d) {
  return `<a class="app-nav-item app-nav-dashboard" href="${escapeHtml(d.href)}" target="_blank" rel="noopener">${escapeHtml(d.label)} ↗</a>`;
}

/** Monta o HTML do nav — string pura (nenhum acesso a `document`), testável
 * direto. `nav.js` só injeta o resultado via `container.innerHTML`.
 *
 * #4002: agrupado por fluxo de trabalho (`NAV_GROUPS`) em vez de flat —
 * dentro de cada grupo, primeiro os itens de página de `NAV_ITEMS` (na ordem
 * declarada), depois os documentos autocontidos de `DASHBOARD_LINKS` que
 * pertencem ao mesmo grupo. Grupo sem nenhum item (não acontece hoje, mas é
 * defensivo caso um grupo fique vazio num refactor futuro) não emite label. */
export function buildNavHtml(activeId, revisaoHref) {
  const groupsHtml = NAV_GROUPS.map((group) => {
    const items = NAV_ITEMS.filter((item) => item.group === group.id).map((item) =>
      renderNavItem(item, activeId, revisaoHref),
    );
    const dashboards = DASHBOARD_LINKS.filter((d) => d.group === group.id).map(renderDashboardLink);
    const nodes = [...items, ...dashboards];
    if (nodes.length === 0) return "";
    return `<span class="app-nav-group-label">${escapeHtml(group.label)}</span>${nodes.join("")}`;
  }).join("");
  return (
    `<button type="button" class="app-nav-toggle" id="app-nav-toggle" aria-expanded="false" aria-controls="app-nav-list">☰ Menu</button>` +
    `<div class="app-nav-list" id="app-nav-list">${groupsHtml}</div>`
  );
}
