/**
 * #3011: shouldShowStalenessNote — comparação pura entre o timestamp de uma
 * seção com dado pré-computado (KV) e o timestamp do cabeçalho da dashboard.
 * Fixtures pedidas na issue: mesmo dia+hora (nota NÃO aparece), dias
 * diferentes (nota aparece), mesmo dia mas hora diferente (nota aparece).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldShowStalenessNote, DEFAULT_STALENESS_TOLERANCE_MINUTES } from "../workers/brevo-dashboard/src/staleness.ts";

test("shouldShowStalenessNote — mesmo dia+hora (poucos segundos de jitter) → nota NÃO aparece", () => {
  const header = new Date("2026-07-06T09:00:03.000Z");
  const section = "2026-07-06T09:00:00.000Z";
  assert.equal(shouldShowStalenessNote(section, header), false);
});

test("shouldShowStalenessNote — dias diferentes → nota aparece", () => {
  const header = new Date("2026-07-06T09:00:00.000Z");
  const section = "2026-07-05T09:00:00.000Z"; // 1 dia antes
  assert.equal(shouldShowStalenessNote(section, header), true);
});

test("shouldShowStalenessNote — mesmo dia mas hora diferente → nota aparece", () => {
  const header = new Date("2026-07-06T14:00:00.000Z");
  const section = "2026-07-06T09:00:00.000Z"; // mesmo dia, 5h antes
  assert.equal(shouldShowStalenessNote(section, header), true);
});

test("shouldShowStalenessNote — jitter dentro da tolerância default (5min) não conta como divergente", () => {
  const header = new Date("2026-07-06T09:03:00.000Z");
  const section = "2026-07-06T09:00:00.000Z"; // 3min de diferença
  assert.equal(shouldShowStalenessNote(section, header), false);
});

test("shouldShowStalenessNote — logo acima da tolerância já diverge", () => {
  const header = new Date("2026-07-06T09:06:01.000Z");
  const section = "2026-07-06T09:00:00.000Z"; // 6min01s de diferença
  assert.equal(shouldShowStalenessNote(section, header), true);
});

test("shouldShowStalenessNote — tolerância customizável", () => {
  const header = new Date("2026-07-06T09:20:00.000Z");
  const section = "2026-07-06T09:00:00.000Z"; // 20min de diferença
  assert.equal(shouldShowStalenessNote(section, header, 30), false, "dentro de 30min de tolerância");
  assert.equal(shouldShowStalenessNote(section, header, 5), true, "fora de 5min de tolerância");
});

test("shouldShowStalenessNote — sectionIso ausente/inválido → false (sem dado, sem nota)", () => {
  const header = new Date("2026-07-06T09:00:00.000Z");
  assert.equal(shouldShowStalenessNote(null, header), false);
  assert.equal(shouldShowStalenessNote(undefined, header), false);
  assert.equal(shouldShowStalenessNote("not-a-date", header), false);
});

test("DEFAULT_STALENESS_TOLERANCE_MINUTES é 5", () => {
  assert.equal(DEFAULT_STALENESS_TOLERANCE_MINUTES, 5);
});
