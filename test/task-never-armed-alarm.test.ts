/**
 * test/task-never-armed-alarm.test.ts (#5607)
 *
 * Lógica pura de `scripts/lib/task-never-armed-alarm.ts` + `toNeverArmedFinding`/
 * `toOrphanTimerFinding` de `scripts/task-never-armed-alarm.ts`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseSystemctlListTimersOutput,
  evaluateTaskNeverArmed,
  isAlarmingVerdict,
  shouldSendTaskNeverArmedAlarm,
  markTaskNeverArmedAlarmed,
  emptyTaskNeverArmedAlarmState,
  buildTaskNeverArmedAlarmEmail,
  KNOWN_SCHEMA_EXCEPTION_UNIT_NAMES,
} from "../scripts/lib/task-never-armed-alarm.ts";
import { toNeverArmedFinding, toOrphanTimerFinding } from "../scripts/task-never-armed-alarm.ts";

describe("parseSystemctlListTimersOutput", () => {
  it("linha real de `systemctl --user list-timers --all --plain --no-legend`", () => {
    const stdout =
      "Mon 2026-08-17 22:40:00 UTC           6min Mon 2026-08-17 22:30:24 UTC   3min 3s ago diaria-overnight-watchdog.timer              diaria-overnight-watchdog.service\n";
    assert.deepEqual(parseSystemctlListTimersOutput(stdout), ["diaria-overnight-watchdog"]);
  });

  it("timer que nunca disparou (colunas LAST/PASSED = '-')", () => {
    const stdout = "Mon 2026-08-17 23:00:00 UTC          26min -                                       - diaria-entity-pages-regen.timer              diaria-entity-pages-regen.service\n";
    assert.deepEqual(parseSystemctlListTimersOutput(stdout), ["diaria-entity-pages-regen"]);
  });

  it("múltiplas linhas → múltiplos nomes-base, na ordem da saída", () => {
    const stdout =
      "Mon ... diaria-a.timer diaria-a.service\n" + "Tue ... diaria-b.timer diaria-b.service\n";
    assert.deepEqual(parseSystemctlListTimersOutput(stdout), ["diaria-a", "diaria-b"]);
  });

  it("saída vazia (--no-legend, nenhum timer) → array vazio", () => {
    assert.deepEqual(parseSystemctlListTimersOutput(""), []);
  });

  it("ignora linhas em branco", () => {
    const stdout = "\n\nMon ... diaria-a.timer diaria-a.service\n\n";
    assert.deepEqual(parseSystemctlListTimersOutput(stdout), ["diaria-a"]);
  });

  it("linha sem token `.timer` (ex: header residual) é ignorada", () => {
    const stdout = "NEXT LEFT LAST PASSED UNIT ACTIVATES\nMon ... diaria-a.timer diaria-a.service\n";
    assert.deepEqual(parseSystemctlListTimersOutput(stdout), ["diaria-a"]);
  });
});

describe("evaluateTaskNeverArmed", () => {
  it("registro vazio, sem timers armados → ok", () => {
    const ev = evaluateTaskNeverArmed([], []);
    assert.deepEqual(ev, { verdict: "ok", neverArmed: [], orphanTimers: [] });
  });

  it("toda task do registro tem timer armado correspondente → ok", () => {
    const ev = evaluateTaskNeverArmed(["Diaria-Foo-Bar"], ["diaria-foo-bar"]);
    assert.equal(ev.verdict, "ok");
  });

  it("task no registro SEM timer armado → alarm-never-armed (cenário real #5607)", () => {
    const ev = evaluateTaskNeverArmed(
      ["Diaria-Systemd-Failed-Units-Alarm", "Diaria-OneDrive-Sync-Alarm"],
      ["diaria-onedrive-sync-alarm"],
    );
    assert.equal(ev.verdict, "alarm-never-armed");
    assert.deepEqual(ev.neverArmed, ["Diaria-Systemd-Failed-Units-Alarm"]);
    assert.deepEqual(ev.orphanTimers, []);
  });

  it("timer diaria-* armado sem task no registro → alarm-orphan-timers", () => {
    const ev = evaluateTaskNeverArmed(["Diaria-Foo-Bar"], ["diaria-foo-bar", "diaria-renamed-task"]);
    assert.equal(ev.verdict, "alarm-orphan-timers");
    assert.deepEqual(ev.orphanTimers, ["diaria-renamed-task"]);
  });

  it("ambos os casos simultâneos → alarm-both", () => {
    const ev = evaluateTaskNeverArmed(["Diaria-Never-Armed"], ["diaria-orphan"]);
    assert.equal(ev.verdict, "alarm-both");
    assert.deepEqual(ev.neverArmed, ["Diaria-Never-Armed"]);
    assert.deepEqual(ev.orphanTimers, ["diaria-orphan"]);
  });

  it("allowlist (KNOWN_SCHEMA_EXCEPTION_UNIT_NAMES) nunca vira orphan — diaria-edicao-diaria e diaria-overnight-watchdog", () => {
    assert.deepEqual(KNOWN_SCHEMA_EXCEPTION_UNIT_NAMES, ["diaria-edicao-diaria", "diaria-overnight-watchdog"]);
    const ev = evaluateTaskNeverArmed([], ["diaria-edicao-diaria", "diaria-overnight-watchdog"]);
    assert.equal(ev.verdict, "ok");
  });

  it("timer fora do prefixo diaria-* nunca vira orphan (fora do escopo deste repo)", () => {
    const ev = evaluateTaskNeverArmed([], ["some-other-vendor-timer"]);
    assert.equal(ev.verdict, "ok");
  });

  it("neverArmed e orphanTimers sempre ordenados independente da ordem de entrada", () => {
    const ev = evaluateTaskNeverArmed(["Diaria-Z", "Diaria-A"], []);
    assert.deepEqual(ev.neverArmed, ["Diaria-A", "Diaria-Z"]);
  });
});

describe("isAlarmingVerdict", () => {
  it("ok → false; qualquer outro verdict → true", () => {
    assert.equal(isAlarmingVerdict("ok"), false);
    assert.equal(isAlarmingVerdict("alarm-never-armed"), true);
    assert.equal(isAlarmingVerdict("alarm-orphan-timers"), true);
    assert.equal(isAlarmingVerdict("alarm-both"), true);
  });
});

describe("shouldSendTaskNeverArmedAlarm — idempotência por CONJUNTO", () => {
  it("verdict ok nunca alarma", () => {
    const ev = evaluateTaskNeverArmed([], []);
    assert.equal(shouldSendTaskNeverArmedAlarm(ev, emptyTaskNeverArmedAlarmState()), false);
  });

  it("1ª detecção (state vazio) alarma", () => {
    const ev = evaluateTaskNeverArmed(["Diaria-A"], []);
    assert.equal(shouldSendTaskNeverArmedAlarm(ev, emptyTaskNeverArmedAlarmState()), true);
  });

  it("mesmo conjunto já alarmado não reenvia", () => {
    const ev = evaluateTaskNeverArmed(["Diaria-A"], []);
    const state = markTaskNeverArmedAlarmed(ev);
    assert.equal(shouldSendTaskNeverArmedAlarm(ev, state), false);
  });

  it("conjunto neverArmed mudou → reenvia", () => {
    const state = markTaskNeverArmedAlarmed(evaluateTaskNeverArmed(["Diaria-A"], []));
    const ev2 = evaluateTaskNeverArmed(["Diaria-A", "Diaria-B"], []);
    assert.equal(shouldSendTaskNeverArmedAlarm(ev2, state), true);
  });

  it("neverArmed estável mas orphanTimers mudou → reenvia", () => {
    const state = markTaskNeverArmedAlarmed(evaluateTaskNeverArmed(["Diaria-A"], ["diaria-orphan-1"]));
    const ev2 = evaluateTaskNeverArmed(["Diaria-A"], ["diaria-orphan-1", "diaria-orphan-2"]);
    assert.equal(shouldSendTaskNeverArmedAlarm(ev2, state), true);
  });
});

describe("buildTaskNeverArmedAlarmEmail", () => {
  it("lista neverArmed no assunto e corpo quando presente", () => {
    const ev = evaluateTaskNeverArmed(["Diaria-Foo"], []);
    const { subject, body } = buildTaskNeverArmedAlarmEmail(ev, "");
    assert.match(subject, /1 task\(s\) nunca armada\(s\)/);
    assert.match(body, /Diaria-Foo/);
  });

  it("lista orphanTimers no assunto e corpo quando presente", () => {
    const ev = evaluateTaskNeverArmed([], ["diaria-orphan"]);
    const { subject, body } = buildTaskNeverArmedAlarmEmail(ev, "");
    assert.match(subject, /1 timer\(s\) órfão\(s\)/);
    assert.match(body, /diaria-orphan\.timer/);
  });

  it("inclui issueLines quando fornecido", () => {
    const ev = evaluateTaskNeverArmed(["Diaria-Foo"], []);
    const { body } = buildTaskNeverArmedAlarmEmail(ev, "\n\nIssues:\n  - #999 (https://x)");
    assert.match(body, /#999/);
  });
});

describe("toNeverArmedFinding / toOrphanTimerFinding", () => {
  it("toNeverArmedFinding: family 'estado', priority P1, fingerprint = TaskName exato", () => {
    const f = toNeverArmedFinding("Diaria-Foo-Bar");
    assert.equal(f.family, "estado");
    assert.equal(f.priority, "P1");
    assert.equal(f.fingerprint, "Diaria-Foo-Bar");
    assert.equal(f.check, "task-never-armed");
  });

  it("toOrphanTimerFinding: family 'estado', priority P3 (alarme mais fraco)", () => {
    const f = toOrphanTimerFinding("diaria-orphan");
    assert.equal(f.family, "estado");
    assert.equal(f.priority, "P3");
    assert.equal(f.fingerprint, "diaria-orphan");
    assert.equal(f.check, "task-never-armed-orphan-timer");
  });
});
