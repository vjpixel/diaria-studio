import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateScheduledTime, needsReschedule } from "../scripts/publish-facebook.ts";

const now = new Date("2026-04-24T12:00:00Z");

describe("validateScheduledTime (#78)", () => {
  it("aceita horário > 10min no futuro", () => {
    const scheduled = "2026-04-24T13:00:00Z"; // +1h
    assert.doesNotThrow(() => validateScheduledTime(scheduled, now));
  });

  it("aceita horário 1 dia no futuro", () => {
    const scheduled = "2026-04-25T12:00:00Z";
    assert.doesNotThrow(() => validateScheduledTime(scheduled, now));
  });

  it("rejeita horário que já passou (1h atrás)", () => {
    const scheduled = "2026-04-24T11:00:00Z";
    assert.throws(
      () => validateScheduledTime(scheduled, now),
      /já passou.*60min atrás/,
    );
  });

  it("rejeita horário exato agora", () => {
    const scheduled = "2026-04-24T12:00:00Z";
    assert.throws(() => validateScheduledTime(scheduled, now), /já passou/);
  });

  it("rejeita horário 5min no futuro (< margem de 10min)", () => {
    const scheduled = "2026-04-24T12:05:00Z";
    assert.throws(
      () => validateScheduledTime(scheduled, now),
      /margem mínima de 10min/,
    );
  });

  it("rejeita horário exatamente 10min no futuro (borderline)", () => {
    // unixTs == nowUnix + 600 → não é strictly <, então passa
    // Mas a condição é `< nowUnix + minOffset`, então 600 exatos ainda é válido.
    const scheduled = "2026-04-24T12:10:00Z";
    assert.doesNotThrow(() => validateScheduledTime(scheduled, now));
  });

  it("margem customizável via terceiro arg", () => {
    // Margem de 30min
    const scheduled = "2026-04-24T12:20:00Z"; // +20min
    assert.throws(
      () => validateScheduledTime(scheduled, now, 1800),
      /margem mínima de 30min/,
    );
  });

  it("rejeita data inválida", () => {
    assert.throws(
      () => validateScheduledTime("not-a-date", now),
      /data inválida/,
    );
  });

  it("erro inclui mensagem acionável (day-offset / fallback_schedule)", () => {
    const scheduled = "2026-04-24T11:00:00Z";
    try {
      validateScheduledTime(scheduled, now);
      assert.fail("should have thrown");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      assert.ok(msg.includes("day-offset") || msg.includes("fallback_schedule"));
    }
  });
});

describe("needsReschedule (#123)", () => {
  it("true quando actual é null (post sem scheduled_at registrado)", () => {
    assert.equal(needsReschedule(null, "2026-04-25T09:00:00-03:00"), true);
  });

  it("false quando actual === expected (mesmo timestamp ISO)", () => {
    const t = "2026-04-25T09:00:00-03:00";
    assert.equal(needsReschedule(t, t), false);
  });

  it("false quando actual e expected representam o mesmo instante em offsets diferentes", () => {
    // 09:00 BRT = 12:00 UTC
    assert.equal(
      needsReschedule("2026-04-25T09:00:00-03:00", "2026-04-25T12:00:00Z"),
      false,
    );
  });

  it("true quando difere por mais de 60s (default tolerance)", () => {
    assert.equal(
      needsReschedule("2026-04-25T09:00:00-03:00", "2026-04-25T09:30:00-03:00"),
      true,
    );
  });

  it("false quando diferença ≤ tolerance (60s default — clock skew)", () => {
    assert.equal(
      needsReschedule("2026-04-25T09:00:00-03:00", "2026-04-25T09:00:30-03:00"),
      false,
    );
  });

  it("tolerância customizável via 3o arg", () => {
    // Margem 5min
    assert.equal(
      needsReschedule(
        "2026-04-25T09:00:00-03:00",
        "2026-04-25T09:04:00-03:00",
        300,
      ),
      false,
    );
    assert.equal(
      needsReschedule(
        "2026-04-25T09:00:00-03:00",
        "2026-04-25T09:06:00-03:00",
        300,
      ),
      true,
    );
  });

  it("true quando actual é data inválida (defensive — força reschedule)", () => {
    assert.equal(
      needsReschedule("not-a-date", "2026-04-25T09:00:00-03:00"),
      true,
    );
  });

  it("caso real do #123: 10:00 BRT vs 09:00 BRT — precisa reschedule", () => {
    assert.equal(
      needsReschedule("2026-04-25T10:00:00-03:00", "2026-04-25T09:00:00-03:00"),
      true,
    );
  });
});
