import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  toAammdd,
  validateExplicitAt,
  resolveArtigoEspecialScheduledAt,
} from "../scripts/lib/artigo-especial-schedule.ts";

const CONFIG = {
  publishing: {
    social: {
      fallback_schedule: { d3_time: "17:30", day_offset: 0 },
      timezone: "America/Sao_Paulo",
    },
  },
};

describe("toAammdd (#5979)", () => {
  it("formata data local em AAMMDD", () => {
    assert.equal(toAammdd(new Date(2026, 7, 23)), "260823"); // 23/ago/2026
  });
  it("preenche zero a esquerda em mes/dia de 1 digito", () => {
    assert.equal(toAammdd(new Date(2026, 0, 5)), "260105");
  });
});

describe("validateExplicitAt (#5979)", () => {
  const now = Date.parse("2026-08-23T12:00:00-03:00");
  it("aceita ISO valido no futuro", () => {
    assert.equal(validateExplicitAt("2026-09-02T17:30:00-03:00", now), "2026-09-02T17:30:00-03:00");
  });
  it("rejeita string nao-ISO", () => {
    assert.throws(() => validateExplicitAt("not-a-real-iso-date", now), /não é um ISO 8601/);
  });
  it("rejeita data no passado", () => {
    assert.throws(() => validateExplicitAt("2026-01-01T00:00:00-03:00", now), /passado/);
  });
  it("rejeita o proprio 'now' (nao estritamente futuro)", () => {
    assert.throws(() => validateExplicitAt(new Date(now).toISOString(), now), /passado/);
  });
});

describe("resolveArtigoEspecialScheduledAt (#5979)", () => {
  it("--at explicito tem precedencia, sem tocar em computeScheduledAt", () => {
    const now = Date.parse("2026-08-23T12:00:00-03:00");
    const iso = resolveArtigoEspecialScheduledAt(CONFIG, { at: "2026-09-02T17:30:00-03:00", now });
    assert.equal(iso, "2026-09-02T17:30:00-03:00");
  });

  it("default: D+1 17:30 BRT a partir de 'now'", () => {
    // 23/ago/2026 (domingo) 10:00 BRT -> D+1 = 24/ago 17:30 BRT.
    const now = Date.parse("2026-08-23T10:00:00-03:00");
    const iso = resolveArtigoEspecialScheduledAt(CONFIG, { now });
    assert.equal(iso, "2026-08-24T17:30:00-03:00");
  });

  it("default respeita virada de mes/ano (D+1 de 31/dez)", () => {
    const now = Date.parse("2026-12-31T10:00:00-03:00");
    const iso = resolveArtigoEspecialScheduledAt(CONFIG, { now });
    assert.equal(iso, "2027-01-01T17:30:00-03:00");
  });

  it("lanca sem fallback_schedule.d3_time configurado", () => {
    const now = Date.parse("2026-08-23T10:00:00-03:00");
    assert.throws(() =>
      resolveArtigoEspecialScheduledAt({ publishing: { social: { timezone: "America/Sao_Paulo" } } }, { now }),
    );
  });
});
