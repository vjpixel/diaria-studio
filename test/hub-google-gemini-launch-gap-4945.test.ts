/**
 * test/hub-google-gemini-launch-gap-4945.test.ts (#4945)
 *
 * Guard anti-regressão: a prosa hardcoded de `google-gemini.ts` (seção de
 * ritmo de lançamento + resposta do FAQ correspondente) afirmava, em dois
 * lugares, "5 lançamentos em 107 dias" para o primeiro surto — mas as duas
 * datas que a própria prosa cita para delimitar esse surto (27 de agosto de
 * 2025, data do Gemini 2.5 Flash Image, a 19 de dezembro de 2025, início do
 * hiato de 63 dias citado no parágrafo seguinte) dão 114 dias, não 107.
 *
 * Este teste computa a diferença real entre as duas datas (via
 * `Date.UTC`, não uma reimplementação paralela de `formatDateLabel`) e trava
 * que o número citado na prosa bate com o cálculo — não com o literal
 * "107" nem com o literal "114": se o dataset mudar de novo e as datas do
 * primeiro surto se moverem, o teste recalcula e o número esperado se move
 * junto, mas o texto (ainda transcrito à mão, ver nota no topo de
 * `google-gemini.ts` sobre o escopo do #4922) segue precisando ser
 * atualizado manualmente para não quebrar aqui.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getGoogleGeminiHub } from "../scripts/lib/hubs/google-gemini.ts";

const FIRST_SURGE_START = "2025-08-27"; // Gemini 2.5 Flash Image
const FIRST_SURGE_END = "2025-12-19"; // Gemini 3 Flash e Manus 1.6 Max — início do hiato de 63 dias

function isoDaysBetween(startIso: string, endIso: string): number {
  const [sy, sm, sd] = startIso.split("-").map(Number);
  const [ey, em, ed] = endIso.split("-").map(Number);
  const start = Date.UTC(sy, sm - 1, sd);
  const end = Date.UTC(ey, em - 1, ed);
  return Math.round((end - start) / (1000 * 60 * 60 * 24));
}

describe("#4945 — google-gemini.ts cita a duração real do 1º surto de lançamentos", () => {
  const expectedDays = isoDaysBetween(FIRST_SURGE_START, FIRST_SURGE_END);

  it("sanity: o intervalo entre as duas datas do 1º surto é 114 dias (se este assert quebrar, as datas citadas na prosa mudaram e o texto precisa ser revisado à mão, não só o teste)", () => {
    assert.equal(expectedDays, 114);
  });

  const hub = getGoogleGeminiHub();

  it("seção de ritmo de lançamento cita a duração correta do 1º surto", () => {
    const heading = "Com que ritmo o Google lança modelo novo de Gemini (e de Nano Banana)?";
    const section = hub.sections.find((s) => s.heading === heading);
    assert.ok(section, "sanity: seção de ritmo de lançamento não encontrada");
    assert.ok(
      section!.paragraphs[0].includes(`5 lançamentos couberam em ${expectedDays} dias`),
      `esperado "5 lançamentos couberam em ${expectedDays} dias" no 1º parágrafo da seção de ritmo, veio: "${section!.paragraphs[0].slice(0, 160)}..."`,
    );
    assert.ok(
      !section!.paragraphs[0].includes("em 107 dias"),
      `seção de ritmo ainda cita o número desatualizado "107 dias": "${section!.paragraphs[0].slice(0, 160)}..."`,
    );
  });

  it("FAQ de lançamentos cita a duração correta do 1º surto", () => {
    const launchFaq = hub.faq.find((f) => /Foram \d+ lançamentos/.test(f.answer));
    assert.ok(launchFaq, "sanity: FAQ de lançamentos não encontrado");
    assert.ok(
      launchFaq!.answer.includes(`5 modelos em ${expectedDays} dias`),
      `esperado "5 modelos em ${expectedDays} dias" na resposta do FAQ de lançamentos, veio: "${launchFaq!.answer}"`,
    );
    assert.ok(
      !launchFaq!.answer.includes("em 107 dias"),
      `FAQ de lançamentos ainda cita o número desatualizado "107 dias": "${launchFaq!.answer}"`,
    );
  });
});
