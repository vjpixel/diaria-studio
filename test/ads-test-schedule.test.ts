/**
 * test/ads-test-schedule.test.ts (#5845)
 *
 * Lógica pura de `scripts/lib/ads-test-schedule.ts` — derivação de datas
 * do teste de 3 canais pagos. Cobertura obrigatória do critério de pronto
 * da issue: "1º domingo ≥ D+42" + virada de mês/ano. Datas sempre injetadas
 * como literais — nunca `Date.now()`/`new Date()` real.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseDateOnly,
  addDays,
  daysBetween,
  isSunday,
  firstSundayOnOrAfter,
  deriveAdsTestSchedule,
} from "../scripts/lib/ads-test-schedule.ts";

describe("#5845 — ads-test-schedule: parseDateOnly/addDays/daysBetween", () => {
  it("parseDateOnly aceita YYYY-MM-DD válido", () => {
    const d = parseDateOnly("2026-08-26");
    assert.equal(d.getUTCFullYear(), 2026);
    assert.equal(d.getUTCMonth(), 7); // 0-indexed
    assert.equal(d.getUTCDate(), 26);
  });

  it("parseDateOnly lança em formato inválido", () => {
    assert.throws(() => parseDateOnly("26/08/2026"));
    assert.throws(() => parseDateOnly("2026-8-26"));
    assert.throws(() => parseDateOnly(""));
  });

  it("parseDateOnly lança em componente fora de faixa (mês 13)", () => {
    assert.throws(() => parseDateOnly("2026-13-01"));
  });

  it("addDays soma dias corridos, inclusive virada de mês", () => {
    assert.equal(addDays("2026-08-26", 14), "2026-09-09");
    assert.equal(addDays("2026-08-30", 3), "2026-09-02");
  });

  it("addDays cruza virada de ANO", () => {
    assert.equal(addDays("2026-12-28", 5), "2027-01-02");
  });

  it("addDays lida com fevereiro em ano bissexto (2028)", () => {
    assert.equal(addDays("2028-02-27", 3), "2028-03-01");
  });

  it("addDays aceita delta negativo", () => {
    assert.equal(addDays("2026-08-26", -1), "2026-08-25");
  });

  it("daysBetween mede a diferença corrida entre duas datas", () => {
    assert.equal(daysBetween("2026-08-26", "2026-09-09"), 14);
    assert.equal(daysBetween("2026-09-09", "2026-08-26"), -14);
    assert.equal(daysBetween("2026-08-26", "2026-08-26"), 0);
  });
});

describe("#5845 — ads-test-schedule: isSunday / firstSundayOnOrAfter", () => {
  it("isSunday identifica domingo corretamente", () => {
    // 2026-08-30 é domingo (confirmado: 2026-08-26 é quarta-feira).
    assert.equal(isSunday("2026-08-30"), true);
    assert.equal(isSunday("2026-08-26"), false);
  });

  it("firstSundayOnOrAfter: data já é domingo → retorna a própria data", () => {
    assert.equal(firstSundayOnOrAfter("2026-08-30"), "2026-08-30");
  });

  it("firstSundayOnOrAfter: avança até o próximo domingo quando não é domingo", () => {
    // 2026-08-26 é quarta (dayOfWeek=3) → próximo domingo é 2026-08-30.
    assert.equal(firstSundayOnOrAfter("2026-08-26"), "2026-08-30");
  });

  it("firstSundayOnOrAfter: cruza virada de mês", () => {
    // 2026-09-29 é terça (confirmar via cálculo) → próximo domingo cai em outubro.
    const result = firstSundayOnOrAfter("2026-09-29");
    assert.equal(isSunday(result), true);
    assert.ok(result >= "2026-09-29");
    assert.ok(result <= addDays("2026-09-29", 6));
  });
});

describe("#5845 — ads-test-schedule: deriveAdsTestSchedule", () => {
  it("D0 = 2026-08-26 (recomendação real do protocolo) — deriva todos os marcos corretamente", () => {
    const schedule = deriveAdsTestSchedule("2026-08-26");
    assert.equal(schedule.d0, "2026-08-26");
    assert.equal(schedule.fim_janela, "2026-09-09"); // D+14
    assert.equal(schedule.religar_brevo, "2026-09-16"); // D+21
    assert.equal(schedule.coorte_madura, "2026-10-06"); // D+41

    // D+42 puro seria 2026-10-07 (quarta-feira) — apuração deve ser o
    // 1º domingo >= essa data, não a data crua.
    const d42 = "2026-10-07";
    assert.notEqual(schedule.apuracao_snapshot, d42);
    assert.equal(isSunday(schedule.apuracao_snapshot), true);
    assert.ok(schedule.apuracao_snapshot >= d42);
  });

  it("regra '1º domingo ≥ D+42' — caso em que D+42 JÁ é domingo (usa a própria data, não pula pro próximo)", () => {
    // Escolhido de propósito: D0 tal que D+42 caia exatamente num domingo.
    // 2026-08-26 + 42 = 2026-10-07 (quarta). Precisamos de um D0 cujo D+42
    // seja domingo — deslocar D0 até D+42 cair num domingo: 2026-10-07 é
    // quarta (dayOfWeek 3); domingo mais próximo ANTES seria 2026-10-04.
    // D0 = 2026-10-04 - 42 dias = 2026-08-23.
    const d0 = "2026-08-23";
    const schedule = deriveAdsTestSchedule(d0);
    const d42 = addDays(d0, 42);
    assert.equal(isSunday(d42), true, "pré-condição do teste: D+42 deve cair num domingo");
    assert.equal(schedule.apuracao_snapshot, d42, "quando D+42 já é domingo, a apuração é o próprio D+42, sem pular pro seguinte");
  });

  it("virada de ANO: D0 em dezembro produz marcos corretos no ano seguinte", () => {
    const schedule = deriveAdsTestSchedule("2026-12-20");
    assert.equal(schedule.fim_janela, "2027-01-03");
    assert.equal(schedule.religar_brevo, "2027-01-10");
    assert.equal(schedule.coorte_madura, "2027-01-30");
    assert.equal(isSunday(schedule.apuracao_snapshot), true);
    assert.ok(schedule.apuracao_snapshot >= addDays("2026-12-20", 42));
  });

  it("virada de MÊS: D0 em 30/01 (mês curto seguinte) deriva sem erro", () => {
    const schedule = deriveAdsTestSchedule("2026-01-30");
    assert.equal(schedule.fim_janela, "2026-02-13");
    assert.equal(isSunday(schedule.apuracao_snapshot), true);
  });

  it("lança se o D0 for malformado", () => {
    assert.throws(() => deriveAdsTestSchedule("26-08-2026"));
  });
});
