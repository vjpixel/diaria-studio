/**
 * test/render-erro-intencional.test.ts (#911)
 *
 * Cobre helpers puros + integração CLI da seção ERRO INTENCIONAL na
 * newsletter. Concurso mensal "Ache o erro" — newsletter revela gabarito
 * da edição anterior + chama leitor pra acertar erro da atual.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import {
  findPreviousIntentionalError,
  composeRevealText,
  renderSection,
  insertOrUpdateSection,
  currentHasIntentionalErrorFlag,
  boldQuotedStrings,
  extractIntentionalErrorFromMd,
  extractNarrativeFromFrontmatter,
  extractRevealFromFrontmatter,
  extractCorrectValueFromFrontmatter,
  findPreviousIntentionalErrorFromMd,
  narrativeHasCorrection,
  narrativeIsCatalogShaped,
  resolvePreviousError,
  ensureIntentionalErrorFrontmatter,
} from "../scripts/render-erro-intencional.ts";
import type { IntentionalError } from "../scripts/lib/intentional-errors.ts";
import {
  frontmatterToEntry,
  parseIntentionalErrorsJsonl,
} from "../scripts/lib/intentional-errors.ts";


import { narrativeIsGenericPlaceholder } from "../scripts/render-erro-intencional.ts";
import {
  checkNarrativeNotGenericPlaceholder,
} from "../scripts/lib/invariant-checks/stage-4.ts";

import {
  extractFrontmatter,
  checkIntentionalError,
} from "../scripts/lib/lint-checks/intentional-error.ts";

describe("findPreviousIntentionalError (#911)", () => {
  it("retorna o erro mais recente anterior à edição atual", () => {
    const errors: IntentionalError[] = [
      { edition: "260505", error_type: "factual", is_feature: true, detail: "X" },
      { edition: "260506", error_type: "factual", is_feature: true, detail: "Y" },
      { edition: "260507", error_type: "factual", is_feature: true, detail: "Z" },
    ];
    const r = findPreviousIntentionalError(errors, "260507");
    assert.equal(r?.edition, "260506");
  });

  it("retorna null quando não há erro anterior", () => {
    const errors: IntentionalError[] = [
      { edition: "260507", error_type: "factual", is_feature: true, detail: "Z" },
    ];
    const r = findPreviousIntentionalError(errors, "260505");
    assert.equal(r, null);
  });

  it("ignora entries com is_feature: false", () => {
    const errors: IntentionalError[] = [
      { edition: "260506", error_type: "factual", is_feature: false, detail: "X" },
      { edition: "260505", error_type: "factual", is_feature: true, detail: "Y" },
    ];
    const r = findPreviousIntentionalError(errors, "260507");
    assert.equal(r?.edition, "260505");
  });
});

describe("composeRevealText (#1079)", () => {
  it("usa narrative quando disponível (novo formato)", () => {
    const prev = {
      edition: "260510",
      error_type: "count_mismatch",
      is_feature: true,
      narrative: "eu disse que a OpenAI lançou 4 modelos, mas listei 3",
    } as IntentionalError & { narrative: string };
    const text = composeRevealText(prev);
    assert.match(text, /^Na última edição, eu disse/);
    assert.match(text, /OpenAI lançou 4 modelos, mas listei 3/);
  });

  it("compõe a partir de detail + gabarito legados quando narrative ausente", () => {
    const prev = {
      edition: "260506",
      error_type: "wrong_number",
      is_feature: true,
      detail: "Texto trazia '220 anos' onde deveria ser '22 anos'",
      gabarito: "22 anos",
    } as IntentionalError & { gabarito: string };
    const text = composeRevealText(prev);
    assert.match(text, /^Na última edição, /);
    assert.match(text, /220 anos/);
    assert.match(text, /mas o correto era/);
    assert.match(text, /22 anos/);
  });

  it("usa só detail quando gabarito + narrative ausentes", () => {
    const prev: IntentionalError = {
      edition: "260505",
      error_type: "version_inconsistency",
      is_feature: true,
      detail: "V4 no título, V5/V6/V7 nos parágrafos do D2",
    };
    const text = composeRevealText(prev);
    assert.match(text, /^Na última edição, /);
    assert.match(text, /V4/);
  });

  it("fallback genérico quando detail/gabarito/narrative todos ausentes (F2: string unificada)", () => {
    const prev: IntentionalError = {
      edition: "260504",
      error_type: "factual",
      is_feature: true,
    };
    const text = composeRevealText(prev);
    // F2: fallback unificado — mesma string em todos os caminhos de fallback
    assert.match(text, /^Na última edição, escondemos um erro proposital — obrigado a quem respondeu apontando\./);
  });

  it("#915: strings entre aspas duplas saem em negrito", () => {
    const prev = {
      edition: "260506",
      error_type: "wrong_number",
      is_feature: true,
      narrative: 'escrevi "fundadores de 220 anos" onde deveria ser "fundadores de 22 anos"',
    } as IntentionalError & { narrative: string };
    const text = composeRevealText(prev);
    assert.match(text, /\*\*"fundadores de 220 anos"\*\*/);
    assert.match(text, /\*\*"fundadores de 22 anos"\*\*/);
  });

  it("#915: strings entre aspas simples (legacy) também saem em negrito", () => {
    const prev = {
      edition: "260506",
      error_type: "wrong_number",
      is_feature: true,
      detail: "Texto trazia '220 anos' onde deveria ser '22 anos'",
      gabarito: "22 anos",
    } as IntentionalError & { gabarito: string };
    const text = composeRevealText(prev);
    assert.match(text, /\*\*'220 anos'\*\*/);
    assert.match(text, /\*\*'22 anos'\*\*/);
  });
});

describe("composeRevealText (#1443) — enforce 'o correto é Y'", () => {
  it("auto-append 'o correto é Y' quando narrative sem correção + correct_value presente (caso Karpathy 260520→260521)", () => {
    const prev = {
      edition: "260520",
      error_type: "factual",
      is_feature: true,
      narrative: "contei que Karpathy cofundou a OpenAI em 1914, depois liderou a IA da Tesla",
      correct_value: "2014",
    } as IntentionalError & { narrative: string };
    const text = composeRevealText(prev);
    assert.match(text, /^Na última edição, /);
    assert.match(text, /em 1914/);
    assert.match(text, /, o correto é 2014\.$/);
  });

  it("preserva narrative quando já tem 'o correto é' (não duplica)", () => {
    const prev = {
      edition: "260520",
      error_type: "factual",
      is_feature: true,
      narrative: "disse que GPT-5 foi lançado em 2024, o correto é 2025",
      correct_value: "2025",
    } as IntentionalError & { narrative: string };
    const text = composeRevealText(prev);
    assert.equal(
      text,
      "Na última edição, disse que GPT-5 foi lançado em 2024, o correto é 2025.",
    );
    // Não pode aparecer 2x
    const matches = text.match(/o correto é/g);
    assert.equal(matches?.length, 1);
  });

  it("preserva narrative com 'mas o correto era' (fraseologia legacy)", () => {
    const prev = {
      edition: "260520",
      error_type: "factual",
      is_feature: true,
      narrative: "escrevi 'V4' onde deveria ser 'V5', mas o correto era V5",
      correct_value: "V5",
    } as IntentionalError & { narrative: string };
    const text = composeRevealText(prev);
    // narrativeHasCorrection match em 'onde deveria ser' OU 'mas o correto era' → preserve
    assert.doesNotMatch(text, /,\s*o correto é V5\./);
    assert.match(text, /mas o correto era V5/);
    // Narrativa veio intacta (com aspas bolded por #915)
    assert.match(text, /escrevi \*\*'V4'\*\* onde deveria ser \*\*'V5'\*\*, mas o correto era V5/);
  });

  it("preserva narrative com 'onde deveria ser' (fraseologia legacy formato 'escrevi X onde deveria ser Y')", () => {
    const prev = {
      edition: "260520",
      error_type: "factual",
      is_feature: true,
      narrative: 'escrevi "iPhone 5 e 6" onde deveria ser "iPhone 15 e 16"',
      correct_value: "iPhone 15 e 16",
    } as IntentionalError & { narrative: string };
    const text = composeRevealText(prev);
    // 'onde deveria ser' já cobre a correção — não auto-append
    assert.match(text, /onde deveria ser/);
    assert.doesNotMatch(text, /,\s*o correto é/);
  });

  it("warn + preserva narrative quando sem correct_value disponível (formato incompleto, não bloqueia)", () => {
    const original = console.warn;
    let warnedWith = "";
    console.warn = (msg: string) => {
      warnedWith += msg;
    };
    try {
      const prev = {
        edition: "260520",
        error_type: "factual",
        is_feature: true,
        narrative: "exagerei o número de empresas",
      } as IntentionalError & { narrative: string };
      const text = composeRevealText(prev);
      assert.match(text, /^Na última edição, exagerei o número de empresas\.$/);
      assert.match(warnedWith, /sem frase de correção/);
    } finally {
      console.warn = original;
    }
  });

  it("usa 'o correto é' quando só detail + correct_value (sem narrative)", () => {
    const prev: IntentionalError = {
      edition: "260520",
      error_type: "factual",
      is_feature: true,
      detail: "ano de fundação errado",
      correct_value: "2014",
    };
    const text = composeRevealText(prev);
    assert.match(text, /ano de fundação errado, o correto é 2014\./);
  });

  it("mantém formato legado 'mas o correto era' quando só detail + gabarito (sem correct_value)", () => {
    const prev = {
      edition: "260506",
      error_type: "wrong_number",
      is_feature: true,
      detail: "Texto trazia '220 anos' onde deveria ser '22 anos'",
      gabarito: "22 anos",
    } as IntentionalError & { gabarito: string };
    const text = composeRevealText(prev);
    assert.match(text, /mas o correto era/);
    assert.match(text, /22 anos/);
  });
});

describe("narrativeHasCorrection (#1443)", () => {
  it("detecta 'o correto é X'", () => {
    assert.equal(narrativeHasCorrection("disse X, o correto é Y"), true);
  });

  it("detecta 'o correto era X'", () => {
    assert.equal(narrativeHasCorrection("disse X, o correto era Y"), true);
  });

  it("detecta 'mas o correto era X'", () => {
    assert.equal(narrativeHasCorrection("texto, mas o correto era 22 anos"), true);
  });

  it("detecta 'na verdade é X'", () => {
    assert.equal(narrativeHasCorrection("disse X, na verdade é Y"), true);
  });

  it("detecta 'deveria ser X'", () => {
    assert.equal(narrativeHasCorrection("escrevi 5, deveria ser 50"), true);
  });

  it("detecta 'onde deveria ser X' (legacy)", () => {
    assert.equal(
      narrativeHasCorrection("escrevi 'V4' onde deveria ser 'V5'"),
      true,
    );
  });

  it("retorna false em narrativa neutra sem correção", () => {
    assert.equal(
      narrativeHasCorrection(
        "contei que Karpathy cofundou a OpenAI em 1914, depois liderou a IA da Tesla",
      ),
      false,
    );
  });

  it("retorna false em texto qualquer", () => {
    assert.equal(narrativeHasCorrection("nada relacionado a correção"), false);
  });
});

describe("narrativeIsCatalogShaped (#2411 — guard contra label interno no reveal)", () => {
  it("detecta 'DESTAQUE 2 lista o Spotify...' (formato catálogo)", () => {
    assert.equal(narrativeIsCatalogShaped("DESTAQUE 2 lista o Spotify entre os assistentes de IA"), true);
  });

  it("detecta 'DESTAQUE 3 (Microsoft/DeepSeek): no primeiro parágrafo...' (formato real 260618)", () => {
    assert.equal(
      narrativeIsCatalogShaped("DESTAQUE 3 (Microsoft/DeepSeek): no primeiro parágrafo a empresa aparece como 'Macrosoft'"),
      true,
    );
  });

  it("retorna false para prosa first-person típica", () => {
    assert.equal(narrativeIsCatalogShaped("escrevi que GPT-5 foi lançado em 2024, o correto é 2025"), false);
  });

  it("retorna false para texto que menciona DESTAQUE mas não começa com ele", () => {
    assert.equal(narrativeIsCatalogShaped("listei o Spotify como assistente de IA no DESTAQUE 2"), false);
  });

  it("retorna false para texto genérico", () => {
    assert.equal(narrativeIsCatalogShaped("contei que Karpathy cofundou a OpenAI em 1914"), false);
  });
});

describe("composeRevealText (#2411/#2419 — guard contra copy quebrada/catalog-shaped)", () => {
  it("#2411/#2419: narrative catálogo (começa com DESTAQUE N) → fallback SEGURO genérico, sem label e sem síntese de correct_value", () => {
    // Regressão: #2398 passava description catálogo como narrative; #2411 bloqueia.
    // #2419 rewrite: fallback seguro é SEMPRE a frase genérica fixa — NUNCA tenta sintetizar
    // a partir de correct_value (pois catalog-shaped é ilegível, não pode ser "consertado").
    // Editor deve preencher `intentional_error.reveal` no frontmatter.
    const prev = {
      edition: "260618",
      error_type: "factual",
      is_feature: true,
      narrative: "DESTAQUE 2 lista o Spotify entre os assistentes de IA",
      correct_value: "Perplexity ou Copilot",
    } as IntentionalError & { narrative: string };
    const text = composeRevealText(prev);
    // NÃO deve conter o label interno "DESTAQUE N" no reveal público
    assert.doesNotMatch(text, /DESTAQUE\s+\d/, "label interno não deve vazar para o reveal público");
    // NÃO deve tentar sintetizar a partir de correct_value (bug #3 da spec)
    assert.doesNotMatch(text, /Perplexity|Copilot/, "correct_value não deve vazar em fallback catalog-shaped");
    // Deve usar fallback seguro genérico (#2419)
    assert.match(text, /Na última edição, escondemos um erro proposital/);
  });

  it("#2411/#2419: detail catálogo (DESTAQUE N) → fallback SEGURO genérico, sem correct_value sintético", () => {
    // Caso JSONL: detail = description copiada do frontmatter (catálogo).
    // #2419 rewrite: fallback seguro é frase fixa — não sintetiza "o correto era Microsoft"
    // a partir de detail catalog-shaped (era o bug #3: "o correto era <cláusula>" agramatical).
    const prev: IntentionalError = {
      edition: "260618",
      error_type: "ortografico",
      is_feature: true,
      detail: "DESTAQUE 3 (Microsoft/DeepSeek): no primeiro parágrafo a empresa aparece como 'Macrosoft', mas o nome correto é Microsoft",
      correct_value: "Microsoft",
    };
    const text = composeRevealText(prev);
    // NÃO deve conter "DESTAQUE 3" no reveal público
    assert.doesNotMatch(text, /DESTAQUE\s+\d/, "label interno não deve vazar para o reveal público");
    // NÃO deve sintetizar correct_value a partir de detail catalog-shaped
    // (o correto: usar campo `reveal` no frontmatter)
    assert.doesNotMatch(text, /o correto era Microsoft/, "correct_value não deve ser sintetizado de detail catalog");
    // Fallback seguro genérico
    assert.match(text, /Na última edição, escondemos um erro proposital/);
  });

  it("#2411/#2419: narrative catalog sem correct_value → fallback genérico", () => {
    const prev = {
      edition: "260618",
      error_type: "factual",
      is_feature: true,
      narrative: "DESTAQUE 1 afirma que o sistema médico empatou com dentistas",
    } as IntentionalError & { narrative: string };
    const text = composeRevealText(prev);
    assert.doesNotMatch(text, /DESTAQUE\s+\d/);
    assert.match(text, /Na última edição, escondemos um erro proposital/);
  });
});

describe("extractCorrectValueFromFrontmatter (#1443)", () => {
  it("extrai correct_value do frontmatter (aspas duplas)", () => {
    const md = [
      "---",
      "intentional_error:",
      '  description: "Ano de fundação da OpenAI no DESTAQUE 2"',
      '  location: "DESTAQUE 2"',
      '  category: "factual"',
      '  correct_value: "2014"',
      "---",
      "",
      "Body",
    ].join("\n");
    assert.equal(extractCorrectValueFromFrontmatter(md), "2014");
  });

  it("extrai correct_value sem aspas", () => {
    const md = [
      "---",
      "intentional_error:",
      "  description: x",
      "  location: y",
      "  category: factual",
      "  correct_value: 2014",
      "---",
    ].join("\n");
    assert.equal(extractCorrectValueFromFrontmatter(md), "2014");
  });

  it("retorna null quando sem frontmatter", () => {
    assert.equal(extractCorrectValueFromFrontmatter("Sem frontmatter"), null);
  });

  it("retorna null quando frontmatter sem intentional_error", () => {
    const md = ["---", "title: X", "---", "body"].join("\n");
    assert.equal(extractCorrectValueFromFrontmatter(md), null);
  });

  it("retorna null quando intentional_error sem correct_value", () => {
    const md = [
      "---",
      "intentional_error:",
      "  description: x",
      "  location: y",
      "  category: factual",
      "---",
    ].join("\n");
    assert.equal(extractCorrectValueFromFrontmatter(md), null);
  });

  it("#1378: frontmatter após bloco TÍTULO (até linha 60) ainda é detectado", () => {
    const md = [
      "**TÍTULO**",
      "",
      "Manchete da edição",
      "",
      "**SUBTÍTULO**",
      "",
      "Subtítulo",
      "",
      "---",
      "intentional_error:",
      '  description: "x"',
      '  location: "y"',
      '  category: "factual"',
      '  correct_value: "42"',
      "---",
      "",
      "Body",
    ].join("\n");
    assert.equal(extractCorrectValueFromFrontmatter(md), "42");
  });
});

describe("extractIntentionalErrorFromMd (#1443) — agora retorna correct_value", () => {
  it("#2411 fix — description catálogo + corpo genérico → null (não vaza label interno)", () => {
    // Regressão #2411: #2398 fazia description catálogo virar narrative do reveal.
    // Após o fix: body genérico é filtrado, frontmatter sem `narrative` → null.
    // (correct_value ainda está no frontmatter, mas não há fonte válida de reveal.)
    const md = [
      "---",
      "intentional_error:",
      '  description: "DESTAQUE 2 lista o Spotify entre os assistentes de IA"',
      '  location: "DESTAQUE 2"',
      '  category: "factual"',
      '  correct_value: "Perplexity ou Copilot"',
      "---",
      "",
      "Body com **ERRO INTENCIONAL**",
      "",
      "Nessa edição, há um erro proposital escondido em um dos destaques. Responda este e-mail com a correção para concorrer ao sorteio.",
      "",
    ].join("\n");
    const r = extractIntentionalErrorFromMd(md);
    // description é catálogo → NÃO deve ser retornada como narrative
    assert.equal(r, null, "deve retornar null — description é catálogo, body é genérico");
  });

  it("#2411 fix — description catálogo + body first-person específico → usa body", () => {
    // Quando o editor escreveu a prosa first-person no corpo, ela é retornada
    // (mesmo que description seja catálogo no frontmatter).
    const md = [
      "---",
      "intentional_error:",
      '  description: "DESTAQUE 2 lista o Spotify entre os assistentes de IA"',
      '  location: "DESTAQUE 2"',
      '  category: "factual"',
      '  correct_value: "Perplexity ou Copilot"',
      "---",
      "",
      "**ERRO INTENCIONAL**",
      "",
      "Na última edição, foo.",
      "",
      "Nessa edição, listei o Spotify como assistente de IA no DESTAQUE 2, mas o Spotify é um serviço de streaming.",
      "",
    ].join("\n");
    const r = extractIntentionalErrorFromMd(md);
    // Body first-person é a fonte primária (#2411)
    assert.ok(r !== null, "deve retornar resultado válido");
    assert.equal(r?.narrative, "listei o Spotify como assistente de IA no DESTAQUE 2, mas o Spotify é um serviço de streaming");
    assert.equal(r?.correct_value, "Perplexity ou Copilot");
  });

  it("passa correct_value do frontmatter pra estrutura retornada (body prose + frontmatter sem description específica)", () => {
    // Caso legado: body tem a narrativa específica, frontmatter só tem correct_value.
    // Sem `description`/`narrative` no frontmatter → fallback para body prose.
    const md = [
      "---",
      "intentional_error:",
      '  location: "DESTAQUE 2"',
      '  category: "factual"',
      '  correct_value: "2014"',
      "---",
      "",
      "Body com **ERRO INTENCIONAL**",
      "",
      "Nessa edição, contei que Karpathy cofundou a OpenAI em 1914.",
      "",
    ].join("\n");
    const r = extractIntentionalErrorFromMd(md);
    assert.equal(r?.narrative, "contei que Karpathy cofundou a OpenAI em 1914");
    assert.equal(r?.correct_value, "2014");
  });

  it("#2411 fix — frontmatter narrative field (first-person) é usada como fallback quando body ausente", () => {
    // Edição com `narrative` (alias first-person) no frontmatter + sem prosa no corpo.
    const md = [
      "---",
      "intentional_error:",
      '  description: "DESTAQUE 3: empresa aparece como Macrosoft"',
      '  narrative: "escrevi Macrosoft no primeiro parágrafo do DESTAQUE 3, o nome correto é Microsoft"',
      '  location: "DESTAQUE 3"',
      '  category: "ortografico"',
      '  correct_value: "Microsoft"',
      "---",
      "",
      "Body sem linha Nessa edição específica.",
    ].join("\n");
    const r = extractIntentionalErrorFromMd(md);
    // `narrative` do frontmatter é a fonte fallback (#2411)
    assert.ok(r !== null, "deve retornar resultado com narrative do frontmatter");
    assert.equal(r?.narrative, "escrevi Macrosoft no primeiro parágrafo do DESTAQUE 3, o nome correto é Microsoft");
    assert.equal(r?.correct_value, "Microsoft");
    // description NÃO deve aparecer como narrative
    assert.doesNotMatch(r?.narrative ?? "", /^DESTAQUE/);
  });

  it("correct_value undefined quando frontmatter ausente", () => {
    const md = `Nessa edição, escrevi "X" onde deveria ser "Y".`;
    const r = extractIntentionalErrorFromMd(md);
    assert.equal(r?.detail, "X");
    assert.equal(r?.gabarito, "Y");
    assert.equal(r?.correct_value, undefined);
  });
});

describe("boldQuotedStrings (#915)", () => {
  it("envolve strings entre aspas duplas em negrito", () => {
    assert.equal(
      boldQuotedStrings('escrevi "X" onde deveria ser "Y"'),
      'escrevi **"X"** onde deveria ser **"Y"**',
    );
  });

  it("envolve strings entre aspas simples em negrito", () => {
    assert.equal(
      boldQuotedStrings("escrevi 'X' onde deveria ser 'Y'"),
      "escrevi **'X'** onde deveria ser **'Y'**",
    );
  });

  it("idempotente: não dobra negrito quando já bold", () => {
    const already = 'escrevi **"X"** onde deveria ser **"Y"**';
    assert.equal(boldQuotedStrings(already), already);
  });

  it("não modifica texto sem aspas", () => {
    assert.equal(
      boldQuotedStrings("texto sem aspas pra tocar"),
      "texto sem aspas pra tocar",
    );
  });

  it("preserva texto fora das aspas", () => {
    const out = boldQuotedStrings('Disse "olá" e foi embora.');
    assert.equal(out, 'Disse **"olá"** e foi embora.');
  });
});

describe("renderSection (#1079)", () => {
  it("inclui header + reveal + placeholder pra declaração corrente quando ausente", () => {
    const block = renderSection("Na última edição, X.");
    assert.match(block, /\*\*ERRO INTENCIONAL\*\*/);
    assert.match(block, /Na última edição, X\./);
    assert.match(block, /\{PREENCHER_NARRATIVA_DO_ERRO\}/);
    // Sem o convite/sorteio mensal (movido pra bloco SORTEIO separado #1079)
    assert.doesNotMatch(block, /sorteio mensal/);
    assert.doesNotMatch(block, /Esta edição tem um erro proposital/);
  });

  it("usa fallback neutro pro reveal quando reveal=null", () => {
    const block = renderSection(null);
    assert.match(block, /\*\*ERRO INTENCIONAL\*\*/);
    assert.match(block, /não trazia erro intencional declarado/);
    // Ainda mostra placeholder pra declaração corrente
    assert.match(block, /\{PREENCHER_NARRATIVA_DO_ERRO\}/);
  });

  it("preserva declaração corrente passada (não usa placeholder)", () => {
    const decl = "Nessa edição, eu disse X, mas Y é o correto.";
    const block = renderSection("Na última edição, A.", decl);
    assert.match(block, /Na última edição, A\./);
    assert.match(block, /Nessa edição, eu disse X, mas Y é o correto\./);
    assert.doesNotMatch(block, /\{PREENCHER_NARRATIVA_DO_ERRO\}/);
  });

  it("placeholder quando currentDeclaration é string vazia", () => {
    const block = renderSection("Na última edição, A.", "");
    assert.match(block, /\{PREENCHER_NARRATIVA_DO_ERRO\}/);
  });
});

describe("insertOrUpdateSection (#911)", () => {
  it("insere a seção antes de ASSINE quando ausente", () => {
    const md = [
      "OUTRAS NOTÍCIAS",
      "",
      "[N1](https://n.com/1)",
      "Desc.",
      "",
      "---",
      "",
      "**ASSINE**",
      "Convite para assinar.",
    ].join("\n");
    const r = insertOrUpdateSection(md, "Reveal X.");
    assert.equal(r.action, "inserted");
    assert.match(r.md, /\*\*ERRO INTENCIONAL\*\*/);
    // ERRO INTENCIONAL deve aparecer ANTES de ASSINE
    const erroIdx = r.md.indexOf("ERRO INTENCIONAL");
    const assineIdx = r.md.indexOf("ASSINE");
    assert.ok(erroIdx > 0 && erroIdx < assineIdx);
  });

  it("idempotente: segunda chamada com mesmo input atualiza, não duplica", () => {
    const md = [
      "OUTRAS NOTÍCIAS",
      "",
      "Item.",
      "",
      "---",
      "",
      "**ASSINE**",
      "X",
    ].join("\n");
    const first = insertOrUpdateSection(md, "Reveal X.");
    assert.equal(first.action, "inserted");
    const second = insertOrUpdateSection(first.md, "Reveal X.");
    // Segunda chamada com o mesmo conteúdo: no_change
    assert.equal(second.action, "no_change");
    // Só uma ocorrência de ERRO INTENCIONAL
    const matches = first.md.match(/\*\*ERRO INTENCIONAL\*\*/g);
    assert.equal(matches?.length, 1);
  });

  it("update: nova reveal substitui a antiga sem duplicar", () => {
    const md = [
      "OUTRAS NOTÍCIAS",
      "",
      "Item.",
      "",
      "---",
      "",
      "**ASSINE**",
      "X",
    ].join("\n");
    const first = insertOrUpdateSection(md, "Reveal antiga.");
    const second = insertOrUpdateSection(first.md, "Reveal nova.");
    assert.equal(second.action, "updated");
    assert.match(second.md, /Reveal nova/);
    assert.doesNotMatch(second.md, /Reveal antiga/);
    const matches = second.md.match(/\*\*ERRO INTENCIONAL\*\*/g);
    assert.equal(matches?.length, 1);
  });

  it("se não há ASSINE/Encerramento, insere no fim", () => {
    const md = ["OUTRAS NOTÍCIAS", "", "Item.", "", "---"].join("\n");
    const r = insertOrUpdateSection(md, "Reveal X.");
    assert.equal(r.action, "inserted");
    assert.match(r.md, /\*\*ERRO INTENCIONAL\*\*/);
  });

  it("#1588: insere ANTES de SORTEIO quando ambos SORTEIO e PARA ENCERRAR existem", () => {
    // Template real Diar.ia tem SORTEIO + PARA ENCERRAR mas SEM ASSINE.
    // Pré-fix: ASSINE_RE/ENCERRAMENTO_RE não matcham nenhum dos dois headers
    // → cai no fim do MD (após PARA ENCERRAR). Pós-fix: SORTEIO_HEADER_RE
    // bate primeiro → seção fica antes do SORTEIO.
    const md = [
      "**📰 OUTRAS NOTÍCIAS**",
      "",
      "[N1](https://n.com/1)",
      "",
      "---",
      "",
      "**🎁 SORTEIO**",
      "",
      "Texto sorteio.",
      "",
      "---",
      "",
      "**🙋🏼‍♀️ PARA ENCERRAR**",
      "",
      "Texto encerrar.",
    ].join("\n");
    const r = insertOrUpdateSection(md, "Reveal anterior.");
    assert.equal(r.action, "inserted");
    const erroIdx = r.md.indexOf("ERRO INTENCIONAL");
    const sorteioIdx = r.md.indexOf("🎁 SORTEIO");
    const encerrarIdx = r.md.indexOf("PARA ENCERRAR");
    assert.ok(erroIdx > 0, "ERRO INTENCIONAL inserido");
    assert.ok(erroIdx < sorteioIdx, `ERRO antes de SORTEIO (got erro=${erroIdx}, sorteio=${sorteioIdx})`);
    assert.ok(sorteioIdx < encerrarIdx, "SORTEIO antes de PARA ENCERRAR (estrutura preservada)");
  });

  it("#1588: fallback pra PARA ENCERRAR quando SORTEIO ausente", () => {
    const md = [
      "OUTRAS NOTÍCIAS",
      "",
      "Item.",
      "",
      "---",
      "",
      "**🙋🏼‍♀️ PARA ENCERRAR**",
      "",
      "Texto.",
    ].join("\n");
    const r = insertOrUpdateSection(md, "Reveal X.");
    assert.equal(r.action, "inserted");
    const erroIdx = r.md.indexOf("ERRO INTENCIONAL");
    const encerrarIdx = r.md.indexOf("PARA ENCERRAR");
    assert.ok(erroIdx < encerrarIdx);
  });

  it("#1279: por default, reveal computado SOBRESCREVE existente (evita stale herdado)", () => {
    // Bug recorrente em 260513-260515: template MD da nova edição herdava
    // "Na última edição..." stale da edição anterior, e #1079 preservava
    // silenciosamente. Agora freshly-computed wins por default.
    const md = [
      "OUTRAS NOTÍCIAS",
      "",
      "Item.",
      "",
      "---",
      "",
      "**ERRO INTENCIONAL**",
      "",
      "Na última edição, texto STALE herdado de N-2.",
      "",
      "Nessa edição, eu disse X, mas Y é o correto.",
      "",
      "---",
      "",
      "**ASSINE**",
      "X",
    ].join("\n");
    const r = insertOrUpdateSection(md, "Na última edição, reveal FRESH computado de N-1.");
    assert.match(r.md, /reveal FRESH computado de N-1/);
    assert.doesNotMatch(r.md, /STALE herdado de N-2/);
    // Declaração corrente "Nessa edição..." continua preservada (é tracking do editor)
    assert.match(r.md, /eu disse X, mas Y é o correto/);
  });

  it("#1279: --preserve-existing-reveal opt-in mantém wording manual do editor", () => {
    // Editor pode opt-in pra preservar reveal editado manualmente.
    const md = [
      "Item.",
      "",
      "---",
      "",
      "**ERRO INTENCIONAL**",
      "",
      "Na última edição, wording manual editado pelo Pixel.",
      "",
      "Nessa edição, X.",
      "",
      "---",
      "",
      "**ASSINE**",
      "X",
    ].join("\n");
    const r = insertOrUpdateSection(md, "Reveal CALCULADO DIFERENTE.", {
      preserveExistingReveal: true,
    });
    assert.match(r.md, /wording manual editado pelo Pixel/);
    assert.doesNotMatch(r.md, /CALCULADO DIFERENTE/);
  });

  it("#1079: idempotência com seção completa pré-existente", () => {
    const md = [
      "Item.",
      "",
      "---",
      "",
      "**ERRO INTENCIONAL**",
      "",
      "Na última edição, A.",
      "",
      "Nessa edição, B.",
      "",
      "---",
      "",
      "**ASSINE**",
      "X",
    ].join("\n");
    const first = insertOrUpdateSection(md, "Na última edição, A.");
    const second = insertOrUpdateSection(first.md, "Na última edição, A.");
    assert.equal(second.action, "no_change");
  });

  it("#1612: strip de ERRO INTENCIONAL termina em **📡 RADAR** (emoji prefix)", () => {
    // Pré-fix: strip regex sentinelas eram bare words (RADAR, SORTEIO, ...).
    // Em MD onde ERRO INTENCIONAL é seguido DIRETAMENTE por seção com emoji
    // prefix (sem `---` separator entre), strip caía pra EOF e engolia tudo.
    const md = [
      "**OUTRAS NOTÍCIAS**",
      "",
      "**ERRO INTENCIONAL**",
      "",
      "Na última edição, X.",
      "",
      "Nessa edição, Y.",
      "**📡 RADAR**",
      "",
      "**[Item radar](https://r.com)**",
      "Desc radar.",
    ].join("\n");
    const result = insertOrUpdateSection(md, "Na última edição, Z.");
    // RADAR deve continuar presente — strip não pode engolir
    assert.match(result.md, /\*\*📡 RADAR\*\*/, "RADAR preservada após strip");
    assert.match(result.md, /Item radar/, "conteúdo do RADAR preservado");
  });

  it("#1612: strip termina em **🎁 SORTEIO** (emoji prefix)", () => {
    const md = [
      "**OUTRAS NOTÍCIAS**",
      "",
      "**ERRO INTENCIONAL**",
      "",
      "Na última edição, X.",
      "",
      "Nessa edição, Y.",
      "**🎁 SORTEIO**",
      "",
      "Texto sorteio.",
    ].join("\n");
    const result = insertOrUpdateSection(md, "Na última edição, Z.");
    assert.match(result.md, /\*\*🎁 SORTEIO\*\*/);
    assert.match(result.md, /Texto sorteio/);
  });
});

