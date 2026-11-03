/**
 * Regressão #11883: `isCircleStackScheduledRunPast` usava o relógio local
 * (`getHours`/`formatAAMMDD`). O `300` roda em Etc/UTC e o timer da task usa
 * `OnCalendar` em America/Sao_Paulo: às 04:00 BRT de segunda (07:00 UTC) a
 * função dizia que a execução das 06:00 já tinha rodado, e o `--approve`
 * recusava uma aprovação que a task ainda ia consumir. Os casos rodam com o
 * `TZ` do processo trocado (UTC, São Paulo, Tóquio) e o resultado não muda.
 */
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { circleStackWallClock, isCircleStackScheduledRunPast } from "../scripts/lib/circle-stack-schedule.ts";

const MONDAY = "261102";
const originalTz = process.env.TZ;

function withTz<T>(tz: string, fn: () => T): T {
  process.env.TZ = tz;
  try {
    return fn();
  } finally {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  }
}

const ZONES = ["Etc/UTC", "America/Sao_Paulo", "Asia/Tokyo"];

describe("Stack: execução agendada medida em BRT, não no relógio local (#11883)", () => {
  afterEach(() => {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  it("04:00 BRT de segunda (07:00 UTC): a execução das 06:00 ainda não rodou, em qualquer TZ do processo", () => {
    for (const tz of ZONES) {
      assert.equal(withTz(tz, () => isCircleStackScheduledRunPast(new Date("2026-11-02T07:00:00Z"), MONDAY)), false, tz);
    }
  });

  it("05:59 BRT ainda não; 06:00 BRT (09:00 UTC) já rodou", () => {
    for (const tz of ZONES) {
      assert.equal(withTz(tz, () => isCircleStackScheduledRunPast(new Date("2026-11-02T08:59:00Z"), MONDAY)), false, tz);
      assert.equal(withTz(tz, () => isCircleStackScheduledRunPast(new Date("2026-11-02T09:00:00Z"), MONDAY)), true, tz);
    }
  });

  it("domingo 22:00 BRT (segunda 01:00 UTC) ainda é domingo em BRT: não rodou", () => {
    for (const tz of ZONES) {
      assert.equal(withTz(tz, () => isCircleStackScheduledRunPast(new Date("2026-11-02T01:00:00Z"), MONDAY)), false, tz);
    }
  });

  it("segunda 22:00 BRT (terça 01:00 UTC) segue a própria segunda, depois das 06:00: rodou", () => {
    for (const tz of ZONES) {
      assert.equal(withTz(tz, () => isCircleStackScheduledRunPast(new Date("2026-11-03T01:00:00Z"), MONDAY)), true, tz);
    }
  });

  it("circleStackWallClock devolve data e hora de São Paulo (meia-noite sai 0, não 24)", () => {
    assert.deepEqual(
      withTz("Etc/UTC", () => circleStackWallClock(new Date("2026-11-02T03:00:00Z"))),
      { aammdd: "261102", hour: 0 },
    );
    assert.deepEqual(
      withTz("Asia/Tokyo", () => circleStackWallClock(new Date("2026-12-31T23:30:00Z"))),
      { aammdd: "261231", hour: 20 },
    );
  });
});
