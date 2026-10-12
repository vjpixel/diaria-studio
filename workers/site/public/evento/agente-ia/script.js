const checkoutUrl = window.EVENT_CHECKOUT_URL?.trim();

// #10080: modo interno (?interno=1). O bootstrap inline do <head> define
// window.__DIA_INTERNO__ antes do pixel e do GTM, que então nem carregam.
// Aqui: sem beacon do clique e com um aviso discreto para a equipe.
const internalMode = window.__DIA_INTERNO__ === true;
if (internalMode) {
  const aviso = document.createElement("div");
  aviso.className = "aviso-interno";
  aviso.setAttribute("role", "status");
  aviso.textContent = "Modo interno: visita não medida";
  Object.assign(aviso.style, {
    position: "fixed",
    left: "8px",
    bottom: "8px",
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

// #10079: origem da visita, calculada uma vez por carregamento da página e
// enviada em TODOS os eventos (visita, rolagem e clique) e no beacon do clique.
// O nome do evento não muda: a separação por origem é feita com conversões
// personalizadas no painel da Meta, filtrando pelo parâmetro `origem`.
// Ordem: o utm_source, se houver; "meta", se houver fbclid; senão "direto".
// Cada campo é cortado em 100 caracteres (mesmo teto do servidor,
// CLICK_BEACON_ORIGIN_FIELD_MAX em scripts/lib/shared/click-beacon.ts).
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

// #8982: `eventID` opcional — quando presente, viaja no 4o argumento do fbq
// (`{eventID}`) pra Meta deduplicar este disparo client-side contra o MESMO
// evento reenviado via CAPI pelo beacon abaixo (mesmo mecanismo de
// event_name+event_id já documentado em meta-capi.ts pro CompleteRegistration).
// O try/catch garante que um erro no pixel nunca impeça a navegação para o
// checkout (o clique chama track depois do preventDefault).
function track(event, data, eventId) {
  if (internalMode || typeof window.fbq !== "function") return;
  try {
    const params = Object.assign({}, visitData, data);
    if (eventId) window.fbq("trackCustom", `${event}_${variant}`, params, { eventID: eventId });
    else window.fbq("trackCustom", `${event}_${variant}`, params);
  } catch (e) {
    // fail-soft
  }
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
  // #10080: no modo interno o clique não vai para a Meta por nenhum caminho.
  if (internalMode) return false;
  var payload = JSON.stringify({
    variant: variant.toLowerCase(),
    posicao: posicao,
    event_id: eventId,
    external_id: window.__DIA_VID__ || readCookie("_dia_vid"),
    fbc: readCookie("_fbc"),
    fbp: readCookie("_fbp"),
    // #10079: mesma origem que vai nos parâmetros do fbq.
    origem: visitData.origem,
    utm_campaign: visitData.utm_campaign || "",
    utm_content: visitData.utm_content || "",
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
