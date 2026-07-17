// rodada.js (#3561) — acompanhamento de rodada overnight/develop: fila
// classificada (entram/pendente/fora, com motivo) + timeline ao vivo. Vanilla
// JS, sem build step (mesmo princípio de triagem.js/#3562). Read-only: só lê
// GET /api/round/:kind (studio-round.ts) — nenhum botão aqui dispara rodada
// nova; isso continua sendo /diaria-overnight`/`/diaria-develop no terminal.
//
// Filtro por "label" espelha `deriveQueueLabels` de studio-round-queue.ts —
// reimplementado aqui client-side (best-effort, mesmo padrão) em vez de
// importar o módulo server: o filtro é sobre o texto já normalizado que o
// servidor devolve (`reason`/`status`/`priority`), não precisa reler plan.json.

const el = {
  fetchDot: document.getElementById("fetch-dot"),
  fetchLabel: document.getElementById("fetch-label"),
  sessionLabel: document.getElementById("round-session"),
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
  pendenteCount: document.getElementById("pendente-count"),
  pendenteBody: document.getElementById("pendente-tbody"),
  foraCount: document.getElementById("fora-count"),
  foraBody: document.getElementById("fora-tbody"),
  timelineBody: document.getElementById("timeline-tbody"),
  tabOvernight: document.getElementById("tab-overnight"),
  tabDevelop: document.getElementById("tab-develop"),
};

const TABS = { overnight: el.tabOvernight, develop: el.tabDevelop };

/** Estado — 1 kind ativo por vez, filtros 100% client-side sobre o snapshot já buscado. */
let kind = "overnight";
let data = null; // último payload de /api/round/:kind
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

function renderQueueTable(tbody, countEl, rows, withReason) {
  const filtered = rows.filter(matchesFilters);
  countEl.textContent = String(filtered.length);
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
  for (const row of rows) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="mono">${escapeHtml(row.unidade)}</td>
      <td class="mono">${escapeHtml(row.inicio)}</td>
      <td class="mono">${escapeHtml(row.fim)}</td>
      <td class="mono">${escapeHtml(row.duracao)}</td>
      <td class="mono">${row.fixIteracoes > 0 ? row.fixIteracoes : "—"}</td>
    `;
    el.timelineBody.appendChild(tr);
  }
}

function renderMeta() {
  if (!data || !data.found) {
    el.meta.hidden = true;
    el.empty.hidden = !data || data.found !== false;
    if (el.empty.hidden === false) el.emptyDir.textContent = `data/${kind}/`;
    return;
  }
  el.empty.hidden = true;
  el.meta.hidden = false;
  el.metaSession.textContent = data.sessionId ?? "—";
  el.metaStarted.textContent = fmtTime(data.startedAt);
  el.metaLoop.textContent = data.loopEstendido === null ? "—" : data.loopEstendido ? "sim" : "não";
  el.metaPath.textContent = data.planPath ?? "—";
}

function renderAll() {
  el.sessionLabel.textContent = data && data.sessionId ? `${kind} — ${data.sessionId}` : kind;
  renderMeta();

  if (data && data.error) {
    el.error.hidden = false;
    el.error.textContent = `falha ao ler plan.json: ${data.error}`;
  } else {
    el.error.hidden = true;
  }

  const queue = (data && data.queue) || { entram: [], pendente: [], fora: [] };
  renderQueueTable(el.entramBody, el.entramCount, queue.entram, false);
  renderQueueTable(el.pendenteBody, el.pendenteCount, queue.pendente, true);
  renderQueueTable(el.foraBody, el.foraCount, queue.fora, true);
  renderTimeline((data && data.timeline) || []);

  el.lastUpdated.textContent = data ? `atualizado ${fmtTime(new Date().toISOString())}` : "";
}

async function fetchRound() {
  setFetchStatus("", "carregando…");
  try {
    const res = await fetch(`/api/round/${kind}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
    setFetchStatus(data.error ? "down" : "ok", data.error ? "erro" : "ok");
  } catch (e) {
    setFetchStatus("down", "falha ao buscar /api/round");
    data = { kind, found: false, error: String(e), queue: { entram: [], pendente: [], fora: [] }, timeline: [] };
  }
  renderAll();
}

function setActiveTab() {
  for (const [k, btn] of Object.entries(TABS)) {
    btn.classList.toggle("active", k === kind);
  }
}

function selectKind(newKind) {
  kind = newKind;
  setActiveTab();
  fetchRound();
}

el.tabOvernight.addEventListener("click", () => selectKind("overnight"));
el.tabDevelop.addEventListener("click", () => selectKind("develop"));
el.filterPriority.addEventListener("change", () => {
  filters.priority = el.filterPriority.value;
  renderAll();
});
el.filterLabel.addEventListener("change", () => {
  filters.label = el.filterLabel.value;
  renderAll();
});
el.refreshBtn.addEventListener("click", () => fetchRound());

// #3561 critério de aceite "timeline ao vivo, lendo plan.json via SSE": o
// servidor já observa data/{overnight,develop}/**/plan.json (plan-watch.ts)
// e emite um evento `plan` em /api/events sempre que mudar — refetch aqui
// mantém a fila/timeline sincronizadas sem polling próprio.
try {
  const events = new EventSource("/api/events");
  events.addEventListener("plan", (ev) => {
    try {
      const sig = JSON.parse(ev.data);
      if (sig.kind === kind) fetchRound();
    } catch {
      // payload malformado — ignora este tick, o próximo refresh manual cobre.
    }
  });
} catch {
  // EventSource indisponível (ambiente de teste/sem browser real) — a página
  // ainda funciona via "Atualizar" manual.
}

setActiveTab();
fetchRound();
