/**
 * test/ads-test-pause-window.test.ts (#8240, #8241)
 *
 * Lógica pura de `scripts/lib/ads-test-pause-window.ts` — helper único de
 * intervalos de pausa (`revisao.pausa`) e diário vigente
 * (`orcamento_diario_brl`), consumido pelo alarme de gasto (#8240) e pela
 * janela móvel/comparabilidade (#8241).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  normalizePauseIntervals,
  pausedFractionOfDay,
  isDatePaused,
  pausedDatesInRange,
  veiculationDaysInRange,
  dailyBudgetForDate,
  plannedBudgetBRL,
} from "../scripts/lib/ads-test-pause-window.ts";

describe("#8240/#8241 — normalizePauseIntervals", () => {
  it("undefined/null vira lista vazia", () => {
    assert.deepEqual(normalizePauseIntervals(undefined), []);
    assert.deepEqual(normalizePauseIntervals(null), []);
  });

  it("objeto único vira lista de 1", () => {
    const pausa = { inicio: "2026-09-09T09:10:00-03:00", fim: "2026-09-17T00:16:00-03:00" };
    assert.deepEqual(normalizePauseIntervals(pausa), [pausa]);
  });

  it("lista passa direto (2ª pausa futura)", () => {
    const pausas = [
      { inicio: "2026-09-09T09:10:00-03:00", fim: "2026-09-10T00:00:00-03:00" },
      { inicio: "2026-09-20T00:00:00-03:00", fim: null },
    ];
    assert.deepEqual(normalizePauseIntervals(pausas), pausas);
  });
});

describe("#8240/#8241 — pausedFractionOfDay / isDatePaused", () => {
  it("sem intervalos -> 0, dia não pausado", () => {
    assert.equal(pausedFractionOfDay("2026-09-10", []), 0);
    assert.equal(isDatePaused("2026-09-10", []), false);
  });

  it("dia inteiramente dentro do intervalo -> fração 1 (dia 100% pausado)", () => {
    const intervals = [{ inicio: "2026-09-09T09:10:00-03:00", fim: "2026-09-17T00:16:00-03:00" }];
    assert.equal(pausedFractionOfDay("2026-09-12", intervals), 1);
    assert.equal(isDatePaused("2026-09-12", intervals), true);
  });

  it("dia da PAUSA (09/09, pausou às 09h10) -> fração parcial, não 1", () => {
    const intervals = [{ inicio: "2026-09-09T09:10:00-03:00", fim: "2026-09-17T00:16:00-03:00" }];
    // 09h10 até meia-noite = 14h50 pausadas de 24h
    const frac = pausedFractionOfDay("2026-09-09", intervals);
    assert.ok(frac > 0.6 && frac < 0.62, `esperado ~0,618; recebi ${frac}`);
    assert.equal(isDatePaused("2026-09-09", intervals), true);
  });

  it("dia da RETOMADA (17/09, religou às 00h16) -> fração quase nula, ainda > 0", () => {
    const intervals = [{ inicio: "2026-09-09T09:10:00-03:00", fim: "2026-09-17T00:16:00-03:00" }];
    const frac = pausedFractionOfDay("2026-09-17", intervals);
    assert.ok(frac > 0 && frac < 0.02, `esperado fração pequena; recebi ${frac}`);
  });

  it("dia totalmente fora do intervalo -> 0", () => {
    const intervals = [{ inicio: "2026-09-09T09:10:00-03:00", fim: "2026-09-17T00:16:00-03:00" }];
    assert.equal(pausedFractionOfDay("2026-09-05", intervals), 0);
    assert.equal(pausedFractionOfDay("2026-09-20", intervals), 0);
  });

  it("dois intervalos SOBREPOSTOS não somam além de 1 (merge antes de somar)", () => {
    const intervals = [
      { inicio: "2026-09-10T00:00:00-03:00", fim: "2026-09-11T00:00:00-03:00" },
      { inicio: "2026-09-10T12:00:00-03:00", fim: "2026-09-11T12:00:00-03:00" },
    ];
    assert.equal(pausedFractionOfDay("2026-09-10", intervals), 1);
  });

  it("pausa em andamento (fim: null) cobre até o fim do dia consultado", () => {
    const intervals = [{ inicio: "2026-09-10T12:00:00-03:00", fim: null }];
    assert.equal(pausedFractionOfDay("2026-09-10", intervals), 0.5);
    assert.equal(pausedFractionOfDay("2026-09-15", intervals), 1);
  });
});

describe("#8241 — pausedDatesInRange", () => {
  it("lista os dias com QUALQUER cobertura (total ou parcial)", () => {
    const intervals = [{ inicio: "2026-09-09T09:10:00-03:00", fim: "2026-09-17T00:16:00-03:00" }];
    const dias = pausedDatesInRange("2026-09-08", "2026-09-18", intervals);
    assert.deepEqual(dias, [
      "2026-09-09",
      "2026-09-10",
      "2026-09-11",
      "2026-09-12",
      "2026-09-13",
      "2026-09-14",
      "2026-09-15",
      "2026-09-16",
      "2026-09-17",
    ]);
  });

  it("sem pausa nenhuma -> lista vazia", () => {
    assert.deepEqual(pausedDatesInRange("2026-09-08", "2026-09-18", []), []);
  });
});

describe("#8240 item 1 — veiculationDaysInRange (pausa NÃO conta como planejado)", () => {
  it("sem pausa -> dias de veiculação = dias de calendário", () => {
    assert.equal(veiculationDaysInRange("2026-09-05", "2026-09-08", []), 4);
  });

  it("8 dias corridos 100% pausados descontam os 8 do total", () => {
    // d0=05/09, throughDate=17/09 = 13 dias corridos. Pausa 09/09 09h10 -> 17/09 00h16.
    const intervals = [{ inicio: "2026-09-09T09:10:00-03:00", fim: "2026-09-17T00:16:00-03:00" }];
    const dias = veiculationDaysInRange("2026-09-05", "2026-09-17", intervals);
    // 05,06,07,08/09 inteiros (4) + fração de 09/09 (~0,382) + 0 (10-16/09) + fração de 17/09 (~0,993)
    assert.ok(dias > 5.3 && dias < 5.4, `esperado ~5,37 dias de veiculação; recebi ${dias}`);
    assert.ok(dias < 13, "13 dias de calendário nunca deveriam contar cheios com 8 dias pausados no meio");
  });
});

describe("#8240 item 3 — dailyBudgetForDate (diário vigente por braço)", () => {
  it("sem schedule -> usa o default", () => {
    assert.equal(dailyBudgetForDate("2026-09-06", undefined, 100), 100);
    assert.equal(dailyBudgetForDate("2026-09-06", [], 100), 100);
  });

  it("Microsoft: R$100 até 06/09 17:07, R$200 depois — muda só a partir da vigência", () => {
    const schedule = [{ desde: "2026-09-06T17:07:00-03:00", brl: 200 }];
    assert.equal(dailyBudgetForDate("2026-09-05", schedule, 100), 100);
    assert.equal(dailyBudgetForDate("2026-09-06", schedule, 100), 200, "dia INTEIRO usa o vigente ao FIM do dia (200)");
    assert.equal(dailyBudgetForDate("2026-09-07", schedule, 100), 200);
  });
});

describe("#8240 itens 1+3 — plannedBudgetBRL (integra diário vigente sobre dias de veiculação)", () => {
  it("sem pausa, sem schedule -> equivalente ao cálculo antigo (dias de calendário × diário fixo)", () => {
    assert.equal(plannedBudgetBRL("2026-08-26", "2026-08-28", undefined, [], 100), 300);
  });

  it("Microsoft: 100/dia até 06/09 17:07, 200/dia depois, planejado NÃO conta os 8 dias pausados", () => {
    const schedule = [{ desde: "2026-09-06T17:07:00-03:00", brl: 200 }];
    const pauseIntervals = [{ inicio: "2026-09-09T09:10:00-03:00", fim: "2026-09-17T00:16:00-03:00" }];
    // 05/09 (100) + 06/09 (200, vigente ao fim do dia) + 07/09 (200) + 08/09 (200)
    // + fração de 09/09 pausada (~0,382 × 200) — nada de 10 a 16/09 (pausados 100%)
    const planejado = plannedBudgetBRL("2026-09-05", "2026-09-09", schedule, pauseIntervals, 100);
    // 100 + 200 + 200 + 200 + (0,382 × 200) ≈ 776,4
    assert.ok(planejado > 770 && planejado < 785, `esperado ~776; recebi ${planejado}`);
  });
});
