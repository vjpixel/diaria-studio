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
  fmtDayLabelLong,
  renderCohortSmallMultipleSvg,
  renderConfoundersSparklineSvg,
  computeLagCorrelations,
  renderDeliveredOpenRateScatterSvg,
  X_LABEL_STEP_DAYS,
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
    immature: false,
    // #5640 A4: confounders — defaults neutros (sem bounce/spam, CTOR 0),
    // sobrescritos pelos testes que exercitam `renderConfoundersSparklineSvg`.
    sent: 100,
    bounces: 0,
    hardBounces: 0,
    bounceRate: 0,
    hardBounceRate: 0,
    spam: 0,
    spamRate: 0,
    clicks: 0,
    ctor: 0,
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

describe("#5610 item 2: splitIntoRuns — conecta através dos buracos (inverte a decisão original do #5593)", () => {
  test("sem null nenhum, 1 único run com todos os itens", () => {
    const runs = splitIntoRuns([1, 2, 3]);
    assert.equal(runs.length, 1);
    assert.deepEqual(runs[0].map((r) => r.value), [1, 2, 3]);
    assert.deepEqual(runs[0].map((r) => r.index), [0, 1, 2]);
  });

  test("null no meio NÃO quebra mais em 2 runs — vira 1 único run contínuo pulando o índice do buraco", () => {
    const runs = splitIntoRuns([1, 2, null, 4, 5]);
    assert.equal(runs.length, 1, "#5610: buraco não deve mais separar em segmentos — a linha conecta através dele");
    assert.deepEqual(runs[0].map((r) => r.value), [1, 2, 4, 5]);
    assert.deepEqual(runs[0].map((r) => r.index), [0, 1, 3, 4], "índice original preservado, inclusive o salto sobre o buraco (índice 2 ausente)");
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

describe("#5603: enumerateDayRange — 3 casos de entrada inválida lançam erros DISTINTOS (nunca o fallback silencioso [startDay])", () => {
  test("startDay malformado lança erro mencionando startDay", () => {
    assert.throws(() => enumerateDayRange("not-a-date", "2026-08-03"), /startDay malformado/);
  });

  test("endDay malformado lança erro mencionando endDay (distinto do erro de startDay)", () => {
    assert.throws(() => enumerateDayRange("2026-08-01", "not-a-date"), /endDay malformado/);
  });

  test("range invertido (startDay > endDay) lança erro mencionando range invertido — distinto dos 2 casos acima", () => {
    assert.throws(() => enumerateDayRange("2026-08-05", "2026-08-01"), /range invertido/);
  });

  test("startDay malformado tem precedência sobre endDay malformado — 1 erro por vez, não silencia o outro", () => {
    assert.throws(() => enumerateDayRange("not-a-date", "also-not-a-date"), /startDay malformado/);
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

  test("#5610 item 2: dia sem envio no meio do intervalo NÃO quebra mais a linha — 1 único segmento contínuo", () => {
    // 01, 02 têm dado; 03 não teve envio; 04, 05 têm dado de novo — a linha
    // agora atravessa o dia 03 em vez de quebrar em 2 segmentos (inversão
    // da decisão original do #5593).
    const rows = [row("2026-08-01"), row("2026-08-02"), row("2026-08-04"), row("2026-08-05")];
    const svg = renderOpenRateChartSvg(rows);
    const deliveredLineCount = (svg.match(/stroke="var\(--brand\)"/g) ?? []).length;
    assert.equal(deliveredLineCount, 1, "buraco no meio não deve mais gerar segmento separado — a linha conecta através dele");
  });

  test("amostra pequena (smallSample=true) usa marcador OCO (fill=var(--card)) em vez do preenchido", () => {
    const svg = renderOpenRateChartSvg([
      row("2026-08-10", { smallSample: true, count: 1 }),
      row("2026-08-11", { smallSample: false }),
    ]);
    assert.match(svg, /fill="var\(--card\)" stroke="var\(--brand\)"/, "marcador oco de Delivered pra dia smallSample");
    assert.match(svg, /fill="var\(--card\)" stroke="var\(--alert\)"/, "marcador oco de Open Rate pra dia smallSample");
  });

  test("#5610 item 5: dia imaturo (immature=true) usa marcador com opacidade reduzida", () => {
    const svg = renderOpenRateChartSvg([
      row("2026-08-10", { immature: true }),
      row("2026-08-11", { immature: false }),
    ]);
    assert.match(svg, /fill="var\(--brand\)" opacity="0\.55"/, "marcador Delivered do dia imaturo tem opacidade reduzida");
    assert.match(svg, /fill="var\(--alert\)" opacity="0\.55"/, "marcador Open Rate do dia imaturo tem opacidade reduzida");
  });

  test("#5610 item 5: smallSample + immature no mesmo dia combinam marcador oco com opacidade reduzida", () => {
    const svg = renderOpenRateChartSvg([
      row("2026-08-10", { smallSample: true, immature: true, count: 1 }),
      row("2026-08-11"),
    ]);
    assert.match(svg, /fill="var\(--card\)" stroke="var\(--brand\)" stroke-width="2" opacity="0\.55"/);
  });

  test("rótulos de extremidade do eixo X usam mês abreviado pt-BR (ex: 'ago 10')", () => {
    const svg = renderOpenRateChartSvg([row("2026-08-10"), row("2026-08-17")]);
    assert.match(svg, />ago 10</);
    assert.match(svg, />ago 17</);
  });

  test("janela de 2 dias sem gridlines verticais — só <line> horizontais (mesmo y1/y2 diferente de x1/x2)", () => {
    const svg = renderOpenRateChartSvg([row("2026-08-10"), row("2026-08-11")]);
    // `\s` depois de "line" distingue `<line ...>` (gridline) de
    // `<linearGradient ...>` (que também começa com o prefixo "<line").
    // #5640 B1: o crosshair (`class="chart-crosshair"`) É uma linha vertical
    // de propósito (segue o ponteiro, invisível por default via
    // `opacity:0`) — excluído aqui porque esta asserção é sobre GRIDLINE
    // estática. #5640 B7 (implementado, ver describe dedicado abaixo) trouxe
    // gridline vertical de VERDADE, mas só a partir de `X_LABEL_STEP_DAYS`
    // dias — esta janela de 2 dias é curta demais pra gerar qualquer uma,
    // então a asserção "só horizontais" continua válida PRA ESTE FIXTURE.
    const lineTags = [...svg.matchAll(/<line\s[^>]*>/g)].map((m) => m[0]).filter((tag) => !tag.includes('class="chart-crosshair"'));
    assert.ok(lineTags.length > 0, "deve ter gridlines horizontais");
    for (const tag of lineTags) {
      const y1 = tag.match(/y1="([^"]+)"/)?.[1];
      const y2 = tag.match(/y2="([^"]+)"/)?.[1];
      assert.equal(y1, y2, `gridline deve ser horizontal (y1===y2): ${tag}`);
    }
  });

  test("sem legenda flutuante — rótulos de série são <text> estáticos dentro do próprio SVG", () => {
    const svg = renderOpenRateChartSvg([row("2026-08-10"), row("2026-08-11")]);
    assert.match(svg, />●<\/tspan> <tspan fill="var\(--ink\)">Delivered</);
    assert.match(svg, />●<\/tspan> <tspan fill="var\(--ink\)">Open Rate</);
  });

  test("contraste AA do rótulo de série (#5593 fleet review): marcador mantém cor da série, texto usa --ink", () => {
    const svg = renderOpenRateChartSvg([row("2026-08-10"), row("2026-08-11")]);
    // O bloco de rótulos de série (dentro de <text>...</text>, antes das
    // gridlines) deve ter os marcadores "●" coloridos por série e o TEXTO
    // ("Delivered"/"Open Rate") sempre em var(--ink) — nunca var(--brand)
    // nem var(--alert) no texto, que é onde a falha de contraste AA mora.
    const labelsBlock = svg.slice(svg.indexOf("<text"), svg.indexOf("Open Rate</tspan></text>") + "Open Rate</tspan></text>".length);
    assert.match(labelsBlock, /<tspan fill="var\(--brand\)">●<\/tspan>/, "marcador Delivered usa --brand");
    assert.match(labelsBlock, /<tspan fill="var\(--alert\)">●<\/tspan>/, "marcador Open Rate usa --alert");
    assert.match(labelsBlock, /<tspan fill="var\(--ink\)">Delivered<\/tspan>/, "texto Delivered usa --ink (AA)");
    assert.match(labelsBlock, /<tspan fill="var\(--ink\)">Open Rate<\/tspan>/, "texto Open Rate usa --ink (AA)");
    // Nunca var(--brand)/var(--alert) diretamente encostado no texto da
    // série (garante que a falha AA documentada em sections-core.ts não foi
    // reintroduzida aqui).
    assert.doesNotMatch(labelsBlock, /fill="var\(--brand\)">Delivered/);
    assert.doesNotMatch(labelsBlock, /fill="var\(--alert\)">Open Rate/);
  });
});

describe("#5603: renderOpenRateChartSvg — assert leve de ordem ascendente + day único (invariante de aggregateByDay)", () => {
  test("day duplicado lança erro descritivo mencionando o day repetido", () => {
    assert.throws(
      () => renderOpenRateChartSvg([row("2026-08-10"), row("2026-08-10")]),
      /day duplicado.*2026-08-10/,
    );
  });

  test("rows fora de ordem ascendente lança erro descritivo com as duas pontas", () => {
    assert.throws(
      () => renderOpenRateChartSvg([row("2026-08-11"), row("2026-08-10")]),
      /fora de ordem ascendente.*2026-08-11.*2026-08-10/,
    );
  });

  test("rows ordenado ascendente e sem duplicata segue funcionando normalmente (nenhuma regressão)", () => {
    const svg = renderOpenRateChartSvg([row("2026-08-10"), row("2026-08-11"), row("2026-08-12")]);
    assert.match(svg, /<svg/);
  });
});

describe("#5593 fleet review: guards defensivos", () => {
  test("fmt (via catmullRomToBezierPath) lança erro descritivo em coordenada NaN, nunca produz \"NaN\" no path", () => {
    assert.throws(
      () => catmullRomToBezierPath([{ x: NaN, y: 0 }, { x: 1, y: 1 }]),
      /coordenada não-finita/,
    );
  });

  test("fmt lança erro descritivo em coordenada Infinity", () => {
    assert.throws(
      () => catmullRomToBezierPath([{ x: 0, y: 0 }, { x: Infinity, y: 1 }]),
      /coordenada não-finita/,
    );
  });

  test("niceMax lança erro descritivo pra NaN/Infinity, antes do guard de value <= 0", () => {
    assert.throws(() => niceMax(NaN), /não-finito/);
    assert.throws(() => niceMax(Infinity), /não-finito/);
    assert.throws(() => niceMax(-Infinity), /não-finito/);
  });

  test("openRate negativo é clampado no piso (0), não só no teto (100)", () => {
    const originalError = console.error;
    const calls: unknown[][] = [];
    console.error = (...args: unknown[]) => calls.push(args);
    try {
      const svg = renderOpenRateChartSvg([
        row("2026-08-10", { openRate: -20 }),
        row("2026-08-11", { openRate: 40 }),
      ]);
      assert.match(svg, /<svg/);
      assert.ok(calls.length >= 1, "clamp de openRate fora de [0,100] deve logar console.error");
    } finally {
      console.error = originalError;
    }
  });

  test("openRate > 100 continua clampado no teto, sem regressão", () => {
    const svg = renderOpenRateChartSvg([
      row("2026-08-10", { openRate: 150 }),
      row("2026-08-11", { openRate: 40 }),
    ]);
    assert.match(svg, /<svg/);
  });
});

describe("#5640 B1: fmtDayLabelLong — data por extenso pt-BR pro tooltip", () => {
  test("formata dia YYYY-MM-DD com dia da semana + mês por extenso", () => {
    // 2026-08-16 é um domingo.
    assert.equal(fmtDayLabelLong("2026-08-16"), "domingo, 16 de agosto de 2026");
  });

  test("atravessa fronteira de mês/ano corretamente (sem deslocamento de fuso)", () => {
    // 2026-01-01 é uma quinta-feira.
    assert.equal(fmtDayLabelLong("2026-01-01"), "quinta-feira, 1 de janeiro de 2026");
  });
});

describe("#5640 B1+B2: renderOpenRateChartSvg — hit rects de coluna (não o marcador)", () => {
  test("emite 1 <rect class=\"chart-hit-rect\"> por DIA da janela, inclusive dias sem envio", () => {
    // 01 e 03 têm dado; 02 é um buraco (sem campanha) — ainda assim deve
    // ganhar um hit rect (B2: hover funciona em qualquer coluna, com ou sem dado).
    const svg = renderOpenRateChartSvg([row("2026-08-01"), row("2026-08-03")]);
    const rects = [...svg.matchAll(/<rect class="chart-hit-rect"[^>]*>/g)];
    assert.equal(rects.length, 3, "3 dias na janela (01, 02 buraco, 03) => 3 hit rects");
  });

  test("hit rect de dia SEM envio tem data-hasdata=\"0\" e nenhum outro data-* numérico", () => {
    const svg = renderOpenRateChartSvg([row("2026-08-01"), row("2026-08-03")]);
    const holeRect = [...svg.matchAll(/<rect class="chart-hit-rect"[^>]*>/g)].map((m) => m[0])
      .find((tag) => tag.includes('data-day="2026-08-02"'));
    assert.ok(holeRect, "deve existir um hit rect pro dia-buraco 2026-08-02");
    assert.match(holeRect!, /data-hasdata="0"/);
    assert.doesNotMatch(holeRect!, /data-delivered=/, "dia sem dado não deve carregar data-delivered");
  });

  test("hit rect de dia COM envio carrega count/delivered/opens/openrate/smallsample/immature", () => {
    const svg = renderOpenRateChartSvg([row("2026-08-10", { count: 3, delivered: 150, opens: 60, openRate: 40, smallSample: false, immature: true })]);
    const rect = svg.match(/<rect class="chart-hit-rect"[^>]*>/)?.[0] ?? "";
    assert.match(rect, /data-hasdata="1"/);
    assert.match(rect, /data-count="3"/);
    assert.match(rect, /data-delivered="150"/);
    assert.match(rect, /data-opens="60"/);
    assert.match(rect, /data-openrate="40"/);
    assert.match(rect, /data-smallsample="0"/);
    assert.match(rect, /data-immature="1"/);
  });

  test("hit rects cobrem a largura toda do chart, sem sobreposição nem buraco entre colunas", () => {
    const svg = renderOpenRateChartSvg([row("2026-08-01"), row("2026-08-02"), row("2026-08-03")]);
    const rects = [...svg.matchAll(/<rect class="chart-hit-rect"[^>]*>/g)].map((m) => m[0]);
    const spans = rects.map((tag) => {
      const x = Number(tag.match(/x="([^"]+)"/)?.[1]);
      const w = Number(tag.match(/width="([^"]+)"/)?.[1]);
      return { x, x2: x + w };
    });
    for (let i = 1; i < spans.length; i++) {
      assert.equal(spans[i - 1].x2, spans[i].x, `coluna ${i - 1} deve terminar exatamente onde a coluna ${i} começa (sem gap/overlap)`);
    }
  });
});

describe("#5640 B1: renderOpenRateChartSvg — crosshair invisível por default", () => {
  test("emite <line class=\"chart-crosshair\"> com opacity:0 (invisível até o hover ligar via JS)", () => {
    const svg = renderOpenRateChartSvg([row("2026-08-10"), row("2026-08-11")]);
    assert.match(svg, /<line id="day-openrate-crosshair" class="chart-crosshair"[^>]*style="opacity:0;pointer-events:none;"/);
  });
});

describe("#5640 B3: renderOpenRateChartSvg — marcadores carregam data-day-index/data-r pro destaque de hover", () => {
  test("cada marcador tem data-day-index (mesmo índice do hit rect do dia) e data-r (raio original)", () => {
    const svg = renderOpenRateChartSvg([row("2026-08-10"), row("2026-08-11", { smallSample: true, count: 1 })]);
    const markers = [...svg.matchAll(/<circle class="chart-marker"[^>]*>/g)].map((m) => m[0]);
    // 2 dias × 2 séries (delivered + openRate) = 4 marcadores.
    assert.equal(markers.length, 4);
    const day0 = markers.filter((m) => m.includes('data-day-index="0"'));
    const day1 = markers.filter((m) => m.includes('data-day-index="1"'));
    assert.equal(day0.length, 2, "dia 0 deve ter 2 marcadores (delivered + openRate)");
    assert.equal(day1.length, 2, "dia 1 deve ter 2 marcadores (delivered + openRate)");
    for (const m of day0) assert.match(m, /data-r="3"/, "dia 0 não é smallSample — raio original 3");
    for (const m of day1) assert.match(m, /data-r="4"/, "dia 1 é smallSample — raio original 4 (marcador oco)");
  });
});

describe("#5640 B6: renderOpenRateChartSvg — svg focável, title/desc acessíveis", () => {
  test("svg tem tabindex=0, role=img, aria-label preservado, e aria-describedby apontando pro <desc>", () => {
    const svg = renderOpenRateChartSvg([row("2026-08-10"), row("2026-08-11")]);
    const openTag = svg.slice(0, svg.indexOf(">") + 1);
    assert.match(openTag, /tabindex="0"/, "svg deve entrar na ordem de foco (WCAG 2.1.1)");
    assert.match(openTag, /role="img"/, "role=img mantido como fallback");
    assert.match(openTag, /aria-label="[^"]+"/, "aria-label mantido como fallback (nome acessível)");
    assert.match(openTag, /aria-describedby="day-openrate-svg-desc"/);
  });

  test("svg emite <title> e <desc id=day-openrate-svg-desc> com texto não-vazio", () => {
    const svg = renderOpenRateChartSvg([row("2026-08-10"), row("2026-08-11")]);
    assert.match(svg, /<title>[^<]+<\/title>/);
    assert.match(svg, /<desc id="day-openrate-svg-desc">[^<]+<\/desc>/);
  });

  test("<desc> menciona a navegação por teclado (setas/Home/End/Esc)", () => {
    const svg = renderOpenRateChartSvg([row("2026-08-10"), row("2026-08-11")]);
    const descMatch = svg.match(/<desc id="day-openrate-svg-desc">([^<]+)<\/desc>/);
    assert.ok(descMatch, "desc deve existir");
    assert.match(descMatch![1], /setas/i);
    assert.match(descMatch![1], /Esc/);
  });
});

describe("#5640 A2: renderCohortSmallMultipleSvg", () => {
  const sharedDays = ["2026-08-10", "2026-08-11", "2026-08-12"];

  test("renderiza <svg>, título com o label da coorte, e a linha de openRate (só 1 série, sem eixo duplo)", () => {
    const svg = renderCohortSmallMultipleSvg(sharedDays, "Assinantes ativos", [
      row("2026-08-10", { openRate: 30 }),
      row("2026-08-11", { openRate: 40 }),
      row("2026-08-12", { openRate: 20 }),
    ]);
    assert.match(svg, /<svg/);
    assert.match(svg, /<title>Assinantes ativos<\/title>/);
    assert.match(svg, /<path d="M [\d.]+,[\d.]+ C /, "3+ pontos deve produzir path com curva");
    assert.doesNotMatch(svg, /Delivered/, "small multiple não mostra a série Delivered (só openRate)");
  });

  test("coorte sem nenhum envio no período (rows=[]) ainda desenha o svg com nota 'sem envios'", () => {
    const svg = renderCohortSmallMultipleSvg(sharedDays, "Novos", []);
    assert.match(svg, /<svg/);
    assert.match(svg, /sem envios/);
    assert.doesNotMatch(svg, /<path d=/, "sem dado, não há linha pra desenhar");
  });

  test("dia sem dado (buraco no meio do domínio compartilhado) não gera marcador nesse dia, mas a linha atravessa (mesmo padrão do gráfico principal)", () => {
    const svg = renderCohortSmallMultipleSvg(sharedDays, "Leads", [
      row("2026-08-10", { openRate: 30 }),
      row("2026-08-12", { openRate: 10 }),
    ]);
    // 2 pontos só (dia 11 é buraco) => path L reto, não C.
    assert.match(svg, /<path d="M [\d.]+,[\d.]+ L [\d.]+,[\d.]+"/);
  });

  test("amostra pequena (smallSample) usa marcador oco (fill=var(--card)); dia imaturo reduz opacidade", () => {
    const svg = renderCohortSmallMultipleSvg(sharedDays, "Ex-assinantes", [
      row("2026-08-10", { openRate: 30, smallSample: true }),
      row("2026-08-11", { openRate: 40, immature: true }),
    ]);
    assert.match(svg, /fill="var\(--card\)" stroke="var\(--alert\)"/, "smallSample = círculo oco");
    assert.match(svg, /opacity="0\.55"/, "immature = opacidade reduzida");
  });

  test("nota do total de envios no canto (contagem, não valor de métrica)", () => {
    const svg = renderCohortSmallMultipleSvg(sharedDays, "Novos", [
      row("2026-08-10", { count: 3 }),
      row("2026-08-11", { count: 2 }),
    ]);
    assert.match(svg, />5 envios</);
  });
});

describe("#5640 A4: renderConfoundersSparklineSvg", () => {
  const sharedDays = ["2026-08-10", "2026-08-11", "2026-08-12"];

  test("renderiza as 3 sparklines rotuladas (Bounce/Spam/CTOR), nunca usa a palavra 'causou'/'por causa de'", () => {
    const svg = renderConfoundersSparklineSvg(sharedDays, [
      row("2026-08-10", { bounceRate: 1, spamRate: 0.1, ctor: 10 }),
      row("2026-08-11", { bounceRate: 2, spamRate: 0.2, ctor: 12 }),
      row("2026-08-12", { bounceRate: 1.5, spamRate: 0.15, ctor: 11 }),
    ]);
    assert.match(svg, />Bounce</);
    assert.match(svg, />Spam</);
    assert.match(svg, />CTOR</);
    assert.doesNotMatch(svg, /causou/i);
    assert.doesNotMatch(svg, /por causa de/i);
  });

  test("mesma viewBoxW/padLeft/padRight do gráfico principal (CHART) — alinhamento em X", () => {
    const svg = renderConfoundersSparklineSvg(sharedDays, [row("2026-08-10"), row("2026-08-11"), row("2026-08-12")]);
    assert.match(svg, /viewBox="0 0 1450 /, "viewBoxW deve bater com CHART.viewBoxW do gráfico principal");
  });

  test("rótulo do último valor reflete a métrica mais recente (não a primeira nem uma média)", () => {
    const svg = renderConfoundersSparklineSvg(sharedDays, [
      row("2026-08-10", { bounceRate: 1 }),
      row("2026-08-11", { bounceRate: 2 }),
      row("2026-08-12", { bounceRate: 9.5 }),
    ]);
    assert.match(svg, />9\.5%</, "último valor de bounceRate (dia mais recente) deve aparecer no rótulo");
  });

  test("dia sem dado no domínio não quebra — rótulo cai pro último valor conhecido", () => {
    const svg = renderConfoundersSparklineSvg(sharedDays, [
      row("2026-08-10", { bounceRate: 3 }),
      // 2026-08-11 e 2026-08-12 ausentes de `rows` — buraco no fim.
    ]);
    assert.match(svg, />3\.0%</);
  });
});

describe("#5640 B7: renderOpenRateChartSvg — rótulos intermediários + gridlines verticais do eixo X", () => {
  test("janela curta (<= X_LABEL_STEP_DAYS dias) não gera nenhum rótulo/gridline interior", () => {
    const rows = Array.from({ length: X_LABEL_STEP_DAYS }, (_, i) => row(`2026-08-${String(i + 1).padStart(2, "0")}`));
    const svg = renderOpenRateChartSvg(rows);
    // Só as 2 gridlines de ponta continuam ausentes de linha vertical dedicada
    // — nenhuma <line> vertical (x1===x2) fora do crosshair (opacity:0).
    const verticalGridlines = [...svg.matchAll(/<line\s[^>]*>/g)]
      .map((m) => m[0])
      .filter((tag) => !tag.includes('class="chart-crosshair"'))
      .filter((tag) => tag.match(/x1="([^"]+)"/)?.[1] === tag.match(/x2="([^"]+)"/)?.[1]);
    assert.equal(verticalGridlines.length, 0, "janela de exatamente X_LABEL_STEP_DAYS não deve ter gridline interior");
  });

  test("janela longa (30 dias) gera rótulos e gridlines interiores a cada X_LABEL_STEP_DAYS dias, sem duplicar os rótulos de ponta", () => {
    const rows = Array.from({ length: 30 }, (_, i) => row(`2026-08-${String(i + 1).padStart(2, "0")}`));
    const svg = renderOpenRateChartSvg(rows);
    const verticalGridlines = [...svg.matchAll(/<line\s[^>]*>/g)]
      .map((m) => m[0])
      .filter((tag) => !tag.includes('class="chart-crosshair"'))
      .filter((tag) => tag.match(/x1="([^"]+)"/)?.[1] === tag.match(/x2="([^"]+)"/)?.[1]);
    // Índices interiores esperados: 5, 10, 15, 20, 25 (30 dias, índices 0-29,
    // step 5, nunca >= days.length - 1 = 29).
    assert.equal(verticalGridlines.length, 5, "30 dias / passo 5 => 5 gridlines interiores (5,10,15,20,25)");
    for (const tag of verticalGridlines) {
      const y1 = tag.match(/y1="([^"]+)"/)?.[1];
      const y2 = tag.match(/y2="([^"]+)"/)?.[1];
      assert.notEqual(y1, y2, "gridline interior deve ser VERTICAL (y1!==y2)");
    }
    // Rótulo do dia 06 (índice 5) deve existir, além dos rótulos de ponta (01, 30).
    assert.match(svg, />ago 06</);
    assert.match(svg, />ago 01</);
    assert.match(svg, />ago 30</);
  });
});

describe("#5640 A1: renderOpenRateChartSvg — 3ª série (open rate esperado)", () => {
  test("sem expectedOpenRate em nenhum dia, nenhuma linha/rótulo 'Esperado' aparece", () => {
    const svg = renderOpenRateChartSvg([row("2026-08-10"), row("2026-08-11")]);
    assert.doesNotMatch(svg, /Esperado/, "chamador que não popula expectedOpenRate não deve ganhar a série");
  });

  test("com expectedOpenRate em >=2 dias, desenha path tracejado var(--ink) e o rótulo 'Esperado (mix)'", () => {
    const svg = renderOpenRateChartSvg([
      row("2026-08-10", { expectedOpenRate: 35 }),
      row("2026-08-11", { expectedOpenRate: 38 }),
    ]);
    assert.match(svg, /stroke="var\(--ink\)" stroke-width="2" stroke-dasharray="6,4"/);
    assert.match(svg, />Esperado \(mix\)</);
  });

  test("hit rect do dia carrega data-expected (tooltip/leitor de tela leem o valor da tracejada)", () => {
    const svg = renderOpenRateChartSvg([
      row("2026-08-10", { expectedOpenRate: 35 }),
      row("2026-08-11", { expectedOpenRate: null }),
    ]);
    assert.match(svg, /data-day="2026-08-10"[^>]*data-expected="35"/);
    const semEstimativa = svg.match(/data-day="2026-08-11"[^>]*>/)?.[0] ?? "";
    assert.ok(!semEstimativa.includes("data-expected"), "dia sem estimativa não vira 0% no tooltip");
  });

  test("único dia com expectedOpenRate na janela desenha um traço curto — não some da tela", () => {
    // Regressão: run de 1 ponto caía no `pts.length >= 2` e não desenhava
    // nada; a série esperada não tem marcador, então o dado sumia inteiro.
    const svg = renderOpenRateChartSvg([
      row("2026-08-10", { expectedOpenRate: null }),
      row("2026-08-11", { expectedOpenRate: 33 }),
      row("2026-08-12", { expectedOpenRate: null }),
    ]);
    assert.match(svg, /<line [^>]*stroke="var\(--ink\)" stroke-width="2" stroke-linecap="round" opacity="0\.6"/);
    assert.match(svg, />Esperado \(mix\)</);
  });

  test("swatch da legenda usa <line> tracejada, nunca o glyph ┄", () => {
    const svg = renderOpenRateChartSvg([
      row("2026-08-10", { expectedOpenRate: 35 }),
      row("2026-08-11", { expectedOpenRate: 38 }),
    ]);
    assert.ok(!svg.includes("┄"), "glyph U+2504 vira tofu em fonte sem esse caractere");
    assert.match(svg, /<line [^>]*stroke-dasharray="6,4"[^>]*\/>\s*<text[^>]*>Esperado \(mix\)</);
  });

  test("dia sem expectedOpenRate (null) no meio vira buraco — linha ainda conecta através dele (mesmo padrão das outras séries)", () => {
    const svg = renderOpenRateChartSvg([
      row("2026-08-10", { expectedOpenRate: 30 }),
      row("2026-08-11", { expectedOpenRate: null }),
      row("2026-08-12", { expectedOpenRate: 34 }),
    ]);
    // Conta só `<path>` — o swatch da legenda também usa `stroke-dasharray="6,4"`
    // (de propósito: mesmo tracejado da série, ver chart-svg.ts).
    const expectedLineCount = (svg.match(/<path [^>]*stroke-dasharray="6,4"/g) ?? []).length;
    assert.equal(expectedLineCount, 1, "1 único segmento tracejado, mesmo com buraco no meio");
  });
});

describe("#5640 A3: computeLagCorrelations", () => {
  test("rows=[] retorna null pros 4 lags", () => {
    assert.deepEqual(computeLagCorrelations([]), { 0: null, 1: null, 2: null, 3: null });
  });

  test("menos de 3 pares válidos pro lag => null (amostra insuficiente)", () => {
    const rows = [row("2026-08-10", { delivered: 100, openRate: 40 }), row("2026-08-11", { delivered: 200, openRate: 20 })];
    const result = computeLagCorrelations(rows);
    assert.equal(result[0], null);
  });

  test("correlação perfeitamente negativa em k=0 (delivered sobe, openRate cai monotonicamente no mesmo dia)", () => {
    const rows = [
      row("2026-08-01", { delivered: 100, openRate: 50 }),
      row("2026-08-02", { delivered: 200, openRate: 40 }),
      row("2026-08-03", { delivered: 300, openRate: 30 }),
      row("2026-08-04", { delivered: 400, openRate: 20 }),
    ];
    const result = computeLagCorrelations(rows);
    assert.ok(result[0] !== null && result[0] < -0.99, `k=0 deve ser ~-1 (perfeitamente negativo), veio ${result[0]}`);
  });

  test("dia imaturo é excluído do par em QUALQUER lado (delivered[i] ou openRate[i+k])", () => {
    const rows = [
      row("2026-08-01", { delivered: 100, openRate: 50 }),
      row("2026-08-02", { delivered: 200, openRate: 40, immature: true }),
      row("2026-08-03", { delivered: 300, openRate: 30 }),
      row("2026-08-04", { delivered: 400, openRate: 20 }),
    ];
    // k=0: par (02,imaturo) excluído — sobram só 3 pares (01,03,04), ainda >= 3.
    const result = computeLagCorrelations(rows);
    assert.notEqual(result[0], null, "3 pares restantes (>=3) ainda produz correlação");
  });

  test("dia de calendário AUSENTE (buraco) conta como passo de defasagem de verdade — não pula pro próximo dado disponível", () => {
    // 01 e 03 têm dado; 02 é buraco. k=1 sobre CALENDÁRIO não deve parear
    // 01(delivered) com 03(openRate) — isso seria k=2 de verdade.
    const rows = [row("2026-08-01", { delivered: 100, openRate: 50 }), row("2026-08-03", { delivered: 300, openRate: 20 })];
    const result = computeLagCorrelations(rows);
    assert.equal(result[1], null, "k=1 não deve enxergar par nenhum através do buraco de calendário (n<3 de qualquer forma)");
  });
});

describe("#5640 A3: renderDeliveredOpenRateScatterSvg", () => {
  test("menos de 2 rows retorna string vazia (dispersão de 0-1 ponto não é gráfico)", () => {
    assert.equal(renderDeliveredOpenRateScatterSvg([]), "");
    assert.equal(renderDeliveredOpenRateScatterSvg([row("2026-08-10")]), "");
  });

  test("emite 1 <circle> por dia, cor var(--alert), nunca hex hardcoded", () => {
    const rows = [row("2026-08-10", { delivered: 100, openRate: 40 }), row("2026-08-11", { delivered: 200, openRate: 30 })];
    const svg = renderDeliveredOpenRateScatterSvg(rows);
    const circles = [...svg.matchAll(/<circle[^>]*>/g)];
    assert.equal(circles.length, 2);
    assert.match(svg, /fill="var\(--alert\)"/);
    assert.doesNotMatch(svg, /#[0-9a-fA-F]{3,6}/, "não deve haver cor hex hardcoded");
  });

  test("dia mais recente tem opacidade maior que o mais antigo (cor por recência)", () => {
    const rows = [row("2026-08-01", { delivered: 100, openRate: 40 }), row("2026-08-10", { delivered: 200, openRate: 30 })];
    const svg = renderDeliveredOpenRateScatterSvg(rows);
    const opacities = [...svg.matchAll(/<circle[^>]*opacity="([\d.]+)"[^>]*>/g)].map((m) => Number(m[1]));
    assert.equal(opacities.length, 2);
    assert.ok(opacities[1] > opacities[0], "2º ponto (mais recente) deve ter opacidade maior que o 1º (mais antigo)");
  });

  test("amostra pequena usa marcador oco (fill=var(--card)); dia imaturo reduz opacidade ainda mais (×0.55)", () => {
    const rows = [
      row("2026-08-01", { delivered: 100, openRate: 40, smallSample: true }),
      row("2026-08-02", { delivered: 200, openRate: 30, immature: true }),
    ];
    const svg = renderDeliveredOpenRateScatterSvg(rows);
    assert.match(svg, /fill="var\(--card\)" stroke="var\(--alert\)"/);
  });

  test("rotula explicitamente 'correlação, não causa' no aria-label", () => {
    const rows = [row("2026-08-01"), row("2026-08-02")];
    const svg = renderDeliveredOpenRateScatterSvg(rows);
    assert.match(svg, /correlação, não causa/i);
  });
});
