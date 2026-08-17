/**
 * test/brevo-dashboard-chart-svg-5593.test.ts (#5593)
 *
 * Testa `workers/brevo-dashboard/src/chart-svg.ts` — gráfico SVG inline
 * (duas séries, spline + área com gradiente) pra "Open rate por dia"
 * (`renderOpenRateByDaySection`, sections-core.ts). Funções puras, sem
 * dependência de Worker/KV/fixture de campanha — a integração com a seção
 * (svg aparece ANTES da tabela) é testada em
 * `test/brevo-dashboard-fase2.test.ts` (describe "#5490: renderOpenRateByDaySection").
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  catmullRomToBezierPath,
  splitIntoRuns,
  enumerateDayRange,
  niceMax,
  renderOpenRateChartSvg,
} from "../workers/brevo-dashboard/src/chart-svg.ts";
import type { DayOpenRateSummary } from "../workers/brevo-dashboard/src/sections-core.ts";

function row(day: string, opts: Partial<DayOpenRateSummary> = {}): DayOpenRateSummary {
  const [, m, d] = day.split("-");
  return {
    day,
    label: `${d}/${m}`,
    count: 2,
    delivered: 100,
    opens: 40,
    openRate: 40,
    smallSample: false,
    ...opts,
  };
}

describe("#5593: catmullRomToBezierPath", () => {
  test("0 ou 1 ponto retorna string vazia (nada a desenhar — só marcador)", () => {
    assert.equal(catmullRomToBezierPath([]), "");
    assert.equal(catmullRomToBezierPath([{ x: 1, y: 1 }]), "");
  });

  test("2 pontos vira uma linha reta (L), sem curva de Bézier", () => {
    const d = catmullRomToBezierPath([{ x: 0, y: 0 }, { x: 10, y: 10 }]);
    assert.match(d, /^M 0,0 L 10,10$/);
  });

  test("3+ pontos produz path com comandos C (curva suave)", () => {
    const d = catmullRomToBezierPath([{ x: 0, y: 10 }, { x: 5, y: 0 }, { x: 10, y: 10 }]);
    assert.match(d, /^M 0,10/);
    assert.match(d, / C /, "deve conter pelo menos 1 comando de curva Bézier");
  });

  test("path sempre começa em M no primeiro ponto (start point preservado)", () => {
    const pts = [{ x: 3, y: 7 }, { x: 8, y: 2 }, { x: 15, y: 9 }, { x: 20, y: 1 }];
    const d = catmullRomToBezierPath(pts);
    assert.match(d, /^M 3,7/);
  });
});

describe("#5593: splitIntoRuns — buraco vira segmento separado, nunca zero interpolado", () => {
  test("sem null nenhum, 1 único run com todos os itens", () => {
    const runs = splitIntoRuns([1, 2, 3]);
    assert.equal(runs.length, 1);
    assert.deepEqual(runs[0].map((r) => r.value), [1, 2, 3]);
    assert.deepEqual(runs[0].map((r) => r.index), [0, 1, 2]);
  });

  test("null no meio quebra em 2 runs — o buraco não vira ponto de valor 0", () => {
    const runs = splitIntoRuns([1, 2, null, 4, 5]);
    assert.equal(runs.length, 2, "dia sem envio deve separar em 2 segmentos, não interpolar");
    assert.deepEqual(runs[0].map((r) => r.value), [1, 2]);
    assert.deepEqual(runs[0].map((r) => r.index), [0, 1]);
    assert.deepEqual(runs[1].map((r) => r.value), [4, 5]);
    assert.deepEqual(runs[1].map((r) => r.index), [3, 4]);
  });

  test("null nas 2 pontas é ignorado (não vira run vazio)", () => {
    const runs = splitIntoRuns([null, 1, 2, null]);
    assert.equal(runs.length, 1);
    assert.deepEqual(runs[0].map((r) => r.value), [1, 2]);
  });

  test("todo null retorna []", () => {
    assert.deepEqual(splitIntoRuns([null, null]), []);
  });
});

describe("#5593: enumerateDayRange — preenche TODO dia-calendário entre extremos (inclusive dias sem envio)", () => {
  test("intervalo de 3 dias com um buraco no meio enumera os 3 dias", () => {
    const days = enumerateDayRange("2026-08-01", "2026-08-03");
    assert.deepEqual(days, ["2026-08-01", "2026-08-02", "2026-08-03"]);
  });

  test("mesmo dia início/fim retorna array de 1 elemento", () => {
    assert.deepEqual(enumerateDayRange("2026-08-01", "2026-08-01"), ["2026-08-01"]);
  });

  test("atravessa fronteira de mês corretamente", () => {
    const days = enumerateDayRange("2026-07-30", "2026-08-02");
    assert.deepEqual(days, ["2026-07-30", "2026-07-31", "2026-08-01", "2026-08-02"]);
  });
});

describe("#5593: niceMax — arredonda pro próximo múltiplo redondo", () => {
  test("0 ou negativo vira 1 (evita divisão por zero na escala)", () => {
    assert.equal(niceMax(0), 1);
    assert.equal(niceMax(-5), 1);
  });

  test("valores típicos arredondam pra 1/2/5/10 × magnitude", () => {
    assert.equal(niceMax(83), 100);
    assert.equal(niceMax(340), 500);
    assert.equal(niceMax(1500), 2000);
  });
});

describe("#5593: renderOpenRateChartSvg", () => {
  test("rows=[] retorna string vazia", () => {
    assert.equal(renderOpenRateChartSvg([]), "");
  });

  test("1 linha só produz marcadores (círculos), sem <path> de linha (1 ponto não faz reta)", () => {
    const svg = renderOpenRateChartSvg([row("2026-08-10")]);
    assert.match(svg, /<svg/);
    assert.match(svg, /<circle/, "deve ter pelo menos 1 marcador");
  });

  test("duas cores de série vêm de var(--brand)/var(--alert) — nunca hex hardcoded", () => {
    const svg = renderOpenRateChartSvg([row("2026-08-10"), row("2026-08-11", { openRate: 55 })]);
    assert.match(svg, /var\(--brand\)/, "Delivered deve usar --brand (token DS)");
    assert.match(svg, /var\(--alert\)/, "Open Rate deve usar --alert (token DS)");
    // Nenhum hex de 3/6 dígitos solto no SVG gerado (fill="#xxxxxx" etc.) —
    // regra explícita da issue: cor sempre via token, nunca hardcoded aqui.
    assert.doesNotMatch(svg, /#[0-9a-fA-F]{3,6}/, "não deve haver cor hex hardcoded no SVG");
  });

  test("dia sem envio no meio do intervalo vira BURACO — path da linha se quebra em 2 segmentos", () => {
    // 01, 02 têm dado; 03 não teve envio; 04, 05 têm dado de novo (2 pontos
    // em cada lado do buraco, pra cada lado render uma linha própria).
    const rows = [row("2026-08-01"), row("2026-08-02"), row("2026-08-04"), row("2026-08-05")];
    const svg = renderOpenRateChartSvg(rows);
    // Cada série com buraco produz 2 <path fill="none" ...> (linha) em vez
    // de 1 só — confirma que NÃO interpolou através do dia 03.
    const deliveredLineCount = (svg.match(/stroke="var\(--brand\)"/g) ?? []).length;
    assert.equal(deliveredLineCount, 2, "buraco no meio deve gerar 2 segmentos de linha pra Delivered, não 1 contínuo");
  });

  test("amostra pequena (smallSample=true) usa marcador OCO (fill=var(--card)) em vez do preenchido", () => {
    const svg = renderOpenRateChartSvg([
      row("2026-08-10", { smallSample: true, count: 1 }),
      row("2026-08-11", { smallSample: false }),
    ]);
    assert.match(svg, /fill="var\(--card\)" stroke="var\(--brand\)"/, "marcador oco de Delivered pra dia smallSample");
    assert.match(svg, /fill="var\(--card\)" stroke="var\(--alert\)"/, "marcador oco de Open Rate pra dia smallSample");
  });

  test("rótulos de extremidade do eixo X usam mês abreviado pt-BR (ex: 'ago 10')", () => {
    const svg = renderOpenRateChartSvg([row("2026-08-10"), row("2026-08-17")]);
    assert.match(svg, />ago 10</);
    assert.match(svg, />ago 17</);
  });

  test("sem gridlines verticais — só <line> horizontais (mesmo y1/y2 diferente de x1/x2)", () => {
    const svg = renderOpenRateChartSvg([row("2026-08-10"), row("2026-08-11")]);
    // `\s` depois de "line" distingue `<line ...>` (gridline) de
    // `<linearGradient ...>` (que também começa com o prefixo "<line").
    const lineTags = [...svg.matchAll(/<line\s[^>]*>/g)].map((m) => m[0]);
    assert.ok(lineTags.length > 0, "deve ter gridlines horizontais");
    for (const tag of lineTags) {
      const y1 = tag.match(/y1="([^"]+)"/)?.[1];
      const y2 = tag.match(/y2="([^"]+)"/)?.[1];
      assert.equal(y1, y2, `gridline deve ser horizontal (y1===y2): ${tag}`);
    }
  });

  test("sem legenda flutuante — rótulos de série são <text> estáticos dentro do próprio SVG", () => {
    const svg = renderOpenRateChartSvg([row("2026-08-10"), row("2026-08-11")]);
    assert.match(svg, />● Delivered</);
    assert.match(svg, />● Open Rate</);
  });
});
