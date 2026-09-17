/**
 * test/ads-window-context.test.ts (#8246)
 *
 * `computeAdsWindowContext` — o "contexto de janela" que substitui a
 * aritmética que antes vivia em PROSA no SKILL.md local da task
 * `relatorio-diario-teste-2608`. Fixture cobre o caso real que motivou a
 * issue: teste que veiculou 05-08/09, pausou 09/09→17/09 (00h16), e
 * retomou até 27/09.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeAdsWindowContext } from "../scripts/lib/ads-window-context.ts";

const BRACOS = ["Google Ads (teste 2608)", "Microsoft Ads (teste 2608)", "Meta Ads (teste 2608)"] as const;

// Pausa real do teste 2608: 09/09 09h10 -> 17/09 00h16 (registrada em
// run-state.json `revisao.pausa`).
const PAUSA_2608 = [{ inicio: "2026-09-09T09:10:00-03:00", fim: "2026-09-17T00:16:00-03:00" }];

const RUN_STATE_2608 = {
  d0: "2026-09-05",
  fim_janela: "2026-09-27",
  coorte_madura: "2026-10-24",
};

describe("#8246 — computeAdsWindowContext, sem run-state", () => {
  it("null quando run-state ausente — 'não sei', nunca inferido", () => {
    const ctx = computeAdsWindowContext(null, [...BRACOS], [], "2026-09-20", 100);
    assert.equal(ctx.d0, null);
    assert.equal(ctx.fimJanela, null);
    assert.equal(ctx.janelaEncerrada, null);
    assert.equal(ctx.coorteMadura, null);
    assert.equal(ctx.coorteAtingida, null);
    assert.equal(ctx.gastoEsperadoAteOntemPorBraco, null);
  });

  it("null quando run-state não declara d0/fim_janela", () => {
    const ctx = computeAdsWindowContext({ coorte_madura: "2026-10-24" }, [...BRACOS], [], "2026-09-20", 100);
    assert.equal(ctx.d0, null);
    assert.equal(ctx.gastoEsperadoAteOntemPorBraco, null);
  });
});

describe("#8246 — computeAdsWindowContext, janela encerrada / coorte madura", () => {
  it("hoje dentro da janela -> janelaEncerrada false", () => {
    const ctx = computeAdsWindowContext(RUN_STATE_2608, [...BRACOS], PAUSA_2608, "2026-09-20", 100);
    assert.equal(ctx.janelaEncerrada, false);
  });

  it("hoje == fim_janela -> ainda não encerrada (fim_janela é o último dia da janela)", () => {
    const ctx = computeAdsWindowContext(RUN_STATE_2608, [...BRACOS], PAUSA_2608, "2026-09-27", 100);
    assert.equal(ctx.janelaEncerrada, false);
  });

  it("hoje == fim_janela + 1 -> janela encerrada — é ISSO que a issue diz que a prosa velha (fim=19/09) não detectava mais", () => {
    const ctx = computeAdsWindowContext(RUN_STATE_2608, [...BRACOS], PAUSA_2608, "2026-09-28", 100);
    assert.equal(ctx.janelaEncerrada, true);
  });

  it("20/09 (o dia que a issue diz que a task poderia encerrar cedo): janela NÃO está encerrada com o run-state corrigido", () => {
    const ctx = computeAdsWindowContext(RUN_STATE_2608, [...BRACOS], PAUSA_2608, "2026-09-20", 100);
    assert.equal(ctx.janelaEncerrada, false, "fim_janela=27/09 corrigido — 20/09 é 7 dias antes do fim, não depois");
  });

  it("coorte madura: false antes da data, true no dia e depois", () => {
    const antes = computeAdsWindowContext(RUN_STATE_2608, [...BRACOS], PAUSA_2608, "2026-10-23", 100);
    const noDia = computeAdsWindowContext(RUN_STATE_2608, [...BRACOS], PAUSA_2608, "2026-10-24", 100);
    const depois = computeAdsWindowContext(RUN_STATE_2608, [...BRACOS], PAUSA_2608, "2026-10-25", 100);
    assert.equal(antes.coorteAtingida, false);
    assert.equal(noDia.coorteAtingida, true);
    assert.equal(depois.coorteAtingida, true);
  });
});

describe("#8246 — computeAdsWindowContext, gasto esperado descontando pausa", () => {
  it("antes de d0: gasto esperado é 0 (teste ainda não começou)", () => {
    const ctx = computeAdsWindowContext(RUN_STATE_2608, [...BRACOS], PAUSA_2608, "2026-09-05", 100);
    // hoje=d0, "ontem" é 04/09, antes de d0 -> 0.
    for (const braco of BRACOS) assert.equal(ctx.gastoEsperadoAteOntemPorBraco?.[braco], 0);
  });

  it("dia seguinte a d0 (06/09): 1 dia de veiculação (05/09) já esperado, sem desconto de pausa (pausa só começa 09/09)", () => {
    const ctx = computeAdsWindowContext(RUN_STATE_2608, [...BRACOS], PAUSA_2608, "2026-09-06", 100);
    for (const braco of BRACOS) assert.equal(ctx.gastoEsperadoAteOntemPorBraco?.[braco], 100);
  });

  it("18/09 (dia seguinte à retomada 17/09 00h16): 05-08/09 veicularam (4 dias), 09/09 parcial (pausou 09h10), 10-16/09 pausados (0), 17/09 quase integral (pausa terminou 00h16)", () => {
    const ctx = computeAdsWindowContext(RUN_STATE_2608, [...BRACOS], PAUSA_2608, "2026-09-18", 100);
    // "ontem" = 17/09. 05-08/09: 4 dias inteiros. 09/09: pausou às 09h10 —
    // veiculado só até lá, fração (24h - 9h10)/24h. 10-16/09: 0 (100% pausados).
    // 17/09: pausa terminou 00h16 — veiculado fração (24h - 16min)/24h.
    const fracao09 = 1 - (14 * 60 + 50) / (24 * 60);
    const fracao17 = 1 - 16 / (24 * 60);
    const esperado = (4 + fracao09 + fracao17) * 100;
    for (const braco of BRACOS) {
      const v = ctx.gastoEsperadoAteOntemPorBraco?.[braco];
      assert.ok(v !== undefined && Math.abs(v - esperado) < 0.5, `esperado ~${esperado.toFixed(2)}, recebi ${v}`);
    }
  });

  it("depois do fim_janela: trava no orçamento planejado até fim_janela, não cresce mais", () => {
    const dentro = computeAdsWindowContext(RUN_STATE_2608, [...BRACOS], PAUSA_2608, "2026-09-28", 100);
    const bemDepois = computeAdsWindowContext(RUN_STATE_2608, [...BRACOS], PAUSA_2608, "2026-10-15", 100);
    for (const braco of BRACOS) {
      assert.equal(dentro.gastoEsperadoAteOntemPorBraco?.[braco], bemDepois.gastoEsperadoAteOntemPorBraco?.[braco]);
    }
  });

  it("orcamento_diario_brl por braço é respeitado (Microsoft R$100->200 desde 06/09 17h07) — sem cálculo paralelo", () => {
    const runStateComOrcamento = {
      ...RUN_STATE_2608,
      orcamento_diario_brl: {
        "Microsoft Ads (teste 2608)": [
          { desde: "2026-09-05T00:00:00-03:00", brl: 100 },
          { desde: "2026-09-06T17:07:00-03:00", brl: 200 },
        ],
      },
    };
    const ctx = computeAdsWindowContext(runStateComOrcamento, [...BRACOS], PAUSA_2608, "2026-09-08", 100);
    // "ontem" = 07/09 -> 3 dias de veiculação sem pausa (05,06,07/09; a
    // pausa só começa 09/09). Google/Meta seguem no default 100/dia (sem
    // schedule declarado) = 300.
    assert.equal(ctx.gastoEsperadoAteOntemPorBraco?.["Google Ads (teste 2608)"], 3 * 100);
    assert.equal(ctx.gastoEsperadoAteOntemPorBraco?.["Meta Ads (teste 2608)"], 3 * 100);
    // Microsoft: 05/09 a 100 + 06/09 a 200 (mudou 17h07, vigente ao FIM do
    // dia — ver docstring de `dailyBudgetForDate`) + 07/09 a 200 = 500.
    assert.equal(ctx.gastoEsperadoAteOntemPorBraco?.["Microsoft Ads (teste 2608)"], 500);
  });
});
