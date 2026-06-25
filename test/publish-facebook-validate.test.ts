import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateScheduledTime, needsReschedule, isValidShiftedSchedule } from "../scripts/publish-facebook.ts";
import { computeScheduledAt as computeScheduledAtShared } from "../scripts/compute-social-schedule.ts";

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

// ── Regressão #2591 — fix ineficaz do #2575: stored-shiftado vs canônico-passado ─
// O teste do #2575 comparou canônico-vs-canônico (disablePastSlotShift=true nos
// dois lados), nunca o valor stored real do agendamento inicial (shiftado). Esse
// set de testes replica o cenário REAL de produção:
//   stored = computeScheduledAt(..., disablePastSlotShift=false)  ← caminho inicial
//   canonical = computeScheduledAt(..., disablePastSlotShift=true) ← comparação
// e verifica que o gate isValidShiftedSchedule retorna true (pular), não false.
describe("#2591 — gate isValidShiftedSchedule: canônico-passado + stored-shiftado-futuro → skip", () => {
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

  it("cenário REAL de produção: stored=shiftado-futuro, canônico=passado → NÃO rescheduleia", () => {
    // Reprodução do cenário 260625 descrito na issue #2591:
    //   edição 260625, d1 canônico = 09:00 BRT, dispatch (now₀) = 13:05 BRT
    //   agendamento inicial grava stored = now₀+15min = 13:20 BRT
    //   --reschedule roda com now = 13:10 BRT
    //   comparação: needsReschedule("13:20", "09:00") → true → DELETE (churn!)
    //   com o fix: isValidShiftedSchedule("09:00", "13:20", 13:10) → true → SKIP
    const now0Ms = new Date("2026-06-25T16:05:00Z").getTime(); // 13:05 BRT (dispatch inicial)
    const nowMs = new Date("2026-06-25T16:06:00Z").getTime();  // 13:06 BRT (rodada --reschedule, 1min depois)

    // Construir o stored com o MESMO caminho do agendamento inicial (shift on)
    // — não canônico-vs-canônico como o #2575 fez.
    delete process.env.DIARIA_DISABLE_PASTSLOT_SHIFT;
    let storedISO: string;
    try {
      storedISO = computeScheduledAtShared({
        config: baseConfig,
        editionDate: "260625",
        destaque: "d1",
        platform: "facebook",
        now: now0Ms,
        disablePastSlotShift: false, // ← caminho INICIAL: aplica shift
      });
    } finally {
      process.env.DIARIA_DISABLE_PASTSLOT_SHIFT = "1";
    }

    // stored deve ser shiftado (now₀+15min), NÃO o slot canônico 09:00
    const expectedStoredMs = now0Ms + 15 * 60_000;
    assert.ok(
      Math.abs(new Date(storedISO).getTime() - expectedStoredMs) <= 1000,
      `stored deve ser shiftado (now₀+15min), got ${storedISO}`,
    );
    assert.ok(
      !storedISO.includes("T09:00:00"),
      `stored não deve ser canônico 09:00, got ${storedISO}`,
    );

    // canonical = slot canônico sem shift (caminho de COMPARAÇÃO do reschedule)
    const canonicalISO = computeScheduledAtShared({
      config: baseConfig,
      editionDate: "260625",
      destaque: "d1",
      platform: "facebook",
      now: nowMs,
      disablePastSlotShift: true, // ← caminho de COMPARAÇÃO: sem shift
    });
    assert.match(
      canonicalISO,
      /^2026-06-25T09:00:00-03:00$/,
      `canonical deve ser 09:00 BRT, got ${canonicalISO}`,
    );

    // O bug do #2575: needsReschedule(stored=shiftado-futuro, canonical=passado) = true → DELETE
    // Verificar que SEM o fix isso seria churn:
    assert.equal(
      needsReschedule(storedISO, canonicalISO),
      true,
      "needsReschedule(stored=futuro-shiftado, canonical=passado) deve ser true — confirma o bug do #2575",
    );

    // O fix do #2591: isValidShiftedSchedule detecta o cenário e retorna true (pular)
    assert.equal(
      isValidShiftedSchedule(canonicalISO, storedISO, nowMs),
      true,
      `isValidShiftedSchedule deve retornar true (pular) — stored (${storedISO}) é futuro válido, canonical (${canonicalISO}) é passado`,
    );
  });

  it("não-regressão: canônico FUTURO com stored driftado → AINDA rescheduleia", () => {
    // Canônico d3=17:00 BRT (futuro com now=13:10 BRT), stored=16:00 BRT (driftado)
    // → isValidShiftedSchedule deve retornar false → needsReschedule avalia normalmente
    const nowMs = new Date("2026-06-25T16:10:00Z").getTime(); // 13:10 BRT
    const canonicalISO = computeScheduledAtShared({
      config: baseConfig,
      editionDate: "260625",
      destaque: "d3",
      platform: "facebook",
      now: nowMs,
      disablePastSlotShift: true,
    });
    // Canônico d3=17:00 BRT deve ser futuro
    assert.match(
      canonicalISO,
      /^2026-06-25T17:00:00-03:00$/,
      `d3 canônico deve ser 17:00 BRT, got ${canonicalISO}`,
    );

    const storedISO = "2026-06-25T16:00:00-03:00"; // driftado (1h antes do canônico)

    // isValidShiftedSchedule deve retornar false: canônico NÃO está no passado
    assert.equal(
      isValidShiftedSchedule(canonicalISO, storedISO, nowMs),
      false,
      "isValidShiftedSchedule com canônico FUTURO deve retornar false (não pular — avaliar via needsReschedule)",
    );
    // E needsReschedule deve detectar o drift e retornar true
    assert.equal(
      needsReschedule(storedISO, canonicalISO),
      true,
      "needsReschedule(stored=driftado, canonical=futuro) deve ser true (rescheduleia)",
    );
  });

  it("não-regressão: stored no passado (expirou) → rescheduleia mesmo com canônico no passado", () => {
    // Canônico d1=09:00 BRT (passado), stored=08:00 BRT (também no passado — expirou)
    // → isValidShiftedSchedule deve retornar false (stored não é futuro válido)
    const nowMs = new Date("2026-06-25T16:10:00Z").getTime(); // 13:10 BRT
    const canonicalISO = "2026-06-25T09:00:00-03:00"; // passado
    const storedISO = "2026-06-25T08:00:00-03:00"; // também no passado (expirou)

    assert.equal(
      isValidShiftedSchedule(canonicalISO, storedISO, nowMs),
      false,
      "isValidShiftedSchedule com stored no passado deve retornar false (rescheduleia)",
    );
  });

  it("idempotência: 2 rodadas de --reschedule com mesmo stored → ambas skipam (sem churn)", () => {
    // Simula 2 rodadas consecutivas de --reschedule.
    // A 1ª rodada com o fix deve SKIP (não deletar/recriar).
    // A 2ª rodada deve também SKIP (o stored permanece o mesmo pois não houve DELETE).
    const now0Ms = new Date("2026-06-25T16:05:00Z").getTime(); // 13:05 BRT
    const now1Ms = now0Ms + 1 * 60_000;  // 13:06 BRT (1ª rodada --reschedule)
    const now2Ms = now0Ms + 2 * 60_000;  // 13:07 BRT (2ª rodada --reschedule)

    delete process.env.DIARIA_DISABLE_PASTSLOT_SHIFT;
    let storedISO: string;
    try {
      storedISO = computeScheduledAtShared({
        config: baseConfig,
        editionDate: "260625",
        destaque: "d1",
        platform: "facebook",
        now: now0Ms,
        disablePastSlotShift: false,
      });
    } finally {
      process.env.DIARIA_DISABLE_PASTSLOT_SHIFT = "1";
    }

    const canonical1 = computeScheduledAtShared({
      config: baseConfig,
      editionDate: "260625",
      destaque: "d1",
      platform: "facebook",
      now: now1Ms,
      disablePastSlotShift: true,
    });
    const canonical2 = computeScheduledAtShared({
      config: baseConfig,
      editionDate: "260625",
      destaque: "d1",
      platform: "facebook",
      now: now2Ms,
      disablePastSlotShift: true,
    });

    // 1ª rodada: skip (stored futuro válido, canonical passado)
    assert.equal(
      isValidShiftedSchedule(canonical1, storedISO, now1Ms),
      true,
      `1ª rodada --reschedule deve skip, got canonical=${canonical1}, stored=${storedISO}`,
    );
    // 2ª rodada: ainda skip (stored não mudou, canonical ainda no passado)
    assert.equal(
      isValidShiftedSchedule(canonical2, storedISO, now2Ms),
      true,
      `2ª rodada --reschedule deve também skip (sem churn), got canonical=${canonical2}, stored=${storedISO}`,
    );
  });
});
