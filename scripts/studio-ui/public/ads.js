// ads.js (#5236) — página de custo por leitor por canal: fetch de
// GET /api/ads (studio-ads.ts), render de um resumo de 4 respostas + tabela
// por canal. Vanilla JS, sem build step (mesmo padrão de tarefas.js/integracoes.js).
//
// READ-ONLY: só lista + botão "Atualizar" (bypassa o cache de 10min via
// ?refresh=1) — nenhuma edição de spend.csv nesta página (import manual é
// fora do Studio, ver `scripts/seed-spend-csv.ts`/CLAUDE.md).

import { clampToContainer, formatDdMm as fmtDdMm, nearestDateIndex, skippedPausedLabel, tooltipRowsForIndex } from "./ads-chart.js";
import { buildFollowersChartModel } from "./ads-followers-chart.js";

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
  campaignMaturityDate: document.getElementById("campaign-maturity-date"),
  followersPanel: document.getElementById("followers-panel"),
  followersNodata: document.getElementById("followers-nodata"),
  followersTotalsGrid: document.getElementById("followers-totals-grid"),
  followersParseErrors: document.getElementById("followers-parse-errors"),
  followersTbody: document.getElementById("followers-tbody"),
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
    // #8210 Bug 1: colisão de canal (ex: "Google Ads" + "Google Ads (teste
    // 2608)" no mesmo mês) vira aviso VISÍVEL aqui — nunca some numa soma
    // silenciosa (a soma continua acontecendo; o aviso é o que muda).
    const dupWarning =
      budget.duplicateWarnings && budget.duplicateWarnings.length > 0
        ? ` ⚠ possível dupla-contagem: ${budget.duplicateWarnings.map((w) => w.canais.join(" + ")).join("; ")}.`
        : "";
    tiles.push(
      tile(
        `Orçamento ${escapeHtml(budget.monthKey)}`,
        `${fmtBrl(budget.spentBrl)} / ${fmtBrl(budget.budgetFloorBrl)}`,
        `${fmtPct(budget.fractionUsed)} do piso conhecido${escapeHtml(dupWarning)}`,
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

function renderTable(report, subscribersSource) {
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
  // #8210 Bug 2: torna VISÍVEL qual fonte de subscribers montou este
  // relatório — o fallback fail-soft pro snapshot Beehiiv precisa aparecer
  // aqui, senão a tela volta a ficar "cega" ao Kit em silêncio (era
  // exatamente o bug original) sem ninguém notar que o store não estava
  // disponível.
  if (subscribersSource === "beehiiv-snapshot") {
    warnings.push(
      "⚠ store unificado indisponível — usando fallback snapshot Beehiiv (cego a cadastros só-Kit). Rode a ingestão do store.",
    );
  }
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
    const totalDias = testState.diasDecorridos + Math.max(testState.diasRestantes, 0);
    const realSuffix =
      testState.diasVeiculacaoReal != null && testState.diasVeiculacaoReal !== testState.diasDecorridos
        ? ` (${testState.diasVeiculacaoReal} de veiculação real, descontando pausa)`
        : "";
    const janela =
      testState.emAndamento
        ? `dia ${testState.diasDecorridos} de ${totalDias}${realSuffix} · ${testState.diasRestantes} restante(s)`
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

/** #8210 Bug 3c: gasto NUNCA aparece como "R$ 0,00" quando é desconhecido —
 *  `gastoTotalBrl` já vem `null` nesse caso (`fmtBrl` mostra "—"); este
 *  badge só acrescenta a EXPLICAÇÃO ("fonte manual" / "desconhecido")
 *  visível ao lado do valor, em vez de deixar o "—" sem contexto. */
function gastoFonteBadge(row) {
  if (row.gastoFonte === "manual") {
    return `<div class="reachable-subtext">fonte manual, até ${escapeHtml(fmtDdMm(row.gastoAsOf))}</div>`;
  }
  if (row.gastoFonte === "unknown") {
    return `<div class="reachable-subtext">⚠ gasto desconhecido (API fora do ar)</div>`;
  }
  return "";
}

/** #8210 melhoria 2 — mesmo texto/classe pros 3 braços (badge ativa/pausada
 *  é da campanha inteira, ver `computeCampaignPauseStatus`). Ausência
 *  (`"desconhecido"`) nunca aparece como "ativa" por omissão. */
function pauseStatusBadge(status) {
  const labelByStatus = { ativa: "ativa", pausada: "pausada", desconhecido: "desconhecido" };
  const label = labelByStatus[status] ?? status;
  return `<span class="state-badge state-${escapeHtml(status)}">${escapeHtml(label)}</span>`;
}

/** #8210 melhoria 1 — mínimo de "n" (mesmo piso de `AMOSTRA_PEQUENA_THRESHOLD`
 *  em `cohort-engagement.ts`) abaixo do qual o % ativo fica esmaecido em vez
 *  de aparecer como um número confiável (ex: "50%" com n=1). */
const ATIVOS_AMOSTRA_MIN = 5;

/** `ativosTotal`/`pctAtivo` nunca viram "0"/"0%" quando o canal ainda não
 *  tem dado no store (`ativosTotal === null`) — sempre "—". Com dado
 *  presente mas `n` abaixo do piso, o valor aparece esmaecido (nunca
 *  escondido — a issue pede visível, só não com peso de número confiável). */
function ativosCell(row) {
  if (row.ativosTotal == null) {
    return `${fmtInt(null)}<div class="reachable-subtext">sem dado no store ainda</div>`;
  }
  const dim = row.ativosAmostraN < ATIVOS_AMOSTRA_MIN;
  return `<span class="${dim ? "ads-dim" : ""}">${fmtInt(row.ativosTotal)} <span class="reachable-subtext">n=${fmtInt(
    row.ativosAmostraN,
  )}</span></span>`;
}

function pctAtivoCell(row) {
  if (row.pctAtivo == null) return fmtPct(null);
  const dim = row.ativosAmostraN < ATIVOS_AMOSTRA_MIN;
  return `<span class="${dim ? "ads-dim" : ""}">${fmtPct(row.pctAtivo)}</span>`;
}

function renderCampaignChannelsTable(channels) {
  el.campaignChannelsTbody.innerHTML = channels
    .map(
      (row) => `
    <tr>
      <td><strong>${escapeHtml(shortChannelLabel(row.canal))}</strong></td>
      <td>${pauseStatusBadge(row.pauseStatus)}</td>
      <td class="mono">${fmtBrl(row.gastoTotalBrl)}${gastoFonteBadge(row)}</td>
      <td>${fmtInt(row.cliquesTotal)}</td>
      <td>${fmtInt(row.impressoesTotal)}</td>
      <td class="mono">${fmtBrl(row.cpcMedioBrl)}</td>
      <td>${fmtInt(row.cadastrosTotal)}</td>
      <td class="mono">${fmtBrl(row.custoPorCadastroBrl)}</td>
      <td class="mono">${ativosCell(row)}</td>
      <td class="mono">${pctAtivoCell(row)}</td>
    </tr>`,
    )
    .join("");
}

const CHART_WIDTH = 720;
const CHART_HEIGHT = 260;
const CHART_MARGIN = { top: 16, right: 16, bottom: 28, left: 56 };

/** Tooltip do gráfico (#8300): o SVG é desenhado à mão, então
 *  não vem tooltip de graça de nenhuma lib. Em vez de depender de acertar
 *  o `<circle>` de r=2.5 (alvo pequeno demais), o hover é por COLUNA de
 *  data — qualquer x dentro do plot resolve o índice mais próximo e mostra
 *  o valor de TODOS os canais naquele dia, que é a comparação que a tela
 *  existe pra fazer. Canal sem valor no dia aparece como "—", nunca some
 *  (some seria indistinguível de "canal não existe"). */
function attachCampaignChartTooltip(cumulative, { allDates, plotW, xForIndex }) {
  const svg = el.campaignChartContainer.querySelector("svg");
  const tooltip = el.campaignChartContainer.querySelector(".ads-chart-tooltip");
  const guide = el.campaignChartContainer.querySelector(".ads-chart-guide");
  if (!svg || !tooltip || allDates.length === 0) return;

  const hide = () => {
    tooltip.hidden = true;
    guide.hidden = true;
  };

  svg.addEventListener("mousemove", (event) => {
    const rect = svg.getBoundingClientRect();
    if (rect.width === 0) return;
    const scale = CHART_WIDTH / rect.width;
    const plotX = (event.clientX - rect.left) * scale - CHART_MARGIN.left;
    // Folga = margem esquerda do gráfico: qualquer x DENTRO do SVG resolve
    // uma coluna, inclusive sobre os rótulos do eixo. Esconder ali seria
    // outra forma do bug do #8300 (mouse no gráfico, nenhum valor).
    const nearest = nearestDateIndex(xForIndex, allDates.length, plotX, plotW, CHART_MARGIN.left);
    if (nearest === null) {
      hide();
      return;
    }

    const rows = tooltipRowsForIndex(cumulative.series, nearest)
      .map(
        (row) =>
          `<span class="ads-chart-tooltip-row"><span class="ads-chart-legend-swatch c${row.colorIndex}"></span>${escapeHtml(
            shortChannelLabel(row.canal),
          )}<strong>${row.value === null ? "—" : fmtBrl(row.value)}</strong></span>`,
      )
      .join("");
    tooltip.innerHTML = `<span class="ads-chart-tooltip-date">${escapeHtml(allDates[nearest])}</span>${rows}`;
    tooltip.hidden = false;

    guide.setAttribute("x1", xForIndex(nearest).toFixed(1));
    guide.setAttribute("x2", xForIndex(nearest).toFixed(1));
    guide.hidden = false;

    // Posiciona em px do container (o SVG escala com viewBox; converter de
    // volta pelo mesmo `scale` mantém o tooltip colado na coluna certa).
    const containerRect = el.campaignChartContainer.getBoundingClientRect();
    const dotLeft = rect.left - containerRect.left + (CHART_MARGIN.left + xForIndex(nearest)) / scale;
    const flip = dotLeft > containerRect.width / 2;
    const rawLeft = flip ? dotLeft - tooltip.offsetWidth - 12 : dotLeft + 12;
    const rawTop = event.clientY - containerRect.top - tooltip.offsetHeight - 12;
    // Clamp nas 4 bordas do container: sem isso o tooltip vaza pra fora do
    // painel nas colunas das pontas e no topo do gráfico (review da #8300).
    tooltip.style.left = `${clampToContainer(rawLeft, tooltip.offsetWidth, containerRect.width)}px`;
    tooltip.style.top = `${clampToContainer(rawTop, tooltip.offsetHeight, containerRect.height)}px`;
  });
  svg.addEventListener("mouseleave", hide);
}

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
  // #8210 melhoria 4: escala RAIZ QUADRADA, não linear — um canal caro
  // (ex: R$ 288,02/cadastro, n baixo) achatava o mais barato (R$ 6,77)
  // contra o zero numa escala linear compartilhada. sqrt() comprime a
  // ponta alta sem inverter a ordem nem exigir eixo por canal (que violaria
  // o requisito 2 da #7536, "escala compartilhada"). `scale(0) = 0` sempre.
  const scale = (v) => Math.sqrt(Math.max(v, 0));
  const yScaledMax = scale(yMax) || 1;
  const yForValue = (v) => plotH - (scale(v) / yScaledMax) * plotH;

  const axisLines = [
    `<line class="ads-chart-axis-line" x1="0" y1="${plotH}" x2="${plotW}" y2="${plotH}" />`,
    `<line class="ads-chart-axis-line" x1="0" y1="0" x2="0" y2="${plotH}" />`,
  ];
  // Posições dos ticks em ESPAÇO ESCALADO (frações do eixo), rótulos no
  // VALOR real — pega 4 pontos pra compensar a compressão do topo.
  const yTicks = [0, 0.25, 0.5, 1].map((frac) => {
    const value = frac * yMax;
    const y = plotH - (scale(value) / yScaledMax) * plotH;
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
        <line class="ads-chart-guide" x1="0" y1="0" x2="0" y2="${plotH}" hidden />
      </g>
    </svg>
    <div class="ads-chart-tooltip" hidden></div>`;

  attachCampaignChartTooltip(cumulative, { allDates, plotW, xForIndex });

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

  // #8475 Parte A / #8533 — canal tirado do gráfico porque a escala dele
  // esmaga os outros no eixo compartilhado. Precisa APARECER: sumir em
  // silêncio troca uma leitura falsa (Google/Meta rente ao zero) por outra
  // (um canal do teste que simplesmente não está ali), que é o mesmo
  // critério que o #8307 aplicou aos dias pausados logo abaixo.
  if (cumulative.omittedScale && cumulative.omittedScale.length > 0) {
    el.campaignChartLegend.innerHTML += `<span class="hint">Fora do gráfico (escala): ${cumulative.omittedScale
      .map((c) => escapeHtml(shortChannelLabel(c)))
      .join(", ")} — ver tabela</span>`;
  }

  // #8307 — o eixo X pula os dias sem veiculação, e isso precisa aparecer:
  // comprimir o tempo em silêncio trocaria uma leitura falsa (trecho reto
  // que parece estabilidade) por outra (dias que somem sem explicação).
  const skipped = cumulative.skippedPausedDates ?? [];
  if (skipped.length > 0) {
    el.campaignChartLegend.innerHTML += `<span class="hint">${escapeHtml(skippedPausedLabel(skipped))}</span>`;
  }
}

/** Saldo diário (#8260) — `+N`/`−N` com sinal explícito, `—` pra `null`
 *  (nunca "0" quando o dado não existe: 1ª amostra, ou dia sem coleta). */
function fmtDelta(delta) {
  if (delta == null) return "—";
  if (delta > 0) return `+${delta}`;
  return String(delta); // já carrega o "-" pra negativo; 0 aparece como "0" (saldo real medido, não ausência)
}

/** Seguidores ganhos por dia (#8260 Fase 1) — 2 séries (IG/FB) mescladas
 *  por data numa tabela única; totais atuais + saldo do período nos tiles
 *  do topo. `data.followers` é `null` quando o arquivo local ainda não
 *  existe (task nunca rodou nesta máquina, ou sessão cloud) — nunca uma
 *  tabela vazia disfarçada de "0 seguidor ganho". */

/** Gráfico de saldo diário (#8475 Parte B) — barras, baseline zero, escala
 *  simétrica quando há saldo negativo. Dia sem coleta / 1ª amostra = sem
 *  barra; saldo real = barra a partir do zero. */
function renderFollowersChart(followers) {
  const elChart = document.getElementById("followers-chart-container");
  if (!elChart) return;
  elChart.innerHTML = "";
  // #8534 — a geometria (barras, baseline, escala simétrica) é decidida em
  // buildFollowersChartModel (ads-followers-chart.js), função pura testável
  // isoladamente; aqui só resta montar a marcação SVG a partir do modelo.
  const model = buildFollowersChartModel(followers);
  if (!model) { elChart.hidden = true; return; }
  elChart.hidden = false;

  const { W, H, margin: M, plotHeight: ph, dates, hasNeg, symM, zeroY, groupW } = model;

  let bars = "";
  // Linha de baseline zero sempre desenhada
  bars += `<line x1="${M.left}" y1="${zeroY}" x2="${W - M.right}" y2="${zeroY}" stroke="#888" stroke-width="1" stroke-dasharray="3,2"/>`;
  for (const bar of model.bars) {
    const fill = bar.channel === "instagram" ? "#1a6" : "#b55";
    bars += `<rect x="${bar.x}" y="${bar.y}" width="${bar.width}" height="${bar.height}" fill="${fill}" rx="2"/>`;
  }

  // Eixos + ticks
  let ticks = "";
  for (let i = 0; i < dates.length; i++) {
    if (i === 0 || i === dates.length - 1 || i % Math.ceil(dates.length / 4) === 0) {
      const cx = M.left + i * groupW + groupW / 2;
      ticks += `<text x="${cx}" y="${H - 8}" font-size="10" fill="#333" text-anchor="middle">${dates[i].slice(5)}</text>`;
    }
  }
  // Tick Y: 0 sempre + min/max quando simétrico
  let yTicks = `<text x="${M.left - 6}" y="${zeroY + 3}" font-size="10" fill="#333" text-anchor="end">0</text>`;
  if (hasNeg) {
    yTicks += `<text x="${M.left - 6}" y="${M.top + 10}" font-size="10" fill="#333" text-anchor="end">+${Math.round(symM)}</text>`;
    yTicks += `<text x="${M.left - 6}" y="${M.top + ph - 4}" font-size="10" fill="#333" text-anchor="end">−${Math.round(symM)}</text>`;
  } else if (symM > 0) {
    yTicks += `<text x="${M.left - 6}" y="${M.top + 10}" font-size="10" fill="#333" text-anchor="end">+${Math.round(symM)}</text>`;
  }

  // Legenda
  const legend = `<g transform="translate(${W - 140},${M.top + 6})">` +
    `<rect x="0" y="0" width="10" height="10" fill="#1a6" rx="2"/><text x="14" y="9" font-size="10" fill="#333">Instagram (saldo)</text>` +
    `<rect x="0" y="16" width="10" height="10" fill="#b55" rx="2"/><text x="14" y="25" font-size="10" fill="#333">Facebook (saldo)</text>` +
    `</g>`;

  elChart.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Saldo diário de seguidores por dia" style="width:100%;height:auto;">` +
    `<g>` + bars + ticks + yTicks + legend + `</g></svg>`;
}

function renderFollowers(followers) {
  if (!followers) {
    el.followersPanel.hidden = false;
    el.followersNodata.hidden = false;
    el.followersTotalsGrid.innerHTML = "";
    el.followersParseErrors.hidden = true;
    el.followersTbody.innerHTML = "";
    return;
  }
  el.followersPanel.hidden = false;
  el.followersNodata.hidden = true;

  const ig = followers.instagram;
  const fb = followers.facebook;

  el.followersTotalsGrid.innerHTML = [
    tile("Instagram — total atual", fmtInt(ig.currentTotal), ig.lastDate ? `em ${fmtDdMm(ig.lastDate)}` : "sem coleta"),
    tile("Instagram — saldo do período", fmtDelta(ig.totalDelta), ig.firstDate ? `desde ${fmtDdMm(ig.firstDate)}` : ""),
    tile("Facebook — total atual", fmtInt(fb.currentTotal), fb.lastDate ? `em ${fmtDdMm(fb.lastDate)}` : "sem coleta"),
    tile("Facebook — saldo do período", fmtDelta(fb.totalDelta), fb.firstDate ? `desde ${fmtDdMm(fb.firstDate)}` : ""),
  ].join("");

  if (followers.parseErrors && followers.parseErrors.length > 0) {
    el.followersParseErrors.hidden = false;
    el.followersParseErrors.textContent = `${followers.parseErrors.length} linha(s) inválida(s) em social-followers.jsonl (ignoradas): ${followers.parseErrors
      .map((e) => `linha ${e.line} (${e.reason})`)
      .join("; ")}`;
  } else {
    el.followersParseErrors.hidden = true;
  }

  const byDate = new Map();
  for (const p of ig.points) byDate.set(p.date, { ...(byDate.get(p.date) || {}), igTotal: p.followersCount, igDelta: p.delta });
  for (const p of fb.points) byDate.set(p.date, { ...(byDate.get(p.date) || {}), fbTotal: p.followersCount, fbDelta: p.delta });
  const dates = [...byDate.keys()].sort().reverse(); // mais recente primeiro

  if (dates.length === 0) {
    el.followersTbody.innerHTML = `<tr><td colspan="5">Sem amostra coletada ainda.</td></tr>`;
    return;
  }

  renderFollowersChart(followers);

  el.followersTbody.innerHTML = dates
    .map((date) => {
      const row = byDate.get(date);
      return `<tr>
        <td>${escapeHtml(fmtDdMm(date))}</td>
        <td>${fmtInt(row.igTotal)}</td>
        <td>${escapeHtml(fmtDelta(row.igDelta))}</td>
        <td>${fmtInt(row.fbTotal)}</td>
        <td>${escapeHtml(fmtDelta(row.fbDelta))}</td>
      </tr>`;
    })
    .join("");
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
  // #8210 Bug 4a: data de maturação vem do run-state, nunca fixa no HTML —
  // "02/10" hardcoded ficava defasado toda vez que o run-state era revisado
  // (achado ao vivo: coorte_madura já tinha ido pra 24/10 quando o HTML
  // ainda dizia 02/10).
  if (el.campaignMaturityDate) {
    el.campaignMaturityDate.textContent = data.runState
      ? `por volta de ${fmtDdMm(data.runState.coorte_madura)}`
      : "quando a coorte cruzar o piso de 20 edições (ver run-state)";
  }
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
    // #8260: seguidores ganhos por dia é uma fonte INDEPENDENTE de
    // spend.csv/snapshot Beehiiv (mesmo raciocínio de campaignEconomics
    // acima) — renderiza mesmo quando `data.report` é null.
    renderFollowers(data.followers);

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
    renderTable(data.report, data.subscribersSource);
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
