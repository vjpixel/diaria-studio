/**
 * test/systemd-unit-rate-alarm.test.ts (#5765)
 *
 * Lógica pura de `scripts/lib/systemd-unit-rate-alarm.ts` +
 * `tasksToUnitsToCheck`/`toAlarmFinding` de `scripts/systemd-unit-rate-alarm.ts`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseJournalUnitOutcomes,
  evaluateUnitFailureRate,
  isAlarmingRateVerdict,
  DEFAULT_WINDOW_SIZE,
  DEFAULT_FAILURE_THRESHOLD,
  type UnitInvocationOutcome,
} from "../scripts/lib/systemd-unit-rate-alarm.ts";
import {
  tasksToUnitsToCheck,
  toAlarmFinding,
  buildAggregatedUnitRateFinding,
  SYSTEMD_UNIT_RATE_ESTREIA_AGGREGATE_THRESHOLD,
} from "../scripts/systemd-unit-rate-alarm.ts";
import { SCHEDULED_TASKS, type ScheduledTaskDefinition } from "../scripts/lib/scheduled-tasks.ts";
import { planAlarmReconciliation, emptyAlarmIssuesState, aggregateFindingsOnDebut } from "../scripts/lib/alarm-issues.ts";

const UNIT = "diaria-clarice-novos.service";

function success(): UnitInvocationOutcome {
  return { kind: "success" };
}
function failure(exitCode: number | null = 1): UnitInvocationOutcome {
  return { kind: "failure", exitCode };
}

describe("parseJournalUnitOutcomes", () => {
  it("reconhece sucesso ('Deactivated successfully.')", () => {
    const lines = [`Aug 18 09:00:05 helios systemd[1234]: ${UNIT}: Deactivated successfully.`];
    assert.deepEqual(parseJournalUnitOutcomes(lines, UNIT), [{ kind: "success" }]);
  });

  it("reconhece falha (exit exited + Failed with result) e extrai o exit code", () => {
    const lines = [
      `Aug 18 09:00:01 helios systemd[1234]: ${UNIT}: Main process exited, code=exited, status=3/n/a`,
      `Aug 18 09:00:01 helios systemd[1234]: ${UNIT}: Failed with result 'exit-code'.`,
    ];
    assert.deepEqual(parseJournalUnitOutcomes(lines, UNIT), [{ kind: "failure", exitCode: 3 }]);
  });

  it("múltiplas invocações em ordem cronológica preservada", () => {
    const lines = [
      `${UNIT}: Deactivated successfully.`,
      `${UNIT}: Main process exited, code=exited, status=1/FAILURE`,
      `${UNIT}: Failed with result 'exit-code'.`,
      `${UNIT}: Deactivated successfully.`,
    ];
    assert.deepEqual(parseJournalUnitOutcomes(lines, UNIT), [
      { kind: "success" },
      { kind: "failure", exitCode: 1 },
      { kind: "success" },
    ]);
  });

  it("'Failed with result' sem 'Main process exited' anterior → exitCode null (nunca dispensado por successExitCodes)", () => {
    const lines = [`${UNIT}: Failed with result 'exit-code'.`];
    assert.deepEqual(parseJournalUnitOutcomes(lines, UNIT), [{ kind: "failure", exitCode: null }]);
  });

  it("linhas de OUTRA unit são ignoradas (filtro por nome exato)", () => {
    const lines = [`diaria-outra-task.service: Deactivated successfully.`, `${UNIT}: Deactivated successfully.`];
    assert.deepEqual(parseJournalUnitOutcomes(lines, UNIT), [{ kind: "success" }]);
  });

  it("linhas em branco e ruído não reconhecido são ignorados", () => {
    const lines = ["", "  ", `${UNIT}: Starting...`, `${UNIT}: Deactivated successfully.`];
    assert.deepEqual(parseJournalUnitOutcomes(lines, UNIT), [{ kind: "success" }]);
  });

  it("saída vazia → array vazio", () => {
    assert.deepEqual(parseJournalUnitOutcomes([], UNIT), []);
  });
});

describe("evaluateUnitFailureRate — regra da issue: 2 de 5 falhas alarma, 1 de 5 não", () => {
  it("2 de 5 falhas na janela → alarm-rate", () => {
    const outcomes = [success(), failure(), success(), failure(), success()];
    const ev = evaluateUnitFailureRate(outcomes);
    assert.equal(ev.verdict, "alarm-rate");
    assert.equal(ev.failuresInWindow, 2);
    assert.equal(ev.windowSize, DEFAULT_WINDOW_SIZE);
    assert.equal(ev.failureThreshold, DEFAULT_FAILURE_THRESHOLD);
  });

  it("1 de 5 falhas na janela → ok, nunca alarma", () => {
    const outcomes = [success(), success(), failure(), success(), success()];
    const ev = evaluateUnitFailureRate(outcomes);
    assert.equal(ev.verdict, "ok");
    assert.equal(ev.failuresInWindow, 1);
  });

  it("0 falhas → ok", () => {
    const outcomes = [success(), success(), success(), success(), success()];
    assert.equal(evaluateUnitFailureRate(outcomes).verdict, "ok");
  });

  it("5 de 5 falhas → alarm-rate", () => {
    const outcomes = [failure(), failure(), failure(), failure(), failure()];
    const ev = evaluateUnitFailureRate(outcomes);
    assert.equal(ev.verdict, "alarm-rate");
    assert.equal(ev.failuresInWindow, 5);
  });
});

describe("evaluateUnitFailureRate — histórico insuficiente nunca alarma", () => {
  it("menos de windowSize invocações → insufficient-data, não alarm-rate mesmo com 100% de falha", () => {
    const outcomes = [failure(), failure(), failure()];
    const ev = evaluateUnitFailureRate(outcomes);
    assert.equal(ev.verdict, "insufficient-data");
    assert.equal(isAlarmingRateVerdict(ev.verdict), false);
  });

  it("histórico vazio → insufficient-data", () => {
    assert.equal(evaluateUnitFailureRate([]).verdict, "insufficient-data");
  });

  it("exatamente windowSize invocações já é suficiente pra avaliar", () => {
    const outcomes = [failure(), failure(), success(), success(), success()];
    assert.equal(evaluateUnitFailureRate(outcomes).verdict, "alarm-rate");
  });
});

describe("evaluateUnitFailureRate — só a JANELA mais recente conta (mais antiga sai)", () => {
  it("só as últimas windowSize invocações entram no cálculo — histórico anterior é descartado", () => {
    // 10 invocações: as 5 primeiras são 100% falha, as 5 últimas 100% sucesso.
    const outcomes = [
      failure(),
      failure(),
      failure(),
      failure(),
      failure(),
      success(),
      success(),
      success(),
      success(),
      success(),
    ];
    const ev = evaluateUnitFailureRate(outcomes);
    assert.equal(ev.verdict, "ok");
    assert.equal(ev.failuresInWindow, 0);
  });

  it("taxa ainda ruim numa execução isolada de recuperação → não fecha ainda (precisa de janela inteira boa)", () => {
    // Janela ruim: 2 falhas nas últimas 5 (alarma). Uma única execução nova
    // BOA desloca a janela — mas as 2 falhas anteriores continuam dentro
    // dela (janela passa a ter 6 invocações no total, últimas 5 ainda
    // carregam as 2 falhas antigas, só a mais velha saiu).
    const bad = [success(), failure(), success(), failure(), success()];
    const evBad = evaluateUnitFailureRate(bad);
    assert.equal(evBad.verdict, "alarm-rate");

    const afterOneRecoveryRun = [...bad, success()];
    const evAfterOne = evaluateUnitFailureRate(afterOneRecoveryRun);
    // janela agora é [failure, success, failure, success, success] — ainda 2 falhas
    assert.equal(evAfterOne.verdict, "alarm-rate", "1 execução boa isolada não deve resolver o achado");
    assert.equal(evAfterOne.failuresInWindow, 2);
  });

  it("taxa se recupera ao longo da janela inteira → verdict volta a 'ok'", () => {
    const bad = [success(), failure(), success(), failure(), success()];
    // 4 execuções boas subsequentes já bastam pra expulsar as 2 falhas da janela de 5.
    const recovered = [...bad, success(), success(), success(), success()];
    const ev = evaluateUnitFailureRate(recovered);
    assert.equal(ev.verdict, "ok");
    assert.equal(ev.failuresInWindow, 0);
  });
});

describe("evaluateUnitFailureRate — successExitCodes customizado é respeitado", () => {
  it("exit code declarado como 'esperado' não conta como falha pro cálculo de taxa", () => {
    // Diaria-Clarice-Novos: successExitCodes: [3] (#5743).
    const outcomes = [failure(3), failure(3), failure(3), failure(3), success()];
    const ev = evaluateUnitFailureRate(outcomes, { successExitCodes: [3] });
    assert.equal(ev.verdict, "ok");
    assert.equal(ev.failuresInWindow, 0);
  });

  it("sem successExitCodes, o MESMO histórico alarma (exit 3 tratado como falha genérica)", () => {
    const outcomes = [failure(3), failure(3), failure(3), failure(3), success()];
    const ev = evaluateUnitFailureRate(outcomes);
    assert.equal(ev.verdict, "alarm-rate");
    assert.equal(ev.failuresInWindow, 4);
  });

  it("exit code de falha REAL (fora de successExitCodes) continua contando mesmo com a lista presente", () => {
    const outcomes = [failure(3), failure(1), failure(1), success(), success()];
    const ev = evaluateUnitFailureRate(outcomes, { successExitCodes: [3] });
    // failure(3) é dispensado, os 2 failure(1) continuam contando
    assert.equal(ev.verdict, "alarm-rate");
    assert.equal(ev.failuresInWindow, 2);
  });

  it("exitCode null (journal sem 'Main process exited' reconhecido) nunca é dispensado por successExitCodes", () => {
    const outcomes = [failure(null), failure(null), success(), success(), success()];
    const ev = evaluateUnitFailureRate(outcomes, { successExitCodes: [3, 1, 2] });
    assert.equal(ev.verdict, "alarm-rate");
    assert.equal(ev.failuresInWindow, 2);
  });
});

describe("evaluateUnitFailureRate — janela/limiar customizáveis", () => {
  it("windowSize/failureThreshold diferentes do default são respeitados", () => {
    const outcomes = [failure(), failure(), failure(), success(), success(), success()];
    const ev = evaluateUnitFailureRate(outcomes, { windowSize: 3, failureThreshold: 1 });
    assert.equal(ev.windowSize, 3);
    // últimas 3 = [success, success, success]
    assert.equal(ev.verdict, "ok");
  });
});

function baseTask(overrides: Partial<ScheduledTaskDefinition> = {}): ScheduledTaskDefinition {
  return {
    name: "Diaria-Clarice-Novos",
    description: "d",
    steps: [{ key: "run", script: "scripts/clarice-novos-run.ts" }],
    logPath: "x/.log",
    schedule: { kind: "daily", hour: 9, minute: 0 },
    issue: "#5765",
    ...overrides,
  };
}

describe("tasksToUnitsToCheck", () => {
  it("deriva unit name via unitBaseName + '.service' e propaga successExitCodes", () => {
    const tasks = [baseTask({ successExitCodes: [3] })];
    const units = tasksToUnitsToCheck(tasks);
    assert.equal(units.length, 1);
    assert.equal(units[0].unitName, "diaria-clarice-novos.service");
    assert.deepEqual(units[0].successExitCodes, [3]);
  });

  it("task com rateAlarmExempt: true é excluída", () => {
    const tasks = [baseTask({ name: "Diaria-Ruidosa" }), baseTask({ name: "Diaria-Exempt", rateAlarmExempt: true })];
    const units = tasksToUnitsToCheck(tasks);
    assert.equal(units.length, 1);
    assert.equal(units[0].taskName, "Diaria-Ruidosa");
  });

  it("task sem successExitCodes propaga lista vazia (default 0-only)", () => {
    const units = tasksToUnitsToCheck([baseTask({ successExitCodes: undefined })]);
    assert.deepEqual(units[0].successExitCodes, []);
  });
});

describe("toAlarmFinding", () => {
  it("family é sempre 'estado' — a janela deslizante já implica auto-resolução coerente (ver docstring do módulo)", () => {
    const unit = { taskName: "Diaria-Clarice-Novos", unitName: UNIT, successExitCodes: [3] };
    const evaluation = evaluateUnitFailureRate([failure(), failure(), success(), success(), success()]);
    const finding = toAlarmFinding({ unit, evaluation });
    assert.equal(finding.family, "estado");
    assert.equal(finding.check, "systemd-unit-rate");
    assert.equal(finding.fingerprint, UNIT);
    assert.equal(finding.priority, "P1");
    assert.match(finding.title, /diaria-clarice-novos\.service/);
    assert.match(finding.body, /journalctl --user -u/);
  });

  it("declara group 'systemd-unit-rate' (#6572) — opt-in no mecanismo genérico de agrupamento na estreia", () => {
    const unit = { taskName: "Diaria-Clarice-Novos", unitName: UNIT, successExitCodes: [] };
    const evaluation = evaluateUnitFailureRate([failure(), failure(), success(), success(), success()]);
    const finding = toAlarmFinding({ unit, evaluation });
    assert.equal(finding.group, "systemd-unit-rate");
  });
});

describe("agrupamento genérico na estreia (#6572) — systemd-unit-rate como 2º consumidor de aggregateFindingsOnDebut", () => {
  function findingFor(unitName: string): ReturnType<typeof toAlarmFinding> {
    const unit = { taskName: unitName, unitName, successExitCodes: [] };
    const evaluation = evaluateUnitFailureRate([failure(), failure(), success(), success(), success()]);
    return toAlarmFinding({ unit, evaluation });
  }

  it("state vazio + volume ACIMA do teto → 1 finding agregado, não 1-por-unit (4 issues de 2 causas raiz, cenário do #6572)", () => {
    const units = ["a", "b", "c", "d"].map((s) => `diaria-${s}.service`);
    const perUnit = units.map(findingFor);
    assert.equal(perUnit.length, SYSTEMD_UNIT_RATE_ESTREIA_AGGREGATE_THRESHOLD + 1);

    const result = aggregateFindingsOnDebut(perUnit, {
      threshold: SYSTEMD_UNIT_RATE_ESTREIA_AGGREGATE_THRESHOLD,
      stateIsEmpty: true,
      buildAggregate: (_group, groupFindings) => buildAggregatedUnitRateFinding(groupFindings),
    });

    assert.equal(result.length, 1);
    assert.equal(result[0].check, "systemd-unit-rate");
    assert.equal(result[0].fingerprint, "estreia-aggregate");
    for (const u of units) assert.match(result[0].body, new RegExp(u.replace(/\./g, "\\.")));
  });

  it("state NÃO vazio → sempre 1-por-unit, mesmo acima do teto (agregação só na estreia)", () => {
    const units = ["a", "b", "c", "d"].map((s) => `diaria-${s}.service`);
    const perUnit = units.map(findingFor);

    const result = aggregateFindingsOnDebut(perUnit, {
      threshold: SYSTEMD_UNIT_RATE_ESTREIA_AGGREGATE_THRESHOLD,
      stateIsEmpty: false,
      buildAggregate: (_group, groupFindings) => buildAggregatedUnitRateFinding(groupFindings),
    });

    assert.equal(result.length, units.length);
  });

  it("state vazio + volume NO/abaixo do teto → continua 1-por-unit (comportamento preservado)", () => {
    const units = ["a", "b", "c"].map((s) => `diaria-${s}.service`);
    const perUnit = units.map(findingFor);
    assert.equal(perUnit.length, SYSTEMD_UNIT_RATE_ESTREIA_AGGREGATE_THRESHOLD);

    const result = aggregateFindingsOnDebut(perUnit, {
      threshold: SYSTEMD_UNIT_RATE_ESTREIA_AGGREGATE_THRESHOLD,
      stateIsEmpty: true,
      buildAggregate: (_group, groupFindings) => buildAggregatedUnitRateFinding(groupFindings),
    });

    assert.equal(result.length, units.length);
  });
});

describe("reconciliação (alarm-issues.ts) — reuso do critério de fechamento padrão é seguro aqui", () => {
  it("achado presente em pending → ensure; achado ausente (janela recuperada) → caminha pro streak de fechamento padrão", () => {
    const unit = { taskName: "Diaria-Clarice-Novos", unitName: UNIT, successExitCodes: [] };
    const badEvaluation = evaluateUnitFailureRate([success(), failure(), success(), failure(), success()]);
    const badFinding = toAlarmFinding({ unit, evaluation: badEvaluation });

    // 1ª execução: achado pendente → ensure.
    const actions1 = planAlarmReconciliation([badFinding], emptyAlarmIssuesState(), 2);
    assert.deepEqual(
      actions1.map((a) => a.kind),
      ["ensure"],
    );

    // Estado local já rastreia a issue (simulado — ensureAlarmIssue faria I/O real).
    const stateWithIssue = {
      [`${badFinding.check}:${badFinding.fingerprint}`]: {
        issueNumber: 1,
        url: "https://x/1",
        missingStreak: 0,
        closedAt: null,
        family: "estado" as const,
      },
    };

    // Janela ainda ruim (1 execução de recuperação isolada, ver teste acima) → achado continua pendente → ensure de novo, nunca close.
    const actions2 = planAlarmReconciliation([badFinding], stateWithIssue, 2);
    assert.deepEqual(
      actions2.map((a) => a.kind),
      ["ensure"],
    );

    // Janela finalmente recuperada → achado NÃO está mais em pending → mecanismo de streak do alarm-issues.ts assume a partir daqui.
    const actions3 = planAlarmReconciliation([], stateWithIssue, 2);
    assert.deepEqual(
      actions3.map((a) => a.kind),
      ["comment_resolved"],
    );
  });
});

// #6723 — REGRESSÃO: skip DEFENSIVO intencional (ex: `Diaria-Clarice-
// Guardrail-Alarm` saindo com `exit 75`/EX_TEMPFAIL — #6563 — porque decidiu
// pular a execução por cota Brevo baixa) não pode contar como falha na taxa
// e abrir issue (#6455-6458). Fio completo do registro real até o veredito:
// `SCHEDULED_TASKS` (declara `successExitCodes: [75]`) → `tasksToUnitsToCheck`
// (propaga pro `UnitToCheck`) → `parseJournalUnitOutcomes` (journal real de
// uma unit AINDA NÃO regenerada com `SuccessExitStatus=75`, #6695 — cada skip
// aparece como "Main process exited...status=75" + "Failed with result",
// journal indistinguível de falha real sem o exit code) → `evaluateUnitFailureRate`
// com esse `successExitCodes` — nenhum destes pontos deve requalificar o
// skip como falha.
describe("skip defensivo (exit code de sucesso) não conta como falha na taxa (#6723)", () => {
  const GUARDRAIL_TASK = SCHEDULED_TASKS.find((t) => t.name === "Diaria-Clarice-Guardrail-Alarm");

  it("sanity: a task real declara successExitCodes: [75] (EX_TEMPFAIL, #6563) — se isto quebrar, o teste abaixo não prova nada", () => {
    assert.ok(GUARDRAIL_TASK, "Diaria-Clarice-Guardrail-Alarm precisa existir em SCHEDULED_TASKS");
    assert.deepEqual(GUARDRAIL_TASK!.successExitCodes, [75]);
  });

  it("journal com histórico de skips (status=75) mistos a sucessos → veredito 'ok', nunca 'alarm-rate'", () => {
    const [unit] = tasksToUnitsToCheck([GUARDRAIL_TASK!]);
    const unitName = unit.unitName;
    // Journal real de uma unit AINDA sem `SuccessExitStatus=75` (#6695): todo
    // skip aparece como "Failed with result 'exit-code'" com status=75 — a
    // MESMA forma de uma falha real, só distinguível pelo exit code.
    const lines = [
      `Aug 20 06:00:01 helios systemd[1]: ${unitName}: Main process exited, code=exited, status=75/n/a`,
      `Aug 20 06:00:01 helios systemd[1]: ${unitName}: Failed with result 'exit-code'.`,
      `Aug 20 10:00:01 helios systemd[1]: ${unitName}: Deactivated successfully.`,
      `Aug 20 14:00:01 helios systemd[1]: ${unitName}: Main process exited, code=exited, status=75/n/a`,
      `Aug 20 14:00:01 helios systemd[1]: ${unitName}: Failed with result 'exit-code'.`,
      `Aug 20 18:00:01 helios systemd[1]: ${unitName}: Deactivated successfully.`,
      `Aug 20 22:00:01 helios systemd[1]: ${unitName}: Deactivated successfully.`,
    ];
    const outcomes = parseJournalUnitOutcomes(lines, unitName);
    assert.equal(outcomes.length, 5);
    assert.equal(outcomes.filter((o) => o.kind === "failure").length, 2, "2 skips aparecem no journal como 'failure' — o parse não sabe da semântica de negócio");

    const evaluation = evaluateUnitFailureRate(outcomes, { successExitCodes: unit.successExitCodes });
    assert.equal(evaluation.failuresInWindow, 0, "os 2 skips (status=75) são reclassificados como não-falha por successExitCodes");
    assert.equal(evaluation.verdict, "ok", "veredito NUNCA deve ser alarm-rate só por skip defensivo repetido");
    assert.equal(isAlarmingRateVerdict(evaluation.verdict), false);
  });

  it("mesmo journal, SEM successExitCodes (regressão do bug relatado) → os 2 skips contam como falha e alarmam — prova que o teste acima exercita o mecanismo de verdade", () => {
    const [unit] = tasksToUnitsToCheck([GUARDRAIL_TASK!]);
    const unitName = unit.unitName;
    const lines = [
      `Aug 20 06:00:01 helios systemd[1]: ${unitName}: Main process exited, code=exited, status=75/n/a`,
      `Aug 20 06:00:01 helios systemd[1]: ${unitName}: Failed with result 'exit-code'.`,
      `Aug 20 10:00:01 helios systemd[1]: ${unitName}: Deactivated successfully.`,
      `Aug 20 14:00:01 helios systemd[1]: ${unitName}: Main process exited, code=exited, status=75/n/a`,
      `Aug 20 14:00:01 helios systemd[1]: ${unitName}: Failed with result 'exit-code'.`,
      `Aug 20 18:00:01 helios systemd[1]: ${unitName}: Deactivated successfully.`,
      `Aug 20 22:00:01 helios systemd[1]: ${unitName}: Deactivated successfully.`,
    ];
    const outcomes = parseJournalUnitOutcomes(lines, unitName);
    const evaluationWithoutSuccessCodes = evaluateUnitFailureRate(outcomes, { successExitCodes: [] });
    assert.equal(evaluationWithoutSuccessCodes.failuresInWindow, 2);
    assert.equal(evaluationWithoutSuccessCodes.verdict, "alarm-rate");
  });

  it("unit JÁ regenerada com SuccessExitStatus=75 (#6695 concluído): journal nem loga 'Failed' — skip vira 'Deactivated successfully' puro, sem depender de successExitCodes", () => {
    const [unit] = tasksToUnitsToCheck([GUARDRAIL_TASK!]);
    const unitName = unit.unitName;
    const lines = Array.from(
      { length: 5 },
      (_, i) => `Aug 2${i} 06:00:01 helios systemd[1]: ${unitName}: Deactivated successfully.`,
    );
    const outcomes = parseJournalUnitOutcomes(lines, unitName);
    const evaluation = evaluateUnitFailureRate(outcomes, { successExitCodes: unit.successExitCodes });
    assert.equal(evaluation.failuresInWindow, 0);
    assert.equal(evaluation.verdict, "ok");
  });
});
