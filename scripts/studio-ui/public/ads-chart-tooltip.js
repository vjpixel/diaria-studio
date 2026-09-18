// ads-chart-tooltip.js (#8300) — lógica PURA do tooltip do gráfico
// "Custo/cadastro acumulado por canal" do painel /ads.
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
