import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  checkScheduleLeadTime,
  assertScheduleLeadTime,
  formatLeadTime,
  SCHEDULE_AT_MIN_LEAD_MS,
  SCHEDULE_AT_WARNING_PREFIX,
} from "../scripts/lib/schedule-guard.ts";

/**
 * test/schedule-guard.test.ts (#7047)
 *
 * `scripts/lib/schedule-guard.ts` extrai o guard de antecedência mínima
 * (#7042) pra um módulo compartilhado, aplicado nos 3 scripts que ainda só
 * tinham o guard "no passado" (`clarice-schedule-sends.ts`,
 * `clarice-schedule-ramp.ts`, `publish-monthly.ts`) — exatamente o estado em
 * que `clarice-schedule-group.ts` estava antes do incidente de 01/09/2026
 * (3 campanhas Clarice destinadas ao dia seguinte saindo no mesmo dia).
 *
 * Mesma disciplina de teste do #7042
 * (`test/clarice-schedule-group-4662-4668.test.ts`): `now` sempre INJETADO
 * com data fixa — nunca `new Date()` real.
 */

const NOW = new Date("2026-09-01T14:00:00.000Z");

describe("checkScheduleLeadTime — antecedência mínima (#7047, generaliza o #7042)", () => {
  it("REGRESSÃO: 30s no futuro (o caso EXATO do incidente #7042) → { ok: false }", () => {
    const raw = new Date(NOW.getTime() + 30_000).toISOString();
    const result = checkScheduleLeadTime(raw, { now: NOW });
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("unreachable");
    assert.match(result.error, /30s/);
    assert.match(result.error, /antecedência mínima/i);
    assert.match(result.error, /2h/);
    assert.match(result.error, /--allow-imminent/);
  });

  it("5 min no futuro → { ok: false }", () => {
    const raw = new Date(NOW.getTime() + 5 * 60_000).toISOString();
    const result = checkScheduleLeadTime(raw, { now: NOW });
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("unreachable");
    assert.match(result.error, /5 min/);
  });

  it("BORDA: exatamente no limite (now + SCHEDULE_AT_MIN_LEAD_MS) → sucesso — limite inclusivo", () => {
    const raw = new Date(NOW.getTime() + SCHEDULE_AT_MIN_LEAD_MS).toISOString();
    const result = checkScheduleLeadTime(raw, { now: NOW });
    assert.equal(result.ok, true, `esperava sucesso: ${!result.ok ? result.error : ""}`);
  });

  it("BORDA: 1ms antes do limite → { ok: false } — corte estrito (< min lead, não <=)", () => {
    const raw = new Date(NOW.getTime() + SCHEDULE_AT_MIN_LEAD_MS - 1).toISOString();
    const result = checkScheduleLeadTime(raw, { now: NOW });
    assert.equal(result.ok, false);
  });

  it("data futura o bastante mas SEM canonicalHourUtc → sucesso sem warning (caller sem convenção documentada, ex: publish-monthly.ts)", () => {
    const raw = "2026-09-02T17:00:00.000Z"; // horário arbitrário
    const result = checkScheduleLeadTime(raw, { now: NOW });
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error("unreachable");
    assert.equal(result.warning, undefined, "sem canonicalHourUtc não deveria nunca gerar warning de horário");
  });

  it("minLeadMs customizado é respeitado (não hardcoded 2h)", () => {
    const raw = new Date(NOW.getTime() + 10 * 60_000).toISOString(); // 10min
    const insuf = checkScheduleLeadTime(raw, { now: NOW, minLeadMs: 30 * 60_000 }); // exige 30min
    assert.equal(insuf.ok, false);
    const suf = checkScheduleLeadTime(raw, { now: NOW, minLeadMs: 5 * 60_000 }); // exige 5min
    assert.equal(suf.ok, true);
  });

  it("contextIssues aparece na mensagem quando passado", () => {
    const raw = new Date(NOW.getTime() + 30_000).toISOString();
    const result = checkScheduleLeadTime(raw, { now: NOW, contextIssues: "#7042, #7047" });
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("unreachable");
    assert.match(result.error, /#7042, #7047/);
  });

  it("suggestNextCanonical injeta a sugestão de horário do PRÓXIMO dia sem montar string à mão", () => {
    const raw = new Date(NOW.getTime() + 30_000).toISOString();
    const result = checkScheduleLeadTime(raw, {
      now: NOW,
      suggestNextCanonical: (tomorrowIso) => `${tomorrowIso}T09:00:00.000Z`,
    });
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("unreachable");
    assert.match(result.error, /2026-09-02T09:00:00\.000Z/);
  });

  it("immediateDispatchFlagName nomeia o caminho de disparo imediato do caller na mensagem", () => {
    const raw = new Date(NOW.getTime() + 30_000).toISOString();
    const result = checkScheduleLeadTime(raw, { now: NOW, immediateDispatchFlagName: "--send-now" });
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("unreachable");
    assert.match(result.error, /--send-now/);
  });

  describe("allowImminent=true (escape hatch nomeado)", () => {
    it("30s no futuro COM allowImminent=true → sucesso", () => {
      const raw = new Date(NOW.getTime() + 30_000).toISOString();
      const result = checkScheduleLeadTime(raw, { now: NOW, allowImminent: true });
      assert.equal(result.ok, true, `esperava sucesso: ${!result.ok ? result.error : ""}`);
    });

    it("allowImminent=true ainda avalia canonicalHourUtc — só desliga a antecedência", () => {
      const raw = new Date(NOW.getTime() + 30_000).toISOString(); // arbitrário, não-canônico
      const result = checkScheduleLeadTime(raw, { now: NOW, allowImminent: true, canonicalHourUtc: 9, canonicalHourLabel: "06:00 BRT" });
      assert.equal(result.ok, true);
      if (!result.ok) throw new Error("unreachable");
      assert.ok(result.warning, "warning de horário não-canônico continua ativo mesmo com allowImminent");
    });
  });
});

describe("checkScheduleLeadTime — aviso de horário fora do canônico (parametrizado, nunca hardcoded)", () => {
  it("horário canônico exato (09:00:00.000 UTC) → sucesso, SEM warning", () => {
    const raw = "2026-09-02T09:00:00.000Z";
    const result = checkScheduleLeadTime(raw, { now: NOW, canonicalHourUtc: 9, canonicalHourLabel: "06:00 BRT" });
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error("unreachable");
    assert.equal(result.warning, undefined);
  });

  it("horário FORA do canônico → sucesso, COM warning nomeado (prefixo estável, não bloqueia)", () => {
    const raw = "2026-09-02T17:00:00.000Z";
    const result = checkScheduleLeadTime(raw, { now: NOW, canonicalHourUtc: 9, canonicalHourLabel: "06:00 BRT" });
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error("unreachable");
    assert.ok(result.warning);
    assert.ok(result.warning!.startsWith(SCHEDULE_AT_WARNING_PREFIX));
    assert.match(result.warning!, /fora do horário canônico/i);
    assert.match(result.warning!, /09:00 UTC/);
    assert.match(result.warning!, /06:00 BRT/);
  });

  it("canonicalHourUtc diferente (ex: outro fluxo com convenção própria) é respeitado, não hardcoded pra Clarice", () => {
    const raw = "2026-09-02T12:00:00.000Z";
    const okAtNoon = checkScheduleLeadTime(raw, { now: NOW, canonicalHourUtc: 12 });
    assert.equal(okAtNoon.ok, true);
    if (!okAtNoon.ok) throw new Error("unreachable");
    assert.equal(okAtNoon.warning, undefined, "12:00 UTC é o canônico deste caller — sem warning");

    const warnAt9 = checkScheduleLeadTime(raw, { now: NOW, canonicalHourUtc: 9 });
    assert.equal(warnAt9.ok, true);
    if (!warnAt9.ok) throw new Error("unreachable");
    assert.ok(warnAt9.warning, "12:00 UTC diverge do canônico=9 deste caller — warning esperado");
  });

  it("minuto/segundo/milissegundo não-zero também dispara o warning (mesmo horário-hora)", () => {
    for (const raw of ["2026-09-02T09:05:00.000Z", "2026-09-02T09:00:05.000Z", "2026-09-02T09:00:00.500Z"]) {
      const result = checkScheduleLeadTime(raw, { now: NOW, canonicalHourUtc: 9 });
      assert.equal(result.ok, true);
      if (!result.ok) throw new Error("unreachable");
      assert.ok(result.warning, `${raw} deveria gerar warning (não é o instante canônico exato)`);
    }
  });
});

describe("checkScheduleLeadTime — ISO inválido", () => {
  it("string não-data → { ok: false }", () => {
    const result = checkScheduleLeadTime("não-é-uma-data", { now: NOW });
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("unreachable");
    assert.match(result.error, /não é ISO 8601 válido/);
  });
});

describe("formatLeadTime — legível, sem locale ICU", () => {
  it("segundos", () => assert.equal(formatLeadTime(30_000), "30s"));
  it("minutos", () => assert.equal(formatLeadTime(5 * 60_000), "5 min"));
  it("horas exatas", () => assert.equal(formatLeadTime(2 * 3600_000), "2h"));
  it("horas com minutos residuais (90min → 1h30min)", () => assert.equal(formatLeadTime(90 * 60_000), "1h30min"));
  it("nunca negativo (clamp em 0)", () => assert.equal(formatLeadTime(-1000), "0s"));
});

describe("assertScheduleLeadTime — wrapper que LANÇA (padrão de assertScheduledAtFuture/assertDatesFuture)", () => {
  it("antecedência insuficiente → lança com a mesma mensagem de checkScheduleLeadTime", () => {
    const raw = new Date(NOW.getTime() + 30_000).toISOString();
    assert.throws(
      () => assertScheduleLeadTime(raw, { now: NOW }),
      /antecedência mínima/i,
    );
  });

  it("antecedência suficiente → não lança", () => {
    const raw = new Date(NOW.getTime() + SCHEDULE_AT_MIN_LEAD_MS).toISOString();
    assert.doesNotThrow(() => assertScheduleLeadTime(raw, { now: NOW }));
  });

  it("allowImminent=true → não lança mesmo com antecedência insuficiente", () => {
    const raw = new Date(NOW.getTime() + 30_000).toISOString();
    assert.doesNotThrow(() => assertScheduleLeadTime(raw, { now: NOW, allowImminent: true }));
  });

  it("sucesso COM warning → logFn é chamado com o texto do warning", () => {
    const raw = "2026-09-02T17:00:00.000Z";
    const calls: string[] = [];
    assertScheduleLeadTime(raw, { now: NOW, canonicalHourUtc: 9, canonicalHourLabel: "06:00 BRT" }, (m) => calls.push(m));
    assert.equal(calls.length, 1);
    assert.match(calls[0], /fora do horário canônico/i);
  });

  it("sucesso SEM warning (horário canônico ou sem canonicalHourUtc) → logFn NUNCA chamado", () => {
    const raw = "2026-09-02T09:00:00.000Z";
    const calls: string[] = [];
    assertScheduleLeadTime(raw, { now: NOW, canonicalHourUtc: 9 }, (m) => calls.push(m));
    assert.equal(calls.length, 0);
  });
});
