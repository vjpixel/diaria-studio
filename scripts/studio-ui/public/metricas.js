// metricas.js (#7178) — página de métricas de negócio: fetch de
// GET /api/metrics (studio-metrics.ts), render das 4 zonas (baseline,
// queda, metas, decomposição). Vanilla JS, sem build step (mesmo padrão de
// ads.js/tarefas.js).
//
// READ-ONLY: só lista + botão "Atualizar" (bypassa o cache de 10min via
// ?refresh=1) — zero escrita, mesma disciplina de ads.js.

const el = {
  fetchDot: document.getElementById("fetch-dot"),
  fetchLabel: document.getElementById("fetch-label"),
  execModeValue: document.getElementById("exec-mode-value"),
  error: document.getElementById("metricas-error"),
  nodata: document.getElementById("metricas-nodata"),
  refreshBtn: document.getElementById("refresh-btn"),
  lastUpdated: document.getElementById("last-updated"),

  baselinePanel: document.getElementById("baseline-panel"),
  baselineTbody: document.getElementById("baseline-tbody"),

  quedaPanel: document.getElementById("queda-panel"),
  quedaGrid: document.getElementById("queda-grid"),

  placarPanel: document.getElementById("placar-panel"),
  placarGrid: document.getElementById("placar-grid"),

  metasPanel: document.getElementById("metas-panel"),
  metasEmpty: document.getElementById("metas-empty"),
  metasTbody: document.getElementById("metas-tbody"),

  decompPanel: document.getElementById("decomposicao-panel"),
  decompGrid: document.getElementById("decomposicao-grid"),
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
    });
  } catch {
    return iso;
  }
}

/** Formata `MetricResult.valor` conforme `unidade` — `null` é SEMPRE "sem
 * coleta", nunca "0" (regra de honestidade da issue #7178). `qualidade:
 * 'faixa'` mostra a faixa completa, nunca o ponto médio. */
function fmtValor(result, unidade) {
  if (result.valor == null) return "sem coleta";
  const fmtNum = (n) => {
    if (unidade === "percentual") return `${n.toFixed(1)}%`;
    if (unidade === "razao") return n.toFixed(3);
    if (unidade === "brl") return `R$ ${n.toFixed(2).replace(".", ",")}`;
    if (unidade === "dias") return `${n.toFixed(1)}d`;
    return Number.isInteger(n) ? String(n) : n.toFixed(2);
  };
  if (result.qualidade === "faixa" && result.limites) {
    return `${fmtNum(result.limites.min)} (até ${fmtNum(result.limites.max)} com não-atribuídos)`;
  }
  const prefix = result.qualidade === "piso" ? "≥ " : "";
  return prefix + fmtNum(result.valor);
}

function qualidadeBadge(qualidade) {
  return `<span class="metricas-qualidade metricas-qualidade-${escapeHtml(qualidade)}">${escapeHtml(qualidade)}</span>`;
}

function motivoLine(result) {
  return result.motivo ? `<span class="metricas-motivo">${escapeHtml(result.motivo)}</span>` : "";
}

function renderBaseline(baseline) {
  el.baselineTbody.innerHTML = baseline
    .map(
      ({ metric, result }) => `
    <tr>
      <td><strong>${escapeHtml(metric.nome)}</strong><div class="reachable-subtext">${escapeHtml(metric.id)}</div></td>
      <td class="mono">${escapeHtml(fmtValor(result, metric.unidade))}${motivoLine(result)}</td>
      <td>${qualidadeBadge(result.qualidade)}</td>
      <td>${escapeHtml(result.frescor ? fmtTime(result.frescor) : "—")}</td>
      <td class="metricas-definicao">${escapeHtml(metric.definicao)}</td>
    </tr>`,
    )
    .join("");
}

function tile(label, value, sub) {
  return `<div class="ads-tile"><div class="ads-tile-label">${escapeHtml(label)}</div><div class="ads-tile-value">${value}</div>${
    sub ? `<div class="ads-tile-sub">${sub}</div>` : ""
  }</div>`;
}

function renderQueda(queda) {
  const tiles = [];
  const beehiivSeries = (queda.baseAtiva.series || []).find((s) => s.chave === "beehiiv");
  const kitSeries = (queda.baseAtiva.series || []).find((s) => s.chave === "kit");
  tiles.push(
    tile(
      "Base ativa — Beehiiv",
      beehiivSeries && beehiivSeries.valor != null ? String(beehiivSeries.valor) : "sem coleta",
      queda.baseAtiva.qualidade === "piso" ? "PISO — snapshot não é de hoje" : escapeHtml(queda.baseAtiva.frescor || ""),
    ),
  );
  tiles.push(
    tile(
      "Base ativa — Kit",
      kitSeries && kitSeries.valor != null ? String(kitSeries.valor) : "sem coleta",
      "leitura viva do Kit não implementada nesta fatia (#7178)",
    ),
  );
  if (queda.baseAtivaAnterior && queda.baseAtivaAnterior.valor != null && queda.baseAtiva.valor != null) {
    const delta = queda.baseAtiva.valor - queda.baseAtivaAnterior.valor;
    const arrow = delta >= 0 ? "▲" : "▼";
    tiles.push(tile("Variação vs. snapshot anterior", `${arrow} ${Math.abs(delta)}`, `snapshot anterior: ${escapeHtml(queda.baseAtivaAnterior.frescor || "—")}`));
  } else {
    tiles.push(tile("Variação vs. snapshot anterior", "—", "sem snapshot anterior pra comparar"));
  }
  el.quedaGrid.innerHTML = tiles.join("");
}

function renderPlacar(placar) {
  const tiles = [
    tile(
      `Placar da meta (${placar.janelaDias}d)`,
      escapeHtml(fmtValor(placar.naoPagoNaoReativacao, "contagem")),
      "organico + iniciativa (não-pago e não-reativação)",
    ),
    tile(
      "Orgânico estrito",
      escapeHtml(fmtValor(placar.organicoEstrito, "contagem")),
      "saúde de descoberta pura, ao lado — nunca no lugar do placar",
    ),
    tile(
      "Fração indeterminada",
      escapeHtml(fmtValor(placar.indeterminados, "razao")),
      "barra de erro do placar",
    ),
  ];
  el.placarGrid.innerHTML = tiles.join("");
}

function estadoBadge(estado) {
  return `<span class="metricas-estado metricas-estado-${escapeHtml(estado)}">${escapeHtml(estado)}</span>`;
}

function renderMetas(metasLayer) {
  if (metasLayer.items.length === 0) {
    el.metasEmpty.hidden = false;
    el.metasTbody.innerHTML = "";
    return;
  }
  el.metasEmpty.hidden = true;
  el.metasTbody.innerHTML = metasLayer.items
    .map(({ meta, status, erro }) => {
      if (erro || !status) {
        return `
    <tr>
      <td><strong>${escapeHtml(meta.id)}</strong></td>
      <td colspan="6" class="metricas-motivo">${escapeHtml(erro || "sem status")}</td>
    </tr>`;
      }
      const faixaCell =
        status.status_no_limite_superior && status.faixa
          ? `${estadoBadge(status.status_no_limite_superior)} (até ${status.faixa.max})`
          : "—";
      return `
    <tr>
      <td><strong>${escapeHtml(meta.id)}</strong><div class="reachable-subtext">${escapeHtml(meta.motivo || "")}</div></td>
      <td>${estadoBadge(status.estado)}</td>
      <td>${status.streak_atual}/${status.streak_necessario}</td>
      <td>${(status.progresso * 100).toFixed(0)}%</td>
      <td>${status.dias_indeterminados}</td>
      <td>${faixaCell}</td>
      <td>${escapeHtml(meta.prazo || "sem prazo")}</td>
    </tr>`;
    })
    .join("");
}

function renderDecomposicao(result) {
  if (!result.series || result.series.length === 0) {
    el.decompGrid.innerHTML = tile("Cadastros por classe", escapeHtml(fmtValor(result, "contagem")), result.motivo ? escapeHtml(result.motivo) : "sem decomposição disponível");
    return;
  }
  el.decompGrid.innerHTML = result.series
    .map((s) => tile(escapeHtml(s.chave), s.valor == null ? "sem coleta" : String(s.valor), ""))
    .join("");
}

async function refresh(forceRefresh) {
  setFetchStatus("", "carregando…");
  try {
    const url = forceRefresh ? "/api/metrics?refresh=1" : "/api/metrics";
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    el.error.hidden = true;
    el.execModeValue.textContent = data.execMode ? `ambiente: ${data.execMode}` : "—";

    if (!data.hasDataDir) {
      el.nodata.hidden = false;
      for (const p of [el.baselinePanel, el.quedaPanel, el.placarPanel, el.metasPanel, el.decompPanel]) p.hidden = true;
      setFetchStatus("down", "sem dados (cloud)");
      el.lastUpdated.textContent = data.generatedAt ? `gerado em ${fmtTime(data.generatedAt)}` : "";
      return;
    }
    el.nodata.hidden = true;

    for (const p of [el.baselinePanel, el.quedaPanel, el.placarPanel, el.metasPanel, el.decompPanel]) p.hidden = false;

    renderBaseline(data.baseline);
    renderQueda(data.queda);
    renderPlacar(data.placar);
    renderMetas(data.metas);
    renderDecomposicao(data.decomposicaoCadastros);

    setFetchStatus("ok", `dia ${data.diaReferencia}${data.cached ? " (cache)" : ""}`);
    const snapshotLabel = data.beehiivSnapshot && data.beehiivSnapshot.date ? ` · snapshot Beehiiv ${data.beehiivSnapshot.date}` : "";
    el.lastUpdated.textContent = data.generatedAt ? `gerado em ${fmtTime(data.generatedAt)}${snapshotLabel}` : "";
  } catch (e) {
    el.error.hidden = false;
    el.error.textContent = `Falha ao carregar métricas: ${e.message}`;
    setFetchStatus("down", "erro");
  }
}

el.refreshBtn.addEventListener("click", () => refresh(true));

refresh(false);
