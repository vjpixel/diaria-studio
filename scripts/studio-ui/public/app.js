// app.js (#3555) — SPA de status do studio-server. Vanilla JS, sem build step,
// sem dependência externa (princípio zero-custo do CLAUDE.md — nenhuma lib
// justificaria o peso pra uma página de status). Consome só as APIs
// read-only desta fatia: GET /api/state, GET /api/editions/:aammdd, SSE em
// GET /api/events.
//
// Ponto de extensão pras próximas fatias (#3556+): este módulo só LÊ estado
// e desenha. Ações (gates como forms, chat drawer) devem entrar como módulos
// próprios que reusam `renderState`/`fetchEditionDetail` em vez de duplicar
// o parsing de SSE.

const STAGE_ORDER = [1, 2, 3, 4, 5, 6];
const STAGE_LABELS = {
  1: "Pesquisa",
  2: "Escrita",
  3: "Imagens",
  4: "Revisão",
  5: "Publicação",
  6: "Agendamento",
};

const el = {
  edition: document.getElementById("statusbar-edition"),
  stage: document.getElementById("statusbar-stage"),
  gates: document.getElementById("statusbar-gates"),
  overnight: document.getElementById("statusbar-overnight"),
  connDot: document.getElementById("conn-dot"),
  connLabel: document.getElementById("conn-label"),
  timeline: document.getElementById("timeline"),
  editionsBody: document.getElementById("editions-tbody"),
  editionsEmpty: document.getElementById("editions-empty"),
  logList: document.getElementById("log-list"),
  currentEditionLink: document.getElementById("current-edition-link"),
  currentEditionReviewLink: document.getElementById("current-edition-review-link"),
};

let lastCurrentEdition = null;

function setConn(status) {
  el.connDot.className = "dot " + status; // "ok" | "down" | ""
  el.connLabel.textContent = status === "ok" ? "conectado" : status === "down" ? "desconectado" : "conectando…";
}

function renderStatusbar(state) {
  el.edition.textContent = state.currentEdition ?? "nenhuma";
  const current = state.editions.find((e) => e.edition === state.currentEdition);
  el.stage.textContent = current ? `${current.stageLabel} (${current.currentStage})` : "—";
  el.gates.textContent = state.gatesPending.length
    ? state.gatesPending.map((g) => `${g.edition}·stage ${g.stage}`).join(", ")
    : "nenhum";
  const on = state.overnight;
  el.overnight.textContent = on ? `${on.sessionId} (${on.totalIssues} issues)` : "sem rodada recente";

  // #3558: link direto pro cockpit da edição corrente.
  if (state.currentEdition) {
    el.currentEditionLink.href = `/edicao/${state.currentEdition}`;
    el.currentEditionLink.style.display = "";
    // #3559: link direto pro painel de revisão de conteúdo da edição corrente.
    el.currentEditionReviewLink.href = `/revisao/${state.currentEdition}`;
    el.currentEditionReviewLink.style.display = "";
  } else {
    el.currentEditionLink.style.display = "none";
    el.currentEditionReviewLink.style.display = "none";
  }
}

function renderEditionsTable(state) {
  // #3874: "nenhum registro ainda" — sem filtro nesta tabela (lista todas as
  // edições que o servidor conhece), então nunca há o caso "0 resultados
  // para este filtro" aqui, só "vazio de verdade" (R4 de
  // docs/studio-ui-ux-guidelines.md — nunca tabela só com cabeçalho e nada
  // embaixo, sem explicação).
  el.editionsEmpty.hidden = state.editions.length > 0;
  el.editionsBody.innerHTML = "";
  for (const e of state.editions) {
    const tr = document.createElement("tr");
    const gates = e.gatesPending.length ? e.gatesPending.join(", ") : "—";
    // #3558: linka pro cockpit da edição (/edicao/:aammdd) — a página de
    // status geral continua sendo a visão de lista, o cockpit é o detalhe.
    tr.innerHTML = `<td><a href="/edicao/${e.edition}">${e.edition}</a></td><td>${e.stageLabel}</td><td>${gates}</td><td>${e.editionDir}</td>`;
    el.editionsBody.appendChild(tr);
  }
}

function renderTimeline(detail) {
  el.timeline.innerHTML = "";
  if (!detail || !detail.stageStatus) {
    el.timeline.textContent = "Sem stage-status para a edição corrente.";
    return;
  }
  const rowsByStage = new Map(detail.stageStatus.rows.map((r) => [r.stage, r]));
  for (const stage of STAGE_ORDER) {
    const row = rowsByStage.get(stage);
    const status = row ? row.status : "pending";
    const chip = document.createElement("span");
    const classes = ["stage-chip"];
    if (status === "done") classes.push("done");
    if (detail.currentStage === stage) classes.push("current");
    if (detail.gatesPending.includes(stage)) classes.push("gate");
    chip.className = classes.join(" ");
    chip.textContent = `${stage} · ${STAGE_LABELS[stage]}`;
    el.timeline.appendChild(chip);
  }
}

async function fetchEditionDetail(aammdd) {
  const res = await fetch(`/api/editions/${encodeURIComponent(aammdd)}`);
  if (!res.ok) return null;
  return res.json();
}

function appendLogRow(event) {
  const row = document.createElement("div");
  const level = (event && event.level) || "info";
  row.className = `log-row ${level}`;
  const ts = event && event.timestamp ? new Date(event.timestamp).toLocaleTimeString("pt-BR") : "";
  row.innerHTML = `<span class="lvl">${level}</span><span class="msg">[${ts}] ${event && event.agent ? event.agent + ": " : ""}${event ? event.message : ""}</span>`;
  // #3874: insere no TOPO do DOM (não appendChild) — mais recente primeiro
  // tanto visualmente quanto na ordem de leitura (teclado/leitor de tela),
  // agora que `.log-list` não usa mais `flex-direction: column-reverse`
  // (style.css) pra inverter só a aparência. Ver render de `log-init` abaixo:
  // eventos chegam em ordem cronológica crescente, cada `insertBefore`
  // empurra o anterior pra baixo — o último processado (mais recente) fica
  // no topo, igual ao comportamento visual de antes.
  el.logList.insertBefore(row, el.logList.firstChild);
  // limita o histórico visível — página de status, não um viewer de log
  // completo. Remove do FIM (mais antigo), que agora é o último filho.
  while (el.logList.children.length > 300) el.logList.removeChild(el.logList.lastChild);
}

async function onState(state) {
  renderStatusbar(state);
  renderEditionsTable(state);
  if (state.currentEdition && state.currentEdition !== lastCurrentEdition) {
    lastCurrentEdition = state.currentEdition;
    const detail = await fetchEditionDetail(state.currentEdition);
    renderTimeline(detail);
  } else if (!state.currentEdition) {
    lastCurrentEdition = null;
    renderTimeline(null);
  }
}

let refetchTimer = null;
function scheduleStateRefetch() {
  // Debounced: um evento de run-log costuma vir em rajada (vários `logEvent`
  // por transição de stage) — uma única atualização de `/api/state` 500ms
  // depois do último evento é suficiente pra sentir "ao vivo" sem martelar
  // o endpoint a cada linha.
  if (refetchTimer) clearTimeout(refetchTimer);
  refetchTimer = setTimeout(() => {
    fetch("/api/state")
      .then((r) => r.json())
      .then(onState)
      .catch(() => {});
  }, 500);
}

function connect() {
  const source = new EventSource("/api/events");

  source.addEventListener("open", () => setConn("ok"));
  source.addEventListener("error", () => setConn("down"));

  source.addEventListener("state", (ev) => {
    setConn("ok");
    onState(JSON.parse(ev.data));
  });

  source.addEventListener("log-init", (ev) => {
    const events = JSON.parse(ev.data);
    for (const e of events) appendLogRow(e);
  });

  source.addEventListener("log", (ev) => {
    appendLogRow(JSON.parse(ev.data));
    scheduleStateRefetch();
  });

  source.addEventListener("plan", () => {
    scheduleStateRefetch();
  });
}

connect();
