// ads.js (#5236) — página de custo por leitor por canal: fetch de
// GET /api/ads (studio-ads.ts), render de um resumo de 4 respostas + tabela
// por canal. Vanilla JS, sem build step (mesmo padrão de tarefas.js/integracoes.js).
//
// READ-ONLY: só lista + botão "Atualizar" (bypassa o cache de 10min via
// ?refresh=1) — nenhuma edição de spend.csv nesta página (import manual é
// fora do Studio, ver `scripts/seed-spend-csv.ts`/CLAUDE.md).

const el = {
  fetchDot: document.getElementById("fetch-dot"),
  fetchLabel: document.getElementById("fetch-label"),
  execModeValue: document.getElementById("exec-mode-value"),
  error: document.getElementById("ads-error"),
  nodata: document.getElementById("ads-nodata"),
  summaryPanel: document.getElementById("ads-summary-panel"),
  summaryGrid: document.getElementById("ads-summary-grid"),
  tablePanel: document.getElementById("ads-table-panel"),
  count: document.getElementById("ads-count"),
  warnings: document.getElementById("ads-warnings"),
  refreshBtn: document.getElementById("refresh-btn"),
  lastUpdated: document.getElementById("last-updated"),
  tbody: document.getElementById("ads-tbody"),
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

function fmtPct(frac) {
  if (frac == null) return "—";
  return (frac * 100).toFixed(1) + "%";
}

function fmtBrl(n) {
  if (n == null) return "—";
  return "R$ " + n.toFixed(2).replace(".", ",");
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

function amostraQualifier(row) {
  if (row.amostraVazia) return "vazia";
  if (row.amostraPequena) return "pequena";
  if (row.amostraInstavel) return "instável";
  return null;
}

function tile(label, value, sub) {
  return `<div class="ads-tile"><div class="ads-tile-label">${escapeHtml(label)}</div><div class="ads-tile-value">${value}</div>${
    sub ? `<div class="ads-tile-sub">${sub}</div>` : ""
  }</div>`;
}

/** Monta os 4 tiles de resumo — as 4 perguntas de 5 segundos da issue #5236. */
function renderSummary(data) {
  const report = data.report;
  const budget = data.budget;
  const tiles = [];

  // 1) Qual canal traz leitor mais barato, e com que n?
  const measured = report ? report.rows.filter((r) => r.kind === "measured" && r.custoPorLeitor != null) : [];
  if (measured.length > 0) {
    const cheapest = measured.reduce((a, b) => (a.custoPorLeitor <= b.custoPorLeitor ? a : b));
    tiles.push(
      tile(
        "Leitor mais barato",
        `${escapeHtml(cheapest.canal)} · ${fmtBrl(cheapest.custoPorLeitor)}`,
        `n=${cheapest.amostraConsiderada}${amostraQualifier(cheapest) ? " · amostra " + amostraQualifier(cheapest) : ""}`,
      ),
    );
  } else {
    tiles.push(tile("Leitor mais barato", "—", "nenhum canal medido com leitores"));
  }

  // 2) A coorte de cada canal lê mais ou menos que a base?
  if (report && report.base.aberturaAgregada != null) {
    const belowBase = report.rows.filter(
      (r) => r.kind === "measured" && r.aberturaAgregada != null && r.aberturaAgregada < report.base.aberturaAgregada,
    ).length;
    const totalMeasured = report.rows.filter((r) => r.kind === "measured" && r.aberturaAgregada != null).length;
    tiles.push(
      tile(
        "Abertura vs. base",
        `base ${fmtPct(report.base.aberturaAgregada)}`,
        totalMeasured > 0 ? `${belowBase}/${totalMeasured} canal(is) abrem abaixo da base` : "sem canal medido",
      ),
    );
  } else {
    tiles.push(tile("Abertura vs. base", "—", "sem dado de base"));
  }

  // 3) Quanto do orçamento do mês já foi consumido?
  if (budget) {
    tiles.push(
      tile(
        `Orçamento ${escapeHtml(budget.monthKey)}`,
        `${fmtBrl(budget.spentBrl)} / ${fmtBrl(budget.budgetFloorBrl)}`,
        `${fmtPct(budget.fractionUsed)} do piso conhecido`,
      ),
    );
  } else {
    tiles.push(tile("Orçamento do mês", "—", "sem dado"));
  }

  // 4) Algum canal degradou desde o último período?
  if (report) {
    const degraded = report.rows.filter((r) => r.kind === "measured" && r.degradado === true);
    const withHistory = report.rows.filter((r) => r.kind === "measured" && r.degradado !== null);
    if (withHistory.length === 0) {
      tiles.push(tile("Degradação", "—", "sem snapshot anterior pra comparar"));
    } else if (degraded.length > 0) {
      tiles.push(tile("Degradação", `⚠ ${degraded.map((r) => r.canal).join(", ")}`, "abertura caiu vs. snapshot anterior"));
    } else {
      tiles.push(tile("Degradação", "nenhuma", "estável desde o snapshot anterior"));
    }
  } else {
    tiles.push(tile("Degradação", "—", "sem relatório"));
  }

  el.summaryGrid.innerHTML = tiles.join("");
}

function measuredRowHtml(row, baseAbertura) {
  const versusBase =
    row.aberturaAgregada != null && baseAbertura != null
      ? `${row.aberturaAgregada >= baseAbertura ? "▲" : "▼"} ${fmtPct(Math.abs(row.aberturaAgregada - baseAbertura))}`
      : "—";
  const qualifier = amostraQualifier(row);
  const degradedBadge = row.degradado === true ? ` <span class="state-badge state-overdue">degradou</span>` : "";
  return `
    <td><strong>${escapeHtml(row.canal)}</strong></td>
    <td>${escapeHtml(row.spend.subcanal || "—")}</td>
    <td class="mono">${fmtBrl(row.custoPorLeitor)}</td>
    <td>${row.leitores}</td>
    <td>${row.ativos}</td>
    <td>${row.cadastros}</td>
    <td>${fmtPct(row.aberturaAgregada)}${degradedBadge}</td>
    <td>${versusBase}</td>
    <td>${row.amostraConsiderada}${qualifier ? `<div class="reachable-subtext">⚠ ${qualifier}</div>` : ""}</td>
    <td>${fmtBrl(row.spend.valor)}</td>
    <td>${escapeHtml(row.spend.mes)}</td>
    <td class="reachable-subtext">${escapeHtml(row.spend.fonte)}</td>
  `;
}

function boostRowHtml(row) {
  return `
    <td><strong>${escapeHtml(row.canal)}</strong></td>
    <td>${escapeHtml(row.spend.subcanal || "—")}</td>
    <td class="mono">${fmtBrl(row.range.custoPorLeitorMin)}–${fmtBrl(row.range.custoPorLeitorMax)}</td>
    <td>${row.range.leitoresMin}–${row.range.leitoresMax}</td>
    <td>${row.range.ativosMin}–${row.range.ativosMax}</td>
    <td>—</td>
    <td>—</td>
    <td>—</td>
    <td><span class="hint">estimado</span></td>
    <td>${fmtBrl(row.spend.valor)}</td>
    <td>${escapeHtml(row.spend.mes)}</td>
    <td class="reachable-subtext">${escapeHtml(row.note)}</td>
  `;
}

function renderTable(report) {
  el.count.textContent = String(report.rows.length);
  el.tbody.innerHTML = "";
  for (const row of report.rows) {
    const tr = document.createElement("tr");
    tr.innerHTML = row.kind === "measured" ? measuredRowHtml(row, report.base.aberturaAgregada) : boostRowHtml(row);
    el.tbody.appendChild(tr);
  }

  const warnings = [];
  if (report.internalFiltered > 0) warnings.push(`${report.internalFiltered} conta(s) interna(s)/teste excluída(s).`);
  if (!report.originApplied) warnings.push("mapa de origem recuperada não aplicado — utm_source cru do snapshot.");
  if (report.unmappedChannels && report.unmappedChannels.length > 0) {
    warnings.push(`canal(is) desconhecido(s) em spend.csv: ${report.unmappedChannels.join(", ")}.`);
  }
  if (report.channelsMissingSpend && report.channelsMissingSpend.length > 0) {
    warnings.push(`canal(is) com assinantes mas sem linha em spend.csv (ausente da tabela): ${report.channelsMissingSpend.join(", ")}.`);
  }
  if (report.window) warnings.push("janela de cadastro aplicada — números recortados por período.");
  el.warnings.textContent = warnings.join(" ");
}

async function refresh(forceRefresh) {
  setFetchStatus("", "carregando…");
  try {
    const url = forceRefresh ? "/api/ads?refresh=1" : "/api/ads";
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    el.error.hidden = true;
    el.execModeValue.textContent = data.execMode ? `ambiente: ${data.execMode}` : "—";

    if (!data.hasDataDir) {
      el.nodata.hidden = false;
      el.summaryPanel.hidden = true;
      el.tablePanel.hidden = true;
      setFetchStatus("down", "sem dados (cloud)");
      el.lastUpdated.textContent = data.generatedAt ? `gerado em ${fmtTime(data.generatedAt)}` : "";
      return;
    }
    el.nodata.hidden = true;

    if (!data.report) {
      const reasons = [];
      if (data.spend.error) reasons.push(`spend.csv: ${data.spend.error}`);
      if (data.snapshot.error) reasons.push(`snapshot: ${data.snapshot.error}`);
      el.nodata.hidden = false;
      el.nodata.textContent = reasons.length > 0 ? reasons.join(" · ") : "Sem dados suficientes pra montar o relatório.";
      el.summaryPanel.hidden = true;
      el.tablePanel.hidden = true;
      setFetchStatus("down", "sem relatório");
      el.lastUpdated.textContent = data.generatedAt ? `gerado em ${fmtTime(data.generatedAt)}` : "";
      return;
    }

    el.summaryPanel.hidden = false;
    el.tablePanel.hidden = false;
    renderSummary(data);
    renderTable(data.report);
    setFetchStatus("ok", `${data.report.rows.length} canal(is)${data.cached ? " (cache)" : ""}`);
    const snapshotLabel = data.snapshot && data.snapshot.date ? ` · snapshot ${data.snapshot.date}` : "";
    el.lastUpdated.textContent = data.generatedAt ? `gerado em ${fmtTime(data.generatedAt)}${snapshotLabel}` : "";
  } catch (e) {
    el.error.hidden = false;
    el.error.textContent = `Falha ao carregar ads: ${e.message}`;
    setFetchStatus("down", "erro");
  }
}

el.refreshBtn.addEventListener("click", () => refresh(true));

refresh(false);
