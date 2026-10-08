// Página de vendas do guia "Seu primeiro agente de IA em uma tarde, sem programar".
// Mesma medição da página do evento (workers/site/public/evento/agente-ia/script.js):
// os parâmetros da visita seguem para o checkout da Hotmart (src/sck mostram a
// origem da venda; fbclid deixa o pixel do checkout reconhecer o clique no anúncio).

const CHECKOUT_URL = "https://pay.hotmart.com/A107949130U?checkoutMode=10";
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
  if (!url.searchParams.has("sck")) url.searchParams.set("sck", ["lp", "guia", content].filter(Boolean).join("-"));
  return url.toString();
}

// Eventos próprios do guia (prefixo Guia), separados dos eventos do evento ao vivo.
function track(event, data) {
  if (typeof window.fbq === "function") window.fbq("trackCustom", `Guia${event}`, data || {});
}

track("Visita");

// Mesmo cuidado do #8982 na página do evento: se o navegador seguir o link no
// mesmo instante do fbq(), a requisição do pixel é cancelada e o clique some.
// O clique comum espera 300 ms antes de ir ao checkout; clique com modificador
// (nova aba) segue como link normal, porque esta aba não navega.
const NAV_DELAY_MS = 300;
const href = checkoutHref(CHECKOUT_URL);
document.querySelectorAll(".checkout-link").forEach((link) => {
  link.href = href;
  link.addEventListener("click", (ev) => {
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
