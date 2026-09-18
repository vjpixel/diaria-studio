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
 *  Até 3 datas saem listadas; acima disso vira intervalo, pra não empurrar
 *  a legenda pra várias linhas numa pausa longa como a de 10–16/09. O
 *  conector distingue os dois casos (achado 3 do review da PR #8312):
 *  "10/09 a 16/09" só quando as datas são consecutivas — 2 pausas separadas
 *  saem como "entre 10/09 e 22/09", que não promete continuidade que não
 *  existe. */
export function skippedPausedLabel(dates, fmtDate = formatDdMm) {
  if (!Array.isArray(dates) || dates.length === 0) return "";
  const noun = dates.length === 1 ? "dia sem veiculação (pausa)" : "dias sem veiculação (pausa)";
  if (dates.length <= 3) {
    return `${dates.length} ${noun} fora do gráfico: ${dates.map((d) => fmtDate(d)).join(", ")}`;
  }
  const primeira = fmtDate(dates[0]);
  const ultima = fmtDate(dates[dates.length - 1]);
  const conector = isConsecutiveDayRun(dates) ? `${primeira} a ${ultima}` : `entre ${primeira} e ${ultima}`;
  return `${dates.length} ${noun} fora do gráfico: ${conector}`;
}

/** As datas são dias de calendário consecutivos? (`YYYY-MM-DD` ordenado
 *  ascendente, como o servidor manda.) @pure */
function isConsecutiveDayRun(dates) {
  const DIA_MS = 86_400_000;
  for (let i = 1; i < dates.length; i += 1) {
    const anterior = Date.parse(`${dates[i - 1]}T00:00:00Z`);
    const atual = Date.parse(`${dates[i]}T00:00:00Z`);
    if (!Number.isFinite(anterior) || !Number.isFinite(atual) || atual - anterior !== DIA_MS) return false;
  }
  return true;
}

/** `YYYY-MM-DD` → `DD/MM`. Só reformatação de string: a data já vem do
 *  servidor como dia BRT, então passar por `new Date()` só arriscaria
 *  deslocar um dia por fuso. Exportado porque `ads.js` já precisava do
 *  mesmo formato (achado 4 do review da PR #8312 — eram duas cópias da
 *  mesma regex). */
export function formatDdMm(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso ?? ""));
  return m ? `${m[3]}/${m[2]}` : String(iso ?? "");
}
