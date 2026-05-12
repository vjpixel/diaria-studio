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
      }
    });

    it("DIARIA_QUIET_SCHEDULE_LOG=1 suprime tudo (CI/teste)", () => {
      process.env.DIARIA_QUIET_SCHEDULE_LOG = "1";
      const restore = startCapture();
      try {
        computeScheduledAt({
          config: baseConfig,
          editionDate: "230101",
          destaque: "d1",
          platform: "linkedin",
          dayOffsetOverride: 1,
        });
        assert.equal(stderrCapture.length, 0, "should be silent");
      } finally {
        restore();
        delete process.env.DIARIA_QUIET_SCHEDULE_LOG;
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
      error: "missing/invalid --platform (linkedin|facebook)",
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
