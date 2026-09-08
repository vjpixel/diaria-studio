/**
 * test/build-annual-page.test.ts (#7581)
 *
 * `scripts/lib/anual/build-annual-page.ts` — corte do trecho público no fim
 * do TEMA 1 + render das duas saídas (completo/trecho). Casos centrais
 * exigidos pelo dispatch (#633 — regressão do fail-closed):
 *
 *   1. `buildAnnualTeaserHtml` NUNCA contém conteúdo de TEMA 2/3+.
 *   2. `buildAnnualHtml` (completo) contém TODOS os temas.
 *   3. Draft sem `**TEMA 1 ...**` → `AnnualTeaserCutError`, nunca um trecho
 *      vazio/malformado.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AnnualTeaserCutError,
  cutDraftAfterFirstTheme,
  buildAnnualHtml,
  buildAnnualTeaserHtml,
} from "../scripts/lib/anual/build-annual-page.ts";

function draftMd(opts: { withThemes?: boolean } = {}) {
  const withThemes = opts.withThemes ?? true;
  return [
    "**ASSUNTO (3 OPÇÕES)**",
    "1. Um ano de IA",
    "",
    "**PREVIEW**",
    "",
    "O ano em uma linha.",
    "",
    "**INTRO**",
    "",
    "Os doze meses foram assim.",
    "",
    ...(withThemes
      ? [
          "**TEMA 1 | ENERGIA**",
          "",
          "Título do primeiro tema — SÓ ISTO deve aparecer no trecho",
          "",
          "Parágrafo exclusivo do tema 1, com bastante texto pra passar do piso de 500 " +
            "caracteres do corte — repetindo pra garantir tamanho suficiente, repetindo pra " +
            "garantir tamanho suficiente, repetindo pra garantir tamanho suficiente, repetindo " +
            "pra garantir tamanho suficiente, repetindo pra garantir tamanho suficiente.",
          "",
          "O fio condutor:",
          "O que o tema 1 revelou.",
          "",
          "**TEMA 2 | TRABALHO**",
          "",
          "Título do segundo tema — NUNCA deve aparecer no trecho",
          "",
          "Parágrafo exclusivo e secreto do tema 2 — conteúdo pago.",
          "",
          "**TEMA 3 | REGULAÇÃO**",
          "",
          "Título do terceiro tema — NUNCA deve aparecer no trecho",
          "",
          "Parágrafo exclusivo e secreto do tema 3 — conteúdo pago.",
          "",
        ]
      : []),
    "**O QUE MUDOU**",
    "",
    "No começo era uma coisa; no fim, outra — NUNCA deve aparecer no trecho.",
    "",
    "**PREVISÕES**",
    "",
    "Estas previsões saem da leitura do próprio período — NUNCA no trecho.",
    "",
    "**PARA ENCERRAR**",
    "",
    "Até a próxima retrospectiva — NUNCA no trecho.",
    "",
  ].join("\n");
}

const OPTS = { windowLabel: "agosto/2025 a agosto/2026", tipo: "aniversario" as const };

describe("cutDraftAfterFirstTheme (#7581)", () => {
  it("corta no próximo marcador de seção depois do TEMA 1", () => {
    const cut = cutDraftAfterFirstTheme(draftMd(), "2026-aniversario");
    assert.ok(cut.includes("TEMA 1"));
    assert.ok(!cut.includes("TEMA 2"));
    assert.ok(!cut.includes("Parágrafo exclusivo e secreto do tema 2"));
  });

  it("draft sem `**TEMA 1 ...**` → AnnualTeaserCutError (nunca trecho vazio/inteiro)", () => {
    assert.throws(
      () => cutDraftAfterFirstTheme(draftMd({ withThemes: false }), "2026-aniversario"),
      AnnualTeaserCutError,
    );
  });

  it("draft com TEMA 1 mas sem seção seguinte → AnnualTeaserCutError", () => {
    const md = ["**INTRO**", "", "abertura", "", "**TEMA 1 | X**", "", "único parágrafo, sem seção depois"].join(
      "\n",
    );
    assert.throws(() => cutDraftAfterFirstTheme(md, "2026-aniversario"), AnnualTeaserCutError);
  });
});

describe("buildAnnualTeaserHtml — fail-closed: NUNCA vaza conteúdo pago (#7581, #633)", () => {
  it("trecho contém o TEMA 1", () => {
    const page = buildAnnualTeaserHtml(draftMd(), "2026-aniversario", OPTS);
    assert.ok(page.html.includes("Título do primeiro tema"));
  });

  it("trecho NUNCA contém texto exclusivo do TEMA 2/3, nem O QUE MUDOU/PREVISÕES/PARA ENCERRAR", () => {
    const page = buildAnnualTeaserHtml(draftMd(), "2026-aniversario", OPTS);
    assert.ok(!page.html.includes("Parágrafo exclusivo e secreto do tema 2"));
    assert.ok(!page.html.includes("Parágrafo exclusivo e secreto do tema 3"));
    assert.ok(!page.html.includes("NUNCA deve aparecer no trecho"));
    assert.ok(!page.html.includes("NUNCA no trecho"));
  });

  it("draft estruturalmente inválido (sem TEMA 1) lança em vez de devolver HTML vazio/parcial", () => {
    assert.throws(() => buildAnnualTeaserHtml(draftMd({ withThemes: false }), "2026-x", OPTS), AnnualTeaserCutError);
  });
});

describe("buildAnnualHtml — completo contém TODOS os temas (#7581)", () => {
  it("completo tem os 3 temas e as seções finais", () => {
    const page = buildAnnualHtml(draftMd(), OPTS);
    assert.ok(page.html.includes("Título do primeiro tema"));
    assert.ok(page.html.includes("Parágrafo exclusivo e secreto do tema 2"));
    assert.ok(page.html.includes("Parágrafo exclusivo e secreto do tema 3"));
    assert.ok(page.html.includes("NUNCA no trecho")); // texto de PREVISÕES, deve estar no completo
  });

  it("nunca lança mesmo com draft incompleto — quem valida validade é o lint, não este módulo", () => {
    assert.doesNotThrow(() => buildAnnualHtml("**INTRO**\n\nsó isso", OPTS));
  });
});
