// relatorios.js (#3714) — cockpit de Relatórios: lista os relatórios de fim
// de trabalho (edição diária, overnight, develop, mensal) registrados via
// `GET /api/reports` (studio-reports.ts), mais recentes no topo. Vanilla JS,
// sem build step (mesmo princípio de triagem.js/app.js — #3555/#3562).
//
// READ-ONLY: só lista + linka pra `GET /relatorios/:id` (abre em nova aba,
// o conteúdo servido é o HTML/markdown-wrapped do relatório).

const el = {
  fetchDot: document.getElementById("fetch-dot"),
  fetchLabel: document.getElementById("fetch-label"),
  error: document.getElementById("reports-error"),
  empty: document.getElementById("reports-empty"),
  tbody: document.getElementById("reports-tbody"),
};

const KIND_LABEL = {
  edicao: "Edição",
  overnight: "Overnight",
  develop: "Develop",
  mensal: "Mensal",
};

function setFetchStatus(status, label) {
  el.fetchDot.className = "dot " + status; // "ok" | "down" | ""
  el.fetchLabel.textContent = label;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtTime(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("pt-BR", {
      timeZone: "America/Sao_Paulo",
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function kindBadge(kind) {
  const labelPt = KIND_LABEL[kind] ?? kind;
  return `<span class="track-badge track-${escapeHtml(kind)}">${escapeHtml(labelPt)}</span>`;
}

function renderReports(reports) {
  el.tbody.innerHTML = "";
  el.empty.hidden = reports.length > 0;
  for (const r of reports) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${kindBadge(r.kind)}</td>
      <td class="mono">${escapeHtml(r.sessionId)}</td>
      <td>${escapeHtml(r.title)}</td>
      <td class="mono">${escapeHtml(fmtTime(r.createdAt))}</td>
      <td><a href="${escapeHtml(r.url)}" target="_blank" rel="noopener">abrir &rarr;</a></td>
    `;
    el.tbody.appendChild(tr);
  }
}

async function refresh() {
  setFetchStatus("", "carregando…");
  try {
    const res = await fetch("/api/reports");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    el.error.hidden = true;
    renderReports(data.reports ?? []);
    setFetchStatus("ok", `${(data.reports ?? []).length} relatório(s)`);
  } catch (e) {
    el.error.hidden = false;
    el.error.textContent = `Falha ao carregar relatórios: ${e.message}`;
    setFetchStatus("down", "erro");
  }
}

refresh();
