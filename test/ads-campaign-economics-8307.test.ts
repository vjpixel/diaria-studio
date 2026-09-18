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

import {
  buildCumulativeSeries,
  effectivePauseIntervals,
  type ChannelDailyMetric,
  type ChannelDailySignup,
} from "../scripts/lib/ads-campaign-economics.ts";
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

  it("dia pausado COM lançamento continua no gráfico — nada de gasto sumindo em silêncio", () => {
    // Achado 2 do review da PR #8312: pular todo dia pausado só devolvia o
    // resíduo se existisse um dia veiculado DEPOIS dele. Numa pausa em
    // andamento (que cobre o fim do intervalo) não existe, e gasto/cadastro
    // real sumia do gráfico. Dia em que algo foi cobrado é dado, e dado
    // aparece — mesmo pausado.
    const comResiduo: ChannelDailyMetric[] = [
      ...metrics,
      { canal: CANAL, date: "2026-09-12", gastoBrl: 7, cliques: 0, impressoes: 0 },
    ];
    const result = buildCumulativeSeries(comResiduo, signups, RANGE, { pauseIntervals: PAUSA_PRODUCAO });
    const datas = result.series[0].points.map((p) => p.date);
    assert.ok(datas.includes("2026-09-12"), "dia pausado com gasto lançado tem que ser plotado");
    assert.ok(!result.skippedPausedDates.includes("2026-09-12"));
    // E os dias pausados VAZIOS ao redor continuam fora.
    assert.ok(!datas.includes("2026-09-11"));
    const ultimo = result.series[0].points.at(-1)!;
    assert.equal(ultimo.gastoAcumuladoBrl, 200 + 88 + 7 + 100);
  });

  it("pausa em andamento: lançamento nos últimos dias NÃO some (era o achado 2)", () => {
    // Sem dia veiculado depois pra herdar o resíduo, este é o caso em que o
    // dado sumia de vez.
    const emAndamento = normalizePauseIntervals({ inicio: "2026-09-09T16:05:36-03:00" });
    const comLancamentoNoFim: ChannelDailyMetric[] = [
      { canal: CANAL, date: "2026-09-08", gastoBrl: 200, cliques: 20, impressoes: 2000 },
      { canal: CANAL, date: "2026-09-17", gastoBrl: 100, cliques: 10, impressoes: 1000 },
    ];
    const signupsNoFim: ChannelDailySignup[] = [
      { canal: CANAL, date: "2026-09-08", cadastros: 1 },
      { canal: CANAL, date: "2026-09-17", cadastros: 1 },
    ];
    const result = buildCumulativeSeries(comLancamentoNoFim, signupsNoFim, RANGE, { pauseIntervals: emAndamento });
    const ultimo = result.series[0].points.at(-1)!;
    assert.equal(ultimo.date, "2026-09-17");
    assert.equal(ultimo.gastoAcumuladoBrl, 300);
    assert.equal(ultimo.cadastrosAcumulados, 2);
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

  it("sharedYAxisMax só olha ponto plotado — dia pulado não manda na escala", () => {
    // Dia pausado e VAZIO não tem ponto, logo não tem custo pra comparar;
    // a escala sai idêntica à de um intervalo que nem incluísse esses dias.
    const soVeiculados: ChannelDailyMetric[] = [
      { canal: CANAL, date: "2026-09-08", gastoBrl: 10, cliques: 1, impressoes: 10 },
      { canal: CANAL, date: "2026-09-17", gastoBrl: 90, cliques: 9, impressoes: 90 },
    ];
    const sign: ChannelDailySignup[] = [{ canal: CANAL, date: "2026-09-08", cadastros: 1 }];
    const comPausa = buildCumulativeSeries(soVeiculados, sign, RANGE, { pauseIntervals: PAUSA_PRODUCAO });
    const semPausa = buildCumulativeSeries(soVeiculados, sign, RANGE);
    assert.equal(comPausa.sharedYAxisMax, 100);
    assert.equal(semPausa.sharedYAxisMax, 100);
    assert.ok(!comPausa.series[0].points.some((p) => p.date === "2026-09-12"));
  });

  it("pausa em andamento (`fim` ausente) pula os dias cobertos E vazios", () => {
    const emAndamento = normalizePauseIntervals({ inicio: "2026-09-09T16:05:36-03:00" });
    const result = buildCumulativeSeries(metrics, signups, RANGE, { pauseIntervals: emAndamento });
    const datas = result.series[0].points.map((p) => p.date);
    // 17/09 tem gasto e cadastro lançados, então fica; 10-16/09 estão vazios.
    assert.deepEqual(datas, ["2026-09-08", "2026-09-09", "2026-09-17"]);
    assert.deepEqual(result.skippedPausedDates, [
      "2026-09-10",
      "2026-09-11",
      "2026-09-12",
      "2026-09-13",
      "2026-09-14",
      "2026-09-15",
      "2026-09-16",
    ]);
  });

  it("lista de pausas vazia é o mesmo que não informar pausa", () => {
    const result = buildCumulativeSeries(metrics, signups, RANGE, { pauseIntervals: [] });
    assert.equal(result.series[0].points.length, 10);
    assert.deepEqual(result.skippedPausedDates, []);
  });
});

describe("#8307 — a pausa vem de `effectivePauseIntervals`, não de `revisao.pausa` direto", () => {
  it("formato ANTIGO (`revisao.pausas`, plural, só data) também pula os dias", () => {
    // Achado 1 do review da PR #8312: ler `revisao.pausa` direto ignorava o
    // formato antigo em silêncio — o badge saía "pausada" e o gráfico
    // continuava plotando os dias, reabrindo o bug conforme o formato do
    // dado. `effectivePauseIntervals` é a fonte única dos dois formatos.
    const intervals = effectivePauseIntervals({ pausas: [{ desde: "2026-09-10", ate: "2026-09-16" }] } as never);
    assert.ok(intervals.length > 0, "formato antigo tem que virar intervalo");
    const result = buildCumulativeSeries(metrics, signups, RANGE, { pauseIntervals: intervals });
    assert.deepEqual(result.skippedPausedDates, [
      "2026-09-10",
      "2026-09-11",
      "2026-09-12",
      "2026-09-13",
      "2026-09-14",
      "2026-09-15",
      "2026-09-16",
    ]);
  });

  it("formato ATUAL tem precedência quando os dois existem", () => {
    const intervals = effectivePauseIntervals({
      pausa: { inicio: "2026-09-09T16:05:36-03:00", fim: "2026-09-17T00:16:00-03:00" },
      pausas: [{ desde: "2026-09-06", ate: "2026-09-07" }],
    } as never);
    const result = buildCumulativeSeries(metrics, signups, RANGE, { pauseIntervals: intervals });
    assert.ok(!result.skippedPausedDates.includes("2026-09-06"));
    assert.ok(result.skippedPausedDates.includes("2026-09-10"));
  });

  it("revisão ausente → nenhum dia pulado (nunca lança)", () => {
    assert.deepEqual(effectivePauseIntervals(undefined), []);
    assert.deepEqual(effectivePauseIntervals(null), []);
  });
});
