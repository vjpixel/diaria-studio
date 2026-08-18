// tarefas.js (#4799) — página de status das tarefas agendadas: fetch de
// GET /api/tasks (studio-tasks.ts), render em tabela + filtro client-side
// por status (mesmo padrão de integracoes.js/triagem.js — #3555/#3848).
// Vanilla JS, sem build step.
//
// READ-ONLY: só lista + botão "Atualizar" (força bypass do cache de 2min
// via ?refresh=1) — nenhuma ação (rodar agora/habilitar/desabilitar) nesta
// página (issue #4799 escopo — "2ª fatia, opcional").

import { matchesStatusFilter, formatDuration } from "./tarefas-guards.js";

const el = {
  fetchDot: document.getElementById("fetch-dot"),
  fetchLabel: document.getElementById("fetch-label"),
  execModeValue: document.getElementById("exec-mode-value"),
  error: document.getElementById("tasks-error"),
  count: document.getElementById("tasks-count"),
  filterStatus: document.getElementById("filter-status"),
  refreshBtn: document.getElementById("refresh-btn"),
  lastUpdated: document.getElementById("last-updated"),
  tbody: document.getElementById("tasks-tbody"),
  empty: document.getElementById("tasks-empty"),
};

/** Snapshot bruto da última resposta de /api/tasks. */
let data = { execMode: null, generatedAt: null, cached: false, overdueGraceMinutes: null, tasks: [] };

const filters = { status: "" };

const ARMED_LABEL = {
  armed: "armada",
  disabled: "desabilitada",
  not_armed: "não armada",
  cannot_verify: "não sei verificar",
};

const OUTCOME_LABEL = {
  ok: "sucesso",
  failed: "falha",
  guard_skip: "pulada (guard)",
  guard_abort: "abortada (guard)",
  unknown: "desconhecido",
};

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function setFetchStatus(status, label) {
  el.fetchDot.className = "dot " + status; // "ok" | "down" | ""
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
      second: "2-digit",
    });
  } catch {
    return iso;
  }
}

function armedCell(task) {
  const badge = `<span class="state-badge state-${escapeHtml(task.armed?.state ?? "cannot_verify")}">${escapeHtml(
    ARMED_LABEL[task.armed?.state] ?? task.armed?.state ?? "?",
  )}</span>`;
  const note = task.armed?.note
    ? `<div class="reachable-subtext">${escapeHtml(task.armed.note)}</div>`
    : "";
  return `${badge}${note}`;
}

function lastRunCell(task) {
  const started = fmtTime(task.lastRun?.startedAt);
  if (!task.lastRun?.startedAt) {
    return `<span class="hint">nunca rodou (ou log ausente)</span>`;
  }
  const duration = formatDuration(task.lastRun?.durationMs);
  return `${escapeHtml(started)}<div class="reachable-subtext">duração ~${escapeHtml(duration)}</div>`;
}

function outcomeCell(task) {
  const outcome = task.lastRun?.outcome;
  if (!outcome) return `<span class="hint">—</span>`;
  const badge = `<span class="state-badge state-outcome-${escapeHtml(outcome)}">${escapeHtml(
    OUTCOME_LABEL[outcome] ?? outcome,
  )}</span>`;
  const steps = (task.lastRun?.steps ?? [])
    .map((s) => `${escapeHtml(s.key)}=${s.code === null ? "?" : s.code}`)
    .join(" ");
  const stepsHtml = steps ? `<div class="reachable-subtext mono">${escapeHtml(steps)}</div>` : "";
  const excerpt = task.lastRun?.excerpt
    ? `<details class="log-excerpt"><summary>trecho do log</summary><pre>${escapeHtml(task.lastRun.excerpt)}</pre></details>`
    : "";
  return `${badge}${stepsHtml}${excerpt}`;
}

function renderTasks() {
  const filtered = data.tasks.filter((t) => matchesStatusFilter(t, filters.status));
  el.count.textContent = String(filtered.length);
  if (filtered.length === 0) {
    el.empty.hidden = false;
    el.empty.textContent =
      data.tasks.length > 0 && filters.status ? "0 resultados para este filtro." : "Nenhuma tarefa agendada.";
  } else {
    el.empty.hidden = true;
  }
  el.tbody.innerHTML = "";
  for (const task of filtered) {
    const tr = document.createElement("tr");
    if (task.overdue) tr.classList.add("row-overdue");
    tr.innerHTML = `
      <td>
        <strong>${escapeHtml(task.name)}</strong>
        <div class="reachable-subtext">${escapeHtml(task.description)} · ${escapeHtml(task.issue)}</div>
        ${task.error ? `<div class="probe-error">erro ao avaliar: ${escapeHtml(task.error)}</div>` : ""}
      </td>
      <td class="mono">${escapeHtml(task.scheduleLabel)}</td>
      <td>${armedCell(task)}</td>
      <td>${lastRunCell(task)}</td>
      <td>${outcomeCell(task)}</td>
      <td class="mono">${escapeHtml(fmtTime(task.nextRunAt))}</td>
      <td>${task.overdue ? '<span class="state-badge state-overdue">atrasada</span>' : "—"}</td>
    `;
    el.tbody.appendChild(tr);
  }
}

async function refresh(forceRefresh) {
  setFetchStatus("", "carregando…");
  try {
    const url = forceRefresh ? "/api/tasks?refresh=1" : "/api/tasks";
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
    el.error.hidden = true;
    el.execModeValue.textContent = data.execMode ? `ambiente: ${data.execMode}` : "—";
    renderTasks();
    const overdueCount = data.tasks.filter((t) => t.overdue).length;
    const overdueNote = overdueCount > 0 ? `, ${overdueCount} atrasada(s)` : "";
    setFetchStatus("ok", `${data.tasks.length} tarefa(s)${overdueNote}${data.cached ? " (cache)" : ""}`);
    el.lastUpdated.textContent = data.generatedAt ? `gerado em ${fmtTime(data.generatedAt)}` : "";
  } catch (e) {
    el.error.hidden = false;
    el.error.textContent = `Falha ao carregar tarefas: ${e.message}`;
    setFetchStatus("down", "erro");
  }
}

el.filterStatus.addEventListener("change", () => {
  filters.status = el.filterStatus.value;
  renderTasks();
});

el.refreshBtn.addEventListener("click", () => refresh(true));

refresh(false);
