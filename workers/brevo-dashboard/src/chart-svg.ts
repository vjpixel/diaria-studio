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
 *
 * **#5603:** as 3 situações de entrada inválida (data malformada em
 * `startDay`, em `endDay`, ou range invertido `start > end`) lançam erros
 * DESCRITIVOS e DISTINTOS, em vez de caírem no mesmo fallback silencioso
 * `return [startDay]` — o único chamador (`renderOpenRateChartSvg`, via
 * `aggregateByDay` em `sections-core.ts`) já garante entrada válida hoje;
 * isto é defesa pra um chamador futuro/refactor que quebre essa garantia
 * implícita não colapsar o gráfico pra "1 dia de dados" sem nenhuma pista
 * de por quê.
 */
export function enumerateDayRange(startDay: string, endDay: string): string[] {
  const start = new Date(`${startDay}T00:00:00Z`);
  if (isNaN(start.getTime())) {
    throw new Error(`chart-svg: enumerateDayRange recebeu startDay malformado (${JSON.stringify(startDay)})`);
  }
  const end = new Date(`${endDay}T00:00:00Z`);
  if (isNaN(end.getTime())) {
    throw new Error(`chart-svg: enumerateDayRange recebeu endDay malformado (${JSON.stringify(endDay)})`);
  }
  if (start > end) {
    throw new Error(`chart-svg: enumerateDayRange recebeu range invertido (startDay=${startDay} > endDay=${endDay})`);
  }
  const days: string[] = [];
  const cur = new Date(start);
  while (cur <= end) {
    days.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return days;
}

/**
 * Config de layout do chart — extraído pra constantes nomeadas testáveis.
 * Exportado (#5640 A4) pra `renderConfoundersSparklineSvg` reusar
 * `padLeft`/`padRight`/`viewBoxW` — mesma matemática de `xAt` do gráfico
 * principal, garantindo alinhamento pixel-a-pixel em X sem acoplar os dois
 * SVGs via JS/crosshair compartilhado (decisão de escopo documentada em
 * `renderOpenRateByDaySection`, sections-core.ts).
 */
export const CHART = {
  viewBoxW: 1450,
  viewBoxH: 300,
  padLeft: 52,
  padRight: 52,
  padTop: 40,
  padBottom: 30,
} as const;

/** #5640 B7: passo (em dias-calendário) entre rótulos/gridlines INTERIORES do eixo X. */
export const X_LABEL_STEP_DAYS = 5;

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

/** Nomes completos de mês pt-BR — só usado no tooltip (#5640 B1, "data por extenso"). */
const PT_MONTHS_FULL = [
  "janeiro", "fevereiro", "março", "abril", "maio", "junho",
  "julho", "agosto", "setembro", "outubro", "novembro", "dezembro",
];

/** Nomes completos de dia da semana pt-BR — idem, só pro tooltip. */
const PT_WEEKDAYS_FULL = [
  "domingo", "segunda-feira", "terça-feira", "quarta-feira",
  "quinta-feira", "sexta-feira", "sábado",
];

/**
 * Formata um dia YYYY-MM-DD por extenso em pt-BR pro tooltip do crosshair
 * (#5640 B1) — ex: "sábado, 16 de agosto de 2026". Usa `Date.UTC` (mesmo
 * padrão de `enumerateDayRange` acima) pra não reintroduzir deslocamento de
 * fuso horário — a chave já chega em BRT, a aritmética é pura sobre a data
 * calendário. Exportado pra teste unitário.
 */
export function fmtDayLabelLong(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const weekday = PT_WEEKDAYS_FULL[dt.getUTCDay()];
  const mon = PT_MONTHS_FULL[m - 1] ?? String(m);
  return `${weekday}, ${d} de ${mon} de ${y}`;
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
 *
 * **#5640 (B1-B4): crosshair + tooltip compartilhado + hit area de coluna +
 * destaque do ponto ativo.** Elementos adicionados, todos consumidos pelo
 * `<script>` inline em `renderOpenRateByDaySection` (sections-core.ts) — este
 * módulo só emite markup/dados, zero JS aqui (mantém a separação já existente
 * entre "gera SVG" e "liga interatividade"):
 * - `<rect class="chart-hit-rect">` — um por DIA (não por dado; dias sem
 *   envio também ganham rect, cobrindo a faixa vertical inteira da coluna,
 *   largura = distância até o ponto médio pros vizinhos, B2) carregando
 *   `data-*` com tudo que o tooltip precisa (`data-day`, `data-daylabel`,
 *   `data-x`, `data-hasdata`, e quando há dado: `data-count`,
 *   `data-delivered`, `data-opens`, `data-openrate`, `data-smallsample`,
 *   `data-immature` — as mesmas duas flags de `DayOpenRateSummary`, sem
 *   inventar novo campo).
 * - `<line class="chart-crosshair">` — 1 linha vertical, `opacity:0` por
 *   default, reposicionada via `x1`/`x2` pelo script ao entrar numa coluna.
 * - Marcadores (`<circle>`) ganham `class="chart-marker"`, `data-day-index`
 *   (índice do dia, pra achar os 2 marcadores — delivered + openRate — do
 *   dia ativo) e `data-r` (raio original, pra restaurar ao sair do hover).
 *
 * **#5640 B6: teclado e leitor de tela.** `<svg>` ganha `tabindex="0"` (entra
 * na ordem de foco — o script de `renderOpenRateByDaySection` liga
 * ←/→/Home/End/Esc) e `aria-describedby` apontando pro `<desc>` abaixo do
 * `<title>` — o `role="img"` + `aria-label` existentes são mantidos como
 * fallback (nome acessível), `<title>`/`<desc>` cobrem leitores/ferramentas
 * que não resolvem `aria-label` em `<svg>`.
 *
 * **#5640 B7 (decisão do editor 260818: implementar agora — "escolhendo uma
 * fonte histórica disponível e adicionando rótulos/gridlines"): rótulos
 * intermediários do eixo X + gridlines verticais.** Além dos 2 rótulos de
 * ponta (primeiro/último dia, já existentes), 1 rótulo + 1 gridline vertical
 * a cada `X_LABEL_STEP_DAYS` (5) dias — só nos índices INTERIORES (nunca
 * duplica os rótulos de ponta, nem desenha um interior colado na ponta).
 * Gridline pontilhada, mesmo idioma visual das horizontais (`var(--rule)`,
 * `stroke-dasharray="2,3"`), opacidade um pouco mais discreta (0.35, vs 0.55
 * do rótulo) pra não competir com o crosshair (B1 — a única linha vertical
 * SÓLIDA, e só visível no hover).
 *
 * **#5640 A1 (mesma decisão do editor): 3ª série — open rate ESPERADO.**
 * `DayOpenRateSummary.expectedOpenRate` (campo opcional, computado por
 * `computeExpectedOpenRateByDay`, sections-core.ts, a partir do mix de
 * coortes do dia × open rate base histórico de cada coorte — ver docstring
 * lá) vira uma linha tracejada, cor NEUTRA (`var(--ink)`, opacidade 0.6 —
 * nunca `--brand`/`--alert`, que já identificam Delivered/Open Rate REAL),
 * SEM marcador e SEM área preenchida (é uma estimativa, não uma série
 * medida — a ausência de marcador já sinaliza isso visualmente). Dia sem
 * `expectedOpenRate` (nenhuma campanha classificável naquele dia, ou coorte
 * sem base histórica suficiente) vira buraco na série — mesmo mecanismo de
 * `splitIntoRuns` das outras duas séries, conecta através do buraco. Se
 * NENHUM dia da janela tem `expectedOpenRate`, nem linha nem rótulo
 * aparecem — chamador que não passa o campo (rows antigas, testes) não
 * regride.
 */
export function renderOpenRateChartSvg(rows: DayOpenRateSummary[]): string {
  if (rows.length === 0) return "";

  // #5603: assert leve — `rows` precisa vir ordenado ASCENDENTE por `day` e
  // sem `day` duplicado. O único chamador (`aggregateByDay` em
  // sections-core.ts) já garante isso hoje, então isto nunca deve disparar
  // em produção; existe pra transformar uma violação FUTURA (refactor de
  // `aggregateByDay`, 2º call site) num erro imediato e localizável — sem
  // este assert, `day` duplicado é resolvido em silêncio pelo `Map`
  // mantendo só a última ocorrência, e ordem descendente produziria um
  // `enumerateDayRange` invertido (que agora lança, ver acima) em vez de um
  // gráfico simplesmente errado.
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].day === rows[i - 1].day) {
      throw new Error(`chart-svg: renderOpenRateChartSvg recebeu day duplicado (${rows[i].day}) — invariante de aggregateByDay violado`);
    }
    if (rows[i].day < rows[i - 1].day) {
      throw new Error(
        `chart-svg: renderOpenRateChartSvg recebeu rows fora de ordem ascendente (${rows[i - 1].day} > ${rows[i].day}) — invariante de aggregateByDay violado`,
      );
    }
  }

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
      for (const { index, value } of run) {
        const { point, smallSample, immature } = value;
        // #5610 item 3: círculo OCO (fill=var(--card)) sinaliza amostra pequena.
        // #5610 item 5: opacidade reduzida (sem excluir o dado) sinaliza que a
        // campanha ainda está dentro da janela de maturação de 48h — as duas
        // condições podem coincidir no mesmo ponto (marcador oco + semitransparente).
        const opacity = immature ? ` opacity="0.55"` : "";
        // #5640 B3: `class`/`data-day-index`/`data-r` — usados pelo script
        // inline de `renderOpenRateByDaySection` pra achar e destacar (raio
        // maior) os 2 marcadores do dia sob o ponteiro. `data-r` guarda o
        // raio ORIGINAL (3 ou 4) pra restaurar ao sair do hover sem precisar
        // recalcular a regra smallSample no JS.
        const r = smallSample ? 4 : 3;
        markers += smallSample
          ? `<circle class="chart-marker" data-day-index="${index}" data-r="${r}" cx="${fmt(point.x)}" cy="${fmt(point.y)}" r="${r}" fill="var(--card)" stroke="var(${colorVar})" stroke-width="2"${opacity}/>`
          : `<circle class="chart-marker" data-day-index="${index}" data-r="${r}" cx="${fmt(point.x)}" cy="${fmt(point.y)}" r="${r}" fill="var(${colorVar})"${opacity}/>`;
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

  // #5640 A1: 3ª série — open rate ESPERADO (mix de coortes × base
  // histórica). Linha tracejada só, sem área/marcador — ver docstring da
  // função. `expectedOpenRate` é opcional em `DayOpenRateSummary`; dia sem
  // valor vira buraco (`null`), mesmo mecanismo de `splitIntoRuns`.
  const expectedSlots: Array<{ point: ChartPoint } | null> = slots.map((s, i) => {
    const v = s?.expectedOpenRate;
    return v != null ? { point: { x: xAt(i), y: yOpenRate(v) } } : null;
  });
  const hasExpectedData = expectedSlots.some((s) => s !== null);
  let expectedLine = "";
  for (const run of splitIntoRuns(expectedSlots)) {
    const pts = run.map((r) => r.value.point);
    if (pts.length >= 2) {
      expectedLine += `<path d="${catmullRomToBezierPath(pts)}" fill="none" stroke="var(--ink)" stroke-width="2" stroke-dasharray="6,4" stroke-linecap="round" opacity="0.6"/>`;
    } else {
      // Run de 1 ponto só (dia isolado com estimativa entre dois dias sem):
      // sem este caso o dado sumia da tela por completo — `pts.length >= 2`
      // não desenha path, e a série esperada não tem marcador por design.
      // Um traço curto centrado no ponto mantém o dado visível SEM virar
      // marcador de série medida (mesma cor/espessura/opacidade da linha).
      const p = pts[0];
      expectedLine += `<line x1="${fmt(p.x - 5)}" y1="${fmt(p.y)}" x2="${fmt(p.x + 5)}" y2="${fmt(p.y)}" stroke="var(--ink)" stroke-width="2" stroke-linecap="round" opacity="0.6"/>`;
    }
  }

  // Gridlines horizontais pontilhadas em 0/50/100% da altura do chart.
  // Rótulos dos dois eixos na mesma altura, cada um na sua própria escala.
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

  // #5640 B7: rótulos intermediários + gridlines verticais — passo fixo
  // (`X_LABEL_STEP_DAYS`), só índices interiores (0 e days.length-1 já são
  // os rótulos de ponta acima, nunca duplicados aqui). Janela curta
  // (`days.length <= X_LABEL_STEP_DAYS`) não produz nenhum interior — o
  // loop simplesmente não itera, sem caso especial.
  let xInteriorGridlines = "";
  let xInteriorLabels = "";
  for (let i = X_LABEL_STEP_DAYS; i < days.length - 1; i += X_LABEL_STEP_DAYS) {
    const x = xAt(i);
    xInteriorGridlines += `<line x1="${fmt(x)}" y1="${fmt(chartTop)}" x2="${fmt(x)}" y2="${fmt(chartBottom)}" stroke="var(--rule)" stroke-width="1" stroke-dasharray="2,3" opacity="0.35"/>`;
    xInteriorLabels += `<text x="${fmt(x)}" y="${viewBoxH - 8}" text-anchor="middle" font-size="11" fill="var(--ink)" opacity="0.55">${escAttr(fmtDayLabel(days[i]))}</text>`;
  }

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
    <text x="${chartRight}" y="16" text-anchor="end" font-size="12" font-weight="700"><tspan fill="var(--alert)">●</tspan> <tspan fill="var(--ink)">Open Rate</tspan></text>
    ${
      // Swatch = `<line>` de verdade com o MESMO `stroke-dasharray` da série,
      // não o glyph `┄` (U+2504): fonte sem esse caractere renderiza tofu, e
      // mesmo quando existe o tracejado do glyph não bate com o da linha.
      hasExpectedData
        ? `<line x1="${fmt((chartLeft + chartRight) / 2 - 66)}" y1="12" x2="${fmt((chartLeft + chartRight) / 2 - 50)}" y2="12" stroke="var(--ink)" stroke-width="2" stroke-dasharray="6,4" stroke-linecap="round" opacity="0.6"/>
    <text x="${fmt((chartLeft + chartRight) / 2 - 44)}" y="16" text-anchor="start" font-size="12" font-weight="700" fill="var(--ink)">Esperado (mix)</text>`
        : ""
    }`;

  // #5640 B1: linha vertical do crosshair — invisível por default
  // (`opacity:0`, sem `pointer-events` pra não competir com os hit rects
  // logo abaixo), reposicionada via `x1`/`x2` pelo script inline ao entrar
  // numa coluna. `id` fixo — só existe 1 instância deste gráfico por página
  // (único call site, `renderOpenRateByDaySection`), então não há colisão.
  const crosshair = `<line id="day-openrate-crosshair" class="chart-crosshair" x1="${fmt(chartLeft)}" y1="${fmt(chartTop)}" x2="${fmt(chartLeft)}" y2="${fmt(chartBottom)}" stroke="var(--rule)" stroke-width="1" style="opacity:0;pointer-events:none;"/>`;

  // #5640 B1+B2: hit area de COLUNA (não do marcador de 3px) — 1 `<rect>`
  // transparente por DIA-CALENDÁRIO da janela inteira (`days`, não só
  // `rows` — dias sem envio também recebem um rect, pra hover funcionar em
  // qualquer ponto da faixa; `data-hasdata="0"` sinaliza ausência de dado
  // pro tooltip). Largura da coluna = distância até o ponto médio com os
  // dias vizinhos (nearest-x sem posição livre do mouse); nas duas pontas a
  // coluna vai até a borda do chart. `data-x` guarda a posição EXATA do
  // ponto (mesma coordenada dos marcadores) pro crosshair alinhar com o
  // marcador, não com o centro da coluna (que pode divergir 1px nas pontas).
  const boundaries: number[] = [chartLeft];
  for (let i = 1; i < days.length; i++) {
    boundaries.push((xAt(i - 1) + xAt(i)) / 2);
  }
  boundaries.push(chartRight);

  let hitRects = "";
  for (let i = 0; i < days.length; i++) {
    const x0 = boundaries[i];
    const x1 = boundaries[i + 1];
    const s = slots[i];
    const dataAttrs = [
      `data-idx="${i}"`,
      `data-day="${escAttr(days[i])}"`,
      `data-daylabel="${escAttr(fmtDayLabelLong(days[i]))}"`,
      `data-x="${fmt(xAt(i))}"`,
      s
        ? `data-hasdata="1" data-count="${s.count}" data-delivered="${s.delivered}" data-opens="${s.opens}" data-openrate="${fmt(s.openRate)}" data-smallsample="${s.smallSample ? "1" : "0"}" data-immature="${s.immature ? "1" : "0"}"${
            // A linha tracejada só serve pra comparar com o real; sem o valor
            // no tooltip/leitor de tela o leitor só consegue estimar o gap a
            // olho. Ausente quando o dia não tem estimativa (nunca "0%").
            s.expectedOpenRate != null ? ` data-expected="${fmt(s.expectedOpenRate)}"` : ""
          }`
        : `data-hasdata="0"`,
    ].join(" ");
    hitRects += `<rect class="chart-hit-rect" x="${fmt(x0)}" y="${fmt(chartTop)}" width="${fmt(x1 - x0)}" height="${fmt(chartH)}" fill="transparent" ${dataAttrs}/>`;
  }

  // #5640 B6: <title>/<desc> — nome/descrição acessível redundante ao
  // aria-label (robustez pra AT que não resolve aria-label em <svg>). A
  // <desc> também documenta a navegação por teclado, já que não há outro
  // jeito de descobrir isso sem ler o affordance note fora do SVG.
  const svgDesc = `Série temporal com ${days.length} dias, de ${escAttr(xLabelFirst)} a ${escAttr(xLabelLast)}. Use as setas do teclado para navegar dia a dia, Home e End para as pontas, Esc para sair. O detalhe de cada dia também está na tabela de Envios abaixo.`;

  return `<svg id="day-openrate-svg" class="day-openrate-chart" viewBox="0 0 ${viewBoxW} ${viewBoxH}" width="100%" height="auto" role="img" tabindex="0" aria-describedby="day-openrate-svg-desc" aria-label="Delivered e Open Rate por dia-calendário — ver texto acima para a janela e as legendas de marcador">
    <title>Delivered e Open Rate por dia-calendário</title>
    <desc id="day-openrate-svg-desc">${svgDesc}</desc>
    <defs>${delivered.defs}${openRate.defs}</defs>
    ${seriesLabels}
    ${gridlines}
    ${xInteriorGridlines}
    ${delivered.areas}
    ${openRate.areas}
    ${delivered.lines}
    ${openRate.lines}
    ${expectedLine}
    ${delivered.markers}
    ${openRate.markers}
    ${xLabels}
    ${xInteriorLabels}
    ${crosshair}
    ${hitRects}
  </svg>`;
}

/**
 * #5640 A2: layout de cada mini-gráfico de coorte (small multiples) — bem
 * menor que `CHART` (gráfico principal), sem eixo duplo (só openRate,
 * 0-100% fixo, sem `niceMax`/eixo Delivered).
 */
const COHORT_CHART = {
  viewBoxW: 400,
  viewBoxH: 130,
  padLeft: 34,
  padRight: 10,
  padTop: 22,
  padBottom: 20,
} as const;

/**
 * Renderiza UM mini-gráfico de "open rate por dia" pra uma coorte (#5640
 * A2, small multiples) — mesmos marcadores/semântica visual do gráfico
 * principal (círculo oco = amostra pequena, opacidade reduzida = imaturo),
 * SÓ a linha de open rate (sem Delivered, sem eixo duplo), Y fixo 0-100%.
 *
 * `days` é o domínio X COMPARTILHADO entre todas as coortes (calculado uma
 * vez pelo chamador a partir do range do gráfico principal — ver
 * `renderOpenRateByDaySection`, sections-core.ts) — não o range próprio de
 * `rows`, que pode ser mais estreito (coorte sem envio nos primeiros/
 * últimos dias da janela) ou vazio. `rows.length === 0` ainda desenha o
 * eixo/gridline vazio com uma nota "sem envios na janela" — deixa explícito
 * que a coorte existe e não recebeu nada, em vez de omitir o painel
 * (omitir esconderia justamente o sinal "essa coorte ficou de fora").
 * Exportado pra teste unitário.
 */
export function renderCohortSmallMultipleSvg(days: string[], label: string, rows: DayOpenRateSummary[]): string {
  const { viewBoxW, viewBoxH, padLeft, padRight, padTop, padBottom } = COHORT_CHART;
  const chartLeft = padLeft;
  const chartRight = viewBoxW - padRight;
  const chartTop = padTop;
  const chartBottom = viewBoxH - padBottom;
  const chartW = chartRight - chartLeft;
  const chartH = chartBottom - chartTop;

  const byDay = new Map(rows.map((r) => [r.day, r]));
  const slots: Array<DayOpenRateSummary | null> = days.map((d) => byDay.get(d) ?? null);

  const xAt = (i: number): number =>
    days.length <= 1 ? chartLeft + chartW / 2 : chartLeft + (chartW * i) / (days.length - 1);
  const yAt = (v: number): number => {
    const clamped = Math.max(0, Math.min(v, 100));
    return chartBottom - (chartH * clamped) / 100;
  };

  type P = { point: ChartPoint; smallSample: boolean; immature: boolean };
  const pointSlots: Array<P | null> = slots.map((s, i) =>
    s ? { point: { x: xAt(i), y: yAt(s.openRate) }, smallSample: s.smallSample, immature: s.immature } : null,
  );

  const runs = splitIntoRuns(pointSlots);
  let line = "";
  let markers = "";
  for (const run of runs) {
    const pts = run.map((r) => r.value.point);
    if (pts.length >= 2) {
      line = `<path d="${catmullRomToBezierPath(pts)}" fill="none" stroke="var(--alert)" stroke-width="2" stroke-linecap="round"/>`;
    }
    for (const { value } of run) {
      const { point, smallSample, immature } = value;
      const opacity = immature ? ` opacity="0.55"` : "";
      const r = smallSample ? 3.5 : 2.5;
      markers += smallSample
        ? `<circle cx="${fmt(point.x)}" cy="${fmt(point.y)}" r="${r}" fill="var(--card)" stroke="var(--alert)" stroke-width="1.5"${opacity}/>`
        : `<circle cx="${fmt(point.x)}" cy="${fmt(point.y)}" r="${r}" fill="var(--alert)"${opacity}/>`;
    }
  }

  const gridY = chartTop + chartH * 0.5;
  const gridline = `<line x1="${fmt(chartLeft)}" y1="${fmt(gridY)}" x2="${fmt(chartRight)}" y2="${fmt(gridY)}" stroke="var(--rule)" stroke-width="1" stroke-dasharray="2,3"/>`;

  const totalCampaigns = rows.reduce((sum, r) => sum + r.count, 0);
  const countLabel = rows.length === 0 ? "sem envios" : `${totalCampaigns} ${totalCampaigns === 1 ? "envio" : "envios"}`;

  return `<svg class="cohort-multiple-chart" viewBox="0 0 ${viewBoxW} ${viewBoxH}" width="100%" height="auto" role="img" aria-label="Open rate por dia — ${escAttr(label)} — ${escAttr(countLabel)}">
    <title>${escAttr(label)}</title>
    <text x="${chartLeft}" y="15" font-size="12" font-weight="700" fill="var(--ink)">${escAttr(label)}</text>
    <text x="${chartRight}" y="15" text-anchor="end" font-size="10" fill="var(--ink)" opacity="0.6">${escAttr(countLabel)}</text>
    ${gridline}
    ${line}
    ${markers}
  </svg>`;
}

/**
 * #5640 A4: uma sparkline por métrica ("confounder"), stacked verticalmente
 * — bounce rate, spam rate (complaints Brevo, mesma fonte de
 * `MonthlyTotalRow`), CTOR. Reusa `CHART.padLeft`/`padRight`/`viewBoxW` do
 * gráfico principal (não `COHORT_CHART`) pra que a coordenada X de cada dia
 * bata pixel-a-pixel com `renderOpenRateChartSvg` — é o mecanismo de
 * "alinhado ao mesmo eixo X" sem precisar compartilhar crosshair/JS (ver
 * decisão de escopo em `renderOpenRateByDaySection`, sections-core.ts).
 * `days` é o mesmo domínio X compartilhado usado pelos small multiples
 * (A2) — computado uma vez pelo chamador. Cada linha usa sua PRÓPRIA
 * escala Y (bounce/spam tipicamente <10%, CTOR tipicamente 0-40%) — eixo Y
 * nunca é mostrado numericamente aqui (é sparkline, não gráfico de eixo
 * completo); só o valor mais recente é rotulado à direita. Buracos (dia
 * sem envio) atravessam a linha, mesmo comportamento de `splitIntoRuns` no
 * gráfico principal (#5610 item 2). Exportado pra teste unitário.
 */
export function renderConfoundersSparklineSvg(days: string[], rows: DayOpenRateSummary[]): string {
  const { viewBoxW, padLeft, padRight } = CHART;
  const chartLeft = padLeft;
  const chartRight = viewBoxW - padRight;
  const chartW = chartRight - chartLeft;

  const ROW_H = 34;
  const ROW_GAP = 4;
  const LABEL_H = 12; // reserva pro rótulo de métrica/último valor no topo de cada linha
  const metrics: Array<{ key: "bounceRate" | "spamRate" | "ctor"; label: string; colorVar: string; minMax: number }> = [
    { key: "bounceRate", label: "Bounce", colorVar: "--alert", minMax: 5 },
    { key: "spamRate", label: "Spam", colorVar: "--alert", minMax: 0.5 },
    { key: "ctor", label: "CTOR", colorVar: "--brand", minMax: 20 },
  ];
  const viewBoxH = metrics.length * (ROW_H + ROW_GAP) + ROW_GAP;

  const byDay = new Map(rows.map((r) => [r.day, r]));
  const slots: Array<DayOpenRateSummary | null> = days.map((d) => byDay.get(d) ?? null);
  const xAt = (i: number): number =>
    days.length <= 1 ? chartLeft + chartW / 2 : chartLeft + (chartW * i) / (days.length - 1);

  let out = "";
  metrics.forEach((metric, rowIdx) => {
    const rowTop = ROW_GAP + rowIdx * (ROW_H + ROW_GAP);
    const plotTop = rowTop + LABEL_H;
    const plotBottom = rowTop + ROW_H;
    const values = slots.map((s) => (s ? s[metric.key] : null));
    const finiteValues = values.filter((v): v is number => v != null);
    const maxV = Math.max(metric.minMax, ...finiteValues);
    const yAt = (v: number): number => {
      if (maxV <= 0) return plotBottom;
      return plotBottom - ((plotBottom - plotTop) * Math.min(v, maxV)) / maxV;
    };

    const pointSlots: Array<{ point: ChartPoint } | null> = slots.map((s, i) =>
      s ? { point: { x: xAt(i), y: yAt(s[metric.key]) } } : null,
    );
    const runs = splitIntoRuns(pointSlots);
    let path = "";
    for (const run of runs) {
      const pts = run.map((r) => r.value.point);
      if (pts.length >= 2) {
        path += `<path d="${catmullRomToBezierPath(pts)}" fill="none" stroke="var(${metric.colorVar})" stroke-width="1.5" stroke-linecap="round" opacity="0.85"/>`;
      } else if (pts.length === 1) {
        path += `<circle cx="${fmt(pts[0].x)}" cy="${fmt(pts[0].y)}" r="1.5" fill="var(${metric.colorVar})"/>`;
      }
    }

    const lastVal = [...finiteValues].pop();
    const lastLabel = lastVal != null ? `${lastVal.toFixed(1)}%` : "—";

    out += `<text x="${chartLeft}" y="${rowTop + 9}" font-size="10" fill="var(--ink)" opacity="0.65">${escAttr(metric.label)}</text>
    <text x="${chartRight}" y="${rowTop + 9}" text-anchor="end" font-size="10" fill="var(--ink)" opacity="0.65">${lastLabel}</text>
    <line x1="${fmt(chartLeft)}" y1="${fmt(plotBottom)}" x2="${fmt(chartRight)}" y2="${fmt(plotBottom)}" stroke="var(--rule)" stroke-width="1" stroke-dasharray="1,3"/>
    ${path}`;
  });

  return `<svg class="confounders-sparkline-chart" viewBox="0 0 ${viewBoxW} ${viewBoxH}" width="100%" height="auto" role="img" aria-label="Bounce rate, spam rate e CTOR por dia — confounders do open rate, mesma janela do gráfico principal">
    <title>Confounders — bounce, spam, CTOR por dia</title>
    ${out}
  </svg>`;
}

/**
 * #5640 A3 (decisão do editor 260818: implementar agora, junto com A1/B7 —
 * a própria issue já classifica esta fatia como "o mais analítico e mais
 * dispensável dos cinco" da Parte A, maior risco de má-interpretação
 * causal). Defasagens fixas `0..3` — pra cada `k`, correlaciona
 * `delivered[dia]` com `openRate[dia+k]` (Pearson). Pico de correlação
 * negativa em `k=0` sugere efeito de MIX (a mesma campanha que trouxe
 * volume trouxe também o público mais frio); pico em `k=1..3` sugere
 * reputação respondendo com atraso — a leitura fica pro texto da seção
 * (`renderOpenRateByDaySection`, sections-core.ts), não aqui.
 *
 * Opera sobre o range de CALENDÁRIO completo (`enumerateDayRange` entre o
 * primeiro e o último `day` de `rows`), não sobre o array `rows` bruto —
 * um buraco de calendário (dia sem envio) precisa contar como um passo de
 * defasagem de verdade, senão `k=1` vira "próximo dia COM dado", que pode
 * ser 3 dias de calendário adiante e falsifica a defasagem.
 *
 * **A5 (guarda-corpo de honestidade):** dias `immature` (open rate ainda
 * subindo, <48h) são excluídos do PAR (`delivered[i]`/`openRate[i+k]`) se
 * QUALQUER um dos dois lados cair num dia imaturo — mesmo padrão de reuso
 * das flags já existentes que a issue pede pra decomposição. Amostra final
 * com menos de 3 pares retorna `null` (correlação de 1-2 pontos não é
 * informação, é ruído).
 *
 * Exportado pra teste unitário.
 */
export function computeLagCorrelations(rows: DayOpenRateSummary[]): Record<0 | 1 | 2 | 3, number | null> {
  const lags: Array<0 | 1 | 2 | 3> = [0, 1, 2, 3];
  if (rows.length === 0) {
    return { 0: null, 1: null, 2: null, 3: null };
  }
  const days = enumerateDayRange(rows[0].day, rows[rows.length - 1].day);
  const byDay = new Map(rows.map((r) => [r.day, r]));
  const slots: Array<DayOpenRateSummary | null> = days.map((d) => byDay.get(d) ?? null);

  const result = {} as Record<0 | 1 | 2 | 3, number | null>;
  for (const k of lags) {
    const xs: number[] = [];
    const ys: number[] = [];
    for (let i = 0; i + k < slots.length; i++) {
      const a = slots[i];
      const b = slots[i + k];
      if (!a || !b) continue;
      if (a.immature || b.immature) continue;
      xs.push(a.delivered);
      ys.push(b.openRate);
    }
    result[k] = pearsonCorrelation(xs, ys);
  }
  return result;
}

/** Coeficiente de correlação de Pearson. `< 3` pares ou variância zero em algum dos dois lados → `null`. */
function pearsonCorrelation(xs: number[], ys: number[]): number | null {
  const n = xs.length;
  if (n < 3) return null;
  const meanX = xs.reduce((s, v) => s + v, 0) / n;
  const meanY = ys.reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let denX = 0;
  let denY = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - meanX;
    const dy = ys[i] - meanY;
    num += dx * dy;
    denX += dx * dx;
    denY += dy * dy;
  }
  if (denX === 0 || denY === 0) return null;
  return num / Math.sqrt(denX * denY);
}

/** #5640 A3: layout do scatter delivered×openRate — dimensões próprias, sem eixo duplo (1 eixo por dimensão). */
const SCATTER_CHART = {
  viewBoxW: 500,
  viewBoxH: 340,
  padLeft: 50,
  padRight: 16,
  padTop: 16,
  padBottom: 40,
} as const;

/**
 * #5640 A3: dispersão delivered (X) × open rate (Y), 1 ponto = 1 dia — o
 * remédio da issue pra "duas linhas sobrepostas de eixo duplo não provam
 * relação monotônica, um scatter sim". Cor por RECÊNCIA: opacidade cresce
 * linearmente do dia mais antigo (0.3) ao mais recente (1.0) — sem
 * gridiente de cor nova, só opacidade sobre `var(--alert)` (mesmo token de
 * Open Rate no gráfico principal). Dias `smallSample`/`immature` reusam os
 * MESMOS marcadores do gráfico principal (círculo oco / opacidade extra
 * ×0.55) — nunca inventam um 3º idioma visual pro mesmo par de flags.
 *
 * `rows.length < 2` retorna `""` (dispersão de 0-1 ponto não é gráfico).
 * Exportado pra teste unitário.
 */
export function renderDeliveredOpenRateScatterSvg(rows: DayOpenRateSummary[]): string {
  if (rows.length < 2) return "";

  const { viewBoxW, viewBoxH, padLeft, padRight, padTop, padBottom } = SCATTER_CHART;
  const chartLeft = padLeft;
  const chartRight = viewBoxW - padRight;
  const chartTop = padTop;
  const chartBottom = viewBoxH - padBottom;
  const chartW = chartRight - chartLeft;
  const chartH = chartBottom - chartTop;

  const maxDelivered = niceMax(rows.reduce((m, r) => Math.max(m, r.delivered), 0));
  const xAt = (v: number): number => chartLeft + (chartW * v) / maxDelivered;
  const yAt = (v: number): number => chartBottom - (chartH * Math.max(0, Math.min(v, 100))) / 100;

  const n = rows.length;
  let points = "";
  rows.forEach((r, i) => {
    const recencyOpacity = n <= 1 ? 1 : 0.3 + 0.7 * (i / (n - 1));
    const opacity = (r.immature ? recencyOpacity * 0.55 : recencyOpacity).toFixed(2);
    const cx = fmt(xAt(r.delivered));
    const cy = fmt(yAt(r.openRate));
    points += r.smallSample
      ? `<circle cx="${cx}" cy="${cy}" r="4" fill="var(--card)" stroke="var(--alert)" stroke-width="2" opacity="${opacity}"/>`
      : `<circle cx="${cx}" cy="${cy}" r="4" fill="var(--alert)" opacity="${opacity}"/>`;
  });

  const yGridlines = [0, 50, 100]
    .map((v) => {
      const y = fmt(yAt(v));
      return `<line x1="${fmt(chartLeft)}" y1="${y}" x2="${fmt(chartRight)}" y2="${y}" stroke="var(--rule)" stroke-width="1" stroke-dasharray="2,3"/>
      <text x="${fmt(chartLeft - 8)}" y="${y}" text-anchor="end" dominant-baseline="middle" font-size="10" fill="var(--ink)" opacity="0.55">${v}%</text>`;
    })
    .join("\n");

  const xTicks = [0, 0.5, 1]
    .map((f) => {
      const v = Math.round(maxDelivered * f);
      const x = fmt(xAt(v));
      return `<text x="${x}" y="${fmt(chartBottom + 16)}" text-anchor="middle" font-size="10" fill="var(--ink)" opacity="0.55">${v.toLocaleString("pt-BR")}</text>`;
    })
    .join("\n");

  const axisLabels = `<text x="${fmt((chartLeft + chartRight) / 2)}" y="${viewBoxH - 6}" text-anchor="middle" font-size="10" fill="var(--ink)" opacity="0.65">Delivered</text>
    <text x="12" y="${fmt((chartTop + chartBottom) / 2)}" text-anchor="middle" font-size="10" fill="var(--ink)" opacity="0.65" transform="rotate(-90 12 ${fmt((chartTop + chartBottom) / 2)})">Open rate (%)</text>`;

  return `<svg class="scatter-delivered-openrate" viewBox="0 0 ${viewBoxW} ${viewBoxH}" width="100%" height="auto" role="img" aria-label="Dispersão delivered por open rate, 1 ponto por dia, mais opaco = mais recente — correlação, não causa">
    <title>Delivered × Open rate — dispersão por dia</title>
    ${yGridlines}
    ${xTicks}
    ${axisLabels}
    ${points}
  </svg>`;
}
