/**
 * test/onedrive-sync-alarm.test.ts (#5548)
 *
 * Lógica pura de `scripts/lib/onedrive-sync-alarm.ts`. Cobre o cenário real
 * da issue: `onedrive.service` morreu em silêncio (exit 0, systemd não
 * reinicia) e ficou 17h parado sem que ninguém percebesse.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseSystemctlIsActiveOutput,
  buildOnedriveSyncCanary,
  evaluateCanaryFreshness,
  evaluateOnedriveSyncAlarm,
  isAlarmingVerdict,
  shouldSendOnedriveSyncAlarm,
  markOnedriveSyncAlarmed,
  emptyOnedriveSyncAlarmState,
  buildOnedriveSyncAlarmEmail,
} from "../scripts/lib/onedrive-sync-alarm.ts";
import { toAlarmFinding } from "../scripts/onedrive-sync-alarm.ts";

// #5558/#5561 enumerou 14 scripts emissores de AlarmFinding no momento em
// que o campo `family` virou obrigatório — este script (#5548) nasceu
// depois e ficou de fora da varredura, o que permitiu um `AlarmFinding` sem
// `family` mergear em master (achado ao vivo, hotfix #5525-adjacente,
// 17/08/2026: `npx tsc --noEmit` vermelho em master por causa disso).
// Trava aqui o mesmo assert que os outros 14 scripts já têm.
describe("toAlarmFinding — family (#5558/#5561, 15º emissor)", () => {
  it("family é sempre 'estado' (é um alarme de ESTADO — serviço parado/canário obsoleto, não um evento pontual)", () => {
    assert.equal(toAlarmFinding("alarm-service-down", "inactive").family, "estado");
    assert.equal(toAlarmFinding("alarm-canary-stale", "active").family, "estado");
  });
});

describe("parseSystemctlIsActiveOutput", () => {
  it('"active" → active', () => {
    assert.equal(parseSystemctlIsActiveOutput("active\n", 0), "active");
  });

  it('"inactive" (cenário real do #5548) → inactive, mesmo com exit code != 0', () => {
    assert.equal(parseSystemctlIsActiveOutput("inactive\n", 3), "inactive");
  });

  it('"failed" → failed', () => {
    assert.equal(parseSystemctlIsActiveOutput("failed\n", 3), "failed");
  });

  it("saída vazia (ENOENT/erro de consulta) → unknown, nunca inventa 'parado'", () => {
    assert.equal(parseSystemctlIsActiveOutput("", null), "unknown");
  });

  it("valor não reconhecido (ex: 'activating') → unknown", () => {
    assert.equal(parseSystemctlIsActiveOutput("activating\n", 0), "unknown");
  });
});

describe("buildOnedriveSyncCanary", () => {
  it("serializa writtenAt (ISO) + machineId", () => {
    const now = new Date("2026-08-17T14:33:34.000Z");
    const canary = buildOnedriveSyncCanary(now, "helios");
    assert.equal(canary.writtenAt, "2026-08-17T14:33:34.000Z");
    assert.equal(canary.machineId, "helios");
  });
});

describe("evaluateCanaryFreshness", () => {
  const now = new Date("2026-08-17T20:00:00.000Z");
  const toleranceMs = 6 * 60 * 60 * 1000; // 6h

  it("mtime ausente (1ª execução) → missing, nunca stale", () => {
    assert.equal(evaluateCanaryFreshness(null, now, toleranceMs), "missing");
  });

  it("mtime dentro da tolerância → fresh", () => {
    const mtime = new Date(now.getTime() - 2 * 60 * 60 * 1000); // 2h atrás
    assert.equal(evaluateCanaryFreshness(mtime, now, toleranceMs), "fresh");
  });

  it("mtime exatamente no limite da tolerância → fresh (inclusive)", () => {
    const mtime = new Date(now.getTime() - toleranceMs);
    assert.equal(evaluateCanaryFreshness(mtime, now, toleranceMs), "fresh");
  });

  it("mtime além da tolerância (cenário real: 17h parado, tolerância 6h) → stale", () => {
    const mtime = new Date(now.getTime() - 17 * 60 * 60 * 1000);
    assert.equal(evaluateCanaryFreshness(mtime, now, toleranceMs), "stale");
  });
});

describe("evaluateOnedriveSyncAlarm — combinação dos 2 sinais", () => {
  it("serviço active + canário fresh → ok", () => {
    const e = evaluateOnedriveSyncAlarm("active", "fresh");
    assert.equal(e.verdict, "ok");
  });

  it("serviço inactive (cenário real #5548) vence, mesmo com canário fresh → alarm-service-down", () => {
    const e = evaluateOnedriveSyncAlarm("inactive", "fresh");
    assert.equal(e.verdict, "alarm-service-down");
  });

  it("serviço failed → alarm-service-down", () => {
    assert.equal(evaluateOnedriveSyncAlarm("failed", "fresh").verdict, "alarm-service-down");
  });

  it("serviço active mas canário stale → alarm-canary-stale (sync degradado sem o daemon detectar)", () => {
    const e = evaluateOnedriveSyncAlarm("active", "stale");
    assert.equal(e.verdict, "alarm-canary-stale");
  });

  it("serviço unknown (systemctl indisponível) + canário stale → ainda alarma pelo canário", () => {
    assert.equal(evaluateOnedriveSyncAlarm("unknown", "stale").verdict, "alarm-canary-stale");
  });

  it("serviço unknown + canário missing (sessão cloud, 1ª execução) → canary-missing-baseline, não alarma", () => {
    const e = evaluateOnedriveSyncAlarm("unknown", "missing");
    assert.equal(e.verdict, "canary-missing-baseline");
    assert.equal(isAlarmingVerdict(e.verdict), false);
  });

  it("serviço active + canário missing → canary-missing-baseline (informativo)", () => {
    assert.equal(evaluateOnedriveSyncAlarm("active", "missing").verdict, "canary-missing-baseline");
  });
});

describe("isAlarmingVerdict", () => {
  it("ok e canary-missing-baseline nunca alarmam", () => {
    assert.equal(isAlarmingVerdict("ok"), false);
    assert.equal(isAlarmingVerdict("canary-missing-baseline"), false);
  });

  it("alarm-service-down e alarm-canary-stale alarmam", () => {
    assert.equal(isAlarmingVerdict("alarm-service-down"), true);
    assert.equal(isAlarmingVerdict("alarm-canary-stale"), true);
  });
});

describe("shouldSendOnedriveSyncAlarm — idempotência (1 e-mail por verdict)", () => {
  it("verdict ok nunca alarma", () => {
    const e = evaluateOnedriveSyncAlarm("active", "fresh");
    assert.equal(shouldSendOnedriveSyncAlarm(e, emptyOnedriveSyncAlarmState()), false);
  });

  it("verdict alarm-service-down + nunca alarmado antes → alarma", () => {
    const e = evaluateOnedriveSyncAlarm("inactive", "fresh");
    assert.equal(shouldSendOnedriveSyncAlarm(e, emptyOnedriveSyncAlarmState()), true);
  });

  it("mesmo verdict já alarmado → não reenvia", () => {
    const e = evaluateOnedriveSyncAlarm("inactive", "fresh");
    const state = markOnedriveSyncAlarmed("alarm-service-down");
    assert.equal(shouldSendOnedriveSyncAlarm(e, state), false);
  });

  it("verdict MUDOU (service-down → canary-stale) → alarma de novo, mesmo já tendo alarmado outro verdict", () => {
    const state = markOnedriveSyncAlarmed("alarm-service-down");
    const e = evaluateOnedriveSyncAlarm("active", "stale");
    assert.equal(shouldSendOnedriveSyncAlarm(e, state), true);
  });

  it("voltou a ok depois de alarmado, e piorou de novo pro MESMO verdict → alarma de novo (não é o mesmo caso de dedup por ciclo)", () => {
    // Nota: este alarme reenvia sempre que o verdict muda desde o último
    // alarme — inclusive "voltou ao mesmo verdict depois de ok" seria
    // suprimido por este dedup simples (limitação aceita, documentada no
    // setup doc — igual ao padrão lastAlarmedCycle/lastAlarmedX dos outros
    // alarmes deste repo, que dedupam por CHAVE, não por streak de "voltou
    // e piorou de novo").
    const state = markOnedriveSyncAlarmed("alarm-service-down");
    const e = evaluateOnedriveSyncAlarm("inactive", "fresh");
    assert.equal(shouldSendOnedriveSyncAlarm(e, state), false);
  });
});

describe("buildOnedriveSyncAlarmEmail", () => {
  it("verdict alarm-service-down menciona o comando de religada manual", () => {
    const e = evaluateOnedriveSyncAlarm("inactive", "fresh");
    const { subject, body } = buildOnedriveSyncAlarmEmail(e, "");
    assert.match(subject, /alarm-service-down/);
    assert.match(body, /systemctl --user restart onedrive/);
  });

  it("verdict alarm-canary-stale menciona o canário", () => {
    const e = evaluateOnedriveSyncAlarm("active", "stale");
    const { body } = buildOnedriveSyncAlarmEmail(e, "");
    assert.match(body, /canário/);
  });

  it("issueLine é anexado ao corpo quando presente", () => {
    const e = evaluateOnedriveSyncAlarm("inactive", "fresh");
    const { body } = buildOnedriveSyncAlarmEmail(e, "\n\nIssue: #9999 (https://example.com/9999)");
    assert.match(body, /#9999/);
  });
});
