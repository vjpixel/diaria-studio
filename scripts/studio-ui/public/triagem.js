// triagem.js (#3562) — cockpit de triagem VISUAL: issues abertas + PRs
// abertos do GitHub, filtráveis por prioridade (P0-P3), label e trilha
// (overnight/develop/other, derivada do prefixo de branch do PR). Vanilla
// JS, sem build step (mesmo princípio de app.js/edicao.js — #3555/#3558).
//
// Escopo desta fatia (#3562): READ-ONLY. Nenhum botão aqui fecha, comenta ou
// mergeia — só lista + linka pro GitHub. Este módulo lê GET /api/issues
// (studio-issues.ts, server-side cache+throttle de `gh`) e GET /api/waves
// (studio-waves.ts, mesmo snapshot cacheado — composição de wave PREVIEW);
// todo filtro de issues/PRs é 100% client-side sobre o snapshot já buscado —
// trocar filtro NUNCA dispara um novo fetch. O botão "Disparar esta onda"
// fica sempre desabilitado nesta fatia: a execução de verdade depende da
// sessão de chat/ações (#3556/#3557), ainda não construída.

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
  prsCount: document.getElementById("prs-count"),
  prsBody: document.getElementById("prs-tbody"),
  wavesError: document.getElementById("waves-error"),
  waveCount: document.getElementById("wave-count"),
  waveChips: document.getElementById("wave-chips"),
  waveDeferredCount: document.getElementById("wave-deferred-count"),
  waveDeferredChips: document.getElementById("wave-deferred-chips"),
  waveCapacityWarning: document.getElementById("wave-capacity-warning"),
  waveClusters: document.getElementById("wave-clusters"),
  waveMaxConcurrency: document.getElementById("wave-max-concurrency"),
  fireWaveBtn: document.getElementById("fire-wave-btn"),
};

/** Snapshot bruto da última resposta de /api/issues — filtros nunca refetcham. */
let data = { issues: [], prs: [], error: null, cached: false, generatedAt: null };

/** Snapshot bruto da última resposta de /api/waves. */
let waveData = { wave: [], deferred: [], clusters: [], overCapacity: false, maxConcurrency: 6, consideredIds: [], error: null };

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
// studio-waves.ts::classifyDispatchTrack. Exposto como tooltip (title=) em cada
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

function renderIssuesTable() {
  const filtered = data.issues.filter(
    (i) =>
      matchesPriorityFilter(i.priority) &&
      matchesLabelFilter(i.labels) &&
      (!filters.dispatch || i.dispatchTrack === filters.dispatch),
  );
  el.issuesCount.textContent = String(filtered.length);
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

function issueLink(number) {
  const issue = data.issues.find((i) => i.number === number);
  return issue ? issue.url : `#${number}`;
}

function chipRow(container, ids, extraClass = "") {
  container.innerHTML = "";
  for (const id of ids) {
    const a = document.createElement("a");
    a.href = issueLink(id);
    a.target = "_blank";
    a.rel = "noopener";
    a.className = `wave-chip ${extraClass}`.trim();
    a.textContent = `#${id}`;
    container.appendChild(a);
  }
}

function renderWaves() {
  if (waveData.error) {
    el.wavesError.hidden = false;
    el.wavesError.textContent = `falha ao montar a proposta de wave: ${waveData.error}`;
  } else {
    el.wavesError.hidden = true;
  }

  el.waveMaxConcurrency.textContent = String(waveData.maxConcurrency ?? 6);
  el.waveCount.textContent = String(waveData.wave.length);
  el.waveDeferredCount.textContent = String(waveData.deferred.length);
  chipRow(el.waveChips, waveData.wave, "wave-chip-active");
  chipRow(el.waveDeferredChips, waveData.deferred, "wave-chip-deferred");

  if (waveData.overCapacity) {
    el.waveCapacityWarning.hidden = false;
    el.waveCapacityWarning.textContent =
      `A onda candidata excedeu o teto de ${waveData.maxConcurrency} concorrentes — ` +
      `só as primeiras ${waveData.maxConcurrency} (por prioridade) entram nesta onda; o resto fica pra próxima.`;
  } else {
    el.waveCapacityWarning.hidden = true;
  }

  el.waveClusters.innerHTML = "";
  const multi = waveData.clusters.filter((c) => c.ids.length > 1);
  if (multi.length === 0) {
    el.waveClusters.innerHTML = '<p class="hint">Nenhum cluster de conflito — todas as issues elegíveis são singletons.</p>';
  }
  for (const c of multi) {
    const card = document.createElement("div");
    card.className = "cluster-card";
    const repr = c.ids[0];
    card.innerHTML = `
      <div class="cluster-ids">
        <span class="wave-chip wave-chip-active">#${repr} (representante)</span>
        ${c.ids
          .slice(1)
          .map((id) => `<span class="wave-chip wave-chip-deferred">#${id}</span>`)
          .join(" ")}
      </div>
      <div class="cluster-files">${c.files.map((f) => `<code>${escapeHtml(f)}</code>`).join(" ")}</div>
    `;
    el.waveClusters.appendChild(card);
  }
}

async function fetchWaves() {
  try {
    const res = await fetch("/api/waves");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    waveData = await res.json();
  } catch (e) {
    waveData = { ...waveData, error: String(e) };
  }
  renderWaves();
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
  await fetchWaves();
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

fetchIssues();
