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
  campaignPanel: document.getElementById("campaign-economics-panel"),
  campaignTilesGrid: document.getElementById("campaign-tiles-grid"),
  campaignFreshness: document.getElementById("campaign-freshness"),
  campaignChartEmpty: document.getElementById("campaign-chart-empty"),
  campaignChartContainer: document.getElementById("campaign-chart-container"),
  campaignChartLegend: document.getElementById("campaign-chart-legend"),
  campaignChannelsTbody: document.getElementById("campaign-channels-tbody"),
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
  // #5859: usa rankedRows (custo válido E gasto > 0) — nunca `rows` cru, que
  // misturava "sem dado" (custoPorLeitor null) e "gasto zero" (0,00 falso
  // "mais barato") com canal genuinamente medido e eficiente.
  const measured = report ? report.rankedRows.filter((r) => r.kind === "measured") : [];
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

function sectionHeaderRow(label, colspan) {
  const tr = document.createElement("tr");
  tr.className = "ads-section-header";
  tr.innerHTML = `<td colspan="${colspan}">${escapeHtml(label)}</td>`;
  return tr;
}

function renderTable(report) {
  el.count.textContent = String(report.rows.length);
  el.tbody.innerHTML = "";

  const COLS = 13;

  // — Bucket 1: rankedRows (custo válido + gasto > 0, inclui boost) —
  if (report.rankedRows.length > 0) {
    el.tbody.appendChild(sectionHeaderRow("Ranqueado — custo por leitor válido", COLS));
    for (const row of report.rankedRows) {
      const tr = document.createElement("tr");
      tr.innerHTML = row.kind === "measured" ? measuredRowHtml(row, report.base.aberturaAgregada) : boostRowHtml(row);
      el.tbody.appendChild(tr);
    }
  }

  // — Bucket 2: noDataRows (sem dado suficiente) —
  if (report.noDataRows.length > 0) {
    el.tbody.appendChild(sectionHeaderRow("Sem dado suficiente — leitores = 0, custo não calculável", COLS));
    for (const row of report.noDataRows) {
      const tr = document.createElement("tr");
      tr.innerHTML = row.kind === "measured" ? measuredRowHtml(row, report.base.aberturaAgregada) : boostRowHtml(row);
      el.tbody.appendChild(tr);
    }
  }

  // — Bucket 3: zeroSpendRows (gasto zero) —
  if (report.zeroSpendRows.length > 0) {
    el.tbody.appendChild(sectionHeaderRow("Gasto zero — custo calculável mas spend.valor = 0", COLS));
    for (const row of report.zeroSpendRows) {
      const tr = document.createElement("tr");
      tr.innerHTML = row.kind === "measured" ? measuredRowHtml(row, report.base.aberturaAgregada) : boostRowHtml(row);
      el.tbody.appendChild(tr);
    }
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

// ─── #7536: "Economia da campanha ao vivo" (teste 2608) ───────────────────

function fmtInt(n) {
  if (n == null) return "—";
  return new Intl.NumberFormat("pt-BR").format(n);
}

/** Rótulo curto pro canal — encurta "X (teste 2608)" pra "X" nos lugares
 *  onde o contexto (a seção inteira é do teste 2608) já deixa isso claro. */
function shortChannelLabel(canal) {
  return String(canal).replace(/\s*\(teste 2608\)\s*$/, "");
}

function renderCampaignTiles(testState) {
  const tiles = [];
  if (testState.d0) {
    const janela =
      testState.emAndamento
        ? `dia ${testState.diasDecorridos} de ${testState.diasDecorridos + Math.max(testState.diasRestantes, 0)} · ${testState.diasRestantes} restante(s)`
        : "janela de veiculação encerrada";
    tiles.push(tile("Janela do teste", `${testState.d0} → ${testState.fimJanela}`, janela));
  } else {
    tiles.push(tile("Janela do teste", "—", "run-state.json ainda não existe (teste não começou)"));
  }
  tiles.push(tile("Gasto acumulado (Google+Microsoft)", fmtBrl(testState.gastoAcumuladoTotalBrl), null));
  tiles.push(tile("Cadastros acumulados", fmtInt(testState.cadastrosAcumuladosTotal), null));
  tiles.push(
    tile(
      "Sinal por canal",
      `${testState.canaisComSinal}/${testState.canaisTotal}`,
      "canal(is) com ≥1 cadastro no período — nunca uma média entre eles",
    ),
  );
  el.campaignTilesGrid.innerHTML = tiles.join("");
}

function freshnessBadge(entry) {
  const labelByStatus = { ok: "ok", stale: "desatualizado", error: "erro", unavailable: "indisponível" };
  const ageLabel = entry.ageMinutes != null ? ` · ${entry.ageMinutes}min atrás` : "";
  const title = entry.error ? escapeHtml(entry.error) : "";
  return `<span class="ads-freshness-badge ${entry.status}" title="${title}"><span class="dot"></span>${escapeHtml(
    entry.source,
  )}: ${labelByStatus[entry.status] ?? entry.status}${ageLabel}</span>`;
}

function renderCampaignFreshness(freshness) {
  el.campaignFreshness.innerHTML = freshness.map(freshnessBadge).join("");
}

function renderCampaignChannelsTable(channels) {
  el.campaignChannelsTbody.innerHTML = channels
    .map(
      (row) => `
    <tr>
      <td><strong>${escapeHtml(shortChannelLabel(row.canal))}</strong></td>
      <td class="mono">${fmtBrl(row.gastoTotalBrl)}</td>
      <td>${fmtInt(row.cliquesTotal)}</td>
      <td>${fmtInt(row.impressoesTotal)}</td>
      <td class="mono">${fmtBrl(row.cpcMedioBrl)}</td>
      <td>${fmtInt(row.cadastrosTotal)}</td>
      <td class="mono">${fmtBrl(row.custoPorCadastroBrl)}</td>
    </tr>`,
    )
    .join("");
}

const CHART_WIDTH = 720;
const CHART_HEIGHT = 260;
const CHART_MARGIN = { top: 16, right: 16, bottom: 28, left: 56 };

/** Gráfico de linhas SVG desenhado à mão (sem lib externa — Studio serve
 *  estático, sem build step) — custo/cadastro ACUMULADO por canal, eixo Y
 *  COMPARTILHADO entre todos os canais (requisitos 1/2 da issue #7536).
 *  `series` já vem filtrada pra só canais com ≥1 cadastro (requisito 3,
 *  `buildCumulativeSeries` do lado do servidor) — esta função não filtra
 *  de novo, só desenha o que recebeu. */
function renderCampaignChart(cumulative) {
  if (!cumulative.series || cumulative.series.length === 0) {
    el.campaignChartEmpty.hidden = false;
    el.campaignChartContainer.innerHTML = "";
    el.campaignChartLegend.innerHTML = "";
    return;
  }
  el.campaignChartEmpty.hidden = true;

  const allDates = cumulative.series[0].points.map((p) => p.date);
  const yMax = cumulative.sharedYAxisMax != null && cumulative.sharedYAxisMax > 0 ? cumulative.sharedYAxisMax : 1;
  const plotW = CHART_WIDTH - CHART_MARGIN.left - CHART_MARGIN.right;
  const plotH = CHART_HEIGHT - CHART_MARGIN.top - CHART_MARGIN.bottom;

  const xForIndex = (i) => (allDates.length <= 1 ? 0 : (i / (allDates.length - 1)) * plotW);
  const yForValue = (v) => plotH - (v / yMax) * plotH;

  const axisLines = [
    `<line class="ads-chart-axis-line" x1="0" y1="${plotH}" x2="${plotW}" y2="${plotH}" />`,
    `<line class="ads-chart-axis-line" x1="0" y1="0" x2="0" y2="${plotH}" />`,
  ];
  const yTicks = [0, 0.5, 1].map((frac) => {
    const y = plotH - frac * plotH;
    const value = frac * yMax;
    return `<text class="ads-chart-axis-label" x="-6" y="${y + 3}" text-anchor="end">${fmtBrl(value)}</text>`;
  });
  const xTicks = [0, allDates.length - 1]
    .filter((i, idx, arr) => i >= 0 && arr.indexOf(i) === idx)
    .map((i) => `<text class="ads-chart-axis-label" x="${xForIndex(i)}" y="${plotH + 18}" text-anchor="middle">${escapeHtml(allDates[i])}</text>`);

  const lines = cumulative.series
    .map((s, idx) => {
      const withValue = s.points
        .map((p, i) => ({ i, value: p.custoPorCadastroAcumulado }))
        .filter((p) => p.value != null);
      if (withValue.length === 0) return "";
      const pathD = withValue
        .map((p, k) => `${k === 0 ? "M" : "L"} ${xForIndex(p.i).toFixed(1)} ${yForValue(p.value).toFixed(1)}`)
        .join(" ");
      const dots = withValue
        .map((p) => `<circle class="ads-chart-dot ads-chart-dot-${idx % 3}" cx="${xForIndex(p.i).toFixed(1)}" cy="${yForValue(p.value).toFixed(1)}" r="2.5" />`)
        .join("");
      return `<path class="ads-chart-line ads-chart-line-${idx % 3}" d="${pathD}" />${dots}`;
    })
    .join("");

  el.campaignChartContainer.innerHTML = `
    <svg viewBox="0 0 ${CHART_WIDTH} ${CHART_HEIGHT}" role="img" aria-label="Custo por cadastro acumulado por canal">
      <g transform="translate(${CHART_MARGIN.left},${CHART_MARGIN.top})">
        ${axisLines.join("")}
        ${yTicks.join("")}
        ${xTicks.join("")}
        ${lines}
      </g>
    </svg>`;

  el.campaignChartLegend.innerHTML = cumulative.series
    .map(
      (s, idx) =>
        `<span class="ads-chart-legend-item"><span class="ads-chart-legend-swatch c${idx % 3}"></span>${escapeHtml(
          shortChannelLabel(s.canal),
        )}</span>`,
    )
    .join("");

  if (cumulative.omittedNoSignups && cumulative.omittedNoSignups.length > 0) {
    el.campaignChartLegend.innerHTML += `<span class="hint">Sem linha (gastou, 0 cadastro): ${cumulative.omittedNoSignups
      .map((c) => escapeHtml(shortChannelLabel(c)))
      .join(", ")}</span>`;
  }
}

function renderCampaignEconomics(data) {
  if (!data) {
    el.campaignPanel.hidden = true;
    return;
  }
  el.campaignPanel.hidden = false;
  renderCampaignTiles(data.testState);
  renderCampaignFreshness(data.freshness);
  renderCampaignChart(data.cumulative);
  renderCampaignChannelsTable(data.channels);
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

    // Independente do estado do relatório "custo por leitor" acima —
    // Google Ads/Microsoft Ads/Kit são fontes próprias (#7536), podem ter
    // dado mesmo sem `spend.csv`/snapshot Beehiiv locais.
    renderCampaignEconomics(data.campaignEconomics);

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
