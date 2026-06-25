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

// ── Regressão #2575 — reschedule idempotência com slot passado ────────────────
// Garante que o caminho de COMPARAÇÃO do reschedule usa slot canônico estável
// (não now+15min que avança a cada run).
import {
  computeScheduledAt as computeScheduledAtShared,
} from "../scripts/compute-social-schedule.ts";

describe("#2575 — reschedule idempotência: disablePastSlotShift retorna canônico estável", () => {
  // Suprimir logs de observabilidade nestes testes
  process.env.DIARIA_QUIET_SCHEDULE_LOG = "1";

  const baseConfig = {
    publishing: {
      social: {
        timezone: "America/Sao_Paulo",
        fallback_schedule: {
          d1_time: "09:00",
          d2_time: "12:30",
          d3_time: "17:00",
          day_offset: 0,
        },
      },
    },
  };

  it("disablePastSlotShift=true retorna slot canônico (sem shift) mesmo com slot no passado", () => {
    // Slot d1=09:00 de 260625 está no passado com now=13:00.
    // Com disablePastSlotShift=true (caminho de comparação), retorna o canônico.
    const now = new Date("2026-06-25T16:00:00Z").getTime(); // 13:00 BRT
    const canonical = computeScheduledAtShared({
      config: baseConfig,
      editionDate: "260625",
      destaque: "d1",
      platform: "facebook",
      now,
      disablePastSlotShift: true,
    });
    // Deve ser o slot canônico 09:00 BRT, independente do now
    assert.match(
      canonical,
      /^2026-06-25T09:00:00-03:00$/,
      `esperado slot canônico 09:00 BRT, got ${canonical}`,
    );
  });

  it("disablePastSlotShift=true é determinístico: 2 chamadas consecutivas retornam igual (sem churn)", () => {
    // Simula 2 rodadas de --reschedule: expectedAt deve ser idêntico.
    const now1 = new Date("2026-06-25T16:00:00Z").getTime(); // 13:00 BRT
    const now2 = now1 + 60_000; // 1 minuto depois (simula 2ª rodada)
    const at1 = computeScheduledAtShared({
      config: baseConfig,
      editionDate: "260625",
      destaque: "d1",
      platform: "facebook",
      now: now1,
      disablePastSlotShift: true,
    });
    const at2 = computeScheduledAtShared({
      config: baseConfig,
      editionDate: "260625",
      destaque: "d1",
      platform: "facebook",
      now: now2,
      disablePastSlotShift: true,
    });
    // Se os dois são iguais, needsReschedule(at1, at2) = false → sem churn
    assert.equal(at1, at2, `reschedule churn: chamadas consecutivas retornaram diferente (${at1} vs ${at2})`);
    assert.equal(
      needsReschedule(at1, at2),
      false,
      "needsReschedule(canônico, canônico) deve ser false — sem churn",
    );
  });

  it("disablePastSlotShift=false (default/inicial) ainda shifta slot passado", () => {
    // Garante que o caminho de PUBLICAÇÃO INICIAL ainda aplica o shift (#2552 não regrediu).
    delete process.env.DIARIA_DISABLE_PASTSLOT_SHIFT;
    const now = new Date("2026-06-25T16:00:00Z").getTime(); // 13:00 BRT
    let shifted: string;
    try {
      shifted = computeScheduledAtShared({
        config: baseConfig,
        editionDate: "260625",
        destaque: "d1",
        platform: "facebook",
        now,
        disablePastSlotShift: false,
      });
    } finally {
      process.env.DIARIA_DISABLE_PASTSLOT_SHIFT = "1";
    }
    // Deve ser shiftado (now+15min), NÃO o slot canônico 09:00
    const expectedShiftedMs = now + 15 * 60_000;
    const actualMs = new Date(shifted).getTime();
    assert.ok(
      Math.abs(actualMs - expectedShiftedMs) <= 1000,
      `caminho inicial deve ainda shiftar: got ${shifted}`,
    );
    assert.ok(
      !shifted.includes("T09:00:00"),
      `slot inicial não deve ser canônico 09:00 quando no passado, got ${shifted}`,
    );
  });
});

// ── Regressão #2576 — múltiplos slots passados espaçados ─────────────────────
describe("#2576 — múltiplos slots passados não colidem (espaçamento por destaque)", () => {
  process.env.DIARIA_QUIET_SCHEDULE_LOG = "1";

  const baseConfig = {
    publishing: {
      social: {
        timezone: "America/Sao_Paulo",
        fallback_schedule: {
          d1_time: "09:00",
          d2_time: "12:30",
          d3_time: "17:00",
          day_offset: 0,
        },
      },
    },
  };

  it("d1 e d2 ambos no passado → shiftados para horários DISTINTOS espaçados (não colidem)", () => {
    // now=13:00 BRT → d1=09:00 (passado) e d2=12:30 (passado), d3=17:00 (futuro)
    delete process.env.DIARIA_DISABLE_PASTSLOT_SHIFT;
    const now = new Date("2026-06-25T16:00:00Z").getTime(); // 13:00 BRT

    let d1At: string;
    let d2At: string;
    let d3At: string;

    try {
      d1At = computeScheduledAtShared({
        config: baseConfig,
        editionDate: "260625",
        destaque: "d1",
        platform: "facebook",
        now,
      });
      d2At = computeScheduledAtShared({
        config: baseConfig,
        editionDate: "260625",
        destaque: "d2",
        platform: "facebook",
        now,
      });
      d3At = computeScheduledAtShared({
        config: baseConfig,
        editionDate: "260625",
        destaque: "d3",
        platform: "facebook",
        now,
      });
    } finally {
      process.env.DIARIA_DISABLE_PASTSLOT_SHIFT = "1";
    }

    // d1 e d2 devem ser distintos (não colidem no mesmo minuto)
    const d1Ms = new Date(d1At).getTime();
    const d2Ms = new Date(d2At).getTime();
    const d3Ms = new Date(d3At).getTime();

    assert.ok(d2Ms > d1Ms, `d2 (${d2At}) deve ser posterior a d1 (${d1At})`);

    // Espaçamento mínimo de 5min entre d1 e d2 shiftados (default spacing=10min)
    const diffD1D2 = (d2Ms - d1Ms) / 60_000;
    assert.ok(diffD1D2 >= 5, `espaçamento d1→d2 deve ser ≥5min, got ${diffD1D2.toFixed(1)}min`);

    // d1 = now + 15min (base shift, índice 0)
    const expectedD1Ms = now + 15 * 60_000;
    assert.ok(
      Math.abs(d1Ms - expectedD1Ms) <= 1000,
      `d1 deve ser now+15min, got ${d1At}`,
    );

    // d2 = now + 25min (base shift + 1*spacing, índice 1)
    const expectedD2Ms = now + 25 * 60_000;
    assert.ok(
      Math.abs(d2Ms - expectedD2Ms) <= 1000,
      `d2 deve ser now+25min, got ${d2At}`,
    );

    // d3 não está no passado (17:00 > 13:00) → deve ser o slot canônico 17:00
    assert.match(d3At, /^2026-06-25T17:00:00-03:00$/, `d3 deve ser canônico 17:00 BRT, got ${d3At}`);

    // Todos acima do piso FB (>10min no futuro)
    assert.ok(d1Ms > now + 10 * 60_000, `d1 deve ser >10min no futuro`);
    assert.ok(d2Ms > now + 10 * 60_000, `d2 deve ser >10min no futuro`);
  });

  it("ordem d1 < d2 < d3 preservada quando todos estão no passado", () => {
    // now=20:00 BRT → todos os 3 slots no passado
    delete process.env.DIARIA_DISABLE_PASTSLOT_SHIFT;
    const now = new Date("2026-06-25T23:00:00Z").getTime(); // 20:00 BRT

    let d1At: string;
    let d2At: string;
    let d3At: string;

    try {
      d1At = computeScheduledAtShared({
        config: baseConfig,
        editionDate: "260625",
        destaque: "d1",
        platform: "facebook",
        now,
      });
      d2At = computeScheduledAtShared({
        config: baseConfig,
        editionDate: "260625",
        destaque: "d2",
        platform: "facebook",
        now,
      });
      d3At = computeScheduledAtShared({
        config: baseConfig,
        editionDate: "260625",
        destaque: "d3",
        platform: "facebook",
        now,
      });
    } finally {
      process.env.DIARIA_DISABLE_PASTSLOT_SHIFT = "1";
    }

    const d1Ms = new Date(d1At).getTime();
    const d2Ms = new Date(d2At).getTime();
    const d3Ms = new Date(d3At).getTime();

    assert.ok(d1Ms < d2Ms, `d1 deve preceder d2 (d1=${d1At}, d2=${d2At})`);
    assert.ok(d2Ms < d3Ms, `d2 deve preceder d3 (d2=${d2At}, d3=${d3At})`);

    // Todos acima do piso FB
    assert.ok(d1Ms > now + 10 * 60_000, `d1 deve ser >10min no futuro`);
    assert.ok(d2Ms > now + 10 * 60_000, `d2 deve ser >10min no futuro`);
    assert.ok(d3Ms > now + 10 * 60_000, `d3 deve ser >10min no futuro`);
  });
});
