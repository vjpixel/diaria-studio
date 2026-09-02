// nav.js (#3849) — menu de navegação unificado do Studio: montagem real no
// DOM (mount point `#app-nav`, presente em toda página — nenhuma marcação de
// item duplicada por página, só o container vazio + um
// `<script>window.STUDIO_PAGE = "...";</script>` inline que identifica a
// página atual pro item ativo). Toda a lógica testável (lista de destinos,
// item ativo, href de Revisão, o HTML do nav em si) mora em `nav-core.js`
// (#633, mesmo padrão de `revisao-guards.js`/`revisao.js`) — este arquivo só
// faz fetch de `/api/state` e injeta no DOM, sem harness de teste direto
// (precedente de app.js/#3555 — ver docstring de
// test/studio-edicao-page.test.ts).
//
// #7050: também injeta o badge global de gate de pipeline pendente
// (`gate-badge.js`, sucessor do `chat-badge.js` removido no #6942) — reusa
// o mesmo fetch de `/api/state` que este arquivo já fazia, sem requisição
// extra.

import { resolveActiveNavId, resolveRevisaoHref, buildNavHtml } from "./nav-core.js";
import { renderGateBadgeHtml } from "./gate-badge.js";

async function fetchState() {
  try {
    const res = await fetch("/api/state");
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function mountNav() {
  const container = document.getElementById("app-nav");
  if (!container) return;
  const pageId = window.STUDIO_PAGE ?? null;
  const activeId = resolveActiveNavId(pageId);
  // Só precisa da edição corrente quando "Revisão" está potencialmente
  // visível/precisa de href — mas buscar sempre é mais simples e barato
  // (mesmo endpoint que app.js já consulta em toda página com estado). O
  // badge de gate (#7050) reusa o mesmo `state` — sem 2ª requisição.
  const state = await fetchState();
  const currentEdition = state?.currentEdition ?? null;
  const revisaoHref = resolveRevisaoHref(currentEdition);
  container.innerHTML =
    buildNavHtml(activeId, revisaoHref) + renderGateBadgeHtml(state?.gatesPending, currentEdition);

  const toggle = document.getElementById("app-nav-toggle");
  const list = document.getElementById("app-nav-list");
  toggle.addEventListener("click", () => {
    const expanded = toggle.getAttribute("aria-expanded") === "true";
    toggle.setAttribute("aria-expanded", String(!expanded));
    list.classList.toggle("open", !expanded);
  });
}

mountNav();
