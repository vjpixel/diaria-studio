const checkoutUrl = window.EVENT_CHECKOUT_URL?.trim();

// Versão da página no teste A/B, marcada no <body data-variante>. Vai no nome
// dos eventos do pixel porque as estatísticas do pixel separam por nome de
// evento, não pelos parâmetros.
const variant = (document.body.dataset.variante || "a").toUpperCase();

// Parâmetros da visita que seguem para o checkout. Com eles, a Hotmart mostra
// de onde veio cada venda (src/sck) e o pixel do checkout reconhece o clique
// no anúncio (fbclid), em vez de tratar a compra como visita sem origem.
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
  if (!url.searchParams.has("sck")) url.searchParams.set("sck", ["lp", variant.toLowerCase(), content].filter(Boolean).join("-"));
  return url.toString();
}

function track(event, data) {
  if (typeof window.fbq === "function") window.fbq("trackCustom", `${event}_${variant}`, data);
}

track("VisitaPagina");

if (checkoutUrl && /^https:\/\//i.test(checkoutUrl)) {
  const href = checkoutHref(checkoutUrl);
  document.querySelectorAll(".checkout-link").forEach((link) => {
    link.href = href;
    link.hidden = false;
    link.addEventListener("click", () => track("CliqueIngresso", { posicao: link.dataset.posicao || "sem-posicao" }));
  });
  document.querySelectorAll(".checkout-pending").forEach((note) => {
    note.hidden = true;
  });
}

// Profundidade de leitura: separa quem saiu no topo de quem leu e não clicou.
const scrollMarks = [50, 90];
const reached = new Set();
window.addEventListener(
  "scroll",
  () => {
    const doc = document.documentElement;
    const pct = ((window.scrollY + window.innerHeight) / doc.scrollHeight) * 100;
    scrollMarks.forEach((mark) => {
      if (pct >= mark && !reached.has(mark)) {
        reached.add(mark);
        track(`Rolagem${mark}`);
      }
    });
  },
  { passive: true },
);
