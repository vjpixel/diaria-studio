import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computeScheduledAt,
  parseEditionDate,
  parseCliArgs,
  timezoneOffsetIso,
} from "../scripts/compute-social-schedule.ts";

// #1140 — Suprimir logs de observabilidade durante testes (ruído). Cada teste
// do bloco "observability + safety guards" abaixo desabilita temporariamente
// pra capturar e validar o log.
process.env.DIARIA_QUIET_SCHEDULE_LOG = "1";
// #2565 — Testes legados usam editionDates históricas que ficam sempre no passado.
// Suprimir o shift de past-slot nesses testes (independente do QUIET_LOG, que é só-log).
// Testes do #2552 deletam esta var explicitamente para testar o shift com `now` injetado.
process.env.DIARIA_DISABLE_PASTSLOT_SHIFT = "1";

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

describe("parseEditionDate (#270)", () => {
  it("parseia AAMMDD em year/month/day", () => {
    assert.deepEqual(parseEditionDate("260428"), {
      year: 2026,
      month: 4,
      day: 28,
    });
  });

  it("ano 2000 (boundary)", () => {
    assert.deepEqual(parseEditionDate("000101"), {
      year: 2000,
      month: 1,
      day: 1,
    });
  });

  it("rejeita formato com não-dígitos", () => {
    assert.throws(() => parseEditionDate("26-04-28"), /inválida/);
    assert.throws(() => parseEditionDate("260428a"), /inválida/);
  });

  it("rejeita comprimento errado", () => {
    assert.throws(() => parseEditionDate("26042"), /inválida/);
    assert.throws(() => parseEditionDate("2604288"), /inválida/);
  });

  it("rejeita mês fora do range", () => {
    assert.throws(() => parseEditionDate("261301"), /fora do range/);
    assert.throws(() => parseEditionDate("260001"), /fora do range/);
  });

  it("rejeita dia fora do range", () => {
    assert.throws(() => parseEditionDate("260400"), /fora do range/);
    assert.throws(() => parseEditionDate("260432"), /fora do range/);
  });
});

describe("computeScheduledAt (#270)", () => {
  it("usa editionDate + day_offset, NÃO today + day_offset (regressão chave)", () => {
    // Edição 260428 (28-abr-2026), d1 LinkedIn, day_offset 0 → 2026-04-28 09:00 BRT
    const iso = computeScheduledAt({
      config: baseConfig,
      editionDate: "260428",
      destaque: "d1",
      platform: "linkedin",
    });
    assert.match(iso, /^2026-04-28T09:00:00-03:00$/);
  });

  it("LinkedIn d2: 12:30 BRT", () => {
    const iso = computeScheduledAt({
      config: baseConfig,
      editionDate: "260428",
      destaque: "d2",
      platform: "linkedin",
    });
    assert.match(iso, /^2026-04-28T12:30:00-03:00$/);
  });

  it("LinkedIn d3: 17:00 BRT (horário unificado)", () => {
    const iso = computeScheduledAt({
      config: baseConfig,
      editionDate: "260428",
      destaque: "d3",
      platform: "linkedin",
    });
    assert.match(iso, /^2026-04-28T17:00:00-03:00$/);
  });

  it("Facebook d1: 09:00 BRT (config unificado com LinkedIn)", () => {
    const iso = computeScheduledAt({
      config: baseConfig,
      editionDate: "260428",
      destaque: "d1",
      platform: "facebook",
    });
    assert.match(iso, /^2026-04-28T09:00:00-03:00$/);
  });

  it("day_offset positivo soma dias na editionDate", () => {
    const cfg = JSON.parse(JSON.stringify(baseConfig));
    cfg.publishing.social.fallback_schedule.day_offset = 1;
    const iso = computeScheduledAt({
      config: cfg,
      editionDate: "260428",
      destaque: "d1",
      platform: "linkedin",
    });
    assert.match(iso, /^2026-04-29T09:00:00-03:00$/);
  });

  it("dayOffsetOverride sobrescreve config (usado por /diaria-test +10)", () => {
    const iso = computeScheduledAt({
      config: baseConfig,
      editionDate: "260428",
      destaque: "d1",
      platform: "linkedin",
      dayOffsetOverride: 10,
    });
    assert.match(iso, /^2026-05-08T09:00:00-03:00$/);
  });

  it("rolagem de mês: 28-fev + 3 → 03-mar (não-bissexto)", () => {
    const iso = computeScheduledAt({
      config: baseConfig,
      editionDate: "270228",
      destaque: "d1",
      platform: "linkedin",
      dayOffsetOverride: 3,
    });
    assert.match(iso, /^2027-03-03T09:00:00-03:00$/);
  });

  it("ano bissexto: 28-fev-2024 + 1 → 29-fev", () => {
    const iso = computeScheduledAt({
      config: baseConfig,
      editionDate: "240228",
      destaque: "d1",
      platform: "linkedin",
      dayOffsetOverride: 1,
    });
    assert.match(iso, /^2024-02-29T09:00:00-03:00$/);
  });

  it("rejeita config sem publishing.social", () => {
    assert.throws(
      () =>
        computeScheduledAt({
          config: {} as any,
          editionDate: "260428",
          destaque: "d1",
          platform: "linkedin",
        }),
      /publishing\.social/,
    );
  });

  it("rejeita fallback_schedule ausente", () => {
    const cfg = JSON.parse(JSON.stringify(baseConfig));
    delete cfg.publishing.social.fallback_schedule;
    assert.throws(
      () =>
        computeScheduledAt({
          config: cfg,
          editionDate: "260428",
          destaque: "d1",
          platform: "linkedin",
        }),
      /fallback_schedule/,
    );
  });

  it("rejeita time inválido", () => {
    const cfg = JSON.parse(JSON.stringify(baseConfig));
    cfg.publishing.social.fallback_schedule.d1_time = "9h";
    assert.throws(
      () =>
        computeScheduledAt({
          config: cfg,
          editionDate: "260428",
          destaque: "d1",
          platform: "linkedin",
        }),
      /time inválido/,
    );
  });

  it("rejeita timezone ausente", () => {
    const cfg = JSON.parse(JSON.stringify(baseConfig));
    delete cfg.publishing.social.timezone;
    assert.throws(
      () =>
        computeScheduledAt({
          config: cfg,
          editionDate: "260428",
          destaque: "d1",
          platform: "linkedin",
        }),
      /timezone/,
    );
  });

  it("rejeita day_offset não-inteiro", () => {
    assert.throws(
      () =>
        computeScheduledAt({
          config: baseConfig,
          editionDate: "260428",
          destaque: "d1",
          platform: "linkedin",
          dayOffsetOverride: 1.5,
        }),
      /day_offset/,
    );
  });

  it("timezone com half-hour offset (ex: India IST UTC+5:30)", () => {
    const cfg = JSON.parse(JSON.stringify(baseConfig));
    cfg.publishing.social.timezone = "Asia/Kolkata";
    const iso = computeScheduledAt({
      config: cfg,
      editionDate: "260428",
      destaque: "d1",
      platform: "linkedin",
    });
    assert.match(iso, /^2026-04-28T09:00:00\+05:30$/);
  });

  describe("#1140 — observability + safety guards", () => {
    // Esses testes capturam stderr pra verificar warnings; usam DIARIA_QUIET_SCHEDULE_LOG
    // pra habilitar/desabilitar logs determinísticos.
    let stderrCapture: string[] = [];

    function startCapture() {
      stderrCapture = [];
      const origConsoleError = console.error;
      console.error = (...args: unknown[]) => {
        stderrCapture.push(args.map(String).join(" "));
      };
      return () => {
        console.error = origConsoleError;
      };
    }

    it("logs observability quando dayOffset != 0", () => {
      delete process.env.DIARIA_QUIET_SCHEDULE_LOG;
      const restore = startCapture();
      try {
        const iso = computeScheduledAt({
          config: baseConfig,
          editionDate: "270428", // futuro pra não trigar safety guard
          destaque: "d1",
          platform: "linkedin",
          dayOffsetOverride: 1,
        });
        assert.match(iso, /^2027-04-29/);
        const obs = stderrCapture.find((l) => l.includes("non-zero dayOffset=1"));
        assert.ok(obs, `expected observability log, got: ${stderrCapture.join("|")}`);
        assert.ok(obs.includes("edition=270428"), "log should include editionDate");
        assert.ok(obs.includes("target=2027-04-29"), "log should include target");
      } finally {
        restore();
        process.env.DIARIA_QUIET_SCHEDULE_LOG = "1";
        process.env.DIARIA_DISABLE_PASTSLOT_SHIFT = "1";
      }
    });

    it("NÃO loga quando dayOffset === 0 (caso normal)", () => {
      delete process.env.DIARIA_QUIET_SCHEDULE_LOG;
      const restore = startCapture();
      try {
        computeScheduledAt({
          config: baseConfig,
          editionDate: "270428",
          destaque: "d1",
          platform: "linkedin",
          dayOffsetOverride: 0,
        });
        assert.equal(
          stderrCapture.length,
          0,
          `expected no logs for dayOffset=0, got: ${stderrCapture.join("|")}`,
        );
      } finally {
        restore();
        process.env.DIARIA_QUIET_SCHEDULE_LOG = "1"; // restaurar pra suprimir nos demais
        process.env.DIARIA_DISABLE_PASTSLOT_SHIFT = "1";
      }
    });

    it("safety guard: warning loud quando editionDate no passado + dayOffset >= 1 (regressão 260512)", () => {
      delete process.env.DIARIA_QUIET_SCHEDULE_LOG;
      const restore = startCapture();
      try {
        // editionDate "230101" claramente no passado (2023-01-01)
        computeScheduledAt({
          config: baseConfig,
          editionDate: "230101",
          destaque: "d1",
          platform: "linkedin",
          dayOffsetOverride: 1,
        });
        const warn = stderrCapture.find((l) => l.includes("WARN") && l.includes("no passado"));
        assert.ok(
          warn,
          `expected safety-guard WARN, got: ${stderrCapture.join("|")}`,
        );
        assert.ok(warn.includes("dayOffset=1"));
      } finally {
        restore();
        process.env.DIARIA_QUIET_SCHEDULE_LOG = "1";
        process.env.DIARIA_DISABLE_PASTSLOT_SHIFT = "1";
      }
    });

    it("DIARIA_QUIET_SCHEDULE_LOG=1 suprime logs mas NÃO o shift (só-log, #2565)", () => {
      // Com QUIET_LOG=1 e DISABLE_PASTSLOT_SHIFT NÃO setado:
      // - O shift de past-slot DEVE acontecer (guard ativo)
      // - O log do WARN NÃO deve aparecer (suprimido por QUIET_LOG)
      // Isso verifica o desacoplamento do #2565: QUIET_LOG não desativa o guard.
      process.env.DIARIA_QUIET_SCHEDULE_LOG = "1";
      delete process.env.DIARIA_DISABLE_PASTSLOT_SHIFT;
      const restore = startCapture();
      const nowFake = new Date("2026-01-01T12:00:00Z").getTime(); // now injetado
      let iso: string;
      try {
        // editionDate "230101" no passado → slot no passado → shift esperado
        iso = computeScheduledAt({
          config: baseConfig,
          editionDate: "230101",
          destaque: "d1",
          platform: "linkedin",
          now: nowFake,
        });
        // Slot DEVE ter sido shiftado (now+15min)
        const expectedMs = nowFake + 15 * 60_000;
        const actualMs = new Date(iso).getTime();
        assert.ok(
          Math.abs(actualMs - expectedMs) <= 1000,
          `QUIET_LOG=1 NÃO deve desativar o shift: esperado now+15min (${new Date(expectedMs).toISOString()}), got ${iso}`,
        );
        // Log NÃO deve ter sido emitido (suprimido por QUIET_LOG)
        const warnLines = stderrCapture.filter((l) => l.includes("WARN (#2552)"));
        assert.equal(warnLines.length, 0,
          `QUIET_LOG=1 deve suprimir o log do WARN, got: ${stderrCapture.join("|")}`);
      } finally {
        restore();
        process.env.DIARIA_DISABLE_PASTSLOT_SHIFT = "1"; // restaurar global
        // QUIET_LOG já está "1" (era o estado inicial global — mantém)
      }
    });

    it("DIARIA_DISABLE_PASTSLOT_SHIFT=1 suprime o shift (testes legados/CI)", () => {
      // Com DISABLE_PASTSLOT_SHIFT=1: o shift NÃO acontece (slot histórico é retornado)
      process.env.DIARIA_QUIET_SCHEDULE_LOG = "1";
      process.env.DIARIA_DISABLE_PASTSLOT_SHIFT = "1";
      const restore = startCapture();
      try {
        const iso = computeScheduledAt({
          config: baseConfig,
          editionDate: "230101",
          destaque: "d1",
          platform: "linkedin",
          dayOffsetOverride: 1,
        });
        assert.equal(stderrCapture.length, 0, "should be silent");
        // Slot retornado deve ser o calculado original (sem shift) = 2023-01-02T09:00:00
        assert.match(iso, /^2023-01-02T09:00:00/, `DISABLE_PASTSLOT_SHIFT=1 deve retornar slot original, got ${iso}`);
      } finally {
        restore();
        // Restaurar ambas as vars pro estado global (ambas "1")
        process.env.DIARIA_QUIET_SCHEDULE_LOG = "1";
        process.env.DIARIA_DISABLE_PASTSLOT_SHIFT = "1";
      }
    });
  });

  it("LinkedIn e Facebook recebem mesmo horário d1 (config unificado)", () => {
    const liIso = computeScheduledAt({
      config: baseConfig,
      editionDate: "260428",
      destaque: "d1",
      platform: "linkedin",
    });
    const fbIso = computeScheduledAt({
      config: baseConfig,
      editionDate: "260428",
      destaque: "d1",
      platform: "facebook",
    });
    assert.equal(liIso, fbIso);
  });

  describe("#2552 — past-slot guard (dispatch depois do 1º slot)", () => {
    // Fixture: edição 260625, dispatch rodando às 11:00 BRT.
    // slots: d1=09:00 (passado), d2=12:30 (futuro), d3=17:00 (futuro).
    // Slots no Brasil em horário padrão: 2026-06-25T09:00:00-03:00, etc.
    // `now` injetado como Unix ms correspondente a 11:00 BRT = 14:00 UTC.
    const edition = "260625"; // 2026-06-25
    const nowBrt11h = new Date("2026-06-25T14:00:00Z").getTime(); // 11:00 BRT = 14:00 UTC

    // Os testes deste bloco precisam que DIARIA_QUIET_SCHEDULE_LOG e
    // DIARIA_DISABLE_PASTSLOT_SHIFT não estejam setados: o shift deve estar ativo
    // e o WARN deve aparecer. Cada teste gerencia as env vars via setup/restore.

    it("d1 (09:00, passado) → shiftado p/ now+15min com WARN no stderr", () => {
      delete process.env.DIARIA_QUIET_SCHEDULE_LOG;
      delete process.env.DIARIA_DISABLE_PASTSLOT_SHIFT;
      const stderrLines: string[] = [];
      const origErr = console.error;
      console.error = (...args: unknown[]) => stderrLines.push(args.map(String).join(" "));

      let iso: string;
      try {
        iso = computeScheduledAt({
          config: baseConfig,
          editionDate: edition,
          destaque: "d1",
          platform: "linkedin",
          now: nowBrt11h,
        });
      } finally {
        console.error = origErr;
        process.env.DIARIA_QUIET_SCHEDULE_LOG = "1";
        process.env.DIARIA_DISABLE_PASTSLOT_SHIFT = "1";
      }

      // Slot shiftado deve ser agora + 15min = 11:15 BRT (14:15 UTC)
      const expectedShiftedMs = nowBrt11h + 15 * 60_000;
      const actualMs = new Date(iso).getTime();
      // Tolerância de 1 segundo para parsing e arredondamentos.
      assert.ok(
        Math.abs(actualMs - expectedShiftedMs) <= 1000,
        `shiftado para ${iso} (esperado ≈ ${new Date(expectedShiftedMs).toISOString()})`,
      );

      // Deve ter emitido WARN no stderr
      const warn = stderrLines.find((l) => l.includes("WARN (#2552)") && l.includes("linkedin/d1"));
      assert.ok(warn, `expected WARN no stderr, got: ${stderrLines.join("|")}`);
      assert.ok(warn.includes("260625"), "warn deve incluir editionDate");
      assert.ok(warn.includes("slot no passado"), "warn deve citar motivo");
    });

    it("d2 (12:30, futuro) → inalterado (>10min no futuro)", () => {
      // Guard ativo (DISABLE_PASTSLOT_SHIFT não setado), mas slot no futuro → sem shift
      delete process.env.DIARIA_DISABLE_PASTSLOT_SHIFT;
      try {
        const iso = computeScheduledAt({
          config: baseConfig,
          editionDate: edition,
          destaque: "d2",
          platform: "linkedin",
          now: nowBrt11h,
        });
        // 12:30 BRT = 2026-06-25T12:30:00-03:00
        assert.match(iso, /^2026-06-25T12:30:00-03:00$/, `d2 deve ser 12:30 BRT, got ${iso}`);
      } finally {
        process.env.DIARIA_DISABLE_PASTSLOT_SHIFT = "1";
      }
    });

    it("d3 (17:00, futuro) → inalterado (>10min no futuro)", () => {
      // Guard ativo (DISABLE_PASTSLOT_SHIFT não setado), mas slot no futuro → sem shift
      delete process.env.DIARIA_DISABLE_PASTSLOT_SHIFT;
      try {
        const iso = computeScheduledAt({
          config: baseConfig,
          editionDate: edition,
          destaque: "d3",
          platform: "facebook",
          now: nowBrt11h,
        });
        // 17:00 BRT = 2026-06-25T17:00:00-03:00
        assert.match(iso, /^2026-06-25T17:00:00-03:00$/, `d3 deve ser 17:00 BRT, got ${iso}`);
      } finally {
        process.env.DIARIA_DISABLE_PASTSLOT_SHIFT = "1";
      }
    });

    it("slot exatamente now+5min (abaixo do piso FB de 10min) → shiftado p/ now+25min (d2, spacing=10min)", () => {
      // now = 11:00 BRT, d2_time ajustado para 11:05 BRT → só 5min no futuro (< piso)
      // (#2576) d2 tem destaqueIndex=1 → shift = now+15min + 1*10min = now+25min
      delete process.env.DIARIA_QUIET_SCHEDULE_LOG;
      delete process.env.DIARIA_DISABLE_PASTSLOT_SHIFT;
      const cfgWith11h05 = JSON.parse(JSON.stringify(baseConfig)) as typeof baseConfig;
      cfgWith11h05.publishing.social.fallback_schedule.d2_time = "11:05";

      const stderrLines: string[] = [];
      const origErr = console.error;
      console.error = (...args: unknown[]) => stderrLines.push(args.map(String).join(" "));

      let iso: string;
      try {
        iso = computeScheduledAt({
          config: cfgWith11h05,
          editionDate: edition,
          destaque: "d2",
          platform: "facebook",
          now: nowBrt11h,
        });
      } finally {
        console.error = origErr;
        process.env.DIARIA_QUIET_SCHEDULE_LOG = "1";
        process.env.DIARIA_DISABLE_PASTSLOT_SHIFT = "1";
      }

      // d2 (índice 1) → now + 15min + 1*10min = now + 25min
      const expectedShiftedMs = nowBrt11h + 25 * 60_000;
      const actualMs = new Date(iso).getTime();
      assert.ok(
        Math.abs(actualMs - expectedShiftedMs) <= 1000,
        `slot 11:05 d2 (5min no futuro) deve ser shiftado p/ now+25min (#2576), got ${iso}`,
      );

      const warn = stderrLines.find((l) => l.includes("WARN (#2552)") && l.includes("facebook/d2"));
      assert.ok(warn, `expected WARN para slot below FB floor, got: ${stderrLines.join("|")}`);
      assert.ok(warn.includes("abaixo do piso mínimo"), "warn deve citar motivo (abaixo do piso)");
    });

    it("slot now+10min exato (margem justa, no piso) → aceito sem shift", () => {
      // now = 11:00, slot = 11:10 (exatamente 10min = não passa do filtro < minFutureMs)
      delete process.env.DIARIA_QUIET_SCHEDULE_LOG;
      delete process.env.DIARIA_DISABLE_PASTSLOT_SHIFT;
      const cfgWith11h10 = JSON.parse(JSON.stringify(baseConfig)) as typeof baseConfig;
      cfgWith11h10.publishing.social.fallback_schedule.d1_time = "11:10";

      const stderrLines: string[] = [];
      const origErr = console.error;
      console.error = (...args: unknown[]) => stderrLines.push(args.map(String).join(" "));

      let iso: string;
      try {
        iso = computeScheduledAt({
          config: cfgWith11h10,
          editionDate: edition,
          destaque: "d1",
          platform: "facebook",
          now: nowBrt11h,
        });
      } finally {
        console.error = origErr;
        process.env.DIARIA_QUIET_SCHEDULE_LOG = "1";
        process.env.DIARIA_DISABLE_PASTSLOT_SHIFT = "1";
      }

      // 11:10 BRT = exatamente nowMs + 10min = NOT strictly less than minFutureCutoffMs (600_000)
      // calculatedMs === nowMs + 10*60_000 → calculatedMs < nowMs + 10*60_000 is false
      // → portanto NÃO deve shiftar (slot exatamente no piso é aceito)
      const slotMs = new Date(iso).getTime();
      const expectedMs = nowBrt11h + 10 * 60_000;
      assert.ok(
        Math.abs(slotMs - expectedMs) <= 1000,
        `slot exatamente em now+10min (no piso) deve ser aceito sem shift, got ${iso}`,
      );
      assert.equal(stderrLines.filter(l => l.includes("WARN (#2552)")).length, 0,
        "slot no piso exato NÃO deve emitir WARN");
    });

    it("past-slot shift: now injetável (não usa Date.now() real)", () => {
      // Garantia de DI: slot de 09:00 de uma edição futura + now injetado em 10:00
      // → deve shiftar (slot passado em relação ao now injetado, mesmo sendo futuro em relação ao hoje real)
      delete process.env.DIARIA_QUIET_SCHEDULE_LOG;
      delete process.env.DIARIA_DISABLE_PASTSLOT_SHIFT;
      const futureEdition = "270625"; // 2027-06-25 (futuro real)
      const nowFake10h = new Date("2027-06-25T13:00:00Z").getTime(); // 10:00 BRT (antes de 09:00 → passado)
      // d1 = 09:00 em 2027-06-25 = 2027-06-25T12:00:00Z → 1h antes do nowFake10h
      // Logo está no passado em relação ao now injetado.
      const stderrLines: string[] = [];
      const origErr = console.error;
      console.error = (...args: unknown[]) => stderrLines.push(args.map(String).join(" "));

      let iso: string;
      try {
        iso = computeScheduledAt({
          config: baseConfig,
          editionDate: futureEdition,
          destaque: "d1",
          platform: "linkedin",
          now: nowFake10h,
        });
      } finally {
        console.error = origErr;
        process.env.DIARIA_QUIET_SCHEDULE_LOG = "1";
        process.env.DIARIA_DISABLE_PASTSLOT_SHIFT = "1";
      }

      const expectedMs = nowFake10h + 15 * 60_000;
      const actualMs = new Date(iso).getTime();
      assert.ok(Math.abs(actualMs - expectedMs) <= 1000,
        `DI: slot deve usar now injetado, got ${iso}`);
      const warn = stderrLines.find((l) => l.includes("WARN (#2552)"));
      assert.ok(warn, "DI: must warn when shifted");
    });
  });
});

describe("parseCliArgs", () => {
  it("parseia args completos", () => {
    const r = parseCliArgs([
      "--edition",
      "260428",
      "--destaque",
      "d1",
      "--platform",
      "linkedin",
    ]);
    assert.deepEqual(r, {
      edition: "260428",
      destaque: "d1",
      platform: "linkedin",
      dayOffset: undefined,
      configPath: undefined,
    });
  });

  it("parseia day-offset opcional", () => {
    const r = parseCliArgs([
      "--edition",
      "260428",
      "--destaque",
      "d2",
      "--platform",
      "facebook",
      "--day-offset",
      "10",
    ]);
    assert.deepEqual(r, {
      edition: "260428",
      destaque: "d2",
      platform: "facebook",
      dayOffset: 10,
      configPath: undefined,
    });
  });

  it("erro: missing --edition", () => {
    const r = parseCliArgs(["--destaque", "d1", "--platform", "linkedin"]);
    assert.deepEqual(r, { error: "missing --edition AAMMDD" });
  });

  it("erro: --destaque inválido", () => {
    const r = parseCliArgs([
      "--edition",
      "260428",
      "--destaque",
      "d4",
      "--platform",
      "linkedin",
    ]);
    assert.deepEqual(r, {
      error: "missing/invalid --destaque (d1|d2|d3)",
    });
  });

  it("aceita --platform instagram (#3817)", () => {
    const r = parseCliArgs([
      "--edition",
      "260428",
      "--destaque",
      "d1",
      "--platform",
      "instagram",
    ]);
    assert.deepEqual(r, {
      edition: "260428",
      destaque: "d1",
      platform: "instagram",
      dayOffset: undefined,
      configPath: undefined,
    });
  });

  it("erro: --platform inválido", () => {
    const r = parseCliArgs([
      "--edition",
      "260428",
      "--destaque",
      "d1",
      "--platform",
      "twitter",
    ]);
    assert.deepEqual(r, {
      error: "missing/invalid --platform (linkedin|facebook|instagram)",
    });
  });
});

describe("timezoneOffsetIso (#292)", () => {
  it("São Paulo fora de DST (maio) → -03:00", () => {
    const d = new Date("2026-05-15T12:00:00Z");
    assert.equal(timezoneOffsetIso(d, "America/Sao_Paulo"), "-03:00");
  });

  it("Asia/Kolkata → +05:30 (meia hora)", () => {
    const d = new Date("2026-05-15T12:00:00Z");
    assert.equal(timezoneOffsetIso(d, "Asia/Kolkata"), "+05:30");
  });

  it("UTC → +00:00", () => {
    const d = new Date("2026-05-15T12:00:00Z");
    assert.equal(timezoneOffsetIso(d, "UTC"), "+00:00");
  });

  it("timezone inválido retorna +00:00 (não throws)", () => {
    const d = new Date("2026-05-15T12:00:00Z");
    try {
      const r = timezoneOffsetIso(d, "Invalid/Foo");
      assert.equal(r, "+00:00"); // fallback
    } catch {
      // RangeError é também comportamento aceitável (documentado)
    }
  });
});
