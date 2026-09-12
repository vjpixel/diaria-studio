import { test } from "node:test";
import assert from "node:assert/strict";
import { civilMonthWindow, isInCivilMonthWindow } from "../scripts/lib/civil-month-window.ts";

// #8024 — fronteira do mês civil BRT (dia 1, 00:00 → dia 1 do mês seguinte,
// 00:00), usada por computeCohortStats pra "Falta 1º envio no mês".

test("civilMonthWindow: início do mês em BRT, não em UTC (00:00 BRT = 03:00 UTC)", () => {
  const w = civilMonthWindow(new Date("2026-06-15T12:00:00Z"));
  assert.equal(w.start.toISOString(), "2026-06-01T03:00:00.000Z", "início = 01/06 00:00 BRT");
  assert.equal(w.end.toISOString(), "2026-07-01T03:00:00.000Z", "fim = 01/07 00:00 BRT (próximo mês)");
});

test("civilMonthWindow: dezembro vira o ano corretamente", () => {
  const w = civilMonthWindow(new Date("2026-12-20T12:00:00Z"));
  assert.equal(w.start.toISOString(), "2026-12-01T03:00:00.000Z");
  assert.equal(w.end.toISOString(), "2027-01-01T03:00:00.000Z", "fim cai em janeiro do ano seguinte");
});

test("civilMonthWindow: instante logo antes da virada de mês (BRT) ainda cai no mês anterior", () => {
  // 2026-06-01T02:59:59Z = 2026-05-31T23:59:59 BRT — ainda maio.
  const w = civilMonthWindow(new Date("2026-06-01T02:59:59Z"));
  assert.equal(w.start.toISOString(), "2026-05-01T03:00:00.000Z");
  assert.equal(w.end.toISOString(), "2026-06-01T03:00:00.000Z");
});

test("isInCivilMonthWindow: null/undefined/data inválida → false, nunca lança", () => {
  const w = civilMonthWindow(new Date("2026-06-15T12:00:00Z"));
  assert.equal(isInCivilMonthWindow(null, w), false);
  assert.equal(isInCivilMonthWindow(undefined, w), false);
  assert.equal(isInCivilMonthWindow("não-é-uma-data", w), false);
});

test("isInCivilMonthWindow: dentro da janela → true; mês anterior/seguinte → false", () => {
  const w = civilMonthWindow(new Date("2026-06-15T12:00:00Z"));
  assert.equal(isInCivilMonthWindow("2026-06-01T03:00:00.000Z", w), true, "início inclusivo");
  assert.equal(isInCivilMonthWindow("2026-06-30T23:00:00Z", w), true, "dentro do mês");
  assert.equal(isInCivilMonthWindow("2026-07-01T03:00:00.000Z", w), false, "fim exclusivo");
  assert.equal(isInCivilMonthWindow("2026-05-31T23:00:00Z", w), false, "mês anterior");
});
