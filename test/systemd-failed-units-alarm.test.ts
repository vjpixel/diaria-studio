/**
 * test/systemd-failed-units-alarm.test.ts (#5563)
 *
 * Lógica pura de `scripts/lib/systemd-failed-units-alarm.ts` + `toAlarmFinding`
 * de `scripts/systemd-failed-units-alarm.ts`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseSystemctlListUnitsFailedOutput,
  evaluateSystemdFailedUnits,
  isAlarmingVerdict,
  shouldSendSystemdFailedUnitsAlarm,
  markSystemdFailedUnitsAlarmed,
  emptySystemdFailedUnitsAlarmState,
  buildSystemdFailedUnitsAlarmEmail,
} from "../scripts/lib/systemd-failed-units-alarm.ts";
import { toAlarmFinding } from "../scripts/systemd-failed-units-alarm.ts";

describe("toAlarmFinding — family obrigatório (#5553/#5557)", () => {
  it("family é sempre 'estado' (condição re-checável a cada sweep — some quando o operador conserta)", () => {
    assert.equal(toAlarmFinding("diaria-edicao-diaria.service").family, "estado");
  });

  it("fingerprint é o nome exato da unit — 1 finding por unit, não agregado", () => {
    const f = toAlarmFinding("diaria-edicao-diaria.service");
    assert.equal(f.check, "systemd-failed-units");
    assert.equal(f.fingerprint, "diaria-edicao-diaria.service");
    assert.equal(f.priority, "P1");
  });
});

describe("parseSystemctlListUnitsFailedOutput", () => {
  it("cenário real do #5563: 1 unit failed, --plain --no-legend", () => {
    const stdout = "diaria-edicao-diaria.service loaded failed failed edicao diaria agendada\n";
    assert.deepEqual(parseSystemctlListUnitsFailedOutput(stdout), ["diaria-edicao-diaria.service"]);
  });

  it("múltiplas units failed, cada uma numa linha", () => {
    const stdout =
      "diaria-edicao-diaria.service loaded failed failed edicao\n" +
      "diaria-cursos-error-alarm.service loaded failed failed alarme\n";
    assert.deepEqual(parseSystemctlListUnitsFailedOutput(stdout), [
      "diaria-edicao-diaria.service",
      "diaria-cursos-error-alarm.service",
    ]);
  });

  it("saída vazia (--no-legend, nenhuma unit failed) → array vazio", () => {
    assert.deepEqual(parseSystemctlListUnitsFailedOutput(""), []);
  });

  it("tolera glyph de árvore residual como 1º token (fallback se --plain não for honrado)", () => {
    const stdout = "● diaria-edicao-diaria.service loaded failed failed edicao\n";
    assert.deepEqual(parseSystemctlListUnitsFailedOutput(stdout), ["diaria-edicao-diaria.service"]);
  });

  it("ignora linhas em branco", () => {
    const stdout = "\n\ndiaria-edicao-diaria.service loaded failed failed edicao\n\n";
    assert.deepEqual(parseSystemctlListUnitsFailedOutput(stdout), ["diaria-edicao-diaria.service"]);
  });
});

describe("evaluateSystemdFailedUnits", () => {
  it("lista vazia → ok", () => {
    assert.deepEqual(evaluateSystemdFailedUnits([]), { verdict: "ok", failedUnits: [] });
  });

  it("1+ units failed → alarm-failed-units, lista ORDENADA independente da ordem de entrada", () => {
    const ev = evaluateSystemdFailedUnits(["diaria-z.service", "diaria-a.service"]);
    assert.equal(ev.verdict, "alarm-failed-units");
    assert.deepEqual(ev.failedUnits, ["diaria-a.service", "diaria-z.service"]);
  });
});

describe("isAlarmingVerdict", () => {
  it("ok → false, alarm-failed-units → true", () => {
    assert.equal(isAlarmingVerdict("ok"), false);
    assert.equal(isAlarmingVerdict("alarm-failed-units"), true);
  });
});

describe("shouldSendSystemdFailedUnitsAlarm — idempotência por CONJUNTO", () => {
  it("verdict ok nunca alarma", () => {
    assert.equal(
      shouldSendSystemdFailedUnitsAlarm({ verdict: "ok", failedUnits: [] }, emptySystemdFailedUnitsAlarmState()),
      false,
    );
  });

  it("1ª detecção (state vazio) alarma", () => {
    const ev = evaluateSystemdFailedUnits(["diaria-a.service"]);
    assert.equal(shouldSendSystemdFailedUnitsAlarm(ev, emptySystemdFailedUnitsAlarmState()), true);
  });

  it("mesmo conjunto já alarmado não reenvia", () => {
    const ev = evaluateSystemdFailedUnits(["diaria-a.service", "diaria-b.service"]);
    const state = markSystemdFailedUnitsAlarmed(["diaria-b.service", "diaria-a.service"]);
    assert.equal(shouldSendSystemdFailedUnitsAlarm(ev, state), false);
  });

  it("conjunto MUDOU (unit nova falhou) reenvia mesmo com sobreposição parcial", () => {
    const ev = evaluateSystemdFailedUnits(["diaria-a.service", "diaria-c.service"]);
    const state = markSystemdFailedUnitsAlarmed(["diaria-a.service", "diaria-b.service"]);
    assert.equal(shouldSendSystemdFailedUnitsAlarm(ev, state), true);
  });

  it("conjunto encolheu (uma unit consertada, outra ainda falha) reenvia", () => {
    const ev = evaluateSystemdFailedUnits(["diaria-a.service"]);
    const state = markSystemdFailedUnitsAlarmed(["diaria-a.service", "diaria-b.service"]);
    assert.equal(shouldSendSystemdFailedUnitsAlarm(ev, state), true);
  });
});

describe("buildSystemdFailedUnitsAlarmEmail", () => {
  it("lista as units no assunto e no corpo", () => {
    const ev = evaluateSystemdFailedUnits(["diaria-edicao-diaria.service"]);
    const { subject, body } = buildSystemdFailedUnitsAlarmEmail(ev, "");
    assert.match(subject, /diaria-edicao-diaria\.service/);
    assert.match(body, /diaria-edicao-diaria\.service/);
    assert.match(body, /journalctl --user -u/);
  });

  it("inclui issueLines quando fornecido", () => {
    const ev = evaluateSystemdFailedUnits(["diaria-a.service"]);
    const { body } = buildSystemdFailedUnitsAlarmEmail(ev, "\n\nIssues:\n  - #999 (https://x)");
    assert.match(body, /#999/);
  });
});
