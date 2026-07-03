/**
 * test/next-edition-date.test.ts (#2068)
 *
 * Testes determinísticos para nextEditionDate (cálculo D+1 em BRT).
 * Cobre viradas de mês, virada de ano, e impacto de DST no Brasil
 * (BRT = UTC-3 fixo; não há horário de verão desde 2019 — mas o teste
 * verifica comportamento em torno de meia-noite UTC para garantir que
 * o fuso seja respeitado corretamente).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  nextEditionDate,
  datePartsInTz,
  toAammdd,
  zonedTimeToUtc,
  BRT_TIMEZONE,
} from "../scripts/lib/next-edition-date.ts";

describe("nextEditionDate (#2068)", () => {
  it("dia normal: pesquisa em 2026-04-26 BRT → edição 260427", () => {
    // 2026-04-26 15:00 BRT = 2026-04-26 18:00 UTC
    const now = new Date("2026-04-26T18:00:00Z");
    assert.equal(nextEditionDate(now), "260427");
  });

  it("virada de mês: pesquisa em 2026-04-30 BRT → edição 260501", () => {
    const now = new Date("2026-04-30T18:00:00Z");
    assert.equal(nextEditionDate(now), "260501");
  });

  it("virada de ano: pesquisa em 2026-12-31 BRT → edição 270101", () => {
    const now = new Date("2026-12-31T18:00:00Z");
    assert.equal(nextEditionDate(now), "270101");
  });

  it("virada de mês (fevereiro ano comum): pesquisa em 2026-02-28 BRT → edição 260301", () => {
    const now = new Date("2026-02-28T18:00:00Z");
    assert.equal(nextEditionDate(now), "260301");
  });

  it("virada de mês (fevereiro bissexto): pesquisa em 2028-02-28 BRT → edição 280229", () => {
    const now = new Date("2028-02-28T18:00:00Z");
    assert.equal(nextEditionDate(now), "280229");
  });

  it("meia-noite UTC é ainda ontem BRT (UTC-3)", () => {
    // 2026-05-01T00:00:00Z = 2026-04-30T21:00:00 BRT (ainda dia 30 em BRT)
    // Logo a edição deve ser 260501 (amanhã em relação ao dia BRT atual = 30)
    const now = new Date("2026-05-01T00:00:00Z");
    assert.equal(nextEditionDate(now), "260501");
  });

  it("três horas após meia-noite UTC já é o dia seguinte BRT (UTC-3 = 03:00 local)", () => {
    // 2026-05-01T03:00:00Z = 2026-05-01T00:00:00 BRT (exatamente meia-noite BRT)
    // hoje BRT = 01/05, amanhã = 260502
    const now = new Date("2026-05-01T03:00:00Z");
    assert.equal(nextEditionDate(now), "260502");
  });
});

describe("datePartsInTz (#2068)", () => {
  it("extrai partes corretas em BRT para data normal", () => {
    const date = new Date("2026-04-26T18:00:00Z"); // 15:00 BRT
    const parts = datePartsInTz(date, BRT_TIMEZONE);
    assert.deepEqual(parts, { year: 2026, month: 4, day: 26 });
  });

  it("respeita UTC-3 em torno de meia-noite", () => {
    // 2026-04-27T01:00:00Z = 2026-04-26T22:00:00 BRT → ainda dia 26
    const date = new Date("2026-04-27T01:00:00Z");
    const parts = datePartsInTz(date, BRT_TIMEZONE);
    assert.deepEqual(parts, { year: 2026, month: 4, day: 26 });
  });

  it("03:00 UTC já é meia-noite BRT — dia avança", () => {
    // 2026-04-27T03:00:00Z = 2026-04-27T00:00:00 BRT → dia 27
    const date = new Date("2026-04-27T03:00:00Z");
    const parts = datePartsInTz(date, BRT_TIMEZONE);
    assert.deepEqual(parts, { year: 2026, month: 4, day: 27 });
  });
});

describe("toAammdd (#2068)", () => {
  it("formata corretamente com padding", () => {
    assert.equal(toAammdd({ year: 2026, month: 4, day: 7 }), "260407");
  });

  it("formata corretamente sem padding necessário", () => {
    assert.equal(toAammdd({ year: 2026, month: 12, day: 31 }), "261231");
  });

  it("virada de milênio funciona (YY é slice -2)", () => {
    assert.equal(toAammdd({ year: 2100, month: 1, day: 1 }), "000101");
  });
});

// #2910: precisão de minuto (nextEditionDate/datePartsInTz só operam em dia)
// — usada pra derivar a fronteira do ciclo de cobrança Brevo (dia 4, 15:45 BRT).
describe("zonedTimeToUtc (#2910)", () => {
  it("15:45 BRT (UTC-3, sem DST) vira 18:45 UTC", () => {
    const d = zonedTimeToUtc(2026, 7, 4, 15, 45, 0, BRT_TIMEZONE);
    assert.equal(d.toISOString(), "2026-07-04T18:45:00.000Z");
  });

  it("meia-noite BRT vira 03:00 UTC", () => {
    const d = zonedTimeToUtc(2026, 6, 1, 0, 0, 0, BRT_TIMEZONE);
    assert.equal(d.toISOString(), "2026-06-01T03:00:00.000Z");
  });

  it("virada de mês/ano: 31/dez 23:59:59 BRT vira 1/jan 02:59:59 UTC", () => {
    const d = zonedTimeToUtc(2026, 12, 31, 23, 59, 59, BRT_TIMEZONE);
    assert.equal(d.toISOString(), "2027-01-01T02:59:59.000Z");
  });

  it("UTC (offset 0) é identidade", () => {
    const d = zonedTimeToUtc(2026, 7, 4, 15, 45, 0, "UTC");
    assert.equal(d.toISOString(), "2026-07-04T15:45:00.000Z");
  });
});
