// ads-chart.js (#8300, #8307) — lógica PURA do gráfico "Custo/cadastro
// acumulado por canal" do painel /ads: resolução de hover do tooltip e a
// nota dos dias sem veiculação. (Nasceu como `ads-chart-tooltip.js` no
// #8300 e foi renomeado no #8307, quando deixou de ser só do tooltip.)
//
// O gráfico é SVG desenhado à mão (`renderCampaignChart` em `ads.js`,
// #7536) — sem lib externa, portanto sem tooltip de graça. Até o #8300 os
// pontos eram `<circle r="2.5">` sem `<title>` nem handler de mouse: o
// hover não mostrava valor nenhum.
//
// Módulo separado porque `ads.js` toca `document` no topo e não é
// importável em node:test (mesmo padrão de `gate-badge.js`/#7050 — este
// projeto não tem jsdom).

/** Índice da coluna de data mais próxima de `plotX` (coordenada X já
 *  relativa à área de plot, sem a margem esquerda).
 *
 *  O hover é por COLUNA, não pelo ponto: o `<circle>` tem r=2.5 no
 *  viewBox, alvo pequeno demais pra acertar com o mouse — era essa a
 *  queixa do #8300. Fora do plot (mais que `slack` de folga em qualquer
 *  ponta) devolve `null`, que é o sinal pra esconder o tooltip. */
export function nearestDateIndex(xForIndex, count, plotX, plotW, slack = 8) {
  if (!Number.isFinite(plotX) || !Number.isInteger(count) || count <= 0) return null;
  if (plotX < -slack || plotX > plotW + slack) return null;
  let nearest = 0;
  for (let i = 1; i < count; i += 1) {
    if (Math.abs(xForIndex(i) - plotX) < Math.abs(xForIndex(nearest) - plotX)) nearest = i;
  }
  return nearest;
}

/** Linhas do tooltip para uma coluna: UMA por canal da série, sempre, na
 *  ordem da série (= ordem da legenda, = índice de cor).
 *
 *  Canal sem valor no dia sai com `value: null` (renderizado "—") em vez
 *  de ser omitido: sumir da lista seria indistinguível de "esse canal não
 *  existe", e a tela existe justamente pra comparar canais lado a lado. */
export function tooltipRowsForIndex(series, index) {
  if (!Array.isArray(series) || !Number.isInteger(index) || index < 0) return [];
  return series.map((s, idx) => {
    const raw = Array.isArray(s?.points) ? s.points[index]?.custoPorCadastroAcumulado : undefined;
    return {
      canal: s?.canal ?? "",
      colorIndex: idx % 3,
      value: typeof raw === "number" && Number.isFinite(raw) ? raw : null,
    };
  });
}

/** Mantém o tooltip dentro do container nas duas pontas do eixo.
 *
 *  Sem isso ele vaza pra fora do painel nas colunas das extremidades e no
 *  topo do gráfico (finding do review da #8300). Quando o tooltip é MAIOR
 *  que o container, a borda inicial vence (0) — cortar no fim esconderia
 *  justamente a data e o primeiro canal. */
export function clampToContainer(pos, size, containerSize) {
  if (!Number.isFinite(pos)) return 0;
  if (!Number.isFinite(size) || !Number.isFinite(containerSize)) return Math.max(0, pos);
  return Math.max(0, Math.min(pos, Math.max(0, containerSize - size)));
}

/** Nota dos dias sem veiculação que ficaram FORA do gráfico (#8307).
 *
 *  O eixo X pula esses dias; comprimir o tempo em silêncio trocaria uma
 *  leitura falsa (trecho reto que parece estabilidade) por outra (dias que
 *  somem sem explicação), então a contagem fica visível ao lado da legenda.
 *
 *  Até 3 datas saem listadas; acima disso vira "N dias … (primeira a
 *  última)" — nunca a lista inteira, que empurraria a legenda pra várias
 *  linhas numa pausa longa como a de 10–16/09. */
export function skippedPausedLabel(dates, fmtDate = formatDdMm) {
  if (!Array.isArray(dates) || dates.length === 0) return "";
  const noun = dates.length === 1 ? "dia sem veiculação (pausa)" : "dias sem veiculação (pausa)";
  const detail =
    dates.length <= 3
      ? dates.map((d) => fmtDate(d)).join(", ")
      : `${fmtDate(dates[0])} a ${fmtDate(dates[dates.length - 1])}`;
  return `${dates.length} ${noun} fora do gráfico: ${detail}`;
}

/** `YYYY-MM-DD` → `DD/MM`. Só reformatação de string: a data já vem do
 *  servidor como dia BRT, então passar por `new Date()` só arriscaria
 *  deslocar um dia por fuso. */
function formatDdMm(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso ?? ""));
  return m ? `${m[3]}/${m[2]}` : String(iso ?? "");
}
