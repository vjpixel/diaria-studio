/**
 * test/hub-google-gemini-start-date-4895.test.ts (#4895)
 *
 * Guard anti-regressão: a prosa hardcoded de `google-gemini.ts` (INTRO,
 * metaDescription, introHeading, seção de ritmo de lançamento, resposta do
 * FAQ de lançamentos) precisa citar a data de início real do hub — a mesma
 * data computada de `sources[0].date`
 * (`google-gemini-sources.generated.json`, regenerado por
 * `generate-hub-sources.ts`) — não um valor transcrito à mão que ficou
 * desatualizado depois de um regen. O #4884 corrigiu a data real de
 * `2025-09-03` para `2025-08-27` (override do #4796) mas não tocou a prosa
 * porque a contagem de edições não mudou (61→61) — resultado: `google-
 * gemini.ts` citava "3 de setembro de 2025"/"03/09/2025" enquanto o FAQ
 * computado (`oldest`, derivado de `sources[0].date`) já mostrava
 * `27/08/2025` (#4895).
 *
 * Cobre os dois formatos usados na prosa ("27/08/2025" e "27 de agosto de
 * 2025") e compara contra `sources[0].date` real (via helpers locais de
 * formatação, não uma cópia de `formatDateLabel` — o teste não importa
 * função não-exportada do módulo de propósito, pra não mascarar um bug na
 * própria formatação).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getGoogleGeminiHub } from "../scripts/lib/hubs/google-gemini.ts";
import sourcesRaw from "../scripts/lib/hubs/google-gemini-sources.generated.json" with { type: "json" };
import type { HubSourceEntry } from "../scripts/generate-hub-sources.ts";

const SOURCES = sourcesRaw as HubSourceEntry[];

const MONTHS_PT = [
  "janeiro",
  "fevereiro",
  "março",
  "abril",
  "maio",
  "junho",
  "julho",
  "agosto",
  "setembro",
  "outubro",
  "novembro",
  "dezembro",
];

function toShortBrDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) throw new Error(`data inesperada: ${iso}`);
  return `${m[3]}/${m[2]}/${m[1]}`;
}

function toLongBrDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) throw new Error(`data inesperada: ${iso}`);
  const day = Number(m[3]);
  const month = MONTHS_PT[Number(m[2]) - 1];
  return `${day} de ${month} de ${m[1]}`;
}

describe("#4895 — google-gemini.ts cita a data de início real do hub", () => {
  const oldestIso = SOURCES[0]?.date;
  assert.ok(oldestIso, "sanity: SOURCES precisa ter pelo menos 1 entrada");
  const shortDate = toShortBrDate(oldestIso as string);
  const longDate = toLongBrDate(oldestIso as string);

  it("sanity: sources[0].date do dataset commitado é 2025-08-27 (se este assert quebrar, o dataset mudou de novo e a prosa precisa ser revisada à mão, não só o teste)", () => {
    assert.equal(oldestIso, "2025-08-27");
  });

  const hub = getGoogleGeminiHub();
  const proseFields: { field: string; value: string }[] = [
    { field: "introParagraph", value: hub.introParagraph },
    { field: "metaDescription", value: hub.metaDescription },
    { field: "introHeading", value: hub.introHeading },
    ...hub.sections.map((s, i) => ({ field: `sections[${i}].heading`, value: s.heading })),
    ...hub.sections.flatMap((s, i) =>
      s.paragraphs.map((p, j) => ({ field: `sections[${i}].paragraphs[${j}]`, value: p })),
    ),
    ...hub.faq.map((f, i) => ({ field: `faq[${i}].answer`, value: f.answer })),
  ];

  it("regression: nenhum campo reader-facing cita a data desatualizada 03/09/2025 / 3 de setembro de 2025", () => {
    const violations = proseFields.filter(
      ({ value }) => value.includes("03/09/2025") || value.includes("3 de setembro de 2025"),
    );
    assert.deepEqual(
      violations,
      [],
      `data desatualizada encontrada em: ${violations.map((v) => v.field).join(", ")}`,
    );
  });

  it("INTRO cita a data real de início (forma longa) computada de sources[0].date", () => {
    assert.ok(
      hub.introParagraph.includes(`Entre ${longDate}`),
      `esperado "Entre ${longDate}" em introParagraph, veio: "${hub.introParagraph.slice(0, 80)}..."`,
    );
  });

  it("seção de ritmo de lançamento cita a data real de início (forma longa)", () => {
    const heading = "Com que ritmo o Google lança modelo novo de Gemini (e de Nano Banana)?";
    const section = hub.sections.find((s) => s.heading === heading);
    assert.ok(section, "sanity: seção de ritmo de lançamento não encontrada");
    assert.ok(
      section!.paragraphs[0].includes(`entre ${longDate}`),
      `esperado "entre ${longDate}" no 1º parágrafo da seção de ritmo, veio: "${section!.paragraphs[0].slice(0, 80)}..."`,
    );
  });

  it("FAQ de lançamentos cita a data real de início (forma curta)", () => {
    const launchFaq = hub.faq.find((f) => /noticiou \d+ lançamentos/.test(f.answer));
    assert.ok(launchFaq, "sanity: FAQ de lançamentos não encontrado");
    assert.ok(
      launchFaq!.answer.includes(`entre ${shortDate}`),
      `esperado "entre ${shortDate}" na resposta do FAQ de lançamentos, veio: "${launchFaq!.answer}"`,
    );
  });
});
