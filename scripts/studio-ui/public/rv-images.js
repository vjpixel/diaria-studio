// rv-images.js (#6447 Fatia 4, achados 6 + 9) — painel "Imagens": galeria por
// destaque (2:1, 1:1, card 4:5, carrossel de parágrafos+CTA) + É IA? (A/B),
// cada imagem com um link pra abrir em tamanho real (sem lightbox — o
// arquivo já é servido por `GET /api/editions/:aammdd/image/:filename`,
// #achado-260716) e um botão "Regenerar" por destaque/eia.
//
// Fonte de dados: GET /api/editions/:aammdd/images
// (scripts/studio-ui/studio-images.ts::buildImagesGallery — leitura pura de
// disco, sem LLM). Ação: POST /api/editions/:aammdd/images/:target/regenerate
// dispara a cadeia de scripts do Stage 3 real EM BACKGROUND (chamada de API
// paga — Gemini/ComfyUI — pode levar dezenas de segundos); esta página faz
// POLLING (recarrega a galeria a cada poucos segundos) enquanto QUALQUER
// destaque/eia estiver `regenerating`, e para sozinha quando o último job
// termina — SSE não foi escolhido pro mesmo motivo documentado no server
// (job curto o bastante pra polling de baixa frequência bastar).
//
// Módulo independente (mesma convenção de import isolado do #3559/#6447) —
// só depende do DOM estático declarado em revisao.html.

import { formatImageExistence, isTargetRegenerating, anyTargetRegenerating, formatRegenerateButtonLabel } from "./rv-images-format.js";

function getAammddFromPath() {
  const m = location.pathname.match(/^\/revisao\/([^/]+)\/?$/);
  return m ? decodeURIComponent(m[1]) : null;
}

const aammdd = getAammddFromPath();

const el = {
  status: document.getElementById("rv-img-status"),
  destaques: document.getElementById("rv-img-destaques"),
  eia: document.getElementById("rv-img-eia"),
  refreshBtn: document.getElementById("rv-img-refresh-btn"),
};

// #6447 guardrail (API cara): proteção client-side contra duplo-clique —
// desabilitado no clique, só reabilitado quando o próximo poll confirmar
// `regenerating: false`. A Map do servidor (studio-images.ts) é a rede de
// segurança de verdade; isto é só UX (evita 2 cliques rápidos disparando 2
// POSTs antes do 1º voltar).
const pendingClicks = new Set();

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function el_(tag, opts = {}) {
  const node = document.createElement(tag);
  if (opts.className) node.className = opts.className;
  if (opts.text !== undefined) node.textContent = opts.text;
  if (opts.type) node.type = opts.type;
  return node;
}

async function regenerate(target, btn) {
  if (!aammdd || pendingClicks.has(target)) return;
  pendingClicks.add(target);
  btn.disabled = true;
  btn.textContent = "Regenerando…";
  try {
    const res = await fetch(`/api/editions/${encodeURIComponent(aammdd)}/images/${encodeURIComponent(target)}/regenerate`, {
      method: "POST",
    });
    let body;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    if (!res.ok || !body || !body.ok) {
      pendingClicks.delete(target);
      btn.disabled = false;
      btn.textContent = "Regenerar";
      el.status.textContent = `Erro ao regenerar ${target}: ${(body && body.error) || `HTTP ${res.status}`}`;
      return;
    }
  } catch (err) {
    pendingClicks.delete(target);
    btn.disabled = false;
    btn.textContent = "Regenerar";
    el.status.textContent = `Erro de rede ao regenerar ${target}: ${(err && err.message) || err}`;
    return;
  }
  pendingClicks.delete(target);
  await loadImages(); // já reflete regenerating:true — segue o polling daqui
}

function imageEntryNode(entry, target, regenerating) {
  const wrap = el_("div", { className: "rv-img-entry" });
  wrap.appendChild(el_("p", { className: "rv-img-entry-label", text: entry.label }));
  if (entry.exists) {
    const link = document.createElement("a");
    link.href = `/api/editions/${encodeURIComponent(aammdd)}/image/${encodeURIComponent(entry.filename)}`;
    link.target = "_blank";
    link.rel = "noopener";
    const img = document.createElement("img");
    img.src = link.href;
    img.alt = entry.label;
    img.loading = "lazy";
    img.className = "rv-img-thumb";
    link.appendChild(img);
    wrap.appendChild(link);
  } else {
    wrap.appendChild(el_("p", { className: "rv-img-empty", text: formatImageExistence(entry) }));
  }
  const btn = el_("button", { className: "rv-img-regen-btn", text: formatRegenerateButtonLabel(regenerating) });
  btn.type = "button";
  btn.disabled = regenerating || pendingClicks.has(target);
  btn.addEventListener("click", () => { regenerate(target, btn); });
  wrap.appendChild(btn);
  return wrap;
}

function renderGroup(container, images, target, regenerating) {
  clear(container);
  for (const entry of images) {
    container.appendChild(imageEntryNode(entry, target, regenerating));
  }
}

function renderDestaques(gallery) {
  clear(el.destaques);
  for (const d of gallery.destaques) {
    const target = `d${d.n}`;
    const regenerating = isTargetRegenerating(gallery, target);
    const group = el_("details", { className: "rv-gate-section" });
    group.open = true;
    const summary = el_("summary", { text: `D${d.n}` });
    group.appendChild(summary);
    const body = el_("div", { className: "rv-img-group" });
    group.appendChild(body);
    el.destaques.appendChild(group);
    renderGroup(body, d.images, target, regenerating);
  }
}

let pollTimer = null;

function stopPolling() {
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}

function scheduleNextPoll() {
  stopPolling();
  pollTimer = setTimeout(() => { loadImages(); }, 4000);
}

export async function loadImages() {
  if (!aammdd || !el.destaques) return;
  try {
    const res = await fetch(`/api/editions/${encodeURIComponent(aammdd)}/images`);
    if (res.status === 404) {
      el.status.textContent = "Edição não encontrada.";
      clear(el.destaques);
      clear(el.eia);
      stopPolling();
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const gallery = await res.json();
    if (!gallery.available) {
      el.status.textContent = gallery.note || "Galeria de imagens indisponível.";
      clear(el.destaques);
      clear(el.eia);
      stopPolling();
      return;
    }
    el.status.textContent = "";
    renderDestaques(gallery);
    renderGroup(el.eia, gallery.eia.images, "eia", isTargetRegenerating(gallery, "eia"));
    // Continua pollando enquanto QUALQUER job estiver rodando — pra e sozinho
    // quando o último terminar (nunca deixa um timer órfão rodando pra
    // sempre numa página sem regeneração pendente).
    if (anyTargetRegenerating(gallery)) {
      scheduleNextPoll();
    } else {
      stopPolling();
    }
  } catch (err) {
    console.error("rv-images: falha ao carregar galeria de imagens:", err);
    el.status.textContent = "Falha ao carregar a galeria de imagens — verifique a conexão.";
  }
}

if (el.refreshBtn) {
  el.refreshBtn.addEventListener("click", () => { loadImages(); });
}

if (aammdd) loadImages();

export { renderDestaques };
