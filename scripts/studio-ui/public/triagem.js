// triagem.js (#3562) — cockpit de triagem VISUAL: issues abertas + PRs
// abertos do GitHub, filtráveis por prioridade (P0-P3), label e trilha
// (overnight/develop/other, derivada do prefixo de branch do PR). Vanilla
// JS, sem build step (mesmo princípio de app.js/edicao.js — #3555/#3558).
//
// Escopo desta fatia (#3562): READ-ONLY. Nenhum botão aqui fecha, comenta ou
// mergeia — só lista + linka pro GitHub. Este módulo lê GET /api/issues
// (studio-issues.ts, server-side cache+throttle de `gh`); todo filtro de
// issues/PRs é 100% client-side sobre o snapshot já buscado — trocar filtro
// NUNCA dispara um novo fetch.
//
// #4004: a seção de composição de onda em preview foi removida — o
// mecanismo real de disparo já tinha sido descontinuado no #3985/#3720 (2
// tentativas de validação ao vivo sem sucesso; job-to-be-done coberto pelo
// chat drawer + `/diaria-develop` digitado direto), e o preview ficou órfão
// sem a execução real por trás.

const el = {
  fetchDot: document.getElementById("fetch-dot"),
  fetchLabel: document.getElementById("fetch-label"),
  error: document.getElementById("triage-error"),
  filterPriority: document.getElementById("filter-priority"),
  filterTrack: document.getElementById("filter-track"),
  filterDispatch: document.getElementById("filter-dispatch"),
  filterLabels: document.getElementById("filter-labels"),
  refreshBtn: document.getElementById("refresh-btn"),
  lastUpdated: document.getElementById("last-updated"),
  issuesCount: document.getElementById("issues-count"),
  issuesBody: document.getElementById("issues-tbody"),
  issuesEmpty: document.getElementById("issues-empty"),
  prsCount: document.getElementById("prs-count"),
  prsBody: document.getElementById("prs-tbody"),
  prsEmpty: document.getElementById("prs-empty"),
  dispatchTrackLegend: document.getElementById("dispatch-track-legend"),
};

/** Snapshot bruto da última resposta de /api/issues — filtros nunca refetcham. */
let data = { issues: [], prs: [], error: null, cached: false, generatedAt: null };

/** Estado dos filtros — 100% client-side. */
const filters = {
  priority: "",
  track: "",
  dispatch: "",
  labels: new Set(),
};

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

function setFetchStatus(status, label) {
  el.fetchDot.className = "dot " + status; // "ok" | "down" | ""
  el.fetchLabel.textContent = label;
}

function labelsBadges(labels) {
  if (!labels || labels.length === 0) return "";
  return labels.map((l) => `<span class="label-chip">${escapeHtml(l)}</span>`).join(" ");
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function priorityBadge(priority) {
  if (!priority) return '<span class="priority-badge priority-none">—</span>';
  return `<span class="priority-badge priority-${priority.toLowerCase()}">${priority}</span>`;
}

function trackBadge(track) {
  return `<span class="track-badge track-${track}">${track}</span>`;
}

// #3715 — significado de cada valor de Classificação (dispatchTrack), espelhando
// studio-issues.ts::classifyDispatchTrack. Exposto como tooltip (title=) em cada
// badge — a tabela não tinha nenhuma explicação por-valor, só a nota genérica
// acima do cabeçalho.
const DISPATCH_TRACK_EXPLAIN = {
  elegivel: "elegível — sem sinal de bloqueio; entra na análise de cluster/dispatch de onda.",
  bloqueada: "bloqueada — tem label de bloqueio real (ex: conta externa/decisão/credencial) e não entra na onda.",
  ambigua: "ambígua — o texto sugere possível bloqueio, mas é marcador fraco (não label); fica fora do dispatch automático até triagem humana.",
};

function dispatchBadge(track) {
  const labelPt = { elegivel: "elegível", bloqueada: "bloqueada", ambigua: "ambígua" }[track] ?? track;
  const title = DISPATCH_TRACK_EXPLAIN[track] ?? "";
  return `<span class="dispatch-badge dispatch-${track}" title="${escapeHtml(title)}">${labelPt}</span>`;
}

// #3874: o significado de cada valor de Classificação só existia como
// `title=` (tooltip) em cada badge da tabela — tooltip não existe em touch
// (R7 de docs/studio-ui-ux-guidelines.md). Renderiza a MESMA
// DISPATCH_TRACK_EXPLAIN como uma legenda em texto visível, 1x por página
// (não repetida por linha — evitaria poluir a tabela), logo acima da
// tabela de issues. `title=` continua nos badges individuais, como reforço
// pro hover no desktop.
function renderDispatchTrackLegend() {
  if (!el.dispatchTrackLegend) return;
  el.dispatchTrackLegend.innerHTML = Object.entries(DISPATCH_TRACK_EXPLAIN)
    .map(([track, explain]) => `<li><strong>${dispatchBadge(track)}</strong> — ${escapeHtml(explain)}</li>`)
    .join("");
}

function ciBadge(ciState) {
  const labelPt = { green: "verde", red: "vermelho", pending: "pendente", none: "sem checks" }[ciState] ?? ciState;
  return `<span class="ci-badge ci-${ciState}">${labelPt}</span>`;
}

function ageDays(iso, nowMs = Date.now()) {
  if (!iso) return null;
  const created = new Date(iso).getTime();
  if (Number.isNaN(created)) return null;
  return Math.max(0, Math.floor((nowMs - created) / 86_400_000));
}

function ageLabel(iso) {
  const days = ageDays(iso);
  if (days === null) return "—";
  if (days === 0) return "hoje";
  return `${days}d`;
}

/** Recalcula o conjunto de labels presentes em issues+PRs e desenha os
 * checkboxes de filtro — chamado só quando um NOVO snapshot chega (não a
 * cada mudança de filtro, pra não reconstruir/perder o estado dos checkboxes
 * marcados). */
function renderLabelFilters() {
  const allLabels = new Set();
  for (const i of data.issues) for (const l of i.labels) allLabels.add(l);
  for (const p of data.prs) for (const l of p.labels) allLabels.add(l);

  const sorted = [...allLabels].sort();
  el.filterLabels.innerHTML = "";
  for (const label of sorted) {
    const id = `label-filter-${label}`;
    const wrap = document.createElement("label");
    wrap.className = "label-filter-item";
    wrap.innerHTML = `<input type="checkbox" id="${id}" value="${escapeHtml(label)}" /> ${escapeHtml(label)}`;
    const input = wrap.querySelector("input");
    input.checked = filters.labels.has(label);
    input.addEventListener("change", () => {
      if (input.checked) filters.labels.add(label);
      else filters.labels.delete(label);
      renderTables();
    });
    el.filterLabels.appendChild(wrap);
  }
}

function matchesPriorityFilter(priority) {
  if (!filters.priority) return true;
  if (filters.priority === "none") return !priority;
  return priority === filters.priority;
}

function matchesLabelFilter(labels) {
  if (filters.labels.size === 0) return true;
  for (const wanted of filters.labels) {
    if (!labels.includes(wanted)) return false;
  }
  return true;
}

// #3874: "0 resultados para este filtro" (tabela zerou por causa de um
// filtro ativo, com dados de verdade escondidos atrás dele) é uma mensagem
// diferente de "nenhum registro ainda" (não há dado nenhum pra mostrar) —
// tabela só com cabeçalho e nada embaixo lê como bug em qualquer um dos 2
// casos (R4 de docs/studio-ui-ux-guidelines.md), então sempre existe 1 dos 2
// textos quando a lista filtrada zera. Mesmo padrão em toda tabela filtrável
// do Studio (relatorios.js é a referência original, só que sem filtro).
function updateEmptyState(emptyEl, filteredCount, totalCount, hasActiveFilter, emptyLabel) {
  if (!emptyEl) return;
  if (filteredCount > 0) {
    emptyEl.hidden = true;
    return;
  }
  emptyEl.hidden = false;
  emptyEl.textContent = totalCount > 0 && hasActiveFilter ? "0 resultados para este filtro." : emptyLabel;
}

function renderIssuesTable() {
  const filtered = data.issues.filter(
    (i) =>
      matchesPriorityFilter(i.priority) &&
      matchesLabelFilter(i.labels) &&
      (!filters.dispatch || i.dispatchTrack === filters.dispatch),
  );
  el.issuesCount.textContent = String(filtered.length);
  const issuesFilterActive = Boolean(filters.priority || filters.dispatch || filters.labels.size > 0);
  updateEmptyState(el.issuesEmpty, filtered.length, data.issues.length, issuesFilterActive, "Nenhuma issue aberta.");
  el.issuesBody.innerHTML = "";
  for (const i of filtered) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><a href="${i.url}" target="_blank" rel="noopener">#${i.number}</a></td>
      <td>${escapeHtml(i.title)}</td>
      <td>${priorityBadge(i.priority)}</td>
      <td>${dispatchBadge(i.dispatchTrack)}</td>
      <td>${labelsBadges(i.labels)}</td>
      <td class="mono">${ageLabel(i.createdAt)}</td>
      <td class="mono">${fmtTime(i.updatedAt)}</td>
    `;
    el.issuesBody.appendChild(tr);
  }
}

function renderPrsTable() {
  const filtered = data.prs.filter(
    (p) =>
      matchesPriorityFilter(p.priority) &&
      matchesLabelFilter(p.labels) &&
      (!filters.track || p.track === filters.track),
  );
  el.prsCount.textContent = String(filtered.length);
  const prsFilterActive = Boolean(filters.track || filters.labels.size > 0);
  updateEmptyState(el.prsEmpty, filtered.length, data.prs.length, prsFilterActive, "Nenhum PR aberto.");
  el.prsBody.innerHTML = "";
  for (const p of filtered) {
    const tr = document.createElement("tr");
    const draftTag = p.isDraft ? ' <span class="draft-tag">draft</span>' : "";
    tr.innerHTML = `
      <td><a href="${p.url}" target="_blank" rel="noopener">#${p.number}</a></td>
      <td>${escapeHtml(p.title)}${draftTag}</td>
      <td>${trackBadge(p.track)}</td>
      <td>${priorityBadge(p.priority)}</td>
      <td>${ciBadge(p.ciState)}</td>
      <td class="mono">${escapeHtml(p.reviewDecision ?? "—")}</td>
      <td>${labelsBadges(p.labels)}</td>
      <td class="mono">${fmtTime(p.updatedAt)}</td>
    `;
    el.prsBody.appendChild(tr);
  }
}

function renderTables() {
  renderIssuesTable();
  renderPrsTable();
}

function renderError() {
  if (data.error) {
    el.error.hidden = false;
    el.error.textContent = data.cached
      ? `gh falhou nesta tentativa (mostrando o último snapshot bom): ${data.error}`
      : `gh falhou e não há cache anterior: ${data.error}`;
  } else {
    el.error.hidden = true;
  }
}

function renderAll() {
  renderLabelFilters();
  renderTables();
  renderError();
  el.lastUpdated.textContent = data.generatedAt
    ? `atualizado ${fmtTime(data.generatedAt)}${data.cached ? " (cache)" : ""}`
    : "";
}

async function fetchIssues() {
  setFetchStatus("", "carregando…");
  try {
    const res = await fetch("/api/issues");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
    setFetchStatus(data.error ? "down" : "ok", data.error ? "erro no gh" : "ok");
  } catch (e) {
    setFetchStatus("down", "falha ao buscar /api/issues");
    data = { issues: data.issues, prs: data.prs, error: String(e), cached: true, generatedAt: data.generatedAt };
  }
  renderAll();
}

el.filterPriority.addEventListener("change", () => {
  filters.priority = el.filterPriority.value;
  renderTables();
});
el.filterTrack.addEventListener("change", () => {
  filters.track = el.filterTrack.value;
  renderTables();
});
el.filterDispatch.addEventListener("change", () => {
  filters.dispatch = el.filterDispatch.value;
  renderTables();
});
el.refreshBtn.addEventListener("click", () => fetchIssues());

// Estático (não depende de `data`) — renderiza 1x ao montar a página.
renderDispatchTrackLegend();
fetchIssues();
