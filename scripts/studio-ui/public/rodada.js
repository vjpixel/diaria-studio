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
//
// #3874: `.round-kind-tabs` segue o padrão WAI-ARIA APG completo agora
// (`role="tab"` já vem do HTML; `aria-selected`/tabindex roving/navegação
// por setas são geridos aqui via tablist-core.js, compartilhado com
// revisao.js).

import { nextTabIndex, syncTabAria } from "./tablist-core.js";
import { unitAge, roundFreshness } from "./rodada-round-age.js";

const el = {
  fetchDot: document.getElementById("fetch-dot"),
  fetchLabel: document.getElementById("fetch-label"),
  connDot: document.getElementById("conn-dot"),
  connLabel: document.getElementById("conn-label"),
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
  entramEmpty: document.getElementById("entram-empty"),
  pendenteCount: document.getElementById("pendente-count"),
  pendenteBody: document.getElementById("pendente-tbody"),
  pendenteEmpty: document.getElementById("pendente-empty"),
  foraCount: document.getElementById("fora-count"),
  foraBody: document.getElementById("fora-tbody"),
  foraEmpty: document.getElementById("fora-empty"),
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

// #3889: indicador de conexão do SSE (`/api/events`), separado do
// fetch-status acima (que só reflete o REST `/api/round/:kind`). Mesmo
// padrão de `edicao.js`/`app.js` (`setConn` + handlers `open`/`error` do
// EventSource) — antes, uma queda de SSE aqui não tinha NENHUM sinal visual:
// a timeline simplesmente parava de atualizar, sem aviso.
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
// relatorios.js, R4 de docs/studio-ui-ux-guidelines.md) — mesma distinção de
// triagem.js, aplicada aqui às 3 tabelas de fila (entram/pendente/fora).
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
    // renderizava IDÊNTICA a uma progredindo normalmente — só dava pra saber
    // abrindo o terminal. Badge "rodando" + idade desde o último timeline.*
    // registrado, escalando pro mesmo tratamento visual de alerta quando
    // `stale` (acima do limiar de `computeStageAge`).
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
    // Só mostra "nenhuma sessão encontrada" quando o SERVIDOR respondeu
    // found:false — nunca quando a própria requisição falhou (fetchFailed),
    // senão uma falha de rede/servidor fora do ar aparenta "sessão ausente"
    // em vez do problema real (ver banner de erro em renderAll()).
    el.empty.hidden = fetchFailed || !data || data.found !== false;
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

// #3561 self-review (PR #3622): `fetchFailed` distingue "a requisição pra
// /api/round/:kind falhou" (rede, HTTP != 2xx) de `data.found === false`
// ("o servidor respondeu 200 mas não achou nenhuma sessão desse kind") —
// antes, o catch de fetchRound() reusava `found:false` pros dois casos, o
// que fazia uma falha de rede exibir "Nenhuma sessão encontrada" (a mesma
// empty-state de um plan.json genuinamente ausente) e o banner de erro dizer
// "falha ao ler plan.json" pra um erro que nem chegou a tocar o servidor.
let fetchFailed = false;

function renderAll() {
  el.sessionLabel.textContent = data && data.sessionId ? `${kind} — ${data.sessionId}` : kind;
  renderMeta();

  if (fetchFailed) {
    el.error.hidden = false;
    el.error.textContent = `falha ao buscar /api/round/${kind}: ${data && data.error}`;
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

  // Só mostra "atualizado" quando o fetch de fato completou com sucesso — na
  // falha, o texto anterior (ou vazio) fica, em vez de sugerir falsamente um
  // refresh bem-sucedido.
  //
  // #3889: `roundFreshness` (rodada-round-age.js) usa `data.updatedAt` (mtime
  // REAL do plan.json, vindo do servidor) em vez de `new Date()` local —
  // antes, uma rodada travada há horas ainda dizia "atualizado agora" a cada
  // refresh, porque o timestamp media o momento do FETCH no cliente, não de
  // quando os dados de fato mudaram (mesmo padrão de `data.generatedAt` em
  // triagem.js). Quando o plan.json não muda entre duas chamadas, `updatedAt`
  // também não muda — o rótulo não avança, denunciando o falso-frescor. O
  // badge de possível stall (`stale`) só liga quando há unidade "em
  // andamento" na timeline — ver doc-comment de `roundFreshness`.
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

async function fetchRound() {
  setFetchStatus("", "carregando…");
  try {
    const res = await fetch(`/api/round/${kind}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
    fetchFailed = false;
    setFetchStatus(data.error ? "down" : "ok", data.error ? "erro" : "ok");
  } catch (e) {
    fetchFailed = true;
    setFetchStatus("down", "falha ao buscar /api/round");
    data = { kind, found: false, error: String(e), queue: { entram: [], pendente: [], fora: [] }, timeline: [] };
  }
  renderAll();
}

const TAB_ORDER = ["overnight", "develop"];

function setActiveTab() {
  for (const [k, btn] of Object.entries(TABS)) {
    btn.classList.toggle("active", k === kind);
  }
  syncTabAria(Object.values(TABS), (btn) => btn === TABS[kind]);
}

function selectKind(newKind) {
  kind = newKind;
  setActiveTab();
  fetchRound();
}

el.tabOvernight.addEventListener("click", () => selectKind("overnight"));
el.tabDevelop.addEventListener("click", () => selectKind("develop"));

// #3874: navegação por setas (WAI-ARIA APG) — ArrowLeft/ArrowRight/Home/End
// movem o foco E ativam a aba (ativação automática, adequada aqui: trocar
// de kind é barato/reversível, sem razão pra exigir Enter/Espaço extra).
el.tabOvernight.parentElement.addEventListener("keydown", (ev) => {
  const currentIndex = TAB_ORDER.indexOf(kind);
  const idx = nextTabIndex(ev.key, currentIndex, TAB_ORDER.length);
  if (idx === null) return;
  ev.preventDefault();
  const nextKind = TAB_ORDER[idx];
  selectKind(nextKind);
  TABS[nextKind].focus();
});
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
//
// #3889: antes, este `EventSource` não tinha handlers `open`/`error` nem
// nenhum indicador visual — uma queda de SSE fazia a timeline simplesmente
// congelar, sem aviso (o único resgate era o botão "Atualizar" manual, que o
// editor só saberia usar se desconfiasse do problema). Agora reflete o
// estado real em `conn-dot`/`conn-label` (mesmo padrão de `edicao.js`).
function connect() {
  try {
    const events = new EventSource("/api/events");
    events.addEventListener("open", () => setConn("ok"));
    events.addEventListener("error", () => setConn("down"));
    events.addEventListener("plan", (ev) => {
      try {
        const sig = JSON.parse(ev.data);
        if (sig.kind === kind) fetchRound();
      } catch {
        // payload malformado — ignora este tick, o próximo refresh manual cobre.
      }
    });
  } catch {
    // EventSource indisponível (ambiente de teste/sem browser real) — a
    // página ainda funciona via "Atualizar" manual; o dot fica em
    // "conectando…" (não é uma queda real, é ausência do recurso).
  }
}

// #3889: tick local de 30s (mesmo padrão de edicao.js, #3871) — sem isto, o
// badge de idade por-unidade e o badge de possível stall só recalculariam no
// próximo fetch (SSE `plan` ou clique manual). Justo o cenário de rodada
// travada (sem eventos novos, sem SSE) nunca dispararia nenhum dos dois —
// exatamente o que este recurso deveria denunciar. Redesenha a partir do
// `data` já em memória, sem refetch.
setInterval(() => {
  if (data) renderAll();
}, 30_000);

setActiveTab();
connect();
fetchRound();
