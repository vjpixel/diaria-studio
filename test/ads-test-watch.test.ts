/**
 * test/ads-test-watch.test.ts (#5845)
 *
 * Lógica pura de `scripts/lib/ads-test-watch.ts` — plano diário
 * (`planAdsTestWatchActions`), cobertura de `clicks-2608.csv`, condição de
 * morte §3.2 item 3, e idempotência assimétrica (religar-brevo/apuração são
 * 1x; os demais repetem). Cada fase testada com data INJETADA, nunca
 * `Date.now()` real.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  planAdsTestWatchActions,
  emptyAdsTestWatchState,
  markReligarBrevoTriggered,
  markApuracaoCompleted,
  parseClicksCsv,
  findMissingClicksBracosForDate,
  evaluateSpendOverageDeathCondition,
  type AdsTestWatchState,
} from "../scripts/lib/ads-test-watch.ts";
import { buildAdsTestRunState, ADS_TEST_2608_BRACOS } from "../scripts/lib/ads-test-run-state.ts";
import { addDays } from "../scripts/lib/ads-test-schedule.ts";

const RUN_STATE = buildAdsTestRunState("2026-08-26", "2026-08-26T09:00:00.000Z");
// d0=2026-08-26 fim_janela=2026-09-09 religar_brevo=2026-09-16 apuracao_snapshot >= 2026-10-07 (1º domingo)

describe("#5845 — ads-test-watch: planAdsTestWatchActions", () => {
  it("sem run-state, sem D0 planejado → nada a fazer", () => {
    const plan = planAdsTestWatchActions("2026-08-30", null, null, emptyAdsTestWatchState());
    assert.deepEqual(plan, {
      alarmMissingD0Overdue: false,
      checkClicksCoverage: false,
      checkDeathConditions: false,
      triggerReligarBrevo: false,
      runApuracao: false,
    });
  });

  it("sem run-state, D0 planejado ainda não chegou → nada a fazer", () => {
    const plan = planAdsTestWatchActions("2026-08-25", null, "2026-08-26", emptyAdsTestWatchState());
    assert.equal(plan.alarmMissingD0Overdue, false);
  });

  it("sem run-state, D0 planejado é HOJE → ainda não é 'overdue' (só passou o dia seguinte alarma)", () => {
    const plan = planAdsTestWatchActions("2026-08-26", null, "2026-08-26", emptyAdsTestWatchState());
    assert.equal(plan.alarmMissingD0Overdue, false);
  });

  it("sem run-state, D0 planejado já passou → alarma 'missing D0 overdue' (repete todo dia)", () => {
    const plan = planAdsTestWatchActions("2026-08-27", null, "2026-08-26", emptyAdsTestWatchState());
    assert.equal(plan.alarmMissingD0Overdue, true);
  });

  it("com run-state, antes do D0 → nada (pre-window)", () => {
    const plan = planAdsTestWatchActions("2026-08-20", RUN_STATE, null, emptyAdsTestWatchState());
    assert.equal(plan.checkClicksCoverage, false);
    assert.equal(plan.checkDeathConditions, false);
  });

  it("com run-state, no D0 exato → checkDeathConditions dentro da janela (checkClicksCoverage: ver regressão do finding 1 abaixo)", () => {
    const plan = planAdsTestWatchActions(RUN_STATE.d0, RUN_STATE, null, emptyAdsTestWatchState());
    assert.equal(plan.checkDeathConditions, true);
  });

  it("com run-state, no meio da janela (d0+1, 'ontem' = d0) → dentro, cobertura checável normalmente", () => {
    // Data intermediária que não colide com nenhum dos edge cases de fronteira
    // (D0 exato / fim_janela+1) cobertos pelas regressões do #5845 abaixo.
    const midWindow = addDays(RUN_STATE.d0, 1);
    const plan = planAdsTestWatchActions(midWindow, RUN_STATE, null, emptyAdsTestWatchState());
    assert.equal(plan.checkClicksCoverage, true);
    assert.equal(plan.checkDeathConditions, true);
  });

  it("com run-state, no último dia da janela (fim_janela) → checkDeathConditions ainda dentro", () => {
    const plan = planAdsTestWatchActions(RUN_STATE.fim_janela, RUN_STATE, null, emptyAdsTestWatchState());
    assert.equal(plan.checkDeathConditions, true);
  });

  it("REGRESSÃO (self-review #5845, finding 1): no D0 exato NÃO checa cobertura — 'ontem' seria antes da campanha existir", () => {
    // checkClicksCoverage audita a linha de ONTEM (ver scripts/ads-test-watch.ts).
    // No D0 exato, ontem = d0-1, uma data anterior ao início da campanha —
    // nenhuma linha pode existir ainda, então checar geraria falso-alarme
    // garantido todo D0. checkDeathConditions continua true (não sofre desse bug).
    const plan = planAdsTestWatchActions(RUN_STATE.d0, RUN_STATE, null, emptyAdsTestWatchState());
    assert.equal(plan.checkClicksCoverage, false);
    assert.equal(plan.checkDeathConditions, true);
  });

  it("REGRESSÃO (self-review #5845, finding 2): fim_janela+1 AINDA checa cobertura do último dia da janela", () => {
    // O último dia da janela (fim_janela) só é auditável no dia SEGUINTE
    // (fim_janela+1, quando "ontem" = fim_janela) — que já está fora de
    // withinWindow. checkClicksCoverage precisa ser independente desse gate.
    const dayAfterWindow = "2026-09-10"; // fim_janela (2026-09-09) + 1
    const plan = planAdsTestWatchActions(dayAfterWindow, RUN_STATE, null, emptyAdsTestWatchState());
    assert.equal(plan.checkClicksCoverage, true, "cobertura do último dia da janela precisa ser auditada em fim_janela+1");
    assert.equal(plan.checkDeathConditions, false, "condição de morte não precisa rodar fora da janela");
  });

  it("REGRESSÃO: 2 dias depois da janela → nem cobertura nem morte (fora de qualquer data auditável)", () => {
    const plan = planAdsTestWatchActions("2026-09-11", RUN_STATE, null, emptyAdsTestWatchState());
    assert.equal(plan.checkClicksCoverage, false);
    assert.equal(plan.checkDeathConditions, false);
  });

  it("D+21 chegou, ainda não disparado → triggerReligarBrevo true", () => {
    const plan = planAdsTestWatchActions(RUN_STATE.religar_brevo, RUN_STATE, null, emptyAdsTestWatchState());
    assert.equal(plan.triggerReligarBrevo, true);
  });

  it("D+21 chegou, JÁ disparado (idempotente) → triggerReligarBrevo false", () => {
    const state = markReligarBrevoTriggered(emptyAdsTestWatchState(), "2026-09-16T06:30:00.000Z");
    const plan = planAdsTestWatchActions(RUN_STATE.religar_brevo, RUN_STATE, null, state);
    assert.equal(plan.triggerReligarBrevo, false);
  });

  it("data de apuração chegou, ainda não rodada → runApuracao true", () => {
    const plan = planAdsTestWatchActions(RUN_STATE.apuracao_snapshot, RUN_STATE, null, emptyAdsTestWatchState());
    assert.equal(plan.runApuracao, true);
  });

  it("data de apuração chegou, JÁ rodada (idempotente) → runApuracao false", () => {
    const state = markApuracaoCompleted(emptyAdsTestWatchState(), "2026-10-11T06:30:00.000Z", "data/aquisicao/cac-reports/x.md");
    const plan = planAdsTestWatchActions(RUN_STATE.apuracao_snapshot, RUN_STATE, null, state);
    assert.equal(plan.runApuracao, false);
  });

  it("task ficou parada e passou tanto D+21 quanto a apuração → os dois disparam no mesmo run", () => {
    const plan = planAdsTestWatchActions("2026-12-01", RUN_STATE, null, emptyAdsTestWatchState());
    assert.equal(plan.triggerReligarBrevo, true);
    assert.equal(plan.runApuracao, true);
  });
});

describe("#5845 — ads-test-watch: parseClicksCsv", () => {
  const HEADER = "canal,data_apuracao,gasto_acumulado,cliques,impressoes,cpc_medio,conversoes,custo_por_conversao,perda_orcamento,perda_ranking,fonte\n";

  it("parseia linhas válidas", () => {
    const csv = HEADER + "Google Ads (teste 2608),2026-08-26,71.43,10,1000,7.1,1,71.43,,,painel Google\n";
    const { rows, errors } = parseClicksCsv(csv);
    assert.equal(errors.length, 0);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].canal, "Google Ads (teste 2608)");
    assert.equal(rows[0].gasto_acumulado, 71.43);
    assert.equal(rows[0].leitoresAcumulado, null, "sem a coluna 'leitores_acumulado' no header -> null, nunca erro (#5239)");
  });

  it("#5239 — coluna OPCIONAL 'leitores_acumulado' presente e preenchida -> parseia como número", () => {
    const headerWithLeitores = HEADER.trim() + ",leitores_acumulado\n";
    const csv = headerWithLeitores + "Google Ads (teste 2608),2026-08-26,71.43,10,1000,7.1,1,71.43,,,painel Google,12\n";
    const { rows, errors } = parseClicksCsv(csv);
    assert.equal(errors.length, 0);
    assert.equal(rows[0].leitoresAcumulado, 12);
  });

  it("#5239 — coluna presente mas VAZIA nesta linha -> null, não é erro (editor ainda não reconciliou este campo)", () => {
    const headerWithLeitores = HEADER.trim() + ",leitores_acumulado\n";
    const csv = headerWithLeitores + "Google Ads (teste 2608),2026-08-26,71.43,10,1000,7.1,1,71.43,,,painel Google,\n";
    const { rows, errors } = parseClicksCsv(csv);
    assert.equal(errors.length, 0);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].leitoresAcumulado, null);
  });

  it("#5239 — coluna presente com valor NÃO-numérico -> erro (mesma disciplina das demais colunas numéricas)", () => {
    const headerWithLeitores = HEADER.trim() + ",leitores_acumulado\n";
    const csv = headerWithLeitores + "Google Ads (teste 2608),2026-08-26,71.43,10,1000,7.1,1,71.43,,,painel Google,abc\n";
    const { rows, errors } = parseClicksCsv(csv);
    assert.equal(rows.length, 0);
    assert.equal(errors.length, 1);
    assert.match(errors[0].reason, /leitores_acumulado/);
  });

  it("lança se o header estiver faltando uma coluna obrigatória", () => {
    const csv = "canal,data_apuracao\nGoogle,2026-08-26\n";
    assert.throws(() => parseClicksCsv(csv));
  });

  it("linha com gasto_acumulado vazio vira erro, não 0 silencioso", () => {
    const csv = HEADER + "Google Ads (teste 2608),2026-08-26,,,,,,,,,\n";
    const { rows, errors } = parseClicksCsv(csv);
    assert.equal(rows.length, 0);
    assert.equal(errors.length, 1);
  });

  it("linha com data_apuracao malformada vira erro", () => {
    const csv = HEADER + "Google Ads (teste 2608),26/08/2026,71.43,,,,,,,,\n";
    const { errors } = parseClicksCsv(csv);
    assert.equal(errors.length, 1);
  });

  it("linha com gasto_acumulado não-numérico vira erro", () => {
    const csv = HEADER + "Google Ads (teste 2608),2026-08-26,abc,,,,,,,,\n";
    const { errors } = parseClicksCsv(csv);
    assert.equal(errors.length, 1);
  });
});

describe("#5845 — ads-test-watch: findMissingClicksBracosForDate", () => {
  it("todos os 3 braços presentes → nenhum faltando", () => {
    const rows = ADS_TEST_2608_BRACOS.map((canal) => ({ canal, data_apuracao: "2026-08-26", gasto_acumulado: 10 }));
    const missing = findMissingClicksBracosForDate(rows, ADS_TEST_2608_BRACOS, "2026-08-26");
    assert.deepEqual(missing, []);
  });

  it("1 braço faltando pra data → aparece na lista", () => {
    const rows = [{ canal: ADS_TEST_2608_BRACOS[0], data_apuracao: "2026-08-26", gasto_acumulado: 10 }];
    const missing = findMissingClicksBracosForDate(rows, ADS_TEST_2608_BRACOS, "2026-08-26");
    assert.deepEqual(missing, [ADS_TEST_2608_BRACOS[1], ADS_TEST_2608_BRACOS[2]]);
  });

  it("linhas de OUTRA data não contam como presença", () => {
    const rows = ADS_TEST_2608_BRACOS.map((canal) => ({ canal, data_apuracao: "2026-08-25", gasto_acumulado: 10 }));
    const missing = findMissingClicksBracosForDate(rows, ADS_TEST_2608_BRACOS, "2026-08-26");
    assert.deepEqual(missing, [...ADS_TEST_2608_BRACOS]);
  });
});

describe("#5845 — ads-test-watch: evaluateSpendOverageDeathCondition (§3.2 item 3)", () => {
  const D0 = "2026-08-26";
  const BRACOS = ["Google Ads (teste 2608)"];

  it("gasto dentro do esperado (não excede 2× o planejado) → nenhum achado", () => {
    // dia 1 (D0): planejado R$100, gasto R$150 (< 2×100=200) → ok.
    const rows = [{ canal: BRACOS[0], data_apuracao: D0, gasto_acumulado: 150 }];
    const findings = evaluateSpendOverageDeathCondition(rows, BRACOS, D0, D0, 100);
    assert.deepEqual(findings, []);
  });

  it("gasto EXATAMENTE 2× o planejado → não dispara (estritamente MAIOR que 2×)", () => {
    const rows = [{ canal: BRACOS[0], data_apuracao: D0, gasto_acumulado: 200 }];
    const findings = evaluateSpendOverageDeathCondition(rows, BRACOS, D0, D0, 100);
    assert.deepEqual(findings, []);
  });

  it("gasto acima de 2× o planejado (acumulado do período) → dispara", () => {
    // dia 3 (D0+2): planejado acumulado = 100*3=300, limite=600. Gasto=650 > 600 → dispara.
    const rows = [{ canal: BRACOS[0], data_apuracao: "2026-08-28", gasto_acumulado: 650 }];
    const findings = evaluateSpendOverageDeathCondition(rows, BRACOS, D0, "2026-08-28", 100);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].braco, BRACOS[0]);
    assert.equal(findings[0].plannedCumulativeBRL, 300);
    assert.ok(findings[0].ratio > 2);
  });

  it("usa a linha mais RECENTE conhecida até hoje, não a mais antiga", () => {
    const rows = [
      { canal: BRACOS[0], data_apuracao: "2026-08-26", gasto_acumulado: 1000 }, // estouraria se usada
      { canal: BRACOS[0], data_apuracao: "2026-08-27", gasto_acumulado: 150 }, // dentro do esperado
    ];
    const findings = evaluateSpendOverageDeathCondition(rows, BRACOS, D0, "2026-08-27", 100);
    assert.deepEqual(findings, []);
  });

  it("ignora linhas com data FUTURA em relação a todayDateStr", () => {
    const rows = [{ canal: BRACOS[0], data_apuracao: "2026-09-01", gasto_acumulado: 999999 }];
    const findings = evaluateSpendOverageDeathCondition(rows, BRACOS, D0, D0, 100);
    assert.deepEqual(findings, [], "linha futura não deveria ser considerada 'a mais recente conhecida até hoje'");
  });

  it("braço sem NENHUMA linha ainda → não entra na lista (é achado de cobertura faltante, não morte)", () => {
    const findings = evaluateSpendOverageDeathCondition([], BRACOS, D0, D0, 100);
    assert.deepEqual(findings, []);
  });
});

describe("#5845 — ads-test-watch: idempotência assimétrica (markX)", () => {
  it("markReligarBrevoTriggered só altera o campo dele, preserva os demais", () => {
    const initial: AdsTestWatchState = { religarBrevoTriggeredAt: null, apuracaoCompletedAt: "x", apuracaoReportPath: "y" };
    const next = markReligarBrevoTriggered(initial, "2026-09-16T06:30:00.000Z");
    assert.equal(next.religarBrevoTriggeredAt, "2026-09-16T06:30:00.000Z");
    assert.equal(next.apuracaoCompletedAt, "x");
    assert.equal(next.apuracaoReportPath, "y");
  });

  it("markApuracaoCompleted grava completedAt + reportPath", () => {
    const next = markApuracaoCompleted(emptyAdsTestWatchState(), "2026-10-11T06:30:00.000Z", "data/aquisicao/cac-reports/2026-10-11.md");
    assert.equal(next.apuracaoCompletedAt, "2026-10-11T06:30:00.000Z");
    assert.equal(next.apuracaoReportPath, "data/aquisicao/cac-reports/2026-10-11.md");
  });
});
