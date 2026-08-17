/**
 * chart-svg.ts (#5593) — gráfico SVG inline server-side pra "Open rate por
 * dia" (`renderOpenRateByDaySection`, sections-core.ts). Duas séries —
 * Delivered (eixo esquerdo) e Open Rate (eixo direito, 0-100% fixo) — como
 * área preenchida com gradiente + linha suavizada (spline), no mesmo idioma
 * visual do benchmark passado pelo editor (#5593).
 *
 * Sem lib externa (CSP do worker, mesmo motivo documentado no #5490 que
 * escolheu spark-bar monospace pra tabela) — path de Bézier calculado à mão
 * a partir de Catmull-Rom, puro TS, zero dependência.
 *
 * Cores: NUNCA hex hardcoded aqui — tudo via `var(--token)`, os mesmos
 * custom properties que `renderDashboardHtml` já define no `:root` a partir
 * de `DS.*` (ds-tokens.generated.ts). O worker não tem hoje nenhum
 * `@media (prefers-color-scheme: dark)`/`data-theme` — nenhuma página deste
 * dashboard implementa tema escuro ainda (confirmado por grep, #5593). Dar
 * ao dashboard inteiro um tema escuro de verdade é fora do escopo desta
 * issue (P2, gráfico) e arriscaria as decisões de contraste AA já calibradas
 * a dedo alhures neste arquivo (#3088/#3323/#2104) — o compromisso adotado é
 * o gráfico nunca hardcoda cor própria: se/quando a página ganhar alternância
 * de tema por qualquer mecanismo (media query, `data-theme`, etc.), o SVG
 * acompanha de graça porque cada cor aqui é sempre `var(--...)`.
 *
 * Funções puras, sem HTML fora do necessário — testável por unidade sem
 * fixture de Worker/KV.
 */
import type { DayOpenRateSummary } from "./sections-core.ts";
import { PT_MONTHS_ABBR } from "../../../scripts/lib/cohorts.ts";

/** Ponto 2D em coordenadas do viewBox do SVG. */
export interface ChartPoint {
  x: number;
  y: number;
}

/**
 * Converte uma sequência de pontos num path de Bézier cúbica suavizada
 * (spline via Catmull-Rom → Bézier, tensão fixa 1/6 — conversão padrão).
 * `points.length < 2` retorna `""` (nada a desenhar — 1 ponto isolado vira
 * só marcador, sem linha). Exportado pra teste unitário.
 */
export function catmullRomToBezierPath(points: ChartPoint[]): string {
  if (points.length === 0) return "";
  if (points.length === 1) return "";
  if (points.length === 2) {
    return `M ${fmt(points[0].x)},${fmt(points[0].y)} L ${fmt(points[1].x)},${fmt(points[1].y)}`;
  }
  let d = `M ${fmt(points[0].x)},${fmt(points[0].y)}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] ?? points[i];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2] ?? p2;
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C ${fmt(c1x)},${fmt(c1y)} ${fmt(c2x)},${fmt(c2y)} ${fmt(p2.x)},${fmt(p2.y)}`;
  }
  return d;
}

function fmt(n: number): string {
  // 2 casas decimais bastam pro viewBox usado aqui — evita `1.2345678901`
  // poluindo o markup gerado. Guard defensivo: uma coordenada não-finita
  // (NaN/Infinity) nunca deve virar a string literal "NaN"/"Infinity" dentro
  // do atributo `d`/`cx`/`cy` do SVG — isso produziria markup malformado
  // silenciosamente aceito pelo browser (path simplesmente não desenha).
  if (!Number.isFinite(n)) {
    throw new Error(`chart-svg: coordenada não-finita (${n}) — dado de entrada corrompido`);
  }
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

/**
 * Extrai os itens não-nulos de uma sequência (alinhada 1:1 a `slots`, alguns
 * `null` = buraco — dia sem envio), preservando o índice original de cada
 * item, e devolve UM único "run" contínuo com todos eles em ordem. Usado pra
 * desenhar a linha/área do gráfico ATRAVESSANDO os buracos em vez de
 * quebrá-la neles (#5610 item 2 — inverte a decisão original do #5593, que
 * desenhava um segmento de path por trecho contíguo e deixava um buraco de
 * verdade na linha a cada dia sem envio; o editor pediu o oposto — pediu
 * pra conectar visualmente através dos dias sem dado, mesmo sabendo que uma
 * linha reta atravessando um gap também pode enganar tanto quanto um zero
 * interpolado — ver ressalva no corpo da issue #5610). O nome/assinatura da
 * função (retorna `Array<Array<...>>`, hoje sempre com 0 ou 1 elemento) foi
 * mantido pra não mexer no formato consumido por `renderSeries` abaixo.
 * Exportado pra teste unitário.
 */
export function splitIntoRuns<T>(slots: Array<T | null>): Array<Array<{ index: number; value: T }>> {
  const run: Array<{ index: number; value: T }> = [];
  for (let i = 0; i < slots.length; i++) {
    const v = slots[i];
    if (v !== null) run.push({ index: i, value: v });
  }
  return run.length > 0 ? [run] : [];
}

/**
 * Enumera todo dia-calendário (YYYY-MM-DD) entre `startDay` e `endDay`
 * (inclusive nas duas pontas), sem depender de fuso — os dois extremos já
 * chegam como chave BRT (mesma origem de `aggregateByDay`/`groupByBrtDay`),
 * então a iteração é pura aritmética de calendário UTC sobre a STRING, não
 * reintroduz fuso horário. Exportado pra teste unitário.
 */
export function enumerateDayRange(startDay: string, endDay: string): string[] {
  const start = new Date(`${startDay}T00:00:00Z`);
  const end = new Date(`${endDay}T00:00:00Z`);
  if (isNaN(start.getTime()) || isNaN(end.getTime()) || start > end) return [startDay];
  const days: string[] = [];
  const cur = new Date(start);
  while (cur <= end) {
    days.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return days;
}

/** Config de layout do chart — extraído pra constantes nomeadas testáveis. */
const CHART = {
  viewBoxW: 1450,
  viewBoxH: 300,
  padLeft: 52,
  padRight: 52,
  padTop: 40,
  padBottom: 30,
} as const;

/**
 * "Nice max" simples pro eixo Delivered — arredonda pra cima pro próximo
 * múltiplo redondo (evita eixo terminando em número feio tipo 1.234).
 * Exportado pra teste unitário.
 */
export function niceMax(value: number): number {
  if (!Number.isFinite(value)) {
    throw new Error(`chart-svg: niceMax recebeu valor não-finito (${value}) — dado de entrada corrompido`);
  }
  if (value <= 0) return 1;
  const magnitude = Math.pow(10, Math.floor(Math.log10(value)));
  const normalized = value / magnitude;
  let niceNormalized: number;
  if (normalized <= 1) niceNormalized = 1;
  else if (normalized <= 2) niceNormalized = 2;
  else if (normalized <= 5) niceNormalized = 5;
  else niceNormalized = 10;
  return niceNormalized * magnitude;
}

function escAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Formata um dia YYYY-MM-DD como "mmm dd" em pt-BR minúsculo (ex: "jul 21"),
 * pro rótulo de extremidade do eixo X. Reusa `PT_MONTHS_ABBR` (já
 * Workers-safe, mesma fonte de `sections-core.ts`/`cohorts.ts`).
 */
function fmtDayLabel(day: string): string {
  const [, m, d] = day.split("-");
  const mon = PT_MONTHS_ABBR[Number(m) - 1] ?? m;
  return `${mon} ${d}`;
}

/**
 * Renderiza o gráfico SVG inline de "Open rate por dia" (#5593) — duas
 * séries por dia-calendário BRT: Delivered (eixo Y esquerdo, escala
 * dinâmica) e Open Rate (eixo Y direito, fixo 0-100%). Curva suavizada,
 * área preenchida com gradiente (mais opaco — 0.35 — no topo → transparente
 * na base), gridlines horizontais pontilhadas discretas, sem gridlines
 * verticais, sem legenda flutuante (rótulos estáticos no canto do próprio
 * SVG).
 *
 * Buraco (dia sem envio, ausente de `rows`) NÃO quebra mais a linha (#5610
 * item 2 — inverte a decisão original do #5593, que desenhava um segmento
 * de path por trecho contíguo e deixava um buraco de verdade a cada dia
 * sem envio): `splitIntoRuns` agora devolve todos os pontos como um único
 * run contínuo, então a linha/área atravessa os dias sem dado. Os marcadores
 * (círculos) continuam desenhados só nos dias com dado de verdade — nunca
 * há marcador num dia sem envio, só a linha passa por cima dele.
 *
 * Dois marcadores distintos, combináveis no mesmo ponto:
 * - Amostra pequena (`smallSample`, <2 campanhas no dia) — círculo OCO
 *   (stroke colorido, fill = var(--card), a cor de fundo do "card") em vez
 *   do círculo preenchido normal — nas duas séries daquele dia, já que a
 *   flag é por-dia, não por-série.
 * - Imaturo (`immature`, alguma campanha do dia <48h — #5610 item 5, dado
 *   nunca mais é excluído do agregado) — opacidade reduzida (0.55) no
 *   marcador, sinalizando visualmente que o open rate ainda pode subir.
 * Legenda textual dos dois: `renderOpenRateByDaySection` (sections-core.ts).
 *
 * `rows.length === 0` retorna `""` — a seção-mãe (`renderOpenRateByDaySection`)
 * já decide se a seção inteira aparece; este helper só cuida do `<svg>`.
 * `rows.length === 1` desenha só os 2 marcadores (delivered + openRate),
 * sem linha (uma linha exige ≥2 pontos por definição).
 */
export function renderOpenRateChartSvg(rows: DayOpenRateSummary[]): string {
  if (rows.length === 0) return "";

  const days = enumerateDayRange(rows[0].day, rows[rows.length - 1].day);
  const byDay = new Map(rows.map((r) => [r.day, r]));
  const slots: Array<DayOpenRateSummary | null> = days.map((d) => byDay.get(d) ?? null);

  const { viewBoxW, viewBoxH, padLeft, padRight, padTop, padBottom } = CHART;
  const chartLeft = padLeft;
  const chartRight = viewBoxW - padRight;
  const chartTop = padTop;
  const chartBottom = viewBoxH - padBottom;
  const chartW = chartRight - chartLeft;
  const chartH = chartBottom - chartTop;

  const maxDelivered = niceMax(rows.reduce((m, r) => Math.max(m, r.delivered), 0));

  const xAt = (i: number): number =>
    days.length <= 1 ? chartLeft + chartW / 2 : chartLeft + (chartW * i) / (days.length - 1);
  const yDelivered = (v: number): number => chartBottom - (chartH * v) / maxDelivered;
  const yOpenRate = (v: number): number => {
    const clamped = Math.max(0, Math.min(v, 100));
    if (clamped !== v) {
      console.error(`chart-svg: openRate fora de [0,100] (${v}) — clampado pra ${clamped}, dado de agregação suspeito upstream`);
    }
    return chartBottom - (chartH * clamped) / 100;
  };

  type SeriesPoint = { point: ChartPoint; smallSample: boolean; immature: boolean };
  const deliveredSlots: Array<SeriesPoint | null> = slots.map((s, i) =>
    s ? { point: { x: xAt(i), y: yDelivered(s.delivered) }, smallSample: s.smallSample, immature: s.immature } : null,
  );
  const openRateSlots: Array<SeriesPoint | null> = slots.map((s, i) =>
    s ? { point: { x: xAt(i), y: yOpenRate(s.openRate) }, smallSample: s.smallSample, immature: s.immature } : null,
  );

  function renderSeries(
    seriesSlots: Array<SeriesPoint | null>,
    colorVar: string,
    gradientId: string,
    baselineY: number,
  ): { defs: string; areas: string; lines: string; markers: string } {
    const runs = splitIntoRuns(seriesSlots);
    let areas = "";
    let lines = "";
    let markers = "";
    for (const run of runs) {
      const pts = run.map((r) => r.value.point);
      if (pts.length >= 2) {
        const linePath = catmullRomToBezierPath(pts);
        lines += `<path d="${linePath}" fill="none" stroke="var(${colorVar})" stroke-width="2.5" stroke-linecap="round"/>`;
        const areaPath = `${linePath} L ${fmt(pts[pts.length - 1].x)},${fmt(baselineY)} L ${fmt(pts[0].x)},${fmt(baselineY)} Z`;
        areas += `<path d="${areaPath}" fill="url(#${gradientId})" stroke="none"/>`;
      }
      for (const { value } of run) {
        const { point, smallSample, immature } = value;
        // #5610 item 3: círculo OCO (fill=var(--card)) sinaliza amostra pequena.
        // #5610 item 5: opacidade reduzida (sem excluir o dado) sinaliza que a
        // campanha ainda está dentro da janela de maturação de 48h — as duas
        // condições podem coincidir no mesmo ponto (marcador oco + semitransparente).
        const opacity = immature ? ` opacity="0.55"` : "";
        markers += smallSample
          ? `<circle cx="${fmt(point.x)}" cy="${fmt(point.y)}" r="4" fill="var(--card)" stroke="var(${colorVar})" stroke-width="2"${opacity}/>`
          : `<circle cx="${fmt(point.x)}" cy="${fmt(point.y)}" r="3" fill="var(${colorVar})"${opacity}/>`;
      }
    }
    const defs = `<linearGradient id="${gradientId}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="var(${colorVar})" stop-opacity="0.35"/>
      <stop offset="100%" stop-color="var(${colorVar})" stop-opacity="0"/>
    </linearGradient>`;
    return { defs, areas, lines, markers };
  }

  // #5593: as duas cores vêm de tokens JÁ canônicos deste arquivo (nunca hex
  // novo) — --brand (teal, DS.brand) é o token que este arquivo já reserva
  // pra "elementos GRÁFICOS" (ver comentário td.metric em sections-core.ts,
  // #3088) e --alert (vermelho, DS.alert) já é o 2º acento semântico do
  // dashboard (circuit breaker). O benchmark do editor sugere laranja/rosa
  // como PALETA de referência, não como hex obrigatório — nenhum dos dois
  // existe como token DS; reusar os 2 tokens de acento já estabelecidos
  // aqui evita inventar cor fora de ds-tokens.generated.ts.
  const delivered = renderSeries(deliveredSlots, "--brand", "chart-gradient-delivered", chartBottom);
  const openRate = renderSeries(openRateSlots, "--alert", "chart-gradient-openrate", chartBottom);

  // Gridlines horizontais pontilhadas em 0/50/100% da altura do chart —
  // sem gridlines verticais (pedido explícito do benchmark). Rótulos dos
  // dois eixos na mesma altura, cada um na sua própria escala.
  const gridFractions = [0, 0.5, 1];
  const gridlines = gridFractions
    .map((f) => {
      const y = chartTop + chartH * f;
      const deliveredVal = Math.round(maxDelivered * (1 - f));
      const openRateVal = Math.round(100 * (1 - f));
      return `<line x1="${chartLeft}" y1="${fmt(y)}" x2="${chartRight}" y2="${fmt(y)}" stroke="var(--rule)" stroke-width="1" stroke-dasharray="2,3"/>
      <text x="${chartLeft - 8}" y="${fmt(y)}" text-anchor="end" dominant-baseline="middle" font-size="11" fill="var(--ink)" opacity="0.55">${deliveredVal.toLocaleString("pt-BR")}</text>
      <text x="${chartRight + 8}" y="${fmt(y)}" text-anchor="start" dominant-baseline="middle" font-size="11" fill="var(--ink)" opacity="0.55">${openRateVal}%</text>`;
    })
    .join("\n");

  const xLabelFirst = fmtDayLabel(days[0]);
  const xLabelLast = fmtDayLabel(days[days.length - 1]);
  const xLabels =
    days.length > 1
      ? `<text x="${chartLeft}" y="${viewBoxH - 8}" text-anchor="start" font-size="11" fill="var(--ink)" opacity="0.55">${escAttr(xLabelFirst)}</text>
      <text x="${chartRight}" y="${viewBoxH - 8}" text-anchor="end" font-size="11" fill="var(--ink)" opacity="0.55">${escAttr(xLabelLast)}</text>`
      : `<text x="${(chartLeft + chartRight) / 2}" y="${viewBoxH - 8}" text-anchor="middle" font-size="11" fill="var(--ink)" opacity="0.55">${escAttr(xLabelFirst)}</text>`;

  // Rótulos estáticos de série (não é legenda flutuante — texto fixo no
  // próprio SVG, sempre visível, sem hover/JS).
  //
  // Contraste AA (#5593 fleet review, code-reviewer + comment-analyzer
  // convergiram no mesmo achado): `var(--brand)` (teal) falha AA (~3.2:1) em
  // texto 12px/700 — `sections-core.ts` já documenta essa falha em 3 lugares
  // (tags ▲ ABERTURA/▲ CLIQUE/▲ MELHOR DIA revertidas pra `--ink` por esse
  // motivo). O marcador "●" É elemento gráfico (associação cor↔série, SC
  // 1.4.11 — não exige 4.5:1) e mantém a cor da série; o TEXTO do rótulo usa
  // `var(--ink)`, que já é a cor de alto contraste calibrada neste arquivo.
  // Dois `<tspan>` por rótulo em vez de 1 `fill` só na `<text>`.
  const seriesLabels = `<text x="${chartLeft}" y="16" font-size="12" font-weight="700"><tspan fill="var(--brand)">●</tspan> <tspan fill="var(--ink)">Delivered</tspan></text>
    <text x="${chartRight}" y="16" text-anchor="end" font-size="12" font-weight="700"><tspan fill="var(--alert)">●</tspan> <tspan fill="var(--ink)">Open Rate</tspan></text>`;

  return `<svg class="day-openrate-chart" viewBox="0 0 ${viewBoxW} ${viewBoxH}" width="100%" height="auto" role="img" aria-label="Delivered e Open Rate por dia-calendário — ver texto acima para a janela e as legendas de marcador">
    <defs>${delivered.defs}${openRate.defs}</defs>
    ${seriesLabels}
    ${gridlines}
    ${delivered.areas}
    ${openRate.areas}
    ${delivered.lines}
    ${openRate.lines}
    ${delivered.markers}
    ${openRate.markers}
    ${xLabels}
  </svg>`;
}
