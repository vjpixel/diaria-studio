/**
 * test/beehiiv-backup-staleness-alarm.test.ts (#5494)
 *
 * Cobertura da lógica pura do alarme de staleness do snapshot semanal
 * `Diaria-Beehiiv-Backup`: dois motivos de alarme (stale/unusable), o caso
 * "nenhum snapshot ainda" (missing vs too-early), e a idempotência por
 * fingerprint.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateBeehiivBackupStalenessAlarm,
  computeBeehiivBackupStalenessFingerprint,
  shouldSendBeehiivBackupStalenessAlarm,
  markBeehiivBackupStalenessAlarmed,
  emptyBeehiivBackupStalenessAlarmState,
  buildBeehiivBackupStalenessAlarmEmail,
  isAlarmVerdict,
} from "../scripts/lib/beehiiv-backup-staleness-alarm.ts";

const DAY = 86400;
const NOW = 1_755_000_000; // época fixa arbitrária pros testes

describe("evaluateBeehiivBackupStalenessAlarm", () => {
  it("snapshot recente e utilizável → ok", () => {
    const evaluation = evaluateBeehiivBackupStalenessAlarm(NOW, "2026-08-16", NOW - 2 * DAY, true, 7);
    assert.equal(evaluation.verdict, "ok");
  });

  it("snapshot com mais de maxAgeDays → alarm-stale", () => {
    const evaluation = evaluateBeehiivBackupStalenessAlarm(NOW, "2026-08-01", NOW - 15 * DAY, true, 7);
    assert.equal(evaluation.verdict, "alarm-stale");
    assert.ok(evaluation.ageDays !== null && evaluation.ageDays > 7);
  });

  it("snapshot no prazo mas inutilizável (manifest error/skip, subscribers.jsonl vazio) → alarm-unusable, mesmo dentro do prazo", () => {
    const evaluation = evaluateBeehiivBackupStalenessAlarm(NOW, "2026-08-16", NOW - 1 * DAY, false, 7);
    assert.equal(evaluation.verdict, "alarm-unusable");
  });

  it("nenhum snapshot, mas ainda antes do 1º prazo esperado → ok-too-early, nunca alarm-missing", () => {
    const evaluation = evaluateBeehiivBackupStalenessAlarm(NOW, null, null, false, 7, NOW + DAY);
    assert.equal(evaluation.verdict, "ok-too-early");
  });

  it("nenhum snapshot, e já passou do 1º prazo esperado → alarm-missing", () => {
    const evaluation = evaluateBeehiivBackupStalenessAlarm(NOW, null, null, false, 7, NOW - DAY);
    assert.equal(evaluation.verdict, "alarm-missing");
  });

  it("exatamente no limite (ageDays == maxAgeDays) ainda é ok — só > maxAgeDays alarma", () => {
    const evaluation = evaluateBeehiivBackupStalenessAlarm(NOW, "2026-08-09", NOW - 7 * DAY, true, 7);
    assert.equal(evaluation.verdict, "ok");
  });
});

describe("isAlarmVerdict", () => {
  it("ok e ok-too-early não são alarme; os 3 alarm-* são", () => {
    assert.equal(isAlarmVerdict("ok"), false);
    assert.equal(isAlarmVerdict("ok-too-early"), false);
    assert.equal(isAlarmVerdict("alarm-stale"), true);
    assert.equal(isAlarmVerdict("alarm-unusable"), true);
    assert.equal(isAlarmVerdict("alarm-missing"), true);
  });
});

describe("idempotência (fingerprint + should-send)", () => {
  it("nunca envia pra veredito ok/ok-too-early", () => {
    const ok = evaluateBeehiivBackupStalenessAlarm(NOW, "2026-08-16", NOW - 1 * DAY, true, 7);
    assert.equal(shouldSendBeehiivBackupStalenessAlarm(ok, emptyBeehiivBackupStalenessAlarmState()), false);
  });

  it("envia na 1ª vez que um alarme aparece, e não reenvia o MESMO veredito+snapshot", () => {
    const stale = evaluateBeehiivBackupStalenessAlarm(NOW, "2026-08-01", NOW - 15 * DAY, true, 7);
    assert.equal(shouldSendBeehiivBackupStalenessAlarm(stale, emptyBeehiivBackupStalenessAlarmState()), true);
    const nextState = markBeehiivBackupStalenessAlarmed(stale);
    assert.equal(shouldSendBeehiivBackupStalenessAlarm(stale, nextState), false);
  });

  it("reenvia se o veredito mudar (ex.: unusable → stale) mesmo pro mesmo snapshot", () => {
    const unusable = evaluateBeehiivBackupStalenessAlarm(NOW, "2026-08-01", NOW - 1 * DAY, false, 7);
    const state = markBeehiivBackupStalenessAlarmed(unusable);
    const staleLater = evaluateBeehiivBackupStalenessAlarm(NOW + 10 * DAY, "2026-08-01", NOW - 1 * DAY, true, 7);
    assert.equal(shouldSendBeehiivBackupStalenessAlarm(staleLater, state), true);
  });

  it("computeBeehiivBackupStalenessFingerprint é estável (mesmo veredito+snapshot → mesmo fingerprint)", () => {
    const a = evaluateBeehiivBackupStalenessAlarm(NOW, "2026-08-01", NOW - 15 * DAY, true, 7);
    const b = evaluateBeehiivBackupStalenessAlarm(NOW + 3600, "2026-08-01", NOW - 15 * DAY, true, 7);
    assert.equal(computeBeehiivBackupStalenessFingerprint(a), computeBeehiivBackupStalenessFingerprint(b));
  });
});

describe("buildBeehiivBackupStalenessAlarmEmail", () => {
  it("subject/body citam o veredito e a data do snapshot", () => {
    const evaluation = evaluateBeehiivBackupStalenessAlarm(NOW, "2026-08-01", NOW - 15 * DAY, true, 7);
    const { subject, body } = buildBeehiivBackupStalenessAlarmEmail(evaluation, 7);
    assert.match(subject, /alarm-stale/);
    assert.match(subject, /2026-08-01/);
    assert.match(body, /2026-08-01/);
    assert.match(body, /DELETE\+CREATE/);
  });

  it("caso alarm-missing cita 'nenhum snapshot' no body", () => {
    const evaluation = evaluateBeehiivBackupStalenessAlarm(NOW, null, null, false, 7, NOW - DAY);
    const { body } = buildBeehiivBackupStalenessAlarmEmail(evaluation, 7);
    assert.match(body, /Nenhum snapshot/);
  });
});
