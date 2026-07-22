// rodada.js (#3561, redesenhado #3841) — acompanhamento de rodada
// overnight/develop: sequência cronológica de TODAS as rodadas (mais
// recente primeiro, GET /api/rounds) + fila classificada (entram/pendente/
// fora, com motivo) + timeline ao vivo da entrada expandida (GET
// /api/round/:kind?session=). Vanilla JS, sem build step (mesmo princípio de
// triagem.js/#3562). Read-only: nenhum botão aqui dispara rodada nova; isso
// continua sendo /diaria-overnight`/`/diaria-develop no terminal.
//
// #3841 — decisão de produto do editor (260721): o painel deixou de resolver
// "a rodada mais recente" (por kind, com um seletor de abas) e passou a
// listar TODAS as rodadas (overnight + develop) numa sequência cronológica
// única, mais recente primeiro — múltiplas rodadas do mesmo dia são só mais
// duas entradas adjacentes na sequência, sem caso especial. Clicar numa
// entrada expande (accordion — só 1 expandida por vez) a fila+timeline
// daquela rodada específica, buscada via `?session=`.
//
// Filtro por "label" espelha `deriveQueueLabels` de studio-round-queue.ts —
// reimplementado aqui client-side (best-effort, mesmo padrão) em vez de
// importar o módulo server: o filtro é sobre o texto já normalizado que o
// servidor devolve (`reason`/`status`/`priority`), não precisa reler plan.json.

import { unitAge, roundFreshness } from "./rodada-round-age.js";

const el = {
  fetchDot: document.getElementById("fetch-dot"),
  fetchLabel: document.getElementById("fetch-label"),
  connDot: document.getElementById("conn-dot"),
  connLabel: document.getElementById("conn-label"),
  sessionLabel: document.getElementById("round-session"),
  roundsListError: document.getElementById("rounds-list-error"),
  roundsListEmpty: document.getElementById("rounds-list-empty"),
  roundsList: document.getElementById("rounds-list"),
  detail: document.getElementById("round-detail"),
  error: document.getElementById("round-error"),
  empty: document.getElementById("round-empty"),
  emptyDir: document.getElementById("round-empty-dir"),
  meta: document.getElementById("round-meta"),
  metaSession: document.getElementById("meta-session"),
  metaStarted: document.getElementById("meta-started"),
  metaLoop: document.getElementById("meta-loop"),
  metaPath: document.getElementById("meta-path"),
  filterPriority: document.getElementById("filter-priority"),
  filterLabel: document.getElementById("filter-label"),
  refreshBtn: document.getElementById("refresh-btn"),
  lastUpdated: document.getElementById("last-updated"),
  entramCount: document.getElementById("entram-count"),
  entramBody: document.getElementById("entram-tbody"),
  entramEmpty: document.getElementById("entram-empty"),
  pendenteCount: document.getElementById("pendente-count"),
  pendenteBody: document.getElementById("pendente-tbody"),
  pendenteEmpty: document.getElementById("pendente-empty"),
  foraCount: document.getElementById("fora-count"),
  foraBody: document.getElementById("fora-tbody"),
  foraEmpty: document.getElementById("fora-empty"),
  timelineBody: document.getElementById("timeline-tbody"),
};

/** Estado — `rounds` é o snapshot de `/api/rounds` (lista completa); `selected`
 * é a entrada expandida no momento (`{kind, sessionId}` ou `null` — nenhuma
 * expandida); `data` é o payload de detalhe (`/api/round/:kind?session=`) da
 * entrada `selected`. Filtros são 100% client-side sobre `data` já buscado. */
let rounds = [];
let roundsFetchFailed = false;
let selected = null; // { kind, sessionId } | null
let data = null; // último payload de /api/round/:kind?session=
const filters = { priority: "", label: "" };

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function setFetchStatus(status, label) {
  el.fetchDot.className = "dot " + status;
  el.fetchLabel.textContent = label;
}

// #3889: indicador de conexão do SSE (`/api/events`), separado do
// fetch-status acima (que só reflete o REST `/api/round(s)`). Mesmo padrão de
// edicao.js/app.js (`setConn` + handlers `open`/`error` do EventSource).
function setConn(status) {
  el.connDot.className = "dot " + status;
  el.connLabel.textContent = status === "ok" ? "conectado" : status === "down" ? "desconectado" : "conectando…";
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

function priorityBadge(priority) {
  if (!priority || priority === "?") return '<span class="priority-badge priority-none">—</span>';
  return `<span class="priority-badge priority-${priority.toLowerCase()}">${priority}</span>`;
}

const KIND_LABEL = { overnight: "Overnight", develop: "Develop" };

/** Resumo textual de status pra 1 entrada da lista de rodadas — ex: "24
 * issues · 20 mergeadas · 2 pendentes". Só as 3 contagens mais informativas
 * (mergeada/draft-ci-vermelho/pendente) pra não poluir a linha da lista —
 * a contagem completa por status já está disponível na fila expandida. */
function summarizeCounts(counts, totalIssues) {
  const parts = [`${totalIssues} issue${totalIssues === 1 ? "" : "s"}`];
  const merged = counts["mergeada"] ?? 0;
  const draft = counts["draft-ci-vermelho"] ?? 0;
  const pendente = counts["pendente"] ?? 0;
  if (merged > 0) parts.push(`${merged} mergeada${merged === 1 ? "" : "s"}`);
  if (draft > 0) parts.push(`${draft} draft`);
  if (pendente > 0) parts.push(`${pendente} pendente${pendente === 1 ? "" : "s"}`);
  return parts.join(" · ");
}

/** Mesma heurística de `deriveQueueLabels` (studio-round-queue.ts) — replicada
 * aqui pra filtro 100% client-side (sem refetch a cada troca de filtro). */
function rowLabels(row) {
  const labels = [];
  if (["P0", "P1", "P2", "P3"].includes(row.priority)) labels.push(row.priority);
  const haystack = `${row.reason ?? ""} ${row.status}`;
  if (/requer-sessao-local|sess[aã]o local/i.test(haystack)) labels.push("local");
  if (/bloqueio-externo|external-blocker|block_category|cat\.\s*[A-E]\b/i.test(haystack)) labels.push("external-blocker");
  return labels;
}

function matchesFilters(row) {
  if (filters.priority && row.priority !== filters.priority) return false;
  if (filters.label && !rowLabels(row).includes(filters.label)) return false;
  return true;
}

// #3874: "0 resultados para este filtro" vs "nenhum registro" (padrão
// relatorios.js, R4 de docs/studio-ui-ux-guidelines.md).
function updateEmptyState(emptyEl, filteredCount, totalCount, hasActiveFilter, emptyLabel) {
  if (!emptyEl) return;
  if (filteredCount > 0) {
    emptyEl.hidden = true;
    return;
  }
  emptyEl.hidden = false;
  emptyEl.textContent = totalCount > 0 && hasActiveFilter ? "0 resultados para este filtro." : emptyLabel;
}

function renderQueueTable(tbody, countEl, rows, withReason, emptyEl, emptyLabel) {
  const filtered = rows.filter(matchesFilters);
  countEl.textContent = String(filtered.length);
  const filterActive = Boolean(filters.priority || filters.label);
  updateEmptyState(emptyEl, filtered.length, rows.length, filterActive, emptyLabel);
  tbody.innerHTML = "";
  for (const row of filtered) {
    const tr = document.createElement("tr");
    if (withReason) {
      tr.innerHTML = `
        <td>#${row.number}</td>
        <td>${priorityBadge(row.priority)}</td>
        <td>${escapeHtml(row.reason ?? "—")}</td>
      `;
    } else {
      tr.innerHTML = `
        <td>#${row.number}</td>
        <td>${priorityBadge(row.priority)}</td>
        <td class="mono">${escapeHtml(row.status)}</td>
        <td>${row.batch ? escapeHtml(row.batch) : '<span class="hint">solo</span>'}</td>
        <td class="mono">${row.pr ? `#${row.pr}` : "—"}</td>
      `;
    }
    tbody.appendChild(tr);
  }
}

function renderTimeline(rows) {
  el.timelineBody.innerHTML = "";
  if (!rows || rows.length === 0) {
    el.timelineBody.innerHTML = '<tr><td colspan="5" class="hint">nenhuma unidade registrada ainda</td></tr>';
    return;
  }
  const now = Date.now();
  for (const row of rows) {
    const tr = document.createElement("tr");
    // #3889: sem isto, uma unidade travada (fim === "em andamento" há horas)
    // renderizava IDÊNTICA a uma progredindo normalmente.
    const isRunning = row.fim === "em andamento";
    if (isRunning) tr.classList.add("timeline-row-running");
    let fimCell = escapeHtml(row.fim);
    if (isRunning) {
      const age = unitAge(row, now);
      fimCell =
        `<span class="timeline-badge-running">rodando</span>` +
        `<span class="unit-age${age.stale ? " unit-age-stale" : ""}">${age.stale ? "⚠ " : ""}${escapeHtml(age.label)}</span>`;
    }
    tr.innerHTML = `
      <td class="mono">${escapeHtml(row.unidade)}</td>
      <td class="mono">${escapeHtml(row.inicio)}</td>
      <td class="mono">${fimCell}</td>
      <td class="mono">${escapeHtml(row.duracao)}</td>
      <td class="mono">${row.fixIteracoes > 0 ? row.fixIteracoes : "—"}</td>
    `;
    el.timelineBody.appendChild(tr);
  }
}

function renderMeta() {
  if (!data || !data.found) {
    el.meta.hidden = true;
    el.empty.hidden = fetchFailed || !data || data.found !== false;
    if (el.empty.hidden === false) {
      el.emptyDir.textContent = selected ? `data/${selected.kind}/${selected.sessionId}/` : "—";
    }
    return;
  }
  el.empty.hidden = true;
  el.meta.hidden = false;
  el.metaSession.textContent = data.sessionId ?? "—";
  // #3841: `startedAtSource === "mtime"` significa que `plan.json` não tinha
  // (ainda) um `started_at` ISO real — o horário exibido é o mtime do
  // arquivo (aproximado), não a hora exata de início da rodada. Rotulado
  // explicitamente em vez de fingir precisão que o dado não tem.
  const approx = data.startedAtSource === "mtime" ? " (aprox., mtime do arquivo)" : "";
  el.metaStarted.textContent = data.startedAt ? `${fmtTime(data.startedAt)}${approx}` : "—";
  el.metaLoop.textContent = data.loopEstendido === null ? "—" : data.loopEstendido ? "sim" : "não";
  el.metaPath.textContent = data.planPath ?? "—";
}

// #3561 self-review (PR #3622): `fetchFailed` distingue "a requisição pra
// /api/round/:kind falhou" (rede, HTTP != 2xx) de `data.found === false`.
let fetchFailed = false;

function renderDetail() {
  if (!selected) {
    el.detail.hidden = true;
    el.sessionLabel.textContent = "—";
    return;
  }
  el.detail.hidden = false;
  el.sessionLabel.textContent = data && data.sessionId ? `${selected.kind} — ${data.sessionId}` : `${selected.kind} — ${selected.sessionId}`;
  renderMeta();

  if (fetchFailed) {
    el.error.hidden = false;
    el.error.textContent = `falha ao buscar /api/round/${selected.kind}: ${data && data.error}`;
  } else if (data && data.error) {
    el.error.hidden = false;
    el.error.textContent = `falha ao ler plan.json: ${data.error}`;
  } else {
    el.error.hidden = true;
  }

  const queue = (data && data.queue) || { entram: [], pendente: [], fora: [] };
  renderQueueTable(el.entramBody, el.entramCount, queue.entram, false, el.entramEmpty, "Nenhuma unidade entra na rodada.");
  renderQueueTable(el.pendenteBody, el.pendenteCount, queue.pendente, true, el.pendenteEmpty, "Nenhuma unidade pendente de desbloqueio.");
  renderQueueTable(el.foraBody, el.foraCount, queue.fora, true, el.foraEmpty, "Nenhuma unidade fica de fora.");
  renderTimeline((data && data.timeline) || []);

  if (!fetchFailed) {
    const freshness = roundFreshness(data);
    if (freshness.updatedAt) {
      const stallBadge = freshness.stale
        ? ` <span class="unit-age unit-age-stale">⚠ possível stall — ${escapeHtml(freshness.ageLabel)}</span>`
        : "";
      el.lastUpdated.innerHTML = `atualizado ${escapeHtml(fmtTime(freshness.updatedAt))}${stallBadge}`;
    } else {
      el.lastUpdated.textContent = data ? "atualizado —" : "";
    }
  }
}

/** Renderiza a lista de rounds (sequência cronológica) — 1 <li> clicável por
 * entrada, com o estado "expandido"/"selecionado" refletido em `aria-expanded`
 * + classe `.active`. Clique alterna: se já é a entrada selecionada, colapsa
 * (accordion — só 1 expandida por vez); senão, seleciona a nova e busca o
 * detalhe. */
function renderRoundsList() {
  if (roundsFetchFailed) {
    el.roundsListError.hidden = false;
    el.roundsListError.textContent = "falha ao buscar /api/rounds — tentando novamente no próximo refresh.";
  } else {
    el.roundsListError.hidden = true;
  }

  el.roundsListEmpty.hidden = rounds.length > 0 || roundsFetchFailed;

  el.roundsList.innerHTML = "";
  for (const r of rounds) {
    const li = document.createElement("li");
    li.className = "round-list-item";
    const isSelected = Boolean(selected && selected.kind === r.kind && selected.sessionId === r.sessionId);
    if (isSelected) li.classList.add("active");

    const approx = r.startedAtSource === "mtime" ? " (aprox.)" : "";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "round-list-row";
    btn.setAttribute("aria-expanded", String(isSelected));
    btn.innerHTML = `
      <span class="round-list-kind kind-${escapeHtml(r.kind)}">${escapeHtml(KIND_LABEL[r.kind] ?? r.kind)}</span>
      <span class="round-list-session mono">${escapeHtml(r.sessionId)}</span>
      <span class="round-list-started mono">${escapeHtml(fmtTime(r.startedAt))}${escapeHtml(approx)}</span>
      <span class="round-list-counts hint">${escapeHtml(summarizeCounts(r.counts, r.totalIssues))}</span>
      <span class="round-list-chevron" aria-hidden="true">${isSelected ? "▾" : "▸"}</span>
    `;
    btn.addEventListener("click", () => toggleRound(r.kind, r.sessionId));
    li.appendChild(btn);
    el.roundsList.appendChild(li);
  }
}

function toggleRound(kind, sessionId) {
  if (selected && selected.kind === kind && selected.sessionId === sessionId) {
    // já expandida — colapsa (accordion)
    selected = null;
    data = null;
    renderRoundsList();
    renderDetail();
    return;
  }
  selected = { kind, sessionId };
  renderRoundsList();
  fetchRoundDetail();
}

async function fetchRoundsList() {
  try {
    const res = await fetch("/api/rounds");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    rounds = Array.isArray(body.rounds) ? body.rounds : [];
    roundsFetchFailed = false;
    // Auto-seleciona a MAIS RECENTE (topo da sequência) na 1ª carga — corrige
    // o defeito original (#3841): antes o painel podia mostrar a rodada
    // ERRADA (mais antiga) por kind; agora a ordenação já é cronológica real
    // e a 1ª entrada É a mais recente de fato, overnight ou develop.
    if (!selected && rounds.length > 0) {
      selected = { kind: rounds[0].kind, sessionId: rounds[0].sessionId };
      renderRoundsList();
      await fetchRoundDetail();
      return;
    }
  } catch (e) {
    roundsFetchFailed = true;
    rounds = [];
  }
  renderRoundsList();
}

async function fetchRoundDetail() {
  if (!selected) {
    renderDetail();
    return;
  }
  setFetchStatus("", "carregando…");
  try {
    const res = await fetch(`/api/round/${selected.kind}?session=${encodeURIComponent(selected.sessionId)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
    fetchFailed = false;
    setFetchStatus(data.error ? "down" : "ok", data.error ? "erro" : "ok");
  } catch (e) {
    fetchFailed = true;
    setFetchStatus("down", "falha ao buscar /api/round");
    data = { kind: selected.kind, sessionId: selected.sessionId, found: false, error: String(e), queue: { entram: [], pendente: [], fora: [] }, timeline: [] };
  }
  renderDetail();
}

el.filterPriority.addEventListener("change", () => {
  filters.priority = el.filterPriority.value;
  renderDetail();
});
el.filterLabel.addEventListener("change", () => {
  filters.label = el.filterLabel.value;
  renderDetail();
});
el.refreshBtn.addEventListener("click", () => {
  fetchRoundsList();
  if (selected) fetchRoundDetail();
});

// #3561 critério de aceite "timeline ao vivo, lendo plan.json via SSE": o
// servidor já observa data/{overnight,develop}/**/plan.json (plan-watch.ts)
// e emite um evento `plan` em /api/events sempre que mudar — refetch aqui
// mantém a lista + a rodada expandida sincronizadas sem polling próprio.
function connect() {
  try {
    const events = new EventSource("/api/events");
    events.addEventListener("open", () => setConn("ok"));
    events.addEventListener("error", () => setConn("down"));
    events.addEventListener("plan", (ev) => {
      try {
        const sig = JSON.parse(ev.data);
        // Qualquer mudança de plan.json pode afetar contagens na lista
        // (qualquer kind/sessão) — refetch da lista é barato (leitura).
        fetchRoundsList();
        if (selected && sig.kind === selected.kind) fetchRoundDetail();
      } catch {
        // payload malformado — ignora este tick, o próximo refresh manual cobre.
      }
    });
  } catch {
    // EventSource indisponível (ambiente de teste/sem browser real) — a
    // página ainda funciona via "Atualizar" manual.
  }
}

// #3889: tick local de 30s (mesmo padrão de edicao.js, #3871) — recalcula
// idade/staleness a partir do `data` já em memória, sem refetch.
setInterval(() => {
  if (selected) renderDetail();
}, 30_000);

connect();
fetchRoundsList();
