/**
 * test/monthly-send-schedule.test.ts (#9473)
 *
 * Regra de envio da mensal: 1º sábado do mês de ENVIO, 06:00 BRT (UTC-3 fixo).
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  computeMonthlySendAt,
  cycleSendYearMonth,
  decideMonthlySendAt,
  nthWeekdayOfMonth,
  resolveMonthlySendSchedule,
  DEFAULT_MONTHLY_SEND_SCHEDULE,
} from "../scripts/lib/mensal/monthly-send-schedule.ts";

describe("computeMonthlySendAt — 1º sábado do mês de envio, 06:00 BRT", () => {
  it("mês que COMEÇA no sábado: o próprio dia 1 (ago/2026, ciclo 2607-08)", () => {
    const r = computeMonthlySendAt("2607-08");
    assert.equal(r.iso, "2026-08-01T06:00:00-03:00");
    assert.equal(new Date(r.epochMs).toISOString(), "2026-08-01T09:00:00.000Z");
  });

  it("mês que começa no domingo: dia 7 (nov/2026, ciclo 2610-11)", () => {
    assert.equal(computeMonthlySendAt("2610-11").iso, "2026-11-07T06:00:00-03:00");
  });

  it("mês que começa na quinta: dia 3 (out/2026, ciclo 2609-10)", () => {
    assert.equal(computeMonthlySendAt("2609-10").iso, "2026-10-03T06:00:00-03:00");
  });

  it("virada de ano: ciclo 2612-01 sai em JANEIRO de 2027 (dia 2), não de 2026", () => {
    assert.deepEqual(cycleSendYearMonth("2612-01"), { year: 2027, month: 1 });
    const r = computeMonthlySendAt("2612-01");
    assert.equal(r.iso, "2027-01-02T06:00:00-03:00");
    assert.equal(new Date(r.epochMs).toISOString(), "2027-01-02T09:00:00.000Z");
  });

  it("o ISO e o epochMs representam o MESMO instante", () => {
    for (const c of ["2607-08", "2610-11", "2612-01", "2704-05"]) {
      const r = computeMonthlySendAt(c);
      assert.equal(Date.parse(r.iso), r.epochMs, c);
    }
  });

  it("ciclo inválido lança", () => {
    assert.throws(() => computeMonthlySendAt("2610-12"), /ciclo inválido/);
    assert.throws(() => computeMonthlySendAt("2610"), /ciclo inválido/);
  });
});

describe("independência do fuso do host", () => {
  const originalTz = process.env.TZ;
  afterEach(() => {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  for (const tz of ["UTC", "America/Sao_Paulo", "Asia/Tokyo", "Pacific/Kiritimati", "America/Los_Angeles"]) {
    it(`TZ=${tz}: mesmo instante para 2607-08 e 2612-01`, () => {
      process.env.TZ = tz;
      assert.equal(new Date(computeMonthlySendAt("2607-08").epochMs).toISOString(), "2026-08-01T09:00:00.000Z");
      assert.equal(new Date(computeMonthlySendAt("2612-01").epochMs).toISOString(), "2027-01-02T09:00:00.000Z");
      assert.equal(nthWeekdayOfMonth(2026, 8, 6, 1), 1);
    });
  }
});

describe("decideMonthlySendAt — antecedência mínima de 24h (#8205)", () => {
  // Envio de 2610-11 = 2026-11-07T09:00:00Z.
  it("com folga: schedule", () => {
    const d = decideMonthlySendAt("2610-11", new Date("2026-11-01T12:00:00Z"));
    assert.equal(d.kind, "schedule");
    assert.equal(d.sendAt, "2026-11-07T06:00:00-03:00");
  });

  it("exatamente 24h antes: schedule (limite inclusivo)", () => {
    const d = decideMonthlySendAt("2610-11", new Date("2026-11-06T09:00:00Z"));
    assert.equal(d.kind, "schedule");
  });

  it("menos de 24h antes: too_late", () => {
    const d = decideMonthlySendAt("2610-11", new Date("2026-11-06T09:00:01Z"));
    assert.equal(d.kind, "too_late");
    assert.match((d as { reason: string }).reason, /abaixo do mínimo de 24h/);
  });

  it("depois do sábado: too_late com motivo 'já passou'", () => {
    const d = decideMonthlySendAt("2610-11", new Date("2026-11-10T00:00:00Z"));
    assert.equal(d.kind, "too_late");
    assert.match((d as { reason: string }).reason, /já passou/);
  });
});

describe("resolveMonthlySendSchedule", () => {
  it("ausente → default (sábado, 1ª, 06:00, 24h)", () => {
    assert.deepEqual(resolveMonthlySendSchedule(undefined), DEFAULT_MONTHLY_SEND_SCHEDULE);
  });

  it("platform.config.json real resolve para a regra do editor (#9473)", () => {
    const cfg = JSON.parse(readFileSync(resolve(import.meta.dirname, "..", "platform.config.json"), "utf8"));
    assert.ok(cfg.monthly_send_schedule, "chave monthly_send_schedule presente");
    assert.deepEqual(resolveMonthlySendSchedule(cfg.monthly_send_schedule), DEFAULT_MONTHLY_SEND_SCHEDULE);
  });

  it("time_brt customizado é respeitado", () => {
    const rule = resolveMonthlySendSchedule({ time_brt: "07:30" });
    assert.equal(computeMonthlySendAt("2610-11", rule).iso, "2026-11-07T07:30:00-03:00");
  });

  it("valores inválidos lançam em vez de cair num default silencioso", () => {
    assert.throws(() => resolveMonthlySendSchedule({ time_brt: "6h" }), /time_brt/);
    assert.throws(() => resolveMonthlySendSchedule({ time_brt: "24:00" }), /time_brt/);
    assert.throws(() => resolveMonthlySendSchedule({ weekday: 7 }), /weekday/);
    assert.throws(() => resolveMonthlySendSchedule({ occurrence: 5 }), /occurrence/);
    assert.throws(() => resolveMonthlySendSchedule({ min_lead_hours: -1 }), /min_lead_hours/);
  });
});
