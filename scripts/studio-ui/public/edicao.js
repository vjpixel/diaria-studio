// edicao.js (#3558) — cockpit de UMA edição: timeline dos 7 stages (0-6),
// gates 4/6 como telas read-only, alertas aproximados de halt (#738), e log
// filtrado por edição. Vanilla JS, sem build step (mesmo princípio de
// app.js/#3555 — zero-custo, sem lib nova).
//
// Escopo desta fatia (#3558): READ-ONLY. Nenhuma ação é disparada daqui —
// aprovar gate, criar edição nova, retry/abort de halt são #3557 (mecanismo
// de forms pra AskUserQuestion) e ficam fora. Este módulo só lê
// /api/state, /api/editions/:aammdd e o SSE /api/events já existentes
// (fatia 1, #3555) e desenha.

import { computeStageAge } from "./edicao-stage-age.js";
import { resolveGateChatBridge, formatWaitingSince, pickBannerGate } from "./gate-chat-bridge.js";
import { createLogDeduper } from "./log-dedup.js";

const STAGE_ORDER = [0, 1, 2, 3, 4, 5, 6];
const STAGE_LABELS = {
  0: "Setup + dedup",
  1: "Pesquisa",
  2: "Escrita",
  3: "Imagens",
  4: "Revisão",
  5: "Publicação",
  6: "Agendamento",
};

// Arquivos gate-facing (de GATE_FACING_FILES em studio-edition-detail.ts)
// relevantes pra cada gate humano — só pra agrupar a exibição; a lista
// canônica e os metadados (exists/size/modified) continuam vindo 100% da
// API, nunca listados/lidos daqui.
const GATE_4_FILES = ["02-reviewed.md", "03-social.md", "04-d1-2x1.jpg", "04-d1-1x1.jpg", "04-d2-1x1.jpg", "04-d3-1x1.jpg"];

const MAX_LOG_BUFFER = 500;

const el = {
  titulo: document.getElementById("edicao-titulo"),
  stage: document.getElementById("edicao-stage"),
  updated: document.getElementById("statusbar-updated"),
  connDot: document.getElementById("conn-dot"),
  connLabel: document.getElementById("conn-label"),
  notFound: document.getElementById("edicao-not-found"),
  alertsSection: document.getElementById("alerts-section"),
  alertsList: document.getElementById("alerts-list"),
  timeline: document.getElementById("stage-timeline"),
  gate4: document.getElementById("gate-4"),
  gate6: document.getElementById("gate-6"),
  logList: document.getElementById("edicao-log-list"),
  reviewLink: document.getElementById("review-link"),
  gateBanner: document.getElementById("gate-chat-banner"),
  gateBannerText: document.getElementById("gate-chat-banner-text"),
  gateBannerBtn: document.getElementById("gate-chat-banner-btn"),
};

/** AAMMDD a partir do path — `/edicao/260716` → `260716`. Pura, testável
 * mentalmente sem DOM (mas não precisa de teste próprio: é um one-liner
 * espelhando o regex já usado no server, `/^\/edicao\/([^/]+)\/?$/`). */
function getAammddFromPath() {
  const m = location.pathname.match(/^\/edicao\/([^/]+)\/?$/);
  return m ? decodeURIComponent(m[1]) : null;
}

function fmtDuration(ms) {
  if (ms === undefined || ms === null || Number.isNaN(ms)) return "—";
  const totalSec = Math.round(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

function fmtTime(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("pt-BR", {
      timeZone: "America/Sao_Paulo",
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function fmtBytes(n) {
  if (n === null || n === undefined) return "—";
  if (n < 1024) return `${n} B`;
  return `${(n / 1024).toFixed(1)} KB`;
}

function setConn(status) {
  el.connDot.className = "dot " + status;
  el.connLabel.textContent = status === "ok" ? "conectado" : status === "down" ? "desconectado" : "conectando…";
}

// #3891 (item 8): "Atualizado HH:MM" no header do cockpit — cronometra o
// último `renderAll()` bem-sucedido (chamado no load inicial e a cada
// `scheduleRefetch()`, mesma lacuna apontada pela auditoria #3866/R1 já
// resolvida em app.js/index).
function markUpdatedNow() {
  if (!el.updated) return;
  el.updated.textContent = new Date().toLocaleTimeString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const aammdd = getAammddFromPath();
let expandedStage = null;
// Buffer só dos eventos de run-log que pertencem a ESTA edição — o SSE
// manda o run-log inteiro (todas as edições), filtramos aqui.
let logBuffer = [];
// #3870: espelha `state.chatPermissionsPending` (mesmo payload de
// `GET /api/state`, empurrado a cada evento SSE `state`) — fonte pra
// `resolveGateChatBridge` decidir se o gate 4/6 pendente tem card ativo no
// chat drawer desta MESMA página. Não é filtrado por edição (o wire não
// carrega essa informação — ver doc-comment de gate-chat-bridge.js).
let chatPermissionsPending = [];

// #3891 (item 6): mesmo problema/fix de app.js (ver doc-comment de
// log-dedup.js) — o reconnect do SSE reenvia a TAIL inteira via `log-init`,
// duplicando linhas já vistas no "Log desta edição" sem isto.
const logDeduper = createLogDeduper(MAX_LOG_BUFFER);

function pushLogEvents(events) {
  const mine = events.filter((e) => e && e.edition === aammdd && logDeduper.isNew(e));
  if (mine.length === 0) return false;
  logBuffer.push(...mine);
  if (logBuffer.length > MAX_LOG_BUFFER) logBuffer = logBuffer.slice(-MAX_LOG_BUFFER);
  return true;
}

function renderHeader(detail) {
  el.titulo.textContent = detail.edition;
  document.title = `Diar.ia Studio — Edição ${detail.edition}`;
  el.stage.textContent = detail.found ? `${detail.stageLabel} (${detail.currentStage})` : "—";
  // #3559: link direto pro painel de revisão de conteúdo desta edição.
  if (el.reviewLink) {
    if (detail.found) {
      el.reviewLink.href = `/revisao/${detail.edition}`;
      el.reviewLink.style.display = "";
    } else {
      el.reviewLink.style.display = "none";
    }
  }
  // #3687: esta página não tem "arquivo"/"aba" (é a timeline de estágios da
  // edição, não o editor de conteúdo — ver revisao.js pra esse par) — só a
  // edição mesmo entra no contexto do chat. Fail-soft: mesmo guard de
  // revisao.js (`syncChatContext`) pra ordem de script.
  if (window.diariaStudioChat && typeof window.diariaStudioChat.setContext === "function") {
    window.diariaStudioChat.setContext({ edition: detail.edition });
  }
}

function renderNotFound(detail) {
  el.notFound.hidden = detail.found;
}

function renderTimeline(detail) {
  el.timeline.innerHTML = "";
  if (!detail.found) return;

  const rowsByStage = new Map((detail.stageStatus ? detail.stageStatus.rows : []).map((r) => [r.stage, r]));

  for (const stage of STAGE_ORDER) {
    const row = rowsByStage.get(stage);
    const status = row ? row.status : "pending";
    const isGate = detail.gatesPending.includes(stage);
    const isCurrent = detail.currentStage === stage;

    const wrap = document.createElement("div");
    const classes = ["stage-row", `status-${status}`];
    if (isCurrent) classes.push("current");
    if (isGate) classes.push("gate");
    wrap.className = classes.join(" ");

    const header = document.createElement("button");
    header.type = "button";
    header.className = "stage-row-header";
    header.setAttribute("aria-expanded", String(expandedStage === stage));

    const durationText = row && row.duration_ms !== undefined ? fmtDuration(row.duration_ms) : "—";
    const timesText = row && row.start ? `${fmtTime(row.start)}${row.end ? " → " + fmtTime(row.end) : ""}` : "—";

    // #3871: pra um stage "current", "status-running" sozinho não diz se
    // está de fato avançando ou travado — um current há 2min e um current
    // há 2h renderizavam idêntico. Calcula a idade do último evento de
    // run-log deste stage (já em `logBuffer`, filtrado por edição) e mostra
    // como texto auxiliar ao lado do badge; `stale` (sem eventos OU acima do
    // limiar) promove o texto pro mesmo tratamento visual do banner ⚠ do
    // espelho remoto (`renderStudioSnapshotHtml`, #3565).
    const stageAge = isCurrent ? computeStageAge(stage, logBuffer) : null;
    const stageAgeHtml = stageAge
      ? ` <span class="stage-age${stageAge.stale ? " stage-age-stale" : ""}">${stageAge.stale ? "⚠ " : ""}${stageAge.label}</span>`
      : "";

    header.innerHTML = `
      <span class="stage-num">${stage}</span>
      <span class="stage-label">${STAGE_LABELS[stage]}</span>
      <span class="stage-status-badge">${status}${isGate ? " · gate pendente" : ""}${stageAgeHtml}</span>
      <span class="stage-times">${timesText}</span>
      <span class="stage-duration">${durationText}</span>
      <span class="stage-caret">${expandedStage === stage ? "▲" : "▼"}</span>
    `;
    header.addEventListener("click", () => {
      expandedStage = expandedStage === stage ? null : stage;
      renderTimeline(detail);
    });
    wrap.appendChild(header);

    if (expandedStage === stage) {
      const panel = document.createElement("div");
      panel.className = "stage-row-panel";
      const stageEvents = logBuffer.filter((e) => e.stage === stage);
      if (stageEvents.length === 0) {
        panel.textContent = "Sem eventos de run-log para este stage (ainda) nesta sessão.";
      } else {
        for (const ev of stageEvents.slice(-100)) {
          const line = document.createElement("div");
          line.className = `log-row ${ev.level || "info"}`;
          const ts = ev.timestamp ? new Date(ev.timestamp).toLocaleTimeString("pt-BR") : "";
          line.innerHTML = `<span class="lvl">${ev.level || "info"}</span><span class="msg">[${ts}] ${ev.agent ? ev.agent + ": " : ""}${ev.message || ""}</span>`;
          panel.appendChild(line);
        }
      }
      wrap.appendChild(panel);
    }

    el.timeline.appendChild(wrap);
  }
}

function renderFileList(container, files) {
  if (files.length === 0) {
    container.textContent = "Nenhum arquivo relevante listado.";
    return;
  }
  const ul = document.createElement("ul");
  ul.className = "file-list";
  for (const f of files) {
    const li = document.createElement("li");
    li.className = f.exists ? "file-exists" : "file-missing";
    li.textContent = f.exists
      ? `${f.name} — ${fmtBytes(f.sizeBytes)} · modificado ${fmtTime(f.modifiedAt)}`
      : `${f.name} — ainda não gerado`;
    ul.appendChild(li);
  }
  container.appendChild(ul);
}

// #3870: clique de "Responder no chat" (card de gate OU banner do topo) —
// expande o drawer e rola até o card ainda não resolvido. Fail-soft: o
// script do drawer pode não ter montado ainda (ordem de `<script>` na
// página) — mesmo guard defensivo já usado por `renderHeader` acima pra
// `setContext`.
function openChatAtPendingCard() {
  if (window.diariaStudioChat && typeof window.diariaStudioChat.scrollToPendingCard === "function") {
    window.diariaStudioChat.scrollToPendingCard();
  } else if (window.diariaStudioChat && typeof window.diariaStudioChat.openDrawer === "function") {
    window.diariaStudioChat.openDrawer();
  }
}

/** Acrescenta a linha "Responder no chat" + "esperando há Xmin" dentro do
 * card de gate (#3870), só quando `bridge.hasCard` é true — chamada por
 * `renderGate4`/`renderGate6` logo depois do parágrafo de status. */
function appendGateChatBridgeRow(container, bridge) {
  if (!bridge.hasCard) return;
  const row = document.createElement("div");
  row.className = "gate-chat-bridge-row";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "gate-chat-bridge-btn";
  btn.textContent = "Responder no chat →";
  btn.addEventListener("click", openChatAtPendingCard);
  row.appendChild(btn);
  const wait = document.createElement("span");
  wait.className = "gate-chat-bridge-wait";
  wait.textContent = formatWaitingSince(bridge.oldestAskedAt);
  row.appendChild(wait);
  container.appendChild(row);
}

function renderGate4(detail) {
  el.gate4.innerHTML = "";
  if (!detail.found) return;
  const bridge = resolveGateChatBridge(4, detail.gatesPending, chatPermissionsPending);
  const status = document.createElement("p");
  status.className = "gate-status " + (bridge.pending ? "gate-status-pending" : "gate-status-idle");
  if (bridge.pending && bridge.hasCard) {
    // #3870: a ação real mora no card do chat drawer desta mesma página —
    // o botão abaixo (appendGateChatBridgeRow) leva até ele em 1 clique.
    status.textContent = "Gate pendente — responda pelo card no chat desta página (botão abaixo) ou aprove no terminal (/diaria-4-revisao).";
  } else if (bridge.pending) {
    // #3870 proposta item 2: sem card no chat = sessão rodando no
    // terminal — explícito que a UI só observa (nada escondido, sem botão
    // pra clicar aqui).
    status.textContent = "Gate pendente — esta sessão está rodando no terminal (não no chat desta página); a UI só observa. Aprove no terminal com /diaria-4-revisao.";
  } else if (detail.currentStage === "unknown" || (typeof detail.currentStage === "number" && detail.currentStage < 4)) {
    status.textContent = "Ainda não chegou no Stage 4.";
  } else {
    status.textContent = "Sem gate pendente aqui agora (já aprovado ou stage ainda não concluiu os pré-requisitos).";
  }
  el.gate4.appendChild(status);
  appendGateChatBridgeRow(el.gate4, bridge);

  const files = detail.gateFacingFiles.filter((f) => GATE_4_FILES.includes(f.name));
  renderFileList(el.gate4, files);
}

function renderGate6(detail) {
  el.gate6.innerHTML = "";
  if (!detail.found) return;
  const bridge = resolveGateChatBridge(6, detail.gatesPending, chatPermissionsPending);
  const status = document.createElement("p");
  status.className = "gate-status " + (bridge.pending ? "gate-status-pending" : "gate-status-idle");
  if (bridge.pending && bridge.hasCard) {
    status.textContent = "Gate pendente — responda pelo card no chat desta página (botão abaixo) ou aprove no terminal (/diaria-6-agendamento).";
  } else if (bridge.pending) {
    status.textContent = "Gate pendente — esta sessão está rodando no terminal (não no chat desta página); a UI só observa. Aprove no terminal com /diaria-6-agendamento.";
  } else if (detail.currentStage === "unknown" || (typeof detail.currentStage === "number" && detail.currentStage < 6)) {
    status.textContent = "Ainda não chegou no Stage 6.";
  } else if (detail.currentStage === "done") {
    status.textContent = "Pipeline concluído — ver stage-status.md para timing final.";
  } else {
    status.textContent = "Sem gate pendente aqui agora.";
  }
  el.gate6.appendChild(status);
  appendGateChatBridgeRow(el.gate6, bridge);

  const stageStatusFile = detail.gateFacingFiles.find((f) => f.name === "stage-status.md");
  if (stageStatusFile) {
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent = stageStatusFile.exists
      ? `stage-status.md atualizado em ${fmtTime(stageStatusFile.modifiedAt)} — detalhes de agendamento (hora, publish_date) vêm de Beehiiv/LinkedIn/Facebook, fora do que este servidor lê localmente.`
      : "stage-status.md ainda não gerado.";
    el.gate6.appendChild(p);
  }
}

/** Banner de gate pendente no TOPO do cockpit (#3870 proposta item 3) — não
 * substitui os cards de Gate 4/6 (que continuam com o detalhe completo),
 * só dá um segundo sinal mais visível que o badge pequeno do rail do chat
 * colapsado. `el.gateBannerBtn` é reaproveitado entre renders (é markup
 * estático do HTML, não recriado) — o listener de clique é registrado uma
 * vez, fora desta função (ver abaixo). */
function renderGateBanner(detail) {
  if (!detail.found) {
    el.gateBanner.hidden = true;
    return;
  }
  const bridge4 = resolveGateChatBridge(4, detail.gatesPending, chatPermissionsPending);
  const bridge6 = resolveGateChatBridge(6, detail.gatesPending, chatPermissionsPending);
  const picked = pickBannerGate(bridge4, bridge6);
  if (!picked) {
    el.gateBanner.hidden = true;
    return;
  }
  el.gateBanner.hidden = false;
  const label = picked.gate === 4 ? "Gate 4 — Revisão editorial" : "Gate 6 — Agendamento";
  if (picked.hasCard) {
    el.gateBannerText.textContent = `${label} pendente — ${formatWaitingSince(picked.oldestAskedAt)}`;
    el.gateBannerBtn.hidden = false;
  } else {
    el.gateBannerText.textContent = `${label} pendente — esta sessão roda no terminal; a UI só observa.`;
    el.gateBannerBtn.hidden = true;
  }
}
el.gateBannerBtn.addEventListener("click", openChatAtPendingCard);

function renderAlerts() {
  const errors = logBuffer.filter((e) => e.level === "error");
  if (errors.length === 0) {
    el.alertsSection.hidden = true;
    return;
  }
  el.alertsSection.hidden = false;
  el.alertsList.innerHTML = "";
  for (const ev of errors.slice(-20)) {
    const row = document.createElement("div");
    row.className = "alert-row";
    const ts = ev.timestamp ? new Date(ev.timestamp).toLocaleString("pt-BR") : "";
    row.textContent = `[${ts}] stage ${ev.stage ?? "?"} · ${ev.agent || "?"}: ${ev.message || ""}`;
    el.alertsList.appendChild(row);
  }
}

function renderLogList() {
  el.logList.innerHTML = "";
  // #3874: `.log-list` não usa mais `flex-direction: column-reverse`
  // (style.css) — a ordem de leitura (DOM) agora precisa bater com a ordem
  // visual (mais recente no topo) por conta própria. Como esta função
  // reconstrói a lista inteira a cada chamada (`innerHTML = ""` acima), basta
  // iterar em ordem reversa (mais recente primeiro) — sem precisar de
  // insertBefore como em app.js (que só faz append incremental).
  for (const ev of [...logBuffer].slice(-300).reverse()) {
    const row = document.createElement("div");
    const level = ev.level || "info";
    row.className = `log-row ${level}`;
    const ts = ev.timestamp ? new Date(ev.timestamp).toLocaleTimeString("pt-BR") : "";
    row.innerHTML = `<span class="lvl">${level}</span><span class="msg">[${ts}] ${ev.agent ? ev.agent + ": " : ""}${ev.message || ""}</span>`;
    el.logList.appendChild(row);
  }
}

let currentDetail = null;

async function fetchDetail() {
  if (!aammdd) return null;
  const res = await fetch(`/api/editions/${encodeURIComponent(aammdd)}`);
  if (res.status === 404 || res.status === 400) {
    return { edition: aammdd, found: false, currentStage: "unknown", stageLabel: "—", gatesPending: [], gateFacingFiles: [], stageStatus: null };
  }
  if (!res.ok) return null;
  return res.json();
}

function renderAll(detail) {
  if (!detail) return;
  currentDetail = detail;
  renderHeader(detail);
  renderNotFound(detail);
  renderTimeline(detail);
  renderGate4(detail);
  renderGate6(detail);
  renderGateBanner(detail);
  renderAlerts();
  renderLogList();
  markUpdatedNow();
}

let refetchTimer = null;
function scheduleRefetch() {
  // Mesmo debounce de app.js (#3555): rajada de eventos de log costuma
  // acompanhar uma transição de stage — uma única atualização 500ms depois
  // do último evento já basta pra "sentir ao vivo".
  if (refetchTimer) clearTimeout(refetchTimer);
  refetchTimer = setTimeout(async () => {
    const detail = await fetchDetail();
    if (detail) renderAll(detail);
  }, 500);
}

async function init() {
  if (!aammdd) {
    el.titulo.textContent = "AAMMDD ausente na URL";
    el.notFound.hidden = false;
    el.notFound.textContent = "URL inválida — use /edicao/AAMMDD.";
    return;
  }
  const detail = await fetchDetail();
  if (detail) renderAll(detail);
  connect();
}

function connect() {
  const source = new EventSource("/api/events");

  source.addEventListener("open", () => setConn("ok"));
  source.addEventListener("error", () => setConn("down"));

  source.addEventListener("log-init", (ev) => {
    const events = JSON.parse(ev.data);
    if (pushLogEvents(events) && currentDetail) {
      renderAlerts();
      renderLogList();
      renderTimeline(currentDetail);
    }
  });

  source.addEventListener("log", (ev) => {
    const changed = pushLogEvents([JSON.parse(ev.data)]);
    if (changed) {
      if (currentDetail) {
        renderAlerts();
        renderLogList();
        renderTimeline(currentDetail);
      }
      scheduleRefetch();
    }
  });

  source.addEventListener("state", (ev) => {
    setConn("ok");
    // #3870: `state` já carrega `chatPermissionsPending` (mesmo shape de
    // GET /api/state) — atualiza o espelho local e reflete no gate 4/6 +
    // banner IMEDIATAMENTE, sem esperar o debounce de 500ms de
    // `scheduleRefetch` (que ainda roda, pro resto da timeline/status).
    try {
      const state = JSON.parse(ev.data);
      chatPermissionsPending = Array.isArray(state.chatPermissionsPending) ? state.chatPermissionsPending : [];
    } catch {
      // payload malformado neste tick — mantém o último valor conhecido
      // (fail-soft, mesma disciplina de pushLogEvents/renderAlerts).
    }
    if (currentDetail) {
      renderGate4(currentDetail);
      renderGate6(currentDetail);
      renderGateBanner(currentDetail);
    }
    scheduleRefetch();
  });

  source.addEventListener("plan", () => {
    scheduleRefetch();
  });
}

// #3871: sem isto, um stage "current" genuinamente TRAVADO (sem log novo
// chegando) nunca dispara re-render — o texto de idade ficaria congelado no
// valor de quando a página carregou, exatamente o cenário que este recurso
// deveria denunciar. Tick puramente local (renderTimeline só redesenha a
// partir do que já está em `currentDetail`/`logBuffer`, sem fetch novo).
setInterval(() => {
  if (currentDetail) renderTimeline(currentDetail);
}, 30_000);

init();
