/**
 * test/edicao-diaria-staleness-alarm.test.ts (#5563)
 *
 * Lógica pura de `scripts/lib/edicao-diaria-staleness-alarm.ts` +
 * `toAlarmFinding` de `scripts/edicao-diaria-staleness-alarm.ts`. Cobre o
 * cenário real da issue: `diaria-edicao-diaria.service` falhou 4x em
 * silêncio (`spawnSync claude ENOENT`) e nada avisou — o guard de
 * idempotência tornava "não rodou" e "rodou e pulou" indistinguíveis por
 * inspeção do diretório de edições.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseOvernightScheduleLogLine,
  findLastEdicaoLogEntry,
  isEdicaoDiariaScheduledWeekday,
  evaluateEdicaoDiariaStaleness,
  isAlarmingVerdict,
  shouldSendEdicaoDiariaStalenessAlarm,
  markEdicaoDiariaStalenessAlarmed,
  emptyEdicaoDiariaStalenessAlarmState,
  buildEdicaoDiariaStalenessAlarmEmail,
} from "../scripts/lib/edicao-diaria-staleness-alarm.ts";
import { toAlarmFinding } from "../scripts/edicao-diaria-staleness-alarm.ts";

describe("toAlarmFinding — family obrigatório (#5553/#5557)", () => {
  it("family é sempre 'estado' (rechecado diariamente por AAMMDD — mesma classificação do LinkedIn semanal, #5497)", () => {
    const f = toAlarmFinding({ verdict: "alarm-never-fired", aammdd: "260901" });
    assert.equal(f.family, "estado");
    assert.equal(f.fingerprint, "260901");
    assert.equal(f.priority, "P1");
  });
});

describe("parseOvernightScheduleLogLine", () => {
  it("START", () => {
    const e = parseOvernightScheduleLogLine("2026-08-17T16:00:01-03:00 | START edition=260818 pid=12345");
    assert.deepEqual(e, { timestampIso: "2026-08-17T16:00:01-03:00", status: "START", edition: "260818" });
  });

  it("OK", () => {
    const e = parseOvernightScheduleLogLine(
      "2026-08-17T17:30:00-03:00 | OK    edition=260818 exit=0 end=2026-08-17T17:30:00-03:00",
    );
    assert.equal(e?.status, "OK");
    assert.equal(e?.edition, "260818");
  });

  it("FAIL — cenário real do #5563 (spawnSync claude ENOENT)", () => {
    const e = parseOvernightScheduleLogLine(
      "2026-08-11T16:00:03-03:00 | FAIL  edition=260812 exit=1 end=... tail=spawnSync claude ENOENT",
    );
    assert.equal(e?.status, "FAIL");
    assert.equal(e?.edition, "260812");
  });

  it("SKIP", () => {
    const e = parseOvernightScheduleLogLine(
      "2026-08-17T16:00:02-03:00 | SKIP  edition=260818 reason=already-started end=...",
    );
    assert.equal(e?.status, "SKIP");
  });

  it("linha que não bate o formato (ex: em branco) → null", () => {
    assert.equal(parseOvernightScheduleLogLine(""), null);
    assert.equal(parseOvernightScheduleLogLine("algum log de outra origem"), null);
  });
});

describe("findLastEdicaoLogEntry", () => {
  const lines = [
    "2026-08-17T16:00:01-03:00 | START edition=260818 pid=1",
    "2026-08-17T16:00:02-03:00 | SKIP  edition=260818 reason=already-started end=...",
    "2026-08-16T16:00:01-03:00 | START edition=260817 pid=2",
    "2026-08-16T16:05:00-03:00 | FAIL  edition=260817 exit=1 end=...",
  ];

  it("retorna a última entrada da edição pedida (não a última linha do arquivo)", () => {
    const e = findLastEdicaoLogEntry(lines, "260817");
    assert.equal(e?.status, "FAIL");
  });

  it("edição ausente do log → null (sinal de 'nunca disparou')", () => {
    assert.equal(findLastEdicaoLogEntry(lines, "260901"), null);
  });

  it("múltiplas entradas pra mesma edição → pega a mais recente (SKIP, não START)", () => {
    const e = findLastEdicaoLogEntry(lines, "260818");
    assert.equal(e?.status, "SKIP");
  });
});

describe("isEdicaoDiariaScheduledWeekday", () => {
  it("domingo a quinta → true (janela do timer)", () => {
    // 2026-08-16 é domingo, 2026-08-20 é quinta (BRT).
    assert.equal(isEdicaoDiariaScheduledWeekday(new Date("2026-08-16T18:00:00-03:00")), true);
    assert.equal(isEdicaoDiariaScheduledWeekday(new Date("2026-08-20T18:00:00-03:00")), true);
  });

  it("sexta e sábado → false (sem disparo)", () => {
    // 2026-08-21 é sexta, 2026-08-22 é sábado (BRT).
    assert.equal(isEdicaoDiariaScheduledWeekday(new Date("2026-08-21T18:00:00-03:00")), false);
    assert.equal(isEdicaoDiariaScheduledWeekday(new Date("2026-08-22T18:00:00-03:00")), false);
  });
});

describe("evaluateEdicaoDiariaStaleness", () => {
  const now = new Date("2026-08-17T18:20:00-03:00");

  it("dia não-agendado (sexta/sábado) → not-applicable, mesmo sem edição/log", () => {
    const ev = evaluateEdicaoDiariaStaleness("260819", false, false, null, now);
    assert.equal(ev.verdict, "not-applicable");
  });

  it("edição existe → ok (sucesso do pipeline)", () => {
    const ev = evaluateEdicaoDiariaStaleness("260818", true, true, null, now);
    assert.equal(ev.verdict, "ok");
  });

  it("edição existe mesmo com SKIP no log (idempotência — editor iniciou à mão) → ok, NUNCA alarma", () => {
    const skip = { timestampIso: "2026-08-17T16:00:02-03:00", status: "SKIP" as const, edition: "260818" };
    const ev = evaluateEdicaoDiariaStaleness("260818", true, true, skip, now);
    assert.equal(ev.verdict, "ok");
    assert.equal(isAlarmingVerdict(ev.verdict), false);
  });

  it("sem edição, sem NENHUMA linha no log → alarm-never-fired (timer não disparou)", () => {
    const ev = evaluateEdicaoDiariaStaleness("260818", true, false, null, now);
    assert.equal(ev.verdict, "alarm-never-fired");
    assert.equal(isAlarmingVerdict(ev.verdict), true);
  });

  it("sem edição, última entrada FAIL → alarm-failed (cenário real do #5563)", () => {
    const fail = { timestampIso: "2026-08-17T16:00:03-03:00", status: "FAIL" as const, edition: "260818" };
    const ev = evaluateEdicaoDiariaStaleness("260818", true, false, fail, now);
    assert.equal(ev.verdict, "alarm-failed");
  });

  it("sem edição, START recente (dentro de 3h) → in-progress, NÃO alarma (run ainda rodando)", () => {
    const start = { timestampIso: "2026-08-17T16:30:00-03:00", status: "START" as const, edition: "260818" };
    // now = 18:20, START às 16:30 → 1h50 de idade, dentro da margem de 3h.
    const ev = evaluateEdicaoDiariaStaleness("260818", true, false, start, now);
    assert.equal(ev.verdict, "in-progress");
    assert.equal(isAlarmingVerdict(ev.verdict), false);
  });

  it("sem edição, START MUITO antigo (além de 3h) → alarm-failed (run travada)", () => {
    const start = { timestampIso: "2026-08-17T14:00:00-03:00", status: "START" as const, edition: "260818" };
    const ev = evaluateEdicaoDiariaStaleness("260818", true, false, start, now);
    assert.equal(ev.verdict, "alarm-failed");
  });

  it("sem edição, última entrada SKIP → alarm-inconsistent (estado incoerente, alarma conservador)", () => {
    const skip = { timestampIso: "2026-08-17T16:00:02-03:00", status: "SKIP" as const, edition: "260818" };
    const ev = evaluateEdicaoDiariaStaleness("260818", true, false, skip, now);
    assert.equal(ev.verdict, "alarm-inconsistent");
    assert.equal(isAlarmingVerdict(ev.verdict), true);
  });
});

describe("shouldSendEdicaoDiariaStalenessAlarm — idempotência por edição, fecha sozinho no dia seguinte", () => {
  it("verdict ok/not-applicable/in-progress nunca alarma", () => {
    const state = emptyEdicaoDiariaStalenessAlarmState();
    assert.equal(shouldSendEdicaoDiariaStalenessAlarm({ verdict: "ok", aammdd: "260818" }, state), false);
    assert.equal(shouldSendEdicaoDiariaStalenessAlarm({ verdict: "not-applicable", aammdd: "260819" }, state), false);
    assert.equal(shouldSendEdicaoDiariaStalenessAlarm({ verdict: "in-progress", aammdd: "260818" }, state), false);
  });

  it("1ª detecção alarma", () => {
    const ev = { verdict: "alarm-never-fired" as const, aammdd: "260818" };
    assert.equal(shouldSendEdicaoDiariaStalenessAlarm(ev, emptyEdicaoDiariaStalenessAlarmState()), true);
  });

  it("mesma edição já alarmada não reenvia (mesmo se o verdict mudou dentro do mesmo dia)", () => {
    const state = markEdicaoDiariaStalenessAlarmed("260818");
    assert.equal(shouldSendEdicaoDiariaStalenessAlarm({ verdict: "alarm-failed", aammdd: "260818" }, state), false);
  });

  it("edição NOVA (dia seguinte) reabre o alarme mesmo com state antigo — fecha sozinho (#5563)", () => {
    const state = markEdicaoDiariaStalenessAlarmed("260818");
    const ev = { verdict: "alarm-never-fired" as const, aammdd: "260819" };
    assert.equal(shouldSendEdicaoDiariaStalenessAlarm(ev, state), true);
  });
});

describe("buildEdicaoDiariaStalenessAlarmEmail", () => {
  it("mensagem distinta pra never-fired vs failed", () => {
    const neverFired = buildEdicaoDiariaStalenessAlarmEmail({ verdict: "alarm-never-fired", aammdd: "260818" });
    const failed = buildEdicaoDiariaStalenessAlarmEmail({ verdict: "alarm-failed", aammdd: "260818" });
    assert.match(neverFired.body, /não disparou/);
    assert.match(failed.body, /FAIL/);
    assert.notEqual(neverFired.body, failed.body);
  });

  it("inclui a issue quando issueRef é fornecido", () => {
    const { body } = buildEdicaoDiariaStalenessAlarmEmail(
      { verdict: "alarm-never-fired", aammdd: "260818" },
      { issueNumber: 9999, url: "https://github.com/x/y/issues/9999", action: "created" },
    );
    assert.match(body, /#9999/);
  });
});
