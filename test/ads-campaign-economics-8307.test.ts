/**
 * test/ads-campaign-economics-8307.test.ts (#8307)
 *
 * Regressão do bug reportado pelo editor em 17/09/2026: o gráfico
 * "Custo/cadastro acumulado por canal" do painel /ads plotava ponto nos
 * dias em que a campanha esteve INTEIRAMENTE pausada, e o tooltip
 * respondia com um valor (ex: `2026-09-11 · Microsoft Ads R$ 288,02`) que
 * existe só porque o acumulado carrega o total anterior — não porque algo
 * aconteceu naquele dia.
 *
 * O cenário dos testes é a pausa REAL de produção
 * (`data/aquisicao/teste-2608/run-state.json` → `revisao.pausa`):
 * 09/09 16:05 BRT → 17/09 00:16 BRT.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildCumulativeSeries, type ChannelDailyMetric, type ChannelDailySignup } from "../scripts/lib/ads-campaign-economics.ts";
import { normalizePauseIntervals } from "../scripts/lib/ads-test-pause-window.ts";

/** A pausa de produção do teste 2608, como está no `run-state.json`. */
const PAUSA_PRODUCAO = normalizePauseIntervals({
  inicio: "2026-09-09T16:05:36-03:00",
  fim: "2026-09-17T00:16:00-03:00",
});

const CANAL = "Microsoft Ads (teste 2608)";

/** Gasto/cadastro só nos dias veiculados — durante a pausa a API reporta
 *  zero, que é o que reproduz o trecho horizontal do bug. */
const metrics: ChannelDailyMetric[] = [
  { canal: CANAL, date: "2026-09-08", gastoBrl: 200, cliques: 20, impressoes: 2000 },
  { canal: CANAL, date: "2026-09-09", gastoBrl: 88, cliques: 9, impressoes: 900 },
  { canal: CANAL, date: "2026-09-17", gastoBrl: 100, cliques: 10, impressoes: 1000 },
];
const signups: ChannelDailySignup[] = [
  { canal: CANAL, date: "2026-09-08", cadastros: 1 },
  { canal: CANAL, date: "2026-09-17", cadastros: 1 },
];
const RANGE = { start: "2026-09-08", end: "2026-09-17" };

describe("#8307 — buildCumulativeSeries pula os dias sem veiculação", () => {
  it("dia 100% pausado não vira ponto (era o bug: 7 pontos retos de 10 a 16/09)", () => {
    const result = buildCumulativeSeries(metrics, signups, RANGE, { pauseIntervals: PAUSA_PRODUCAO });
    const datas = result.series[0].points.map((p) => p.date);
    assert.deepEqual(datas, ["2026-09-08", "2026-09-09", "2026-09-17"]);
    for (const d of ["2026-09-10", "2026-09-11", "2026-09-12", "2026-09-13", "2026-09-14", "2026-09-15", "2026-09-16"]) {
      assert.ok(!datas.includes(d), `${d} não deveria ter ponto`);
    }
  });

  it("dia PARCIALMENTE pausado continua no gráfico — veiculou de verdade", () => {
    // 09/09 rodou até 16:05; 17/09 religou 00:16. Apagá-los esconderia
    // gasto e cadastros reais — é a divergência deliberada de `isDatePaused`.
    const result = buildCumulativeSeries(metrics, signups, RANGE, { pauseIntervals: PAUSA_PRODUCAO });
    const datas = result.series[0].points.map((p) => p.date);
    assert.ok(datas.includes("2026-09-09"));
    assert.ok(datas.includes("2026-09-17"));
  });

  it("o acumulado ATRAVESSA os dias pulados — nenhum gasto residual se perde", () => {
    // Gasto residual num dia 100% pausado (ex: cobrança que a API lança com
    // atraso) tem que reaparecer no próximo dia veiculado, nunca sumir.
    const comResiduo: ChannelDailyMetric[] = [
      ...metrics,
      { canal: CANAL, date: "2026-09-12", gastoBrl: 7, cliques: 0, impressoes: 0 },
    ];
    const result = buildCumulativeSeries(comResiduo, signups, RANGE, { pauseIntervals: PAUSA_PRODUCAO });
    const ultimo = result.series[0].points.at(-1)!;
    assert.equal(ultimo.date, "2026-09-17");
    assert.equal(ultimo.gastoAcumuladoBrl, 200 + 88 + 7 + 100);
  });

  it("reporta as datas puladas e as plotadas — a UI avisa em vez de comprimir o eixo em silêncio", () => {
    const result = buildCumulativeSeries(metrics, signups, RANGE, { pauseIntervals: PAUSA_PRODUCAO });
    assert.deepEqual(result.skippedPausedDates, [
      "2026-09-10",
      "2026-09-11",
      "2026-09-12",
      "2026-09-13",
      "2026-09-14",
      "2026-09-15",
      "2026-09-16",
    ]);
    assert.deepEqual(result.plottedDates, ["2026-09-08", "2026-09-09", "2026-09-17"]);
  });

  it("sem pausa informada, nada muda (comportamento pré-#8307 preservado)", () => {
    const result = buildCumulativeSeries(metrics, signups, RANGE);
    assert.equal(result.series[0].points.length, 10);
    assert.deepEqual(result.skippedPausedDates, []);
    assert.equal(result.plottedDates.length, 10);
  });

  it("sharedYAxisMax ignora os dias pulados — o eixo Y não cresce por dia que não existe", () => {
    // Dia pausado com gasto residual empurraria o acumulado pra cima; como
    // ele não é plotado, não pode mandar na escala de nada.
    const comResiduo: ChannelDailyMetric[] = [
      { canal: CANAL, date: "2026-09-08", gastoBrl: 10, cliques: 1, impressoes: 10 },
      { canal: CANAL, date: "2026-09-12", gastoBrl: 990, cliques: 0, impressoes: 0 },
    ];
    const semPausa = buildCumulativeSeries(comResiduo, [{ canal: CANAL, date: "2026-09-08", cadastros: 1 }], RANGE);
    const comPausa = buildCumulativeSeries(comResiduo, [{ canal: CANAL, date: "2026-09-08", cadastros: 1 }], RANGE, {
      pauseIntervals: PAUSA_PRODUCAO,
    });
    assert.equal(semPausa.sharedYAxisMax, 1000);
    assert.equal(comPausa.sharedYAxisMax, 1000); // 17/09 (plotado) já carrega o resíduo
    const plotadosComPausa = comPausa.series[0].points.map((p) => p.date);
    assert.ok(!plotadosComPausa.includes("2026-09-12"));
  });

  it("pausa em andamento (`fim` ausente) pula os dias já inteiramente cobertos", () => {
    const emAndamento = normalizePauseIntervals({ inicio: "2026-09-09T16:05:36-03:00" });
    const result = buildCumulativeSeries(metrics, signups, RANGE, { pauseIntervals: emAndamento });
    const datas = result.series[0].points.map((p) => p.date);
    assert.deepEqual(datas, ["2026-09-08", "2026-09-09"]);
    assert.ok(result.skippedPausedDates.includes("2026-09-17"));
  });

  it("lista de pausas vazia é o mesmo que não informar pausa", () => {
    const result = buildCumulativeSeries(metrics, signups, RANGE, { pauseIntervals: [] });
    assert.equal(result.series[0].points.length, 10);
    assert.deepEqual(result.skippedPausedDates, []);
  });
});
