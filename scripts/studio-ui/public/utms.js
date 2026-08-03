// utms.js (#4041) — página de inventário × realidade dos UTMs.
//
// Fetch de `GET /api/utms` (studio-utms.ts): o registry único cruzado com a
// conversão real do Beehiiv e o clique da Brevo, mais o drift nos dois
// sentidos. Mesmo padrão vanilla/sem-build de integracoes.js/triagem.js.
//
// EDIÇÃO ESCOPADA: o botão "Editar" só abre description/status/note. Os
// VALORES de UTM (source/medium/campaign) são renderizados como texto, nunca
// como campo — o backend também os rejeita (400), então a UI não é a única
// linha de defesa. Racional completo no header de studio-utms.ts.
//
// Ordenação/conversão (#4463): a lógica PURA vive em `utms-sort.js`, separada
// de propósito pra ser testável sem harness de DOM (mesmo padrão de
// `revisao-guards.js`).

import { computeConversion, fmtPercent, sortRows } from "./utms-sort.js";

const el = {
  fetchDot: document.getElementById("fetch-dot"),
  fetchLabel: document.getElementById("fetch-label"),
  execModeValue: document.getElementById("exec-mode-value"),
  error: document.getElementById("utms-error"),
  count: document.getElementById("utms-count"),
  filterStatus: document.getElementById("filter-status"),
  refreshBtn: document.getElementById("refresh-btn"),
  lastUpdated: document.getElementById("last-updated"),
  tbody: document.getElementById("utms-tbody"),
  empty: document.getElementById("utms-empty"),
  driftList: document.getElementById("drift-list"),
  driftCount: document.getElementById("drift-count"),
  driftEmpty: document.getElementById("drift-empty"),
  externalTbody: document.getElementById("external-tbody"),
  externalCount: document.getElementById("external-count"),
};

let data = {
  execMode: null,
  generatedAt: null,
  cached: false,
  emitters: [],
  externalSurfaces: [],
  drift: [],
};
const filters = { status: "" };
/** Estado de ordenação da tabela de Emissores (#4463) — a 1ª tabela ordenável
 * do Studio. `column: null` = ordem natural do registry (default). */
const sort = { column: null, direction: "asc" };
/** `<th>` (carrega `aria-sort`) e `<button>` (clicável, carrega o indicador
 * ▲/▼) das 3 colunas ordenáveis — atualizados juntos em `updateSortHeaders`. */
const sortHeaderCells = document.querySelectorAll("th[data-sort-col]");
const sortHeaderButtons = document.querySelectorAll("button[data-sort-col]");

function escapeHtml(s) {
  return String(s ?? "")
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

/** `null` = a fonte externa falhou (≠ zero real) — distinção que importa: um
 * "0" enganoso viraria falso alarme de "posição morta". */
function fmtNum(n) {
  return n === null || n === undefined ? "—" : String(n);
}

function updateSortHeaders() {
  for (const th of sortHeaderCells) {
    const col = th.getAttribute("data-sort-col");
    th.setAttribute(
      "aria-sort",
      sort.column !== col ? "none" : sort.direction === "asc" ? "ascending" : "descending",
    );
  }
  for (const btn of sortHeaderButtons) {
    const col = btn.getAttribute("data-sort-col");
    const indicator = btn.querySelector(".sort-indicator");
    if (!indicator) continue;
    indicator.textContent = sort.column !== col ? "" : sort.direction === "asc" ? "▲" : "▼";
  }
}

function statusBadge(status) {
  return `<span class="state-badge state-${escapeHtml(status)}">${escapeHtml(status)}</span>`;
}

function campaignCell(row) {
  const parts = [`<code>${escapeHtml(row.campaignPattern)}</code>`];
  if (row.campaigns && row.campaigns.length) {
    const top = row.campaigns
      .slice(0, 5)
      .map((c) => `${escapeHtml(c.campaign)} (${c.count})`)
      .join("<br>");
    parts.push(`<div class="hint">${top}</div>`);
    if (row.campaigns.length > 5) {
      parts.push(`<div class="hint">+${row.campaigns.length - 5} outras</div>`);
    }
  }
  return parts.join("");
}

function descCell(row) {
  const parts = [escapeHtml(row.description)];
  if (row.note) parts.push(`<div class="hint"><em>${escapeHtml(row.note)}</em></div>`);
  parts.push(`<div class="hint"><code>${escapeHtml(row.originFile)}</code></div>`);
  if (row.metadataEditedAt) {
    parts.push(`<div class="hint">metadados editados em ${escapeHtml(fmtTime(row.metadataEditedAt))}</div>`);
  }
  return parts.join("");
}

function renderDrift() {
  const drift = data.drift ?? [];
  el.driftCount.textContent = String(drift.length);
  el.driftEmpty.hidden = drift.length > 0;
  el.driftList.innerHTML = "";
  for (const f of drift) {
    const li = document.createElement("li");
    li.innerHTML = `<strong>${escapeHtml(f.kind === "sem_conversao" ? "sem conversão" : "não catalogado")}</strong> — ${escapeHtml(f.detail)}`;
    el.driftList.appendChild(li);
  }
}

function renderEmitters() {
  const all = data.emitters ?? [];
  const filtered = all.filter((e) => !filters.status || e.status === filters.status);
  const sorted = sortRows(filtered, sort.column, sort.direction);
  el.count.textContent = String(filtered.length);
  if (filtered.length === 0) {
    el.empty.hidden = false;
    el.empty.textContent =
      all.length > 0 && filters.status ? "0 resultados para este filtro." : "Nenhum emissor no registry.";
  } else {
    el.empty.hidden = true;
  }
  updateSortHeaders();
  el.tbody.innerHTML = "";
  for (const row of sorted) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${fmtNum(row.clicks)}</td>
      <td>${fmtNum(row.subscribers)}</td>
      <td>${fmtPercent(computeConversion(row))}</td>
      <td>${escapeHtml(row.label)}</td>
      <td class="mono"><code>${escapeHtml(row.source)}</code> / <code>${escapeHtml(row.medium)}</code></td>
      <td class="mono">${campaignCell(row)}</td>
      <td>${statusBadge(row.status)}</td>
      <td>${descCell(row)}</td>
      <td><button type="button" data-edit-id="${escapeHtml(row.id)}">Editar</button></td>
    `;
    el.tbody.appendChild(tr);
  }
}

/** Superfícies externas (#4525) — read-only por natureza: o valor não muda por
 * aqui nem por PR, muda quando alguém cola a URL no painel da plataforma. Por
 * isso a tabela mostra a URL pronta e o caminho do campo, sem botão de editar. */
function renderExternalSurfaces() {
  const rows = data.externalSurfaces ?? [];
  el.externalCount.textContent = String(rows.length);
  el.externalTbody.innerHTML = "";
  for (const row of rows) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${fmtNum(row.clicks)}</td>
      <td>${fmtNum(row.campaignSubscribers)}</td>
      <td>${escapeHtml(row.label)}<div class="hint">${escapeHtml(row.description)}</div></td>
      <td class="mono"><code>${escapeHtml(row.source)}</code> / <code>${escapeHtml(row.medium)}</code> / <code>${escapeHtml(row.campaign)}</code><div class="hint"><code>${escapeHtml(row.url)}</code></div></td>
      <td>${row.appliedAt ? escapeHtml(row.appliedAt) : '<span class="hint">pendente</span>'}</td>
      <td><a href="${escapeHtml(row.panelUrl)}" target="_blank" rel="noreferrer noopener">painel</a><div class="hint">${escapeHtml(row.field)}</div></td>
    `;
    el.externalTbody.appendChild(tr);
  }
}

/** Edição inline via prompt — só os 3 campos editoriais. Deliberadamente sem
 * formulário pra source/medium/campaign: eles não são editáveis por aqui. */
async function editRow(id) {
  const row = (data.emitters ?? []).find((e) => e.id === id);
  if (!row) return;
  const description = window.prompt(`Descrição da posição — ${row.label}`, row.description ?? "");
  if (description === null) return;
  const note = window.prompt(`Nota do editor (opcional) — ${row.label}`, row.note ?? "");
  if (note === null) return;
  const status = window.prompt(
    `Status — ${row.label} (ativo | aposentado)`,
    row.status ?? "ativo",
  );
  if (status === null) return;

  try {
    const res = await fetch(`/api/utms/${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description, note, status: status.trim() }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.ok === false) {
      throw new Error(body.error || `HTTP ${res.status}`);
    }
    await refresh(true);
  } catch (e) {
    el.error.hidden = false;
    el.error.textContent = `Falha ao salvar metadados: ${e.message}`;
  }
}

async function refresh(forceRefresh) {
  setFetchStatus("", "carregando…");
  try {
    const res = await fetch(forceRefresh ? "/api/utms?refresh=1" : "/api/utms");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
    const avisos = [data.beehiivError, data.brevoError].filter(Boolean);
    if (avisos.length) {
      el.error.hidden = false;
      el.error.textContent = `Dados parciais — ${avisos.join(" | ")}`;
    } else {
      el.error.hidden = true;
    }
    el.execModeValue.textContent = data.execMode ? `ambiente: ${data.execMode}` : "—";
    renderDrift();
    renderEmitters();
    renderExternalSurfaces();
    setFetchStatus("ok", `${(data.emitters ?? []).length} emissor(es)${data.cached ? " (cache)" : ""}`);
    el.lastUpdated.textContent = data.generatedAt ? `gerado em ${fmtTime(data.generatedAt)}` : "";
  } catch (e) {
    el.error.hidden = false;
    el.error.textContent = `Falha ao carregar UTMs: ${e.message}`;
    setFetchStatus("down", "erro");
  }
}

el.filterStatus.addEventListener("change", () => {
  filters.status = el.filterStatus.value;
  renderEmitters();
});

for (const btn of sortHeaderButtons) {
  btn.addEventListener("click", () => {
    const col = btn.getAttribute("data-sort-col");
    if (sort.column === col) {
      sort.direction = sort.direction === "asc" ? "desc" : "asc";
    } else {
      sort.column = col;
      // 1º clique numa coluna nova começa por "maior primeiro" — é a leitura
      // mais comum pra achar quem mais converte/clica (#4463).
      sort.direction = "desc";
    }
    renderEmitters();
  });
}

el.refreshBtn.addEventListener("click", () => refresh(true));

el.tbody.addEventListener("click", (ev) => {
  const btn = ev.target.closest("[data-edit-id]");
  if (btn) editRow(btn.getAttribute("data-edit-id"));
});

refresh(false);
