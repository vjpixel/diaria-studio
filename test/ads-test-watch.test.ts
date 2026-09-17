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
  evaluateSpendWarning,
  projectBudgetCrossing,
  resolveArmSpend,
  buildSpendWatchDigestSection,
  type AdsTestWatchState,
} from "../scripts/lib/ads-test-watch.ts";
import { buildAdsTestRunState, ADS_TEST_2608_BRACOS } from "../scripts/lib/ads-test-run-state.ts";
import { addDays } from "../scripts/lib/ads-test-schedule.ts";
import { plannedBudgetBRL } from "../scripts/lib/ads-test-pause-window.ts";

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

/**
 * #8240 — a pausa (09/09 09h10 -> 17/09 00h16) NÃO conta como orçamento
 * planejado, e o diário vigente é POR BRAÇO (Microsoft R$200/dia desde
 * 06/09 17:07). Fixture inspirada nos números reais da issue: Meta com
 * R$517,85 acumulado até a pausa — a leitura de calendário (0,43×) e a
 * leitura de veiculação (>1×) precisam divergir.
 */
describe("#8240 — evaluateSpendOverageDeathCondition com pausa + diário vigente", () => {
  const D0 = "2026-09-05";
  const BRACO_META = "Meta Ads (teste 2608)";
  const BRACO_MSFT = "Microsoft Ads (teste 2608)";
  const PAUSE = [{ inicio: "2026-09-09T09:10:00-03:00", fim: "2026-09-17T00:16:00-03:00" }];

  it("regressão: SEM opts (comportamento antigo) a pausa de 8 dias INFLA o planejado até esconder o estouro", () => {
    // Meta gastou R$517,85 até a pausa (09/09); sem desconto de pausa, 13
    // dias de calendário (05-17/09) a R$100/dia = R$1.300 planejado —
    // 517,85 nunca ultrapassa nem 1× isso, quanto mais 2×.
    const rows = [{ canal: BRACO_META, data_apuracao: "2026-09-17", gasto_acumulado: 517.85 }];
    const findings = evaluateSpendOverageDeathCondition(rows, [BRACO_META], D0, "2026-09-17", 100);
    assert.deepEqual(findings, [], "achado antigo: calendário nunca dispara aqui — é o defeito que #8240 corrige via opts");
  });

  it("COM pauseIntervals, a razão sobre dias de VEICULAÇÃO fica bem mais alta (não dispara morte, mas não é mais 0,43×)", () => {
    const rows = [{ canal: BRACO_META, data_apuracao: "2026-09-17", gasto_acumulado: 517.85 }];
    const findings = evaluateSpendOverageDeathCondition(rows, [BRACO_META], D0, "2026-09-17", 100, { pauseIntervals: PAUSE });
    // Não é achado de MORTE (< 2×) — mas o planejado usado internamente é
    // bem menor que R$1.300; confirmar via evaluateSpendWarning abaixo.
    assert.deepEqual(findings, []);
  });

  // #8262 review item 10: as duas asserções deepEqual([]) acima não
  // discriminam implementação certa de errada — passariam mesmo com
  // `plannedBudgetBRL` cabeado errado, desde que o resultado ficasse abaixo
  // do limiar de morte. Aqui medimos a RAZÃO numérica real (gasto ÷
  // planejado) com `plannedBudgetBRL` — a mesma função que
  // `evaluateSpendOverageDeathCondition`/`evaluateSpendWarning` chamam
  // internamente (scripts/lib/ads-test-watch.ts:309,360) — usando o valor
  // de gasto REAL da issue #8240 até a pausa (não os dados sintéticos
  // "Braço único" de outros testes deste describe). `throughDate` é o dia
  // da pausa (09/09), que é quando a issue mede a razão "até a pausa".
  //
  // Critério de aceite do #8240: "Meta ≈1,18×, Google ≈1,14× [...] com a
  // pausa às 09h10 gravada [...] Nada de 0,43×, 0,42× e 0,24×."
  it("razão real até a pausa: Meta ≈1,18× (não 0,43×) — pausa 09h10 gravada no run-state", () => {
    const planned = plannedBudgetBRL(D0, "2026-09-09", undefined, PAUSE, 100);
    const ratio = 517.85 / planned;
    assert.ok(Math.abs(ratio - 1.18) < 0.02, `esperava ≈1,18×, obtive ${ratio.toFixed(4)}×`);
    assert.ok(Math.abs(ratio - 0.43) > 0.1, "não pode regredir pro valor antigo (calendário sem desconto de pausa)");
  });

  it("razão real até a pausa: Google ≈1,14× (não 0,42×) — pausa 09h10 gravada no run-state (não existia teste pro Google antes)", () => {
    const BRACO_GOOGLE = "Google Ads (teste 2608)";
    const planned = plannedBudgetBRL(D0, "2026-09-09", undefined, PAUSE, 100);
    const ratio = 500.57 / planned;
    assert.ok(Math.abs(ratio - 1.14) < 0.02, `esperava ≈1,14×, obtive ${ratio.toFixed(4)}×`);
    assert.ok(Math.abs(ratio - 0.42) > 0.1, "não pode regredir pro valor antigo (calendário sem desconto de pausa)");
    // Confirma pelo caminho de produção real (evaluateSpendOverageDeathCondition
    // com o nome do braço Google, não uma cópia do teste do Meta): 1,14× está
    // abaixo de 2× e não dispara morte, mas também abaixo do limiar de aviso
    // de 1,25× (SPEND_WARNING_RATIO_THRESHOLD) — não gera nem morte nem aviso
    // neste ponto específico (a pausa ainda não terminou os 8 dias).
    const rows = [{ canal: BRACO_GOOGLE, data_apuracao: "2026-09-09", gasto_acumulado: 500.57 }];
    const death = evaluateSpendOverageDeathCondition(rows, [BRACO_GOOGLE], D0, "2026-09-09", 100, { pauseIntervals: PAUSE });
    const warn = evaluateSpendWarning(rows, [BRACO_GOOGLE], D0, "2026-09-09", 100, { pauseIntervals: PAUSE });
    assert.deepEqual(death, []);
    assert.deepEqual(warn, []);
  });

  it("Microsoft: diário vigente 100->200 (06/09 17:07) muda o planejado só a partir da vigência, mesmo com pausa", () => {
    const rows = [{ canal: BRACO_MSFT, data_apuracao: "2026-09-08", gasto_acumulado: 288.03 }];
    const scheduleAntigo = evaluateSpendOverageDeathCondition(rows, [BRACO_MSFT], D0, "2026-09-08", 100, {
      pauseIntervals: PAUSE,
      budgetScheduleByBraco: {},
    });
    const scheduleNovo = evaluateSpendOverageDeathCondition(rows, [BRACO_MSFT], D0, "2026-09-08", 100, {
      pauseIntervals: PAUSE,
      budgetScheduleByBraco: { [BRACO_MSFT]: [{ desde: "2026-09-06T17:07:00-03:00", brl: 200 }] },
    });
    // Nenhum dos dois dispara morte com este gasto — mas o planejado (e
    // portanto o limiar) muda: confirmamos indiretamente via warning abaixo,
    // que expõe `plannedCumulativeBRL`.
    assert.deepEqual(scheduleAntigo, []);
    assert.deepEqual(scheduleNovo, []);
  });

  it("Microsoft: razão real até a pausa ≈0,37× com o diário vigente 100->200 — não regride pro 0,24× antigo", () => {
    // A issue #8240 estima manualmente ≈0,41× pra este cenário (pró-rateando
    // o dia 06/09 em duas frações: R$100 até 17:07 e R$200 depois). O
    // código NÃO integra sub-dia: `dailyBudgetForDate` usa o diário vigente
    // ao FIM do dia inteiro (doc em ads-test-pause-window.ts:230-237,
    // decisão deliberada — "não pretende precisão de minuto"), então o dia
    // 06/09 inteiro entra no planejado já a R$200 (não R$100 parcial +
    // R$200 parcial). Isso INFLA levemente o planejado em relação à conta
    // manual da issue, o que torna a razão mais BAIXA (mais conservadora,
    // nunca escondendo um estouro) — medido aqui em ≈0,37×, não ≈0,41×.
    // Não é bug: é a mesma aproximação de granularidade-por-dia documentada
    // na função, e a issue já avisa que a razão depende de qual instante se
    // usa. O que importa pro critério de aceite é não regredir pro valor
    // antigo (0,24×, calendário sem desconto de pausa nem diário vigente).
    const schedule = [{ desde: "2026-09-06T17:07:00-03:00", brl: 200 }];
    const planned = plannedBudgetBRL(D0, "2026-09-09", schedule, PAUSE, 100);
    const ratio = 288.03 / planned;
    assert.ok(Math.abs(ratio - 0.37) < 0.02, `esperava ≈0,37× (aproximação por dia inteiro do código), obtive ${ratio.toFixed(4)}×`);
    assert.ok(Math.abs(ratio - 0.24) > 0.05, "não pode regredir pro valor antigo (calendário + R$100 fixo pros 3 braços)");
  });

  it("razão 1,3× gera AVISO e NÃO gera achado de morte; 2,1× continua gerando morte", () => {
    const braco = "Braço único";
    const rowsAviso = [{ canal: braco, data_apuracao: D0, gasto_acumulado: 130 }]; // planejado D0 = 100
    const warn = evaluateSpendWarning(rowsAviso, [braco], D0, D0, 100);
    assert.equal(warn.length, 1);
    assert.ok(Math.abs(warn[0].ratio - 1.3) < 1e-9);
    const death1 = evaluateSpendOverageDeathCondition(rowsAviso, [braco], D0, D0, 100);
    assert.deepEqual(death1, []);

    const rowsMorte = [{ canal: braco, data_apuracao: D0, gasto_acumulado: 210 }]; // 2,1×
    const warn2 = evaluateSpendWarning(rowsMorte, [braco], D0, D0, 100);
    assert.deepEqual(warn2, [], "braço que já cruzou morte não deveria também aparecer como aviso");
    const death2 = evaluateSpendOverageDeathCondition(rowsMorte, [braco], D0, D0, 100);
    assert.equal(death2.length, 1);
  });

  it("razão abaixo de 1,25× não gera aviso nenhum", () => {
    const braco = "Braço único";
    const rows = [{ canal: braco, data_apuracao: D0, gasto_acumulado: 110 }]; // 1,1×
    assert.deepEqual(evaluateSpendWarning(rows, [braco], D0, D0, 100), []);
  });
});

describe("#8240 item 4 (2º ponto) — projectBudgetCrossing", () => {
  const BRACO = "Microsoft Ads (teste 2608)";
  const FIM_JANELA = "2026-09-27";

  it("R$288,03 + R$200/dia desde 17/09 cruza R$1.500 em 23/09, com fim_janela em 27/09", () => {
    const rows = [{ canal: BRACO, data_apuracao: "2026-09-16", gasto_acumulado: 288.03 }];
    const projection = projectBudgetCrossing(rows, BRACO, "2026-09-17", FIM_JANELA, 1500, 200);
    assert.ok(projection, "esperava uma projeção de cruzamento");
    assert.equal(projection!.crossesOn, "2026-09-23");
    assert.equal(projection!.fimJanela, FIM_JANELA);
  });

  it("braço que NÃO cruza o nominal antes do fim da janela não gera linha", () => {
    const rows = [{ canal: BRACO, data_apuracao: "2026-09-16", gasto_acumulado: 100 }];
    // ritmo baixo (10/dia) não cruza R$1.500 antes de 27/09
    const projection = projectBudgetCrossing(rows, BRACO, "2026-09-17", FIM_JANELA, 1500, 10);
    assert.equal(projection, null);
  });

  it("braço que já cruzou o nominal não entra (não é mais projeção, é fato corrente)", () => {
    const rows = [{ canal: BRACO, data_apuracao: "2026-09-16", gasto_acumulado: 1600 }];
    const projection = projectBudgetCrossing(rows, BRACO, "2026-09-17", FIM_JANELA, 1500, 200);
    assert.equal(projection, null);
  });

  it("braço sem nenhuma linha não entra", () => {
    assert.equal(projectBudgetCrossing([], BRACO, "2026-09-17", FIM_JANELA, 1500, 200), null);
  });
});

describe("#8240 item 3 — resolveArmSpend (fonte automática complementa o CSV, nunca substitui)", () => {
  const BRACO = "Microsoft Ads (teste 2608)";

  it("sem linha nenhuma no CSV → sem baseline, fonte automática não complementa", () => {
    const resolved = resolveArmSpend(BRACO, [], "2026-09-17", new Map([["2026-09-17", 200]]));
    assert.equal(resolved.gastoAcumulado, 0);
    assert.match(resolved.label ?? "", /sem linha de base/);
  });

  it("CSV parado em 16/09, fonte automática indisponível (null) → cai pro CSV com rótulo 'fonte manual, até 16/09'", () => {
    const rows = [{ canal: BRACO, data_apuracao: "2026-09-16", gasto_acumulado: 288.03 }];
    const resolved = resolveArmSpend(BRACO, rows, "2026-09-18", null);
    assert.equal(resolved.gastoAcumulado, 288.03);
    assert.equal(resolved.lastKnownDate, "2026-09-16");
    assert.equal(resolved.label, "fonte manual, até 2026-09-16");
  });

  it("CSV parado em 16/09, fonte automática disponível com 17/09 e 18/09 → gasto pós-retomada ENTRA na conta, sem rótulo", () => {
    const rows = [{ canal: BRACO, data_apuracao: "2026-09-16", gasto_acumulado: 288.03 }];
    const auto = new Map([
      ["2026-09-17", 200],
      ["2026-09-18", 200],
    ]);
    const resolved = resolveArmSpend(BRACO, rows, "2026-09-18", auto);
    assert.equal(resolved.gastoAcumulado, 288.03 + 200 + 200);
    assert.equal(resolved.lastKnownDate, "2026-09-18");
    assert.equal(resolved.label, null);
  });

  it("fonte automática disponível mas SEM dado pro dia em questão → cai pro rótulo manual (as duas fontes nunca somam 0 silencioso)", () => {
    const rows = [{ canal: BRACO, data_apuracao: "2026-09-16", gasto_acumulado: 288.03 }];
    const auto = new Map<string, number>(); // fonte "disponível" mas sem nenhum ponto pro braço
    const resolved = resolveArmSpend(BRACO, rows, "2026-09-18", auto);
    assert.equal(resolved.gastoAcumulado, 288.03, "sem dado automático novo, o acumulado não deveria mudar");
    assert.equal(resolved.label, "fonte manual, até 2026-09-16");
  });
});

describe("#8240 item 4 — buildSpendWatchDigestSection", () => {
  it("sem avisos nem projeções → seção vazia", () => {
    assert.deepEqual(buildSpendWatchDigestSection([], []), []);
  });

  it("com avisos e projeções → linhas nomeando cada braço", () => {
    const lines = buildSpendWatchDigestSection(
      [{ braco: "X", lastKnownDate: "2026-09-17", gastoAcumulado: 130, plannedCumulativeBRL: 100, ratio: 1.3 }],
      [{ braco: "Y", crossesOn: "2026-09-23", fimJanela: "2026-09-27", nominalTotalBRL: 1500, ritmoUsadoBRL: 200 }],
    );
    assert.ok(lines.some((l) => l.includes("X") && l.includes("1.30")));
    assert.ok(lines.some((l) => l.includes("Y") && l.includes("2026-09-23") && l.includes("2026-09-27")));
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

/**
 * #7577 — `cadastros_acumulado` é o NUMERADOR do CAC da janela móvel de 3 dias
 * (`scripts/lib/ads-rolling-window.ts`).
 *
 * A coluna existia no CSV desde o início do teste e nada a parseava; a #7577
 * passou a lê-la. O review da PR #7586 apontou que a mudança tinha entrado sem
 * teste NENHUM no parser — os testes da janela constroem `ClicksCsvRow` à mão e
 * pulam `parseClicksCsv` inteiro, então um erro aqui (nome de chave trocado,
 * validação frouxa) passaria por todos eles. A coluna irmã `leitores_acumulado`
 * ganhou exatamente estes quatro casos quando entrou (#5239).
 */
describe("#7577 — parseClicksCsv: coluna 'cadastros_acumulado'", () => {
  const HEADER_BASE = "canal,data_apuracao,gasto_acumulado,cliques,impressoes,cpc_medio,conversoes,custo_por_conversao,perda_orcamento,perda_ranking,fonte";
  const HEADER_COM = `${HEADER_BASE},cadastros_acumulado\n`;

  it("coluna AUSENTE do header -> null, nunca erro", () => {
    const csv = `${HEADER_BASE}\n` + "Google Ads (teste 2608),2026-09-04,190.00,10,1000,7.1,1,71.43,,,painel\n";
    const { rows, errors } = parseClicksCsv(csv);
    assert.equal(errors.length, 0);
    assert.equal(rows[0].cadastrosAcumulado, null);
  });

  it("presente e preenchida -> número", () => {
    const csv = HEADER_COM + "Google Ads (teste 2608),2026-09-04,190.00,10,1000,7.1,1,71.43,,,painel,25\n";
    const { rows, errors } = parseClicksCsv(csv);
    assert.equal(errors.length, 0);
    assert.equal(rows[0].cadastrosAcumulado, 25);
  });

  it("presente e VAZIA na linha -> null (sem amostra), e a linha continua válida", () => {
    // A linha ainda serve pro watchdog de gasto — perder `gasto_acumulado` por
    // causa de uma coluna opcional em branco seria pior que não ter a coluna.
    const csv = HEADER_COM + "Google Ads (teste 2608),2026-09-04,190.00,10,1000,7.1,1,71.43,,,painel,\n";
    const { rows, errors } = parseClicksCsv(csv);
    assert.equal(errors.length, 0);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].cadastrosAcumulado, null);
    assert.equal(rows[0].gasto_acumulado, 190);
  });

  it("valor NÃO-NUMÉRICO é erro da linha — nunca coagido em silêncio", () => {
    const csv = HEADER_COM + "Google Ads (teste 2608),2026-09-04,190.00,10,1000,7.1,1,71.43,,,painel,vinte\n";
    const { rows, errors } = parseClicksCsv(csv);
    assert.equal(rows.length, 0);
    assert.equal(errors.length, 1);
    assert.match(errors[0].reason, /cadastros_acumulado/);
  });

  it("valor NEGATIVO é erro — acumulado de cadastros não pode ser negativo", () => {
    const csv = HEADER_COM + "Google Ads (teste 2608),2026-09-04,190.00,10,1000,7.1,1,71.43,,,painel,-3\n";
    const { rows, errors } = parseClicksCsv(csv);
    assert.equal(rows.length, 0);
    assert.equal(errors.length, 1);
    assert.match(errors[0].reason, /cadastros_acumulado/);
  });

  it("zero é valor VÁLIDO, distinto de vazio", () => {
    // `0` significa "medido, nenhum cadastro"; vazio significa "não medido".
    // Colapsar os dois é o erro que a §3.5 do protocolo proíbe.
    const csv = HEADER_COM + "Microsoft Ads (teste 2608),2026-09-04,1.34,2,80,0.67,0,,,,painel,0\n";
    const { rows, errors } = parseClicksCsv(csv);
    assert.equal(errors.length, 0);
    assert.equal(rows[0].cadastrosAcumulado, 0);
  });
});
