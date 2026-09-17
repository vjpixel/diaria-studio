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

  // #8262 review item 6: `dailyBudgetForDate` já ordena defensivamente
  // (`[...schedule].sort(...)`, ver comentário na função) mas nenhum teste
  // passava schedule fora de ordem — um refactor que removesse o sort não
  // quebraria nada aqui. 3 vigências deliberadamente desordenadas (a mais
  // recente primeiro) devem produzir o MESMO resultado que a mesma lista
  // ordenada ascendente por `desde`.
  it("schedule fora de ordem (mais recente primeiro) dá o mesmo resultado da lista ordenada — regressão do sort defensivo", () => {
    const ordered = [
      { desde: "2026-09-05T00:00:00-03:00", brl: 100 },
      { desde: "2026-09-06T17:07:00-03:00", brl: 200 },
      { desde: "2026-09-10T00:00:00-03:00", brl: 300 },
    ];
    const shuffled = [ordered[2], ordered[0], ordered[1]];
    for (const date of ["2026-09-05", "2026-09-06", "2026-09-07", "2026-09-10", "2026-09-11"] as const) {
      assert.equal(
        dailyBudgetForDate(date, shuffled, 100),
        dailyBudgetForDate(date, ordered, 100),
        `dailyBudgetForDate(${date}) diverge entre schedule ordenado e desordenado`,
      );
    }
    // valores concretos, não só "os dois batem entre si" — trava contra os
    // dois lados quebrarem do mesmo jeito
    assert.equal(dailyBudgetForDate("2026-09-05", shuffled, 100), 100);
    assert.equal(dailyBudgetForDate("2026-09-07", shuffled, 100), 200);
    assert.equal(dailyBudgetForDate("2026-09-11", shuffled, 100), 300);
  });
});

describe("#8240 itens 1+3 — plannedBudgetBRL (integra diário vigente sobre dias de veiculação)", () => {
  it("sem pausa, sem schedule -> equivalente ao cálculo antigo (dias de calendário × diário fixo)", () => {
    assert.equal(plannedBudgetBRL("2026-08-26", "2026-08-28", undefined, [], 100), 300);
  });

  it("Microsoft: 100/dia até 06/09 17:07, 200/dia depois, pró-rateado no dia da virada (#8270)", () => {
    const schedule = [{ desde: "2026-09-06T17:07:00-03:00", brl: 200 }];
    const pauseIntervals = [{ inicio: "2026-09-09T09:10:00-03:00", fim: "2026-09-17T00:16:00-03:00" }];
    // 05/09 (100) + 06/09 pró-rateado (100 × 17h07/24h + 200 × 6h53/24h ≈ 128,68)
    // + 07/09 (200) + 08/09 (200) + fração de 09/09 pausada (~0,382 × 200)
    // — nada de 10 a 16/09 (pausados 100%)
    const planejado = plannedBudgetBRL("2026-09-05", "2026-09-09", schedule, pauseIntervals, 100);
    // 100 + 128,68 + 200 + 200 + (0,382 × 200) ≈ 705,07 (valor que a #8270 pediu)
    assert.ok(planejado > 700 && planejado < 710, `esperado ~705,07; recebi ${planejado}`);
  });

  // #8262 review item 6 (continuação): `plannedBudgetBRL` consome a mesma
  // `schedule` — confirmar que o sort defensivo protege também este caminho,
  // não só `dailyBudgetForDate` isolado.
  it("schedule fora de ordem produz o MESMO planejado que a lista ordenada", () => {
    const orderedSchedule = [
      { desde: "2026-09-05T00:00:00-03:00", brl: 100 },
      { desde: "2026-09-06T17:07:00-03:00", brl: 200 },
    ];
    const shuffledSchedule = [orderedSchedule[1], orderedSchedule[0]];
    const pauseIntervals = [{ inicio: "2026-09-09T09:10:00-03:00", fim: "2026-09-17T00:16:00-03:00" }];
    const planejadoOrdenado = plannedBudgetBRL("2026-09-05", "2026-09-09", orderedSchedule, pauseIntervals, 100);
    const planejadoDesordenado = plannedBudgetBRL("2026-09-05", "2026-09-09", shuffledSchedule, pauseIntervals, 100);
    assert.equal(planejadoDesordenado, planejadoOrdenado);
    assert.ok(planejadoOrdenado > 700 && planejadoOrdenado < 710, `esperado ~705,07; recebi ${planejadoOrdenado}`);
  });

  // #8270: caso de borda explícito — pausa E virada de orçamento no MESMO
  // dia. As duas frações precisam compor (união de breakpoints), nunca
  // multiplicar ingenuamente `(1 - fraçãoPausada) × orçamentoDoDiaInteiro`.
  it("pausa e virada de orçamento no MESMO dia compõem por sub-intervalo, não multiplicam ingenuamente", () => {
    // Dia único: orçamento 100 até 12:00, 300 dali em diante; pausa das
    // 18:00 às 24:00 (6h). Frações do dia: [00-12h]=100 não pausado,
    // [12-18h]=300 não pausado, [18-24h]=300 mas pausado (0).
    const schedule = [{ desde: "2026-09-10T12:00:00-03:00", brl: 300 }];
    const pauseIntervals = [{ inicio: "2026-09-10T18:00:00-03:00", fim: "2026-09-11T00:00:00-03:00" }];
    const planejado = plannedBudgetBRL("2026-09-10", "2026-09-10", schedule, pauseIntervals, 100);
    // 100 × 12/24 + 300 × 6/24 = 50 + 75 = 125 (a fração pausada das 18-24h
    // não contribui nada, mesmo sendo o trecho de orçamento MAIOR).
    assert.ok(Math.abs(planejado - 125) < 1e-6, `esperado 125; recebi ${planejado}`);

    // Contraprova: o cálculo ingênuo antigo (fração-não-pausada do dia ×
    // orçamento-vigente-ao-fim-do-dia) daria (1 - 6/24) × 300 = 225 —
    // bem diferente do valor composto corretamente.
    const ingenuo = (1 - 6 / 24) * 300;
    assert.ok(Math.abs(planejado - ingenuo) > 50, "a versão correta não pode coincidir com a conta ingênua neste cenário");
  });

  // #8270 review, achado 1: o caminho novo (`veiculatedBudgetForDay`, usado
  // por `plannedBudgetBRL`) parou de chamar `pausedFractionOfDay` e, com
  // isso, perdeu a validação de "fim < inicio" que #8262 (achado 7) já
  // tinha endurecido — reabria a mesma classe de falha silenciosa num
  // caminho novo. Trava aqui que `plannedBudgetBRL` também falha alto.
  it("intervalo de pausa invertido (fim < inicio) falha ALTO também via plannedBudgetBRL, não só pausedFractionOfDay", () => {
    const invertido = [{ inicio: "2026-09-10T18:00:00-03:00", fim: "2026-09-10T09:00:00-03:00" }];
    assert.throws(
      () => plannedBudgetBRL("2026-09-10", "2026-09-10", undefined, invertido, 100),
      /intervalo de pausa invertido/,
    );
  });

  // #8270 review, achado 2: pausa em andamento (`fim: null`) combinada com
  // virada de orçamento no MESMO dia — cobre o breakpoint condicional que
  // só existe pra `fim != null` (a pausa sem fim não adiciona breakpoint de
  // TÉRMINO, e precisa ainda assim cobrir o resto do dia).
  it("pausa EM ANDAMENTO (fim: null) + virada de orçamento no mesmo dia: cobre até o fim do dia inteiro", () => {
    // Orçamento 100 até 10:00, 400 dali em diante. Pausa começa 15:00, sem fim.
    const schedule = [{ desde: "2026-09-10T10:00:00-03:00", brl: 400 }];
    const pauseIntervals = [{ inicio: "2026-09-10T15:00:00-03:00", fim: null }];
    const planejado = plannedBudgetBRL("2026-09-10", "2026-09-10", schedule, pauseIntervals, 100);
    // [00-10h]=100 não pausado (10h) + [10-15h]=400 não pausado (5h) + [15-24h] pausado (0).
    const esperado = 100 * (10 / 24) + 400 * (5 / 24);
    assert.ok(Math.abs(planejado - esperado) < 1e-6, `esperado ${esperado}; recebi ${planejado}`);
  });

  // #8270 review, achado 2: MÚLTIPLAS mudanças de orçamento no mesmo dia.
  it("múltiplas mudanças de orçamento no mesmo dia produzem 3 sub-intervalos, não 2", () => {
    const schedule = [
      { desde: "2026-09-10T08:00:00-03:00", brl: 200 },
      { desde: "2026-09-10T16:00:00-03:00", brl: 300 },
    ];
    const planejado = plannedBudgetBRL("2026-09-10", "2026-09-10", schedule, [], 100);
    // [00-08h]=100 (8h) + [08-16h]=200 (8h) + [16-24h]=300 (8h)
    const esperado = 100 * (8 / 24) + 200 * (8 / 24) + 300 * (8 / 24);
    assert.ok(Math.abs(planejado - esperado) < 1e-6, `esperado ${esperado}; recebi ${planejado}`);
  });

  // #8270 review, achado 2: entrada de schedule EXATAMENTE na virada do dia
  // (meia-noite BRT) — não deve gerar breakpoint espúrio nem deixar o dia
  // anterior contaminado pelo novo valor.
  it("entrada de schedule exatamente à meia-noite BRT vale o dia inteiro seguinte, sem afetar o dia anterior", () => {
    const schedule = [{ desde: "2026-09-11T00:00:00-03:00", brl: 500 }];
    const dia10 = plannedBudgetBRL("2026-09-10", "2026-09-10", schedule, [], 100);
    const dia11 = plannedBudgetBRL("2026-09-11", "2026-09-11", schedule, [], 100);
    assert.equal(dia10, 100, "dia anterior à virada segue no default");
    assert.equal(dia11, 500, "dia da virada (desde à meia-noite) já entra 100% no novo valor");
  });
});
