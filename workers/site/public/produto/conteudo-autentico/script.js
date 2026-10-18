// Página de vendas da aula "Conteúdo Autêntico com IA" (produto 8596324 na Hotmart).
// Mesma medição da página do guia (workers/site/public/guia/agente-ia/script.js):
// os parâmetros da visita seguem para o checkout da Hotmart (src/sck mostram a
// origem da venda; fbclid deixa o pixel do checkout reconhecer o clique no anúncio).

const CHECKOUT_URL = "https://pay.hotmart.com/U107768057V?off=lhwtb1jf";

// #10080: modo interno (?interno=1). O bootstrap inline do <head> define
// window.__DIA_INTERNO__ antes do pixel e do GTM, que então nem carregam.
// Aqui: sem eventos do pixel e com um aviso discreto para a equipe.
const internalMode = window.__DIA_INTERNO__ === true;
if (internalMode) {
  const aviso = document.createElement("div");
  aviso.className = "aviso-interno";
  aviso.setAttribute("role", "status");
  aviso.textContent = "Modo interno: visita não medida";
  Object.assign(aviso.style, {
    position: "fixed",
    left: "8px",
    top: "8px",
    zIndex: "9999",
    padding: "3px 8px",
    borderRadius: "4px",
    background: "rgba(0, 0, 0, 0.65)",
    color: "#fff",
    font: "12px/1.4 system-ui, sans-serif",
    pointerEvents: "none",
  });
  document.body.appendChild(aviso);
}
const TRACKING_PARAMS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "fbclid", "gclid"];

function checkoutHref(base) {
  const url = new URL(base);
  const visit = new URLSearchParams(window.location.search);
  TRACKING_PARAMS.forEach((key) => {
    const value = visit.get(key);
    if (value) url.searchParams.set(key, value);
  });
  const source = visit.get("utm_source");
  const content = (visit.get("utm_content") || "").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (source && !url.searchParams.has("src")) url.searchParams.set("src", source);
  if (!url.searchParams.has("sck")) url.searchParams.set("sck", ["lp", "conteudo-autentico", content].filter(Boolean).join("-"));
  return url.toString();
}

// Origem da visita (#10079), calculada uma vez por carregamento da página e
// enviada em todos os eventos. Mesma regra das páginas do evento e do guia: o
// utm_source, se houver; "meta", se houver fbclid; senão "direto".
const ORIGIN_FIELD_MAX = 100;
function visitOrigin(search) {
  const visit = new URLSearchParams(search);
  const clean = (key) => (visit.get(key) || "").trim().slice(0, ORIGIN_FIELD_MAX).trim();
  const source = clean("utm_source");
  const data = { origem: source || (clean("fbclid") ? "meta" : "direto") };
  const campaign = clean("utm_campaign");
  const content = clean("utm_content");
  if (campaign) data.utm_campaign = campaign;
  if (content) data.utm_content = content;
  return data;
}
// Nome com prefixo de propósito: `origin` sozinho encobriria window.origin
// para os outros scripts da página (este arquivo não é módulo).
const visitData = visitOrigin(window.location.search);

// Eventos próprios desta página (prefixo ConteudoAutentico), separados dos do
// evento ao vivo e dos do guia. O try/catch garante que um erro no pixel nunca
// impeça a navegação para o checkout.
function track(event, data) {
  if (internalMode || typeof window.fbq !== "function") return;
  try {
    window.fbq("trackCustom", `ConteudoAutentico${event}`, Object.assign({}, visitData, data));
  } catch (e) {
    // fail-soft
  }
}

track("Visita");

// Mesmo cuidado do #8982: se o navegador seguir o link no mesmo instante do
// fbq(), a requisição do pixel é cancelada e o clique some. O clique comum
// espera 300 ms antes de ir ao checkout; clique com modificador (nova aba)
// segue como link normal, porque esta aba não navega.
const NAV_DELAY_MS = 300;
const href = checkoutHref(CHECKOUT_URL);
document.querySelectorAll(".checkout-link").forEach((link) => {
  link.href = href;
  link.addEventListener("click", (ev) => {
    // #10080: no modo interno não há pixel para esperar: o link segue normal.
    if (internalMode) return;
    const data = { posicao: link.dataset.posicao || "sem-posicao" };
    if (ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) {
      track("Clique", data);
      return;
    }
    ev.preventDefault();
    track("Clique", data);
    setTimeout(() => {
      window.location.href = link.href;
    }, NAV_DELAY_MS);
  });
});

// Botão flutuante: aparece depois de duas alturas de tela e some enquanto a
// oferta, o CTA final ou o rodapé estão visíveis, para não cobrir nenhum deles.
const floatCta = document.querySelector(".float-cta");
if (floatCta) {
  floatCta.hidden = false;
  const blockers = ["#oferta", "#cta-final", ".site-footer"].map((sel) => document.querySelector(sel)).filter(Boolean);
  const onScreen = (el) => {
    const r = el.getBoundingClientRect();
    return r.top < window.innerHeight && r.bottom > 0;
  };
  const update = () => {
    const show = window.scrollY > window.innerHeight * 2 && !blockers.some(onScreen);
    floatCta.classList.toggle("is-visible", show);
    floatCta.setAttribute("aria-hidden", show ? "false" : "true");
    floatCta.tabIndex = show ? 0 : -1;
  };
  window.addEventListener("scroll", update, { passive: true });
  window.addEventListener("resize", update, { passive: true });
  floatCta.addEventListener("click", () => track("CliqueFlutuante"));
  update();
}

// Profundidade de leitura: separa quem saiu no topo de quem leu e não comprou.
const reached = new Set();
window.addEventListener(
  "scroll",
  () => {
    const doc = document.documentElement;
    const pct = ((window.scrollY + window.innerHeight) / doc.scrollHeight) * 100;
    [50, 90].forEach((mark) => {
      if (pct >= mark && !reached.has(mark)) {
        reached.add(mark);
        track(`Rolagem${mark}`);
      }
    });
  },
  { passive: true },
);
