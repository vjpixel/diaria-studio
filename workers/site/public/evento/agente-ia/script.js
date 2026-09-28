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

// #8982: `eventID` opcional — quando presente, viaja no 4o argumento do fbq
// (`{eventID}`) pra Meta deduplicar este disparo client-side contra o MESMO
// evento reenviado via CAPI pelo beacon abaixo (mesmo mecanismo de
// event_name+event_id já documentado em meta-capi.ts pro CompleteRegistration).
function track(event, data, eventId) {
  if (typeof window.fbq !== "function") return;
  if (eventId) window.fbq("trackCustom", `${event}_${variant}`, data || {}, { eventID: eventId });
  else window.fbq("trackCustom", `${event}_${variant}`, data);
}

track("VisitaPagina");

// #8982: lê UM cookie do document.cookie da página atual — usado só pra
// mandar _dia_vid/_fbc/_fbp no CORPO do beacon (defesa em profundidade; o
// beacon é same-origin, então o cookie já chega no header Cookie do
// request também — ver docstring de scripts/lib/shared/click-beacon.ts).
function readCookie(name) {
  var m = document.cookie.match(new RegExp("(?:^|; )" + name + "=([^;]+)"));
  return m ? m[1] : "";
}

// #8982 (CliqueIngresso perdia quase todo o clique real, #8983 fold-in):
// navigator.sendBeacon sobrevive à navegação que o clique dispara logo em
// seguida — o listener antigo chamava fbq() e deixava o navegador seguir o
// href no MESMO instante, cancelando a requisição do pixel antes dela sair.
function sendClickBeacon(eventId, posicao) {
  var payload = JSON.stringify({
    variant: variant.toLowerCase(),
    posicao: posicao,
    event_id: eventId,
    external_id: window.__DIA_VID__ || readCookie("_dia_vid"),
    fbc: readCookie("_fbc"),
    fbp: readCookie("_fbp"),
  });
  try {
    if (typeof navigator.sendBeacon === "function") {
      return navigator.sendBeacon("/evento/agente-ia/clique", new Blob([payload], { type: "application/json" }));
    }
    if (typeof window.fetch === "function") {
      window.fetch("/evento/agente-ia/clique", { method: "POST", body: payload, keepalive: true, headers: { "Content-Type": "application/json" } });
      return true;
    }
  } catch (e) {
    // fail-soft: o clique real (fbq + navegação) nunca pode travar por causa
    // do reforço server-side.
  }
  return false;
}

if (checkoutUrl && /^https:\/\//i.test(checkoutUrl)) {
  const href = checkoutHref(checkoutUrl);
  document.querySelectorAll(".checkout-link").forEach((link) => {
    link.href = href;
    link.hidden = false;
    link.addEventListener("click", (ev) => {
      const posicao = link.dataset.posicao || "sem-posicao";
      // Clique com modificador (nova aba/janela) ou botão diferente do
      // esquerdo: nunca intercepta — abrir em nova aba precisa continuar
      // funcionando como um link normal. Sem eventID: não há navegação
      // desta aba pro beacon proteger contra.
      if (ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) {
        track("CliqueIngresso", { posicao });
        return;
      }
      ev.preventDefault();
      const eventId = `clique-${variant.toLowerCase()}-${posicao}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      track("CliqueIngresso", { posicao }, eventId);
      const beaconQueued = sendClickBeacon(eventId, posicao);
      let navigated = false;
      const go = () => {
        if (navigated) return;
        navigated = true;
        window.location.href = link.href;
      };
      // `sendBeacon`/`fetch(keepalive)` são fire-and-forget — "queued" não
      // é confirmação de entrega, só garante que a navegação não cancela a
      // requisição no meio. Navega em até 300ms de qualquer forma: nunca
      // trava o clique real esperando o beacon.
      if (beaconQueued) setTimeout(go, 300);
      else go();
    });
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
