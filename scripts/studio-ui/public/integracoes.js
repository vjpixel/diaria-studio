// integracoes.js (#3848) — página de status de todas as integrações (APIs +
// MCPs): fetch de GET /api/integrations (studio-integrations.ts), render em
// tabela + filtro client-side por tipo (mesmo padrão de triagem.js/apoios.js
// — #3555/#3562/#3602). Vanilla JS, sem build step.
//
// READ-ONLY: só lista + botão "Atualizar" (força bypass do cache de 5min via
// ?refresh=1) — nenhuma mutação nesta página.

const el = {
  fetchDot: document.getElementById("fetch-dot"),
  fetchLabel: document.getElementById("fetch-label"),
  execModeValue: document.getElementById("exec-mode-value"),
  error: document.getElementById("integrations-error"),
  count: document.getElementById("integrations-count"),
  filterKind: document.getElementById("filter-kind"),
  refreshBtn: document.getElementById("refresh-btn"),
  lastUpdated: document.getElementById("last-updated"),
  tbody: document.getElementById("integrations-tbody"),
  empty: document.getElementById("integrations-empty"),
};

/** Snapshot bruto da última resposta de /api/integrations. */
let data = { execMode: null, generatedAt: null, cached: false, integrations: [] };

const filters = { kind: "" };

const CONFIGURED_LABEL = {
  configured: "configurada",
  partial: "parcial",
  not_configured: "não configurada",
  unknown: "desconhecida",
};

const REACHABLE_LABEL = {
  reachable: "alcançável",
  unreachable: "inalcançável",
  error: "erro",
  not_verified: "não verificável",
  skipped: "não tentado",
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

function kindBadge(kind) {
  const label = kind === "mcp" ? "MCP" : "API";
  return `<span class="kind-badge kind-${escapeHtml(kind)}">${escapeHtml(label)}</span>`;
}

function stateBadge(state, labelMap) {
  const label = labelMap[state] ?? state;
  return `<span class="state-badge state-${escapeHtml(state)}">${escapeHtml(label)}</span>`;
}

function noteCell(integration) {
  const parts = [];
  if (integration.note) parts.push(escapeHtml(integration.note));
  if (integration.missingEnvVars && integration.missingEnvVars.length) {
    parts.push(`<span class="missing-vars">ausente: ${integration.missingEnvVars.map(escapeHtml).join(", ")}</span>`);
  }
  if (integration.error) {
    parts.push(`<span class="probe-error">${escapeHtml(integration.error)}</span>`);
  }
  return `<div class="integrations-note">${parts.join("")}</div>`;
}

function renderIntegrations() {
  const filtered = data.integrations.filter((i) => !filters.kind || i.kind === filters.kind);
  el.count.textContent = String(filtered.length);
  // #3874: "0 resultados para este filtro" vs "nenhuma integração" — mesmo
  // padrão de triagem.js/apoios.js (R4 de docs/studio-ui-ux-guidelines.md).
  if (filtered.length === 0) {
    el.empty.hidden = false;
    el.empty.textContent =
      data.integrations.length > 0 && filters.kind ? "0 resultados para este filtro." : "Nenhuma integração cadastrada.";
  } else {
    el.empty.hidden = true;
  }
  el.tbody.innerHTML = "";
  for (const integration of filtered) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(integration.name)}</td>
      <td>${kindBadge(integration.kind)}</td>
      <td>${stateBadge(integration.configured, CONFIGURED_LABEL)}</td>
      <td>${stateBadge(integration.reachable, REACHABLE_LABEL)}</td>
      <td class="mono">${escapeHtml(fmtTime(integration.checkedAt))}</td>
      <td>${noteCell(integration)}</td>
    `;
    el.tbody.appendChild(tr);
  }
}

async function refresh(forceRefresh) {
  setFetchStatus("", "carregando…");
  try {
    const url = forceRefresh ? "/api/integrations?refresh=1" : "/api/integrations";
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
    el.error.hidden = true;
    el.execModeValue.textContent = data.execMode ? `ambiente: ${data.execMode}` : "—";
    renderIntegrations();
    setFetchStatus("ok", `${data.integrations.length} integração(ões)${data.cached ? " (cache)" : ""}`);
    el.lastUpdated.textContent = data.generatedAt ? `gerado em ${fmtTime(data.generatedAt)}` : "";
  } catch (e) {
    el.error.hidden = false;
    el.error.textContent = `Falha ao carregar integrações: ${e.message}`;
    setFetchStatus("down", "erro");
  }
}

el.filterKind.addEventListener("change", () => {
  filters.kind = el.filterKind.value;
  renderIntegrations();
});

el.refreshBtn.addEventListener("click", () => refresh(true));

refresh(false);
