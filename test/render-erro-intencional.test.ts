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

describe("currentHasIntentionalErrorFlag (#911)", () => {
  it("detecta intentional_error no frontmatter", () => {
    const md = [
      "---",
      "intentional_error:",
      "  description: X",
      "  location: D1",
      "---",
      "",
      "Body",
    ].join("\n");
    assert.equal(currentHasIntentionalErrorFlag(md), true);
  });

  it("retorna false quando frontmatter sem intentional_error", () => {
    const md = ["---", "title: X", "---", "", "Body"].join("\n");
    assert.equal(currentHasIntentionalErrorFlag(md), false);
  });

  it("retorna false quando sem frontmatter", () => {
    const md = "Apenas body sem frontmatter.";
    assert.equal(currentHasIntentionalErrorFlag(md), false);
  });
});

describe("extractIntentionalErrorFromMd (#961 / #1079)", () => {
  it("#1079: extrai narrative livre (sem aspas)", () => {
    const md = `Nessa edição, eu disse que a OpenAI lançou 4 modelos, mas listei 3 (que é o número correto).`;
    const r = extractIntentionalErrorFromMd(md);
    assert.equal(r?.narrative, "eu disse que a OpenAI lançou 4 modelos, mas listei 3 (que é o número correto)");
    // detail/gabarito ficam undefined nesse caso (não bate com regex legacy)
    assert.equal(r?.detail, undefined);
    assert.equal(r?.gabarito, undefined);
  });

  it("extrai narrative + detail/gabarito da linha legacy 'escrevi \"X\" onde deveria ser \"Y\"' (back-compat)", () => {
    const md = `Texto.\n\nNessa edição, escrevi "iPhone 5 e 6" onde deveria ser "iPhone 15 e 16".\n\nMais texto.`;
    const r = extractIntentionalErrorFromMd(md);
    assert.equal(r?.detail, "iPhone 5 e 6");
    assert.equal(r?.gabarito, "iPhone 15 e 16");
    assert.match(r?.narrative ?? "", /escrevi "iPhone 5 e 6" onde deveria ser "iPhone 15 e 16"/);
  });

  it("extrai com aspas simples (caso histórico)", () => {
    const md = `Nessa edição, escrevi 'V4' onde deveria ser 'V8'.`;
    const r = extractIntentionalErrorFromMd(md);
    assert.equal(r?.detail, "V4");
    assert.equal(r?.gabarito, "V8");
  });

  it("retorna null quando linha não existe", () => {
    const md = `Nada de erro intencional aqui.`;
    assert.equal(extractIntentionalErrorFromMd(md), null);
  });

  it("captura narrativa parcial quando linha está malformada legacy (#1079: pega texto livre)", () => {
    // No formato novo (#1079), qualquer linha "Nessa edição, X." vira narrative.
    // O regex legacy de aspas só roda como sub-extração; quando falha, retorna só narrative.
    const md = `Nessa edição, escrevi "X" mas esqueci o resto.`;
    const r = extractIntentionalErrorFromMd(md);
    assert.equal(r?.narrative, `escrevi "X" mas esqueci o resto`);
    assert.equal(r?.detail, undefined);
    assert.equal(r?.gabarito, undefined);
  });

  it("#991: aceita aspas duplas em ambos os lados", () => {
    const md = `Nessa edição, escrevi "X" onde deveria ser "Y".`;
    const r = extractIntentionalErrorFromMd(md);
    assert.equal(r?.detail, "X");
    assert.equal(r?.gabarito, "Y");
  });

  it("#991: aceita aspas simples em ambos os lados", () => {
    const md = `Nessa edição, escrevi 'X' onde deveria ser 'Y'.`;
    const r = extractIntentionalErrorFromMd(md);
    assert.equal(r?.detail, "X");
    assert.equal(r?.gabarito, "Y");
  });

  it("#991: aceita aspas mistas — duplas no detail + simples no gabarito (cada lado consistente)", () => {
    const md = `Nessa edição, escrevi "X" onde deveria ser 'Y'.`;
    const r = extractIntentionalErrorFromMd(md);
    assert.equal(r?.detail, "X");
    assert.equal(r?.gabarito, "Y");
  });

  it("#1079: regex de narrative permite pontos internos quando tudo na mesma linha", () => {
    // Non-greedy [^\n]+? ancorado em \.\s*(\n|$) captura até o último ponto
    // antes da quebra. Narrativas com pontos internos cabem se tudo em 1 linha.
    const md = `Nessa edição, eu disse X. Depois corrigi pra Y.`;
    const r = extractIntentionalErrorFromMd(md);
    assert.equal(r?.narrative, "eu disse X. Depois corrigi pra Y");
  });

  it("#1079: regex de narrative para na primeira quebra de parágrafo", () => {
    // Em reviewed.md real, parágrafos são separados por \n\n. A regex termina
    // no primeiro \n, então linhas subsequentes não são capturadas.
    const md = `Nessa edição, X.\n\nOutro parágrafo. Não capturar.`;
    const r = extractIntentionalErrorFromMd(md);
    assert.equal(r?.narrative, "X");
  });

  it("#1099: ancorado em bloco ERRO INTENCIONAL — ignora 'Nessa edição da Diar.ia' do PARA ENCERRAR", () => {
    const md = `Para esta edição...

---

**DESTAQUE 1 | 🇧🇷 BRASIL**

Texto.

---

**ERRO INTENCIONAL**

Na última edição, foo.

Nessa edição, escrevi 'X' onde deveria ser 'Y'.

---

**🙋🏼‍♀️ PARA ENCERRAR**

Nessa edição da **Diar.ia**, usei Claude Code para automatizar...
`;
    const r = extractIntentionalErrorFromMd(md);
    assert.equal(r?.narrative, "escrevi 'X' onde deveria ser 'Y'");
    // Confirma que NÃO pegou o PARA ENCERRAR
    assert.doesNotMatch(r?.narrative ?? "", /Diar\.ia|Claude Code/);
  });

  it("#1099: retorna null quando ERRO INTENCIONAL tem só placeholder (não preenchido)", () => {
    const md = `**ERRO INTENCIONAL**

Na última edição, foo.

Nessa edição, {PREENCHER_NARRATIVA_DO_ERRO}.

---

**🙋🏼‍♀️ PARA ENCERRAR**

Nessa edição da **Diar.ia**, usei Claude Code...
`;
    const r = extractIntentionalErrorFromMd(md);
    assert.equal(r, null, "deve retornar null em placeholder + ignorar PARA ENCERRAR");
  });

  it("#1099: vírgula obrigatória — 'Nessa edição da Diar.ia' (sem vírgula) não matcha", () => {
    const md = `Texto blah.

Nessa edição da **Diar.ia**, usei Claude Code para escrever.
`;
    // Sem header ERRO INTENCIONAL → busca global, mas vírgula é obrigatória.
    // "Nessa edição da Diar.ia" não tem vírgula entre "edição" e "da" → não matcha.
    const r = extractIntentionalErrorFromMd(md);
    assert.equal(r, null, "frase do PARA ENCERRAR sem vírgula não deve matchar");
  });
});

describe("findPreviousIntentionalErrorFromMd (#961)", () => {
  it("encontra a edição anterior mais recente com declaração (pulando vazias)", () => {
    const root = mkdtempSync(join(tmpdir(), "preheat-erro-"));
    try {
      mkdirSync(join(root, "260505"), { recursive: true });
      mkdirSync(join(root, "260506"), { recursive: true });
      mkdirSync(join(root, "260507"), { recursive: true });
      writeFileSync(
        join(root, "260505", "02-reviewed.md"),
        `Nessa edição, escrevi "antigo" onde deveria ser "novo".`,
        "utf8",
      );
      writeFileSync(
        join(root, "260506", "02-reviewed.md"),
        `Nessa edição, escrevi "X" onde deveria ser "Y".`,
        "utf8",
      );
      writeFileSync(
        join(root, "260507", "02-reviewed.md"),
        `Sem declaração aqui.`,
        "utf8",
      );

      // 260507 não tem declaração — script pula e usa 260506 (próxima mais recente)
      const r = findPreviousIntentionalErrorFromMd(root, "260508");
      assert.equal(r?.edition, "260506");
      assert.equal(r?.detail, "X");
      assert.equal(r?.gabarito, "Y");
    } finally {
      rmSync(root, { recursive: true });
    }
  });

  it("pula edição anterior sem declaração e usa a anterior", () => {
    const root = mkdtempSync(join(tmpdir(), "preheat-erro-skip-"));
    try {
      mkdirSync(join(root, "260505"), { recursive: true });
      mkdirSync(join(root, "260506"), { recursive: true });
      mkdirSync(join(root, "260507"), { recursive: true });
      writeFileSync(
        join(root, "260505", "02-reviewed.md"),
        `Nessa edição, escrevi "X" onde deveria ser "Y".`,
        "utf8",
      );
      writeFileSync(join(root, "260506", "02-reviewed.md"), `Sem declaração.`, "utf8");
      writeFileSync(join(root, "260507", "02-reviewed.md"), `Outro sem.`, "utf8");

      const r = findPreviousIntentionalErrorFromMd(root, "260508");
      assert.equal(r?.edition, "260505");
      assert.equal(r?.detail, "X");
      assert.equal(r?.gabarito, "Y");
    } finally {
      rmSync(root, { recursive: true });
    }
  });

  it("retorna null quando não há edições anteriores com declaração", () => {
    const root = mkdtempSync(join(tmpdir(), "preheat-erro-empty-"));
    try {
      mkdirSync(join(root, "260505"), { recursive: true });
      writeFileSync(join(root, "260505", "02-reviewed.md"), `Vazio.`, "utf8");
      const r = findPreviousIntentionalErrorFromMd(root, "260508");
      assert.equal(r, null);
    } finally {
      rmSync(root, { recursive: true });
    }
  });

  it("retorna null quando editionsRoot não existe", () => {
    const r = findPreviousIntentionalErrorFromMd("/path/que/nao/existe", "260508");
    assert.equal(r, null);
  });

  it("ignora edições com sufixos não-AAMMDD (backups)", () => {
    const root = mkdtempSync(join(tmpdir(), "preheat-erro-backups-"));
    try {
      mkdirSync(join(root, "260507"), { recursive: true });
      mkdirSync(join(root, "260507-backup-20260507T2352Z"), { recursive: true });
      writeFileSync(
        join(root, "260507", "02-reviewed.md"),
        `Nessa edição, escrevi "A" onde deveria ser "B".`,
        "utf8",
      );
      writeFileSync(
        join(root, "260507-backup-20260507T2352Z", "02-reviewed.md"),
        `Nessa edição, escrevi "BACKUP" onde deveria ser "WRONG".`,
        "utf8",
      );

      const r = findPreviousIntentionalErrorFromMd(root, "260508");
      assert.equal(r?.edition, "260507", "deve usar a versão canônica AAMMDD");
      assert.equal(r?.detail, "A");
    } finally {
      rmSync(root, { recursive: true });
    }
  });
});

describe("resolvePreviousError (#1854/#1860)", () => {
  const jsonl = (edition: string, extra: Partial<IntentionalError> = {}): IntentionalError => ({
    edition,
    error_type: "factual",
    is_feature: true,
    detail: `detail-${edition}`,
    ...extra,
  });
  const md = (edition: string, extra: Partial<Record<string, string>> = {}) => ({
    edition,
    detail: `md-detail-${edition}`,
    gabarito: `md-gabarito-${edition}`,
    narrative: `md-narrativa-${edition}`,
    ...extra,
  });

  it("mesma edição → enriquece JSONL com campos do MD (source jsonl+md)", () => {
    const r = resolvePreviousError(jsonl("260603"), md("260603"));
    assert.equal(r.source, "jsonl+md");
    assert.equal(r.gap, false);
    assert.equal(r.prev?.edition, "260603");
    // JSONL não tinha narrativa → puxa do MD
    assert.equal(r.prev?.narrative, "md-narrativa-260603");
  });

  it("#1589: mesma edição com drift → MD frontmatter vence (correct_value)", () => {
    // JSONL tem correct_value stale (publish-time); editor corrigiu o MD
    // depois. MD é autoritativo — evita o "reveal Frankenstein" do 260528→260529.
    const r = resolvePreviousError(
      jsonl("260603", { correct_value: "valor-stale-do-jsonl" }),
      md("260603", { correct_value: "Satya Nadella" }),
    );
    assert.equal(r.prev?.correct_value, "Satya Nadella");
  });

  it("#1589: mesma edição com drift → MD frontmatter vence (detail)", () => {
    const r = resolvePreviousError(
      jsonl("260603", { detail: "detail-stale-do-jsonl" }),
      md("260603", { detail: "detail-corrigido-no-md" }),
    );
    assert.equal(r.prev?.detail, "detail-corrigido-no-md");
    // narrative/gabarito sempre vêm do MD (JSONL nunca os carrega).
    assert.equal(r.prev?.narrative, "md-narrativa-260603");
    assert.equal(r.prev?.gabarito, "md-gabarito-260603");
  });

  it("#1589: MD sem correct_value → preserva o do JSONL (não apaga)", () => {
    // Old behavior: `...(fromMd.correct_value ? {…} : {})` — MD só sobrescreve
    // quando tem valor. Sem valor no MD, mantém o do JSONL.
    const r = resolvePreviousError(
      jsonl("260603", { correct_value: "do-jsonl" }),
      md("260603"), // md() não inclui correct_value
    );
    assert.equal(r.prev?.correct_value, "do-jsonl");
  });

  it("MD mais recente que JSONL → gap-fill do MD (source md, gap true)", () => {
    // JSONL parou em 260603; 260604 declarou erro só na prosa.
    const r = resolvePreviousError(jsonl("260603"), md("260604"));
    assert.equal(r.source, "md");
    assert.equal(r.gap, true);
    assert.equal(r.prev?.edition, "260604");
    assert.equal(r.prev?.narrative, "md-narrativa-260604");
  });

  it("MD mais antigo que JSONL → usa JSONL (source jsonl, sem gap)", () => {
    const r = resolvePreviousError(jsonl("260604"), md("260602"));
    assert.equal(r.source, "jsonl");
    assert.equal(r.gap, false);
    assert.equal(r.prev?.edition, "260604");
  });

  it("só JSONL → source jsonl", () => {
    const r = resolvePreviousError(jsonl("260604"), null);
    assert.equal(r.source, "jsonl");
    assert.equal(r.gap, false);
    assert.equal(r.prev?.edition, "260604");
  });

  it("só MD → source md (sem gap, JSONL nunca existiu)", () => {
    const r = resolvePreviousError(null, md("260604"));
    assert.equal(r.source, "md");
    assert.equal(r.gap, false);
    assert.equal(r.prev?.edition, "260604");
  });

  it("nenhum → null", () => {
    const r = resolvePreviousError(null, null);
    assert.equal(r.prev, null);
    assert.equal(r.source, null);
    assert.equal(r.gap, false);
  });
});

describe("render-erro-intencional CLI (#911)", () => {
  function runCli(args: string[]) {
    const projectRoot = join(import.meta.dirname, "..");
    const scriptPath = join(projectRoot, "scripts", "render-erro-intencional.ts");
    return spawnSync(
      process.execPath,
      ["--import", "tsx", scriptPath, ...args],
      { cwd: projectRoot, encoding: "utf8" },
    );
  }

  it("integração: insere seção lendo errors.jsonl + MD", () => {
    const dir = mkdtempSync(join(tmpdir(), "render-erro-int-"));
    try {
      const mdPath = join(dir, "02-reviewed.md");
      const errPath = join(dir, "intentional-errors.jsonl");
      writeFileSync(
        mdPath,
        [
          "OUTRAS NOTÍCIAS",
          "",
          "Item.",
          "",
          "---",
          "",
          "**ASSINE**",
          "Convite.",
        ].join("\n"),
        "utf8",
      );
      writeFileSync(
        errPath,
        JSON.stringify({
          edition: "260506",
          error_type: "wrong_number",
          is_feature: true,
          detail: "Texto trazia '220 anos' onde deveria ser '22 anos'",
          gabarito: "22 anos",
        }) + "\n",
        "utf8",
      );

      const r = runCli([
        "--edition",
        "260507",
        "--md",
        mdPath,
        "--errors",
        errPath,
      ]);
      assert.equal(r.status, 0, r.stderr);
      const out = JSON.parse(r.stdout);
      assert.equal(out.action, "inserted");
      assert.equal(out.prev_edition, "260506");
      assert.equal(out.prev_revealed, true);
      const updated = readFileSync(mdPath, "utf8");
      assert.match(updated, /\*\*ERRO INTENCIONAL\*\*/);
      // #1079: reveal agora começa com "Na última edição, ..."
      assert.match(updated, /Na última edição/);
      assert.match(updated, /22 anos/);
      // Placeholder pra autor escrever o erro corrente
      assert.match(updated, /\{PREENCHER_NARRATIVA_DO_ERRO\}/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("#2411 fix: integração — prev MD tem description catálogo + corpo genérico → sem reveal válido (fallback neutro)", () => {
    // Regressão #2411: antes, description catálogo virava reveal público quebrado.
    // Após o fix: body genérico é filtrado, sem `narrative` no frontmatter → prev_revealed=false.
    // Reveal na próxima edição: "A edição anterior não trazia erro intencional declarado."
    const dir = mkdtempSync(join(tmpdir(), "render-erro-int-2411-"));
    try {
      const editionsRoot = join(dir, "editions");
      mkdirSync(join(editionsRoot, "260520"), { recursive: true });
      mkdirSync(join(editionsRoot, "260521"), { recursive: true });

      // Edição anterior 260520: frontmatter description catálogo + corpo genérico
      // (padrão real observado em 260617/260618 — descrição com "DESTAQUE N")
      writeFileSync(
        join(editionsRoot, "260520", "02-reviewed.md"),
        [
          "---",
          "intentional_error:",
          '  description: "DESTAQUE 2 lista o Spotify entre os assistentes de IA"',
          '  location: "DESTAQUE 2"',
          '  category: "factual"',
          '  correct_value: "Perplexity ou Copilot"',
          "---",
          "",
          "Body.",
          "",
          "**ERRO INTENCIONAL**",
          "",
          "Na última edição, foo.",
          "",
          "Nessa edição, há um erro proposital escondido em um dos destaques. Responda este e-mail com a correção para concorrer ao sorteio.",
          "",
        ].join("\n"),
        "utf8",
      );

      // Edição atual 260521: MD que vai receber a seção ERRO INTENCIONAL
      const mdPath = join(editionsRoot, "260521", "02-reviewed.md");
      writeFileSync(
        mdPath,
        ["OUTRAS NOTÍCIAS", "", "Item.", "", "---", "", "**ASSINE**", "X"].join("\n"),
        "utf8",
      );

      const r = runCli([
        "--edition",
        "260521",
        "--md",
        mdPath,
        "--editions-dir",
        editionsRoot,
        "--errors",
        join(dir, "ghost.jsonl"), // forçar caminho MD
      ]);
      assert.equal(r.status, 0, r.stderr);
      const out = JSON.parse(r.stdout);
      // Sem fonte válida de reveal (body genérico + sem narrative no frontmatter)
      assert.equal(out.prev_revealed, false, "sem fonte first-person → sem reveal válido");
      const updated = readFileSync(mdPath, "utf8");
      // A linha "Na última edição, ..." não deve conter label interno "DESTAQUE N"
      const revealLine = updated.split("\n").find((l) => l.startsWith("Na última edição,")) ?? "";
      assert.doesNotMatch(revealLine, /DESTAQUE\s+\d/, "reveal não deve vazar label interno DESTAQUE N");
      // Fallback neutro correto
      assert.match(updated, /não trazia erro intencional declarado/, "deve usar fallback neutro");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("#2411 fix: integração — prev MD com body first-person → reveal correto, sem label interno", () => {
    // Caso onde o editor escreveu a prosa first-person no corpo (como deveria):
    // o reveal deve usar essa prosa e NÃO vazar labels internos.
    const dir = mkdtempSync(join(tmpdir(), "render-erro-int-2411-fp-"));
    try {
      const editionsRoot = join(dir, "editions");
      mkdirSync(join(editionsRoot, "260520"), { recursive: true });
      mkdirSync(join(editionsRoot, "260521"), { recursive: true });

      // Edição anterior 260520: frontmatter description catálogo + corpo first-person
      writeFileSync(
        join(editionsRoot, "260520", "02-reviewed.md"),
        [
          "---",
          "intentional_error:",
          '  description: "DESTAQUE 2 lista o Spotify entre os assistentes de IA"',
          '  location: "DESTAQUE 2"',
          '  category: "factual"',
          '  correct_value: "Perplexity ou Copilot"',
          "---",
          "",
          "Body.",
          "",
          "**ERRO INTENCIONAL**",
          "",
          "Na última edição, foo.",
          "",
          "Nessa edição, listei o Spotify como assistente de IA no DESTAQUE 2, mas o correto é Perplexity.",
          "",
        ].join("\n"),
        "utf8",
      );

      const mdPath = join(editionsRoot, "260521", "02-reviewed.md");
      writeFileSync(
        mdPath,
        ["OUTRAS NOTÍCIAS", "", "Item.", "", "---", "", "**ASSINE**", "X"].join("\n"),
        "utf8",
      );

      const r = runCli([
        "--edition",
        "260521",
        "--md",
        mdPath,
        "--editions-dir",
        editionsRoot,
        "--errors",
        join(dir, "ghost.jsonl"),
      ]);
      assert.equal(r.status, 0, r.stderr);
      const out = JSON.parse(r.stdout);
      assert.equal(out.prev_revealed, true, "body first-person → reveal válido");
      const updated = readFileSync(mdPath, "utf8");
      // Reveal usa a prosa first-person do corpo
      assert.match(updated, /Na última edição, listei o Spotify/);
      // O reveal é gramatical e não vaza label "DESTAQUE N" como prefixo
      assert.doesNotMatch(updated, /Na última edição, DESTAQUE/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("integração: errors.jsonl ausente → seção com placeholder neutro", () => {
    const dir = mkdtempSync(join(tmpdir(), "render-erro-int-noerr-"));
    try {
      const mdPath = join(dir, "02-reviewed.md");
      writeFileSync(
        mdPath,
        ["OUTRAS NOTÍCIAS", "", "Item.", "", "---", "", "**ASSINE**", "X"].join("\n"),
        "utf8",
      );
      const ghostErrPath = join(dir, "ghost.jsonl");
      const r = runCli([
        "--edition",
        "260507",
        "--md",
        mdPath,
        "--errors",
        ghostErrPath,
      ]);
      assert.equal(r.status, 0, r.stderr);
      const out = JSON.parse(r.stdout);
      assert.equal(out.prev_revealed, false);
      const updated = readFileSync(mdPath, "utf8");
      assert.match(updated, /não trazia erro intencional declarado/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("#2078: prev.no_error branch — frase natural no reveal", () => {
  it("findPreviousIntentionalError inclui entrada no_error=true", () => {
    const errors: IntentionalError[] = [
      { edition: "260605", error_type: "none", is_feature: false, no_error: true },
      { edition: "260604", error_type: "factual", is_feature: true, detail: "X" },
    ];
    const r = findPreviousIntentionalError(errors, "260606");
    // no_error=true deve ser incluído (mais recente)
    assert.equal(r?.edition, "260605");
    assert.equal(r?.no_error, true);
  });

  it("#2667: integração CLI: prev no_error=true → reveal=null (sem 'Na última edição...')", () => {
    // Regressão #2667: antes (#2078), no_error=true gerava
    // "Na última edição, não havia erro intencional: quem respondeu que não há erro, acertou."
    // Isso propagava um reveal-fantasma quando o editor cancelava o erro sem limpar o frontmatter.
    // Após o fix (#2667): no_error=true → reveal=null → texto neutro "A edição anterior não trazia..."
    const dir = mkdtempSync(join(tmpdir(), "render-erro-none-"));
    try {
      const mdPath = join(dir, "02-reviewed.md");
      const errPath = join(dir, "intentional-errors.jsonl");
      writeFileSync(
        mdPath,
        ["OUTRAS NOTICIAS", "", "Item.", "", "---", "", "**ASSINE**", "X"].join("\n"),
        "utf8",
      );
      writeFileSync(
        errPath,
        JSON.stringify({
          edition: "260605",
          error_type: "none",
          is_feature: false,
          no_error: true,
          source: "frontmatter_02_reviewed",
          detected_by: "sync-intentional-error.ts none scalar (#2016)",
          resolution: "no_error_declared",
        }) + "\n",
        "utf8",
      );

      const projectRoot = join(import.meta.dirname, "..");
      const scriptPath = join(projectRoot, "scripts", "render-erro-intencional.ts");
      const r = spawnSync(process.execPath, ["--import", "tsx", scriptPath,
        "--edition", "260606",
        "--md", mdPath,
        "--errors", errPath,
      ], { cwd: projectRoot, encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
      const out = JSON.parse(r.stdout);
      // #2667: reveal=null → prev_revealed=false
      assert.equal(out.prev_revealed, false, "#2667: no_error=true deve resultar em reveal=null (prev_revealed=false)");
      assert.equal(out.prev_edition, "260605");
      const updated = readFileSync(mdPath, "utf8");
      // #2667: NÃO deve inserir linha de reveal "Na última edição, ..." no corpo do ERRO INTENCIONAL
      // Atenção: o frontmatter placeholder tem "Na última edição, escrevi X..." como exemplo —
      // checar que a LINHA DO REVEAL no bloco ERRO INTENCIONAL NÃO começa com "Na última edição,".
      const erroIdx = updated.indexOf("**ERRO INTENCIONAL**");
      assert.ok(erroIdx >= 0, "bloco ERRO INTENCIONAL deve estar presente");
      const erroBlock = updated.slice(erroIdx, updated.indexOf("\n---", erroIdx + 1));
      assert.doesNotMatch(erroBlock, /^Na última edição,/m, "#2667: corpo do bloco não deve ter reveal quando prev no_error=true");
      // Deve usar o texto neutro do renderSection(null, ...)
      assert.match(updated, /não trazia erro intencional declarado/, "deve usar fallback neutro");
      // NÃO pode ter a concatenação mecânica antiga
      assert.doesNotMatch(erroBlock, /o correto é não há erro/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("#2667: integração CLI: prev com reveal válido (is_feature=true) → 'Na última edição...' é inserido (não-regressão do caminho feliz)", () => {
    // Non-regression: quando prev tem reveal válido, o reveal DEVE ser inserido.
    // Este é o caminho feliz — não pode ser quebrado pelo fix #2667.
    const dir = mkdtempSync(join(tmpdir(), "render-erro-feliz-"));
    try {
      const mdPath = join(dir, "02-reviewed.md");
      const errPath = join(dir, "intentional-errors.jsonl");
      writeFileSync(
        mdPath,
        ["OUTRAS NOTICIAS", "", "Item.", "", "---", "", "**ASSINE**", "X"].join("\n"),
        "utf8",
      );
      writeFileSync(
        errPath,
        JSON.stringify({
          edition: "260607",
          error_type: "factual",
          is_feature: true,
          reveal: "Na última edição, escrevi 1990 onde o correto é 1998.",
          source: "frontmatter_02_reviewed",
        }) + "\n",
        "utf8",
      );

      const projectRoot = join(import.meta.dirname, "..");
      const scriptPath = join(projectRoot, "scripts", "render-erro-intencional.ts");
      const r = spawnSync(process.execPath, ["--import", "tsx", scriptPath,
        "--edition", "260608",
        "--md", mdPath,
        "--errors", errPath,
      ], { cwd: projectRoot, encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
      const out = JSON.parse(r.stdout);
      // Caminho feliz: prev com reveal válido → prev_revealed=true
      assert.equal(out.prev_revealed, true, "reveal válido deve ser inserido (não-regressão #2667)");
      assert.equal(out.prev_edition, "260607");
      const updated = readFileSync(mdPath, "utf8");
      // O reveal deve aparecer no MD
      assert.match(updated, /Na última edição, escrevi 1990 onde o correto é 1998/, "reveal válido deve ser inserido no MD");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("ensureIntentionalErrorFrontmatter (#2284)", () => {
  it("nada a fazer quando frontmatter com intentional_error já existe", () => {
    const md = `---\nintentional_error:\n  description: "x"\n  location: "D1"\n  category: "factual"\n  correct_value: "y"\n---\nCorpo.`;
    const { md: out, inserted } = ensureIntentionalErrorFrontmatter(md);
    assert.equal(inserted, false);
    assert.equal(out, md); // idempotente
  });

  it("insere placeholder frontmatter quando nenhum frontmatter existe", () => {
    const md = "Corpo sem frontmatter.\n\n**ERRO INTENCIONAL**\n\nNessa edição, {PREENCHER}.";
    const { md: out, inserted } = ensureIntentionalErrorFrontmatter(md);
    assert.equal(inserted, true);
    assert.match(out, /^---\n/); // frontmatter no topo
    assert.match(out, /intentional_error:/);
    assert.match(out, /description:/);
    assert.match(out, /location:/);
    assert.match(out, /category:/);
    assert.match(out, /correct_value:/);
    assert.match(out, /PREENCHER/); // placeholder presente
  });

  it("insere intentional_error dentro de frontmatter existente que não tem a chave", () => {
    const md = "---\noutro_campo: valor\n---\nCorpo.";
    const { md: out, inserted } = ensureIntentionalErrorFrontmatter(md);
    assert.equal(inserted, true);
    assert.match(out, /intentional_error:/);
    // frontmatter deve permanecer como bloco único
    const fmMatch = out.match(/^---\n([\s\S]*?)\n---/);
    assert.ok(fmMatch, "frontmatter não encontrado após inserção");
    assert.match(fmMatch![1], /outro_campo/); // campo original preservado
    assert.match(fmMatch![1], /intentional_error/); // campo novo adicionado
  });

  it("idempotente: 2ª chamada não modifica quando placeholder já existe", () => {
    const md = "Corpo.";
    const { md: after1, inserted: ins1 } = ensureIntentionalErrorFrontmatter(md);
    assert.equal(ins1, true, "primeira chamada deve inserir frontmatter"); // P3 fix #2300
    const { md: after2, inserted: ins2 } = ensureIntentionalErrorFrontmatter(after1);
    assert.equal(ins2, false);
    assert.equal(after2, after1);
  });

  it("integração CLI: frontmatter inserido no output do script (#2284)", () => {
    // Verificar que o script render-erro-intencional.ts grava o frontmatter
    // no arquivo quando ele está ausente (regressão do bug 260615).
    const dir = mkdtempSync(join(tmpdir(), "render-erro-fm-"));
    try {
      const mdPath = join(dir, "02-reviewed.md");
      writeFileSync(mdPath, "Corpo sem frontmatter.\n\n**ERRO INTENCIONAL**\n\nNessa edição, {PREENCHER}.\n");
      // Sem errors.jsonl — script deve rodar sem crashar e inserir o frontmatter
      const projectRoot = join(import.meta.dirname, "..");
      const scriptPath = join(projectRoot, "scripts", "render-erro-intencional.ts");
      const r = spawnSync(process.execPath, ["--import", "tsx", scriptPath,
        "--edition", "260616",
        "--md", mdPath,
        "--errors", join(dir, "nonexistent.jsonl"),
      ], { cwd: projectRoot, encoding: "utf8" });
      assert.equal(r.status, 0, `stderr: ${r.stderr}`);
      const out = JSON.parse(r.stdout);
      assert.equal(out.frontmatter_inserted, true);
      const written = readFileSync(mdPath, "utf8");
      assert.match(written, /intentional_error:/);
      assert.match(written, /description:/);
      assert.match(written, /correct_value:/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // P1 fix #2300: CRLF regression tests
  it("P1 #2300: CRLF — currentHasIntentionalErrorFlag detecta frontmatter com \\r\\n", () => {
    // Simula 02-reviewed.md salvo com CRLF no Windows
    const md = "---\r\nintentional_error:\r\n  description: \"x\"\r\n---\r\nCorpo.";
    assert.equal(currentHasIntentionalErrorFlag(md), true, "deve detectar com CRLF");
  });

  it("P1 #2300: CRLF — ensureIntentionalErrorFrontmatter não duplica frontmatter com \\r\\n", () => {
    // Simula MD com frontmatter CRLF existente (sem intentional_error) —
    // antes do fix, regex ^(---\n) não casava ---\r\n, caindo no branch
    // "sem frontmatter" e ADICIONANDO um bloco no topo → frontmatter duplicado.
    const md = "---\r\noutro: valor\r\n---\r\nCorpo.";
    const { md: out, inserted } = ensureIntentionalErrorFrontmatter(md);
    assert.equal(inserted, true);
    // Deve ter exatamente 1 bloco frontmatter (não duplicado)
    const fences = (out.match(/^---/gm) ?? []).length;
    assert.equal(fences, 2, `esperado 2 fences (1 bloco), encontrado ${fences}`);
    assert.match(out, /intentional_error:/);
    // Campo original preservado
    assert.match(out, /outro: valor/);
  });

  it("P1 #2300: $ — ensureIntentionalErrorFrontmatter não corrompe valores com $ no frontmatter", () => {
    // Simula frontmatter com campo contendo $ (ex: correct_value: "R$1.5bi")
    // Antes do fix, String.replace(full, `${open}${newBody}${close}`) interpretava
    // $1 como capture group (empty string), corrompendo o valor.
    const md = "---\nsubtitle: \"Investimento R$1.5bi\"\n---\nCorpo.";
    const { md: out, inserted } = ensureIntentionalErrorFrontmatter(md);
    assert.equal(inserted, true);
    // O valor com $ deve estar INTACTO no output
    assert.match(out, /subtitle: "Investimento R\$1\.5bi"/, "campo com $ não deve ser corrompido");
    assert.match(out, /intentional_error:/, "intentional_error deve ter sido adicionado");
  });
});

// ── Regressão #2377: narrativeIsGenericPlaceholder ──────────────────────────────────────────
//
// Root cause fix: o bug foi causado por um `narrative` genérico (copiado do bloco de convite
// ao sorteio) que acabou sendo formatado por composeRevealText como reveal real. O guard
// detecta esse texto genérico e bloqueia no Stage 4 antes da publicação.

import { narrativeIsGenericPlaceholder } from "../scripts/render-erro-intencional.ts";
import {
  checkNarrativeNotGenericPlaceholder,
  checkNoErrorBodyConsistent,
} from "../scripts/lib/invariant-checks/stage-4.ts";

describe("narrativeIsGenericPlaceholder (#2377 root cause fix)", () => {
  // ── Input exato do bug — regressão obrigatória (#633) ──────────────────────────────────────
  it("detecta EXATAMENTE o input do bug #2377 como genérico", () => {
    // Este é o narrative que causou o incidente: extraído do bloco de convite ao sorteio
    // em vez de uma declaração real do editor. Causou publish:
    // "Na última edição, há um erro proposital escondido em um dos destaques. Responda este
    //  e-mail com a correção para concorrer ao sorteio, o correto é Microsoft"
    const bugNarrative =
      "há um erro proposital escondido em um dos destaques. Responda este e-mail com a correção para concorrer ao sorteio";
    assert.equal(
      narrativeIsGenericPlaceholder(bugNarrative),
      true,
      "o narrative exato do bug #2377 deve ser detectado como genérico",
    );
  });

  it("detecta 'há um erro proposital' (variante simples)", () => {
    assert.equal(
      narrativeIsGenericPlaceholder("há um erro proposital em algum dos destaques"),
      true,
    );
  });

  it("detecta 'esta edição tem um erro proposital'", () => {
    assert.equal(
      narrativeIsGenericPlaceholder("esta edição tem um erro proposital escondido"),
      true,
    );
  });

  it("detecta 'responda este e-mail'", () => {
    assert.equal(
      narrativeIsGenericPlaceholder("responda este e-mail com a correção"),
      true,
    );
  });

  it("detecta 'concorrer ao sorteio'", () => {
    assert.equal(
      narrativeIsGenericPlaceholder("para concorrer ao sorteio mensal"),
      true,
    );
  });

  it("detecta 'um erro escondido em'", () => {
    assert.equal(
      narrativeIsGenericPlaceholder("há um erro escondido em um dos destaques"),
      true,
    );
  });

  // ── Declarações reais de primeira pessoa devem passar (false) ──────────────────────────────
  it("passa (false) em declaração real de primeira pessoa — 'escrevi que'", () => {
    assert.equal(
      narrativeIsGenericPlaceholder(
        "escrevi que a empresa parceira da DeepSeek se chamava Macrosoft, quando o correto é Microsoft",
      ),
      false,
    );
  });

  it("passa (false) em declaração real — 'contei que'", () => {
    assert.equal(
      narrativeIsGenericPlaceholder(
        "contei que Karpathy cofundou a OpenAI em 1914, depois liderou a IA da Tesla",
      ),
      false,
    );
  });

  it("passa (false) em declaração real — 'coloquei X onde deveria ser Y'", () => {
    assert.equal(
      narrativeIsGenericPlaceholder(
        "coloquei junho onde deveria ser maio na data de lançamento",
      ),
      false,
    );
  });

  it("passa (false) em texto vazio", () => {
    assert.equal(narrativeIsGenericPlaceholder(""), false);
  });
});

describe("composeRevealText com narrativeIsGenericPlaceholder — warn de defense-in-depth (#2377)", () => {
  it("emite warn quando narrative é o placeholder genérico exato do bug", () => {
    // Este é o cenário exato do bug: narrative genérico chegou até composeRevealText
    // e seria formatado verbatim. O warn é a defense-in-depth (o blocker primário
    // é o lint do Stage 4).
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (msg: string) => warnings.push(msg);
    try {
      const bugNarrative =
        "há um erro proposital escondido em um dos destaques. Responda este e-mail com a correção para concorrer ao sorteio";
      const prev = {
        edition: "260601",
        error_type: "factual",
        is_feature: true,
        narrative: bugNarrative,
        correct_value: "Microsoft",
      } as IntentionalError & { narrative: string };
      const text = composeRevealText(prev);
      // Deve ter emitido o warn sobre narrative genérico
      const warnFound = warnings.some((w) => w.includes("#2377") || w.includes("placeholder genérico"));
      assert.ok(warnFound, `Nenhum warn sobre placeholder genérico. Warns: ${JSON.stringify(warnings)}`);
      // Ainda produz output (não bloqueia — o blocker é o lint)
      assert.match(text, /^Na última edição,/);
    } finally {
      console.warn = originalWarn;
    }
  });
});

describe("checkNarrativeNotGenericPlaceholder — invariant Stage 4 (#2377)", () => {
  it("retorna violation quando narrative é o placeholder genérico exato do bug", () => {
    const dir = mkdtempSync(join(tmpdir(), "stage4-narrative-generic-"));
    try {
      const md = [
        "**ERRO INTENCIONAL**",
        "",
        "Na última edição, X.",
        "",
        // Este é o narrative genérico exato que causou o incidente
        "Nessa edição, há um erro proposital escondido em um dos destaques. Responda este e-mail com a correção para concorrer ao sorteio.",
        "",
        "---",
        "",
        "**ASSINE**",
        "Texto.",
      ].join("\n");
      writeFileSync(join(dir, "02-reviewed.md"), md, "utf8");
      const violations = checkNarrativeNotGenericPlaceholder(dir);
      assert.equal(violations.length, 1, "deve retornar 1 violation para o narrative genérico");
      assert.equal(violations[0].rule, "narrative-not-generic-placeholder");
      assert.equal(violations[0].severity, "warning"); // hotfix: rebaixado error→warning (#2403)
      assert.match(
        violations[0].message,
        /placeholder genérico|há um erro proposital/i,
        "mensagem deve mencionar o problema (placeholder genérico ou a frase que causou o bug)",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("retorna 0 violations quando narrative é declaração real de primeira pessoa", () => {
    const dir = mkdtempSync(join(tmpdir(), "stage4-narrative-ok-"));
    try {
      const md = [
        "**ERRO INTENCIONAL**",
        "",
        "Na última edição, X.",
        "",
        "Nessa edição, escrevi que a empresa parceira da DeepSeek se chamava Macrosoft, quando o correto é Microsoft.",
        "",
        "---",
        "",
        "**ASSINE**",
        "Texto.",
      ].join("\n");
      writeFileSync(join(dir, "02-reviewed.md"), md, "utf8");
      const violations = checkNarrativeNotGenericPlaceholder(dir);
      assert.equal(violations.length, 0, "narrative real não deve gerar violation");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("retorna 0 violations quando 02-reviewed.md não tem seção ERRO INTENCIONAL", () => {
    const dir = mkdtempSync(join(tmpdir(), "stage4-narrative-noblock-"));
    try {
      writeFileSync(
        join(dir, "02-reviewed.md"),
        ["**ASSINE**", "", "Texto."].join("\n"),
        "utf8",
      );
      const violations = checkNarrativeNotGenericPlaceholder(dir);
      assert.equal(violations.length, 0, "sem bloco ERRO INTENCIONAL — sem violation");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("retorna 0 violations quando 02-reviewed.md não existe", () => {
    const dir = mkdtempSync(join(tmpdir(), "stage4-narrative-nofile-"));
    try {
      // não criar o arquivo
      const violations = checkNarrativeNotGenericPlaceholder(dir);
      assert.equal(violations.length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── #2398: extractNarrativeFromFrontmatter + fix de fonte ────────────────────────────────────
//
// #2411 reverteu a prioridade do fix #2398: `description` é catálogo (lint/catalog),
// NÃO é mais fonte do reveal. Apenas o campo `narrative` do frontmatter é aceito
// como fonte do reveal pelo `extractNarrativeFromFrontmatter`.

describe("extractNarrativeFromFrontmatter (#2398 + #2411)", () => {
  it("#2411: só description no frontmatter → null (description é catálogo, não fonte do reveal)", () => {
    // #2398 retornava description; #2411 reverte: description é catálogo, não reveal.
    const md = [
      "---",
      "intentional_error:",
      '  description: "DESTAQUE 2 lista o Spotify entre os assistentes de IA que teriam evoluído"',
      '  location: "DESTAQUE 2"',
      '  category: "factual"',
      '  correct_value: "Perplexity ou Copilot"',
      "---",
      "",
      "Nessa edição, há um erro proposital escondido em um dos destaques.",
      "",
    ].join("\n");
    const r = extractNarrativeFromFrontmatter(md);
    // #2411: description é catálogo → null (não é fonte do reveal)
    assert.equal(r, null, "#2411: description é catálogo, não deve ser retornada como narrative do reveal");
  });

  it("aceita alias `narrative:` no frontmatter (fonte do reveal)", () => {
    const md = [
      "---",
      "intentional_error:",
      '  narrative: "escrevi Microsoft onde deveria ser Macrosoft"',
      '  location: "DESTAQUE 3"',
      '  category: "ortografico"',
      '  correct_value: "Microsoft"',
      "---",
      "",
      "Body.",
    ].join("\n");
    const r = extractNarrativeFromFrontmatter(md);
    assert.equal(r, "escrevi Microsoft onde deveria ser Macrosoft");
  });

  it("retorna null quando frontmatter ausente", () => {
    assert.equal(extractNarrativeFromFrontmatter("Corpo sem frontmatter."), null);
  });

  it("retorna null quando intentional_error sem narrative", () => {
    const md = [
      "---",
      "intentional_error:",
      '  location: "D1"',
      '  category: "factual"',
      '  correct_value: "2014"',
      "---",
    ].join("\n");
    assert.equal(extractNarrativeFromFrontmatter(md), null);
  });

  it("retorna null quando narrative é placeholder {PREENCHER}", () => {
    const md = [
      "---",
      "intentional_error:",
      '  description: "DESTAQUE X usa Y"',
      '  narrative: "{PREENCHER — o que o assinante deve identificar}"',
      '  location: "{PREENCHER}"',
      "---",
    ].join("\n");
    assert.equal(extractNarrativeFromFrontmatter(md), null);
  });
});

describe("extractIntentionalErrorFromMd — prioridade frontmatter (#2398 + #2411)", () => {
  it("(a) #2411: frontmatter description catálogo + corpo genérico → null (não vaza label)", () => {
    // #2398 retornava description catálogo como narrative; #2411 reverte.
    // Com o fix: body genérico é filtrado, description catálogo não é fonte → null.
    const md = [
      "---",
      "intentional_error:",
      '  description: "DESTAQUE 3 usa Macrosoft em vez de Microsoft no primeiro parágrafo"',
      '  location: "DESTAQUE 3, primeiro parágrafo"',
      '  category: "ortografico"',
      '  correct_value: "Microsoft"',
      "---",
      "",
      "**ERRO INTENCIONAL**",
      "",
      "Na última edição, X.",
      "",
      "Nessa edição, há um erro proposital escondido em um dos destaques. Responda este e-mail com a correção para concorrer ao sorteio.",
      "",
    ].join("\n");
    const r = extractIntentionalErrorFromMd(md);
    // #2411: description é catálogo + body é genérico → null
    assert.equal(r, null, "#2411: description catálogo + body genérico → null");
  });

  it("(b) sem frontmatter description, corpo específico → fallback funciona (back-compat)", () => {
    // Edição legada: sem frontmatter, corpo tem narrativa específica.
    const md = [
      "---",
      "intentional_error:",
      '  location: "DESTAQUE 1"',
      '  category: "factual"',
      '  correct_value: "2014"',
      "---",
      "",
      "**ERRO INTENCIONAL**",
      "",
      "Nessa edição, escrevi que a OpenAI foi fundada em 1914, quando o correto é 2014.",
      "",
    ].join("\n");
    const r = extractIntentionalErrorFromMd(md);
    assert.ok(r !== null, "fallback para corpo deve funcionar");
    assert.equal(r!.narrative, "escrevi que a OpenAI foi fundada em 1914, quando o correto é 2014");
    assert.equal(r!.correct_value, "2014");
    assert.equal(narrativeIsGenericPlaceholder(r!.narrative), false);
  });

  it("(c) #2411: sem frontmatter narrative, corpo genérico → extractIntentionalErrorFromMd=null", () => {
    // #2411: corpo genérico é filtrado pelo extractIntentionalErrorFromMd (não retornado).
    // (O lint Stage 4 checkNarrativeNotGenericPlaceholder detecta isso diretamente.)
    const md = [
      "**ERRO INTENCIONAL**",
      "",
      "Na última edição, X.",
      "",
      "Nessa edição, há um erro proposital escondido em um dos destaques. Responda este e-mail com a correção para concorrer ao sorteio.",
      "",
    ].join("\n");
    const r = extractIntentionalErrorFromMd(md);
    // #2411: genérico filtrado → null (o lint acessa o corpo diretamente)
    assert.equal(r, null, "#2411: corpo genérico filtrado → null");
  });
});

describe("checkNarrativeNotGenericPlaceholder — fix #2411 (guard Stage 4)", () => {
  it("#2411: 1 violation (warning) quando frontmatter só tem description catálogo + corpo genérico", () => {
    // Este é o caso real 260617/260618: editor preencheu description (catálogo) mas
    // não preencheu narrative first-person. O lint deve sinalizar que falta a declaração.
    const dir = mkdtempSync(join(tmpdir(), "stage4-2411-description-catalog-"));
    try {
      const md = [
        "---",
        "intentional_error:",
        '  description: "DESTAQUE 2 lista o Spotify entre os assistentes de IA"',
        '  location: "DESTAQUE 2, parágrafo dos motivos"',
        '  category: "factual"',
        '  correct_value: "Perplexity ou Copilot"',
        "---",
        "",
        "**ERRO INTENCIONAL**",
        "",
        "Na última edição, X.",
        "",
        "Nessa edição, há um erro proposital escondido em um dos destaques. Responda este e-mail com a correção para concorrer ao sorteio.",
        "",
        "---",
        "",
        "**ASSINE**",
        "Texto.",
      ].join("\n");
      writeFileSync(join(dir, "02-reviewed.md"), md, "utf8");
      const violations = checkNarrativeNotGenericPlaceholder(dir);
      // #2411: sem narrative first-person → lint deve sinalizar (warning)
      assert.equal(violations.length, 1,
        `description catálogo + corpo genérico deve gerar 1 violation (falta narrative first-person). Got: ${JSON.stringify(violations)}`);
      assert.equal(violations[0].severity, "warning");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("#2411: 0 violations quando frontmatter narrative específico + corpo genérico", () => {
    // Editor preencheu `narrative` first-person no frontmatter → lint OK.
    const dir = mkdtempSync(join(tmpdir(), "stage4-2411-narrative-ok-"));
    try {
      const md = [
        "---",
        "intentional_error:",
        '  description: "DESTAQUE 2 lista o Spotify entre os assistentes de IA"',
        '  narrative: "listei o Spotify como assistente de IA, mas o correto é Perplexity"',
        '  location: "DESTAQUE 2"',
        '  category: "factual"',
        '  correct_value: "Perplexity ou Copilot"',
        "---",
        "",
        "**ERRO INTENCIONAL**",
        "",
        "Na última edição, X.",
        "",
        "Nessa edição, há um erro proposital escondido em um dos destaques. Responda este e-mail com a correção para concorrer ao sorteio.",
        "",
        "---",
        "",
        "**ASSINE**",
        "Texto.",
      ].join("\n");
      writeFileSync(join(dir, "02-reviewed.md"), md, "utf8");
      const violations = checkNarrativeNotGenericPlaceholder(dir);
      assert.equal(violations.length, 0,
        `frontmatter narrative first-person OK → sem violation. Got: ${JSON.stringify(violations)}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("#2411: 1 violation (warning) quando frontmatter ausente E corpo genérico", () => {
    // Sem frontmatter description E sem narrative: o corpo genérico deve sinalizar.
    const dir = mkdtempSync(join(tmpdir(), "stage4-2398-no-fm-generic-"));
    try {
      const md = [
        "**ERRO INTENCIONAL**",
        "",
        "Na última edição, X.",
        "",
        "Nessa edição, há um erro proposital escondido em um dos destaques. Responda este e-mail com a correção para concorrer ao sorteio.",
        "",
        "---",
        "",
        "**ASSINE**",
        "Texto.",
      ].join("\n");
      writeFileSync(join(dir, "02-reviewed.md"), md, "utf8");
      const violations = checkNarrativeNotGenericPlaceholder(dir);
      assert.equal(violations.length, 1, "sem frontmatter + corpo genérico deve gerar 1 violation");
      assert.equal(violations[0].severity, "warning");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── #2410 discriminants: bugs 1-3 de extractNarrativeFromFrontmatter ─────────────────────────
//
// Estes testes foram escritos para o fix #2398 (que priorizava description).
// O fix #2411 reverteu a prioridade: `description` é catálogo (lint/catalog),
// `narrative` é o campo para o reveal (primeira pessoa). Os testes foram atualizados
// para refletir o novo contrato.
//
// (a) Bug 1: agora irrelevante para description (não é mais lida pelo reveal).
//     Mantido para documentar que `narrative` com aspas duplas é lido corretamente.
// (b) narrative={PREENCHER} → null (sem campo narrative válido → null).
// (c) Precedência: agora `narrative` tem precedência (campo do reveal); description é ignorado.
// (d) `narrative` com aspas simples → valor sem aspas.
// (e) description vazia + prosa válida no corpo → fallback pro corpo (inalterado).

describe("extractNarrativeFromFrontmatter — discriminants (#2410/#2411)", () => {
  // (a) narrative com aspas duplas → valor extraído SEM aspas
  it("(a) narrative com aspas duplas → valor extraído SEM aspas", () => {
    const md = [
      "---",
      "intentional_error:",
      '  description: "DESTAQUE 2 lista o Spotify entre os assistentes de IA"',
      '  narrative: "escrevi que o Spotify era um assistente de IA no DESTAQUE 2"',
      '  location: "DESTAQUE 2"',
      '  category: "factual"',
      '  correct_value: "Perplexity"',
      "---",
      "",
      "Corpo.",
    ].join("\n");
    const r = extractNarrativeFromFrontmatter(md);
    // #2411: apenas o campo `narrative` é fonte do reveal
    assert.equal(r, "escrevi que o Spotify era um assistente de IA no DESTAQUE 2",
      "narrative sem aspas duplas vazando");
    assert.ok(!r!.startsWith('"'), 'valor não deve começar com "');
    assert.ok(!r!.endsWith('"'), 'valor não deve terminar com "');
  });

  // (b) #2411: sem campo `narrative` (só description) → null
  it("(b) sem campo narrative (só description) → retorna null (#2411)", () => {
    const md = [
      "---",
      "intentional_error:",
      '  description: "DESTAQUE 3 diz que a Meta foi fundada em 1994"',
      '  location: "DESTAQUE 3"',
      '  category: "factual"',
      '  correct_value: "2004"',
      "---",
      "",
      "Corpo.",
    ].join("\n");
    const r = extractNarrativeFromFrontmatter(md);
    // description é catálogo → NÃO é fonte do reveal → null
    assert.equal(r, null,
      "#2411: description é catálogo, não deve ser retornada por extractNarrativeFromFrontmatter");
  });

  // (b2) narrative={PREENCHER} → null (placeholder não preenchido)
  it("(b2) narrative={PREENCHER} → null (placeholder)", () => {
    const md = [
      "---",
      "intentional_error:",
      '  description: "DESTAQUE 3 diz que a Meta foi fundada em 1994"',
      '  narrative: "{PREENCHER — o que o assinante deve identificar}"',
      '  location: "DESTAQUE 3"',
      '  category: "factual"',
      '  correct_value: "2004"',
      "---",
      "",
      "Corpo.",
    ].join("\n");
    const r = extractNarrativeFromFrontmatter(md);
    // narrative placeholder → null (description não é fallback para o reveal)
    assert.equal(r, null,
      "narrative={PREENCHER} deve retornar null — description não é fonte do reveal (#2411)");
  });

  // (c) #2411: quando narrative está preenchido, é retornado (description é ignorado)
  it("(c) narrative preenchido → retorna narrative (description ignorada, #2411)", () => {
    const md = [
      "---",
      "intentional_error:",
      '  description: "campo description catálogo (ignorado)"',
      '  narrative: "escrevi X onde deveria ser Y (primeira pessoa)"',
      '  location: "D1"',
      '  category: "ortografico"',
      '  correct_value: "correto"',
      "---",
    ].join("\n");
    const r = extractNarrativeFromFrontmatter(md);
    assert.equal(r, "escrevi X onde deveria ser Y (primeira pessoa)",
      "#2411: narrative (primeira pessoa) tem precedência; description catálogo é ignorada");
  });

  // (d) narrative com aspas simples → valor sem aspas simples
  it("(d) narrative com aspas simples → valor sem aspas simples", () => {
    const md = [
      "---",
      "intentional_error:",
      "  description: 'DESTAQUE 1: campo catálogo'",
      "  narrative: 'escrevi GPT-4 onde deveria ser GPT-5'",
      "  location: 'DESTAQUE 1'",
      "  category: 'version_inconsistency'",
      "  correct_value: 'GPT-5'",
      "---",
    ].join("\n");
    const r = extractNarrativeFromFrontmatter(md);
    assert.ok(r !== null, "deve extrair valor com aspas simples");
    assert.equal(r, "escrevi GPT-4 onde deveria ser GPT-5",
      "aspas simples do YAML não devem vazar no valor extraído");
    assert.ok(!r!.startsWith("'"), "valor não deve começar com aspas simples");
    assert.ok(!r!.endsWith("'"), "valor não deve terminar com aspas simples");
  });

  // (e) description vazia + prosa válida no corpo → fallback pro corpo funciona (inalterado)
  it("(e) description vazia + prosa 'Nessa edição,' → extractIntentionalErrorFromMd usa corpo", () => {
    // Sem description/narrative preenchidos no frontmatter → extractNarrativeFromFrontmatter=null
    // → extractIntentionalErrorFromMd deve cair no fallback do corpo.
    const md = [
      "---",
      "intentional_error:",
      "  location: 'DESTAQUE 2'",
      "  category: 'factual'",
      "  correct_value: '2014'",
      "---",
      "",
      "**ERRO INTENCIONAL**",
      "",
      "Nessa edição, escrevi que a OpenAI foi fundada em 1904, o correto é 2015.",
      "",
    ].join("\n");
    // extractNarrativeFromFrontmatter deve retornar null (sem description/narrative)
    const fm = extractNarrativeFromFrontmatter(md);
    assert.equal(fm, null, "frontmatter sem narrative deve retornar null");
    // extractIntentionalErrorFromMd deve pegar o corpo como fallback
    const full = extractIntentionalErrorFromMd(md);
    assert.ok(full !== null, "fallback pro corpo deve funcionar");
    assert.ok(
      full!.narrative.includes("fundada em 1904"),
      "narrative deve vir do corpo quando frontmatter não tem narrative",
    );
  });

  // Teste integrado: description catálogo + corpo genérico → null (não vaza label interno)
  it("integrado: description catálogo + corpo genérico → extractIntentionalErrorFromMd=null (#2411)", () => {
    // Com o fix #2411: description é catálogo (não fonte do reveal), corpo é genérico
    // (filtrado por narrativeIsGenericPlaceholder) → null.
    const md = [
      "---",
      "intentional_error:",
      '  description: "DESTAQUE 1 usa o número 42 onde o correto é 24"',
      '  location: "DESTAQUE 1, parágrafo 2"',
      '  category: "numeric"',
      '  correct_value: "24"',
      "---",
      "",
      "**ERRO INTENCIONAL**",
      "",
      "Na última edição, houve um reveal anterior.",
      "",
      "Nessa edição, há um erro proposital escondido em um dos destaques. Responda este e-mail com a correção para concorrer ao sorteio.",
      "",
    ].join("\n");
    const r = extractIntentionalErrorFromMd(md);
    // description é catálogo (ignorada), corpo é genérico (filtrado) → null
    assert.equal(r, null,
      "#2411: description catálogo + corpo genérico → null (não vaza label interno)");
  });
});

// ── Regressão #2304: CRLF round-trip ─────────────────────────────────────────────────────────
//
// Máquina do editor é Windows (OneDrive/VS Code usam CRLF). O caminho
// ensureIntentionalErrorFrontmatter → extractFrontmatter (via checkIntentionalError)
// precisa round-trippar sem false-positive `intentional_error_frontmatter_missing`.

import {
  extractFrontmatter,
  checkIntentionalError,
} from "../scripts/lib/lint-checks/intentional-error.ts";

describe("CRLF round-trip (#2304)", () => {
  it("extractFrontmatter: hits fast-path com CRLF line endings", () => {
    // CRLF file: frontmatter na linha 1 deve acertar o canonical fast-path,
    // não cair no scanner de fallback.
    const crlf = "---\r\nintentional_error: none\r\n---\r\nCorpo.";
    const fm = extractFrontmatter(crlf);
    assert.ok(fm !== null, "extractFrontmatter deve retornar body não-nulo em arquivo CRLF");
    assert.match(fm!, /intentional_error/, "deve conter a chave intentional_error");
  });

  it("extractFrontmatter: retorna body sem \\r ao ser parseado", () => {
    const crlf = "---\r\nfoo: bar\r\nbaz: qux\r\n---\r\nCorpo.";
    const fm = extractFrontmatter(crlf);
    assert.ok(fm !== null);
    // Body deve conter as chaves sem quebrar o parsing YAML simples
    assert.ok(fm!.includes("foo: bar") || fm!.includes("foo: bar\r"), "deve conter a chave foo");
  });

  it("ensureIntentionalErrorFrontmatter: CRLF file → PLACEHOLDER_BLOCK usa \\r\\n", () => {
    // Arquivo CRLF sem frontmatter → novo bloco YAML deve usar CRLF
    const crlfBody = "Corpo da newsletter.\r\nSegunda linha.\r\n";
    const { md: out, inserted } = ensureIntentionalErrorFrontmatter(crlfBody);
    assert.equal(inserted, true, "deve inserir frontmatter");
    // O bloco inserido deve usar CRLF (não LF bare)
    assert.ok(out.includes("---\r\n"), "bloco frontmatter deve ter CRLF (\\r\\n)");
    assert.ok(out.includes("intentional_error:\r\n"), "PLACEHOLDER_BLOCK deve usar \\r\\n");
  });

  it("ensureIntentionalErrorFrontmatter: CRLF file com frontmatter existente → chave inserida com CRLF", () => {
    // Arquivo CRLF com frontmatter existente sem intentional_error
    const crlf = "---\r\nsubtitle: \"Teste\"\r\n---\r\nCorpo.\r\n";
    const { md: out, inserted } = ensureIntentionalErrorFrontmatter(crlf);
    assert.equal(inserted, true, "deve inserir chave no frontmatter existente");
    // Chave inserida deve usar CRLF
    assert.ok(out.includes("intentional_error:\r\n"), "chave inserida deve usar \\r\\n");
    // Frontmatter original intacto
    assert.ok(out.includes("subtitle: \"Teste\""), "campo original deve estar intacto");
  });

  it("round-trip: CRLF file → ensureIntentionalError → extractFrontmatter encontra a chave", () => {
    // Simula: arquivo CRLF vem do Drive → ensureIntentionalErrorFrontmatter insere
    // placeholder → extractFrontmatter consegue parsear → sem false-positive missing.
    const crlfMd = "---\r\nsubtitle: \"Ed 260616\"\r\n---\r\nCorpo.\r\n";
    const { md: withFm } = ensureIntentionalErrorFrontmatter(crlfMd);
    const fm = extractFrontmatter(withFm);
    assert.ok(fm !== null, "extractFrontmatter deve encontrar frontmatter após ensureIntentionalErrorFrontmatter em CRLF");
    assert.match(fm!, /intentional_error/, "frontmatter deve conter intentional_error");
  });

  it("round-trip via checkIntentionalError: CRLF file com {PREENCHER} → incomplete (não missing)", () => {
    // Após ensureIntentionalErrorFrontmatter em CRLF, checkIntentionalError não deve
    // reportar `intentional_error_frontmatter_missing` — deve reportar `_incomplete`
    // (placeholder não preenchido). Demonstra que o fast-path de extractFrontmatter
    // funciona em CRLF.
    const tmp = mkdtempSync(join(tmpdir(), "crlf-roundtrip-"));
    try {
      const crlfMd = "---\r\nsubtitle: \"Ed 260616\"\r\n---\r\nCorpo.\r\n";
      const { md: withFm } = ensureIntentionalErrorFrontmatter(crlfMd);
      const mdPath = join(tmp, "02-reviewed.md");
      // Escrever como binário pra preservar os \r\n
      writeFileSync(mdPath, Buffer.from(withFm));
      const result = checkIntentionalError(mdPath);
      assert.notEqual(
        result.label,
        "intentional_error_missing: 02-reviewed.md sem frontmatter — adicione bloco YAML com intentional_error",
        "não deve reportar missing (frontmatter foi inserido com CRLF)",
      );
      // Deve reportar incomplete (placeholder {PREENCHER} ainda lá) ou missing da chave,
      // mas NÃO "sem frontmatter" (que indicaria que extractFrontmatter falhou).
      assert.ok(
        result.label?.includes("intentional_error_incomplete") ||
        result.label?.includes("não está no formato mapping") ||
        result.label?.includes("placeholder"),
        `label deve indicar incomplete/placeholder, not 'sem frontmatter'. got: ${result.label}`,
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

/**
 * Fixtures mandatórias da reescrita #2419.
 * Cada teste corresponde a uma classe de bug confirmada contra dado real.
 * Sem estes testes → NÃO mergear (#633).
 */
describe("#2419 reescrita — fixtures obrigatórias (6 classes de bug)", () => {
  /**
   * Fixture 1 (bugs #1, #7): reveal numérico/data first-person ("Na última edição,
   * escrevi 1990 onde o correto é 1998.") → campo `reveal` sai INTACTO, não-genérico.
   *
   * Bug #1: narrativeIsCatalogShaped 2ª alternativa `^[A-Z...]{4,}\s+\d` com /i
   * casava QUALQUER palavra 4+ letras + número. "Nessa edição, escrevi 1990 onde..." →
   * reveal substituído por genérico (regex matcha "escrevi" como WORD4+ + "1990").
   *
   * Bug #7: regex #2418 falso-positivo: "Nubank 1 bilhão...", "Meta 3 produtos..." →
   * NUKED e substituído por genérico.
   *
   * Fix #2419: campo `reveal` dedicado usado verbatim. Não passa por narrativeIsCatalogShaped.
   */
  it("Fixture 1 (bugs #1, #7): reveal numérico/data first-person via campo `reveal` → INTACTO", () => {
    const prev: IntentionalError = {
      edition: "260620",
      error_type: "numeric",
      is_feature: true,
      reveal: "Na última edição, escrevi 1990 onde o correto é 1998.",
    };
    const text = composeRevealText(prev);
    // Deve sair verbatim — não genérico, não substituído por fallback
    assert.equal(text, "Na última edição, escrevi 1990 onde o correto é 1998.");
    assert.doesNotMatch(text, /escondemos um erro proposital/);
  });

  it("Fixture 1b (bug #7): reveal com marca+número first-person via campo `reveal` → INTACTO", () => {
    const prev: IntentionalError = {
      edition: "260620",
      error_type: "factual",
      is_feature: true,
      reveal: "Na última edição, escrevi que o Nubank tem 1 bilhão de clientes, o correto é 100 milhões.",
    };
    const text = composeRevealText(prev);
    // Verbatim — não nuked por regex antigo
    assert.match(text, /Nubank tem 1 bilhão de clientes/);
    assert.doesNotMatch(text, /escondemos um erro proposital/);
  });

  /**
   * Fixture 2 (bugs #2, #4, #5, #6, #8, #9, #10): frontmatter só com `description`
   * catalog (sem `reveal`), corpo genérico → reveal = fallback genérico seguro,
   * SEM vazar "DESTAQUE N" nem texto de catálogo.
   *
   * Bug #2: stage-4.ts checkNarrativeNotGenericPlaceholder só checava narrativeIsGenericPlaceholder,
   * nunca catalog-shaped. Caso real 260617 ("Nessa edição, DESTAQUE 2 lista o Spotify...")
   * passava o gate VERDE com 0 violations.
   *
   * Bug #4: insertOrUpdateSection montava "Nessa edição, ${narrative}." sem guard catalog →
   * re-gravava label interno no corpo MD publicado.
   *
   * Bug #5: extractIntentionalErrorFromMd caminho corpo filtrava genérico mas NÃO catalog-shaped.
   *
   * Bug #6: composeRevealText ramo narrative, quando correctValue ausente, emitia `detail` VERBATIM
   * sem re-checar catálogo → vazava label interno.
   *
   * Bug #8: regressão de cobertura #2418: hábito REAL (só `description` no frontmatter + corpo
   * genérico) → extractIntentionalErrorFromMd retornava null → reveal perdia gancho.
   *
   * Bug #9: extractIntentionalErrorFromMd NÃO filtrava catalog-shaped no corpo.
   *
   * Bug #10: narrativeIsGenericPlaceholder SÓ fazia console.warn, não retornava fallback.
   */
  it("Fixture 2 (bugs #2, #4, #5, #6, #8, #9, #10): description catálogo + corpo genérico → fallback seguro, sem leak", () => {
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
      "Nessa edição, há um erro proposital escondido em um dos destaques. Responda este e-mail.",
      "",
    ].join("\n");

    // extractIntentionalErrorFromMd deve retornar null (bug #5/#9 fix)
    const extracted = extractIntentionalErrorFromMd(md);
    assert.equal(extracted, null, "description catálogo + corpo genérico → null (bug #5 fix)");

    // composeRevealText com entry JSONL que tem detail=description (catálogo):
    // NÃO deve vazar "DESTAQUE N" no reveal (bugs #6, #10 fix)
    const prev: IntentionalError = {
      edition: "260617",
      error_type: "factual",
      is_feature: true,
      detail: "DESTAQUE 2 lista o Spotify entre os assistentes de IA",
      correct_value: "Perplexity ou Copilot",
    };
    const text = composeRevealText(prev);
    assert.doesNotMatch(text, /DESTAQUE\s+\d/, "label interno não deve vazar no reveal (bug #6/#10)");
    assert.doesNotMatch(text, /Perplexity|Copilot/, "correct_value não deve sintetizar de detail catalog");
    // Deve usar fallback seguro genérico (#2419)
    assert.match(text, /escondemos um erro proposital/, "fallback seguro esperado");
  });

  it("Fixture 2b (bug #2 — stage-4 lint): corpo catalog-shaped → emite warning (não verde silencioso)", () => {
    // Bug #2: stage-4.ts checkNarrativeNotGenericPlaceholder não detectava catalog-shaped.
    // Caso real 260617: "Nessa edição, DESTAQUE 2 lista o Spotify..." passava sem violação.
    // Fix #2419: checkNarrativeNotGenericPlaceholder detecta catalog-shaped e emite warning.
    const dir = mkdtempSync(join(tmpdir(), "lint-catalog-2419-"));
    try {
      const mdPath = join(dir, "02-reviewed.md");
      writeFileSync(
        mdPath,
        [
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
          "Nessa edição, DESTAQUE 2 lista o Spotify como assistente de IA.",
          "",
          "---",
          "",
          "**ASSINE**",
          "X",
        ].join("\n"),
        "utf8",
      );
      const violations = checkNarrativeNotGenericPlaceholder(dir);
      assert.equal(violations.length, 1, "deve emitir 1 violation para corpo catalog-shaped (bug #2 fix)");
      assert.equal(violations[0].severity, "warning");
      // Mensagem deve apontar para o campo `reveal`
      assert.match(violations[0].message, /reveal/, "mensagem deve apontar para campo reveal");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * Fixture 3 (bug #3): correct_value cláusula inteira ("No lugar de Spotify, um assistente
   * de IA real...") → reveal gramatical, sem "o correto era <cláusula>" agramatical.
   *
   * Bug #3: render-erro-intencional.ts:507 — fallback catalog "o correto era ${correct_value}"
   * assumia noun-phrase, mas correct_value real 260617 era cláusula inteira →
   * "o correto era No lugar de Spotify, um assistente de IA real — por exemplo, Perplexity ou Copilot."
   * (agramatical, chegava aos assinantes).
   *
   * Fix #2419: fallback catalog-shaped usa frase genérica fixa, NÃO sintetiza de correct_value.
   */
  it("Fixture 3 (bug #3): correct_value cláusula inteira + catalog detail → fallback seguro, sem cláusula agramatical", () => {
    const prev: IntentionalError = {
      edition: "260617",
      error_type: "factual",
      is_feature: true,
      detail: "DESTAQUE 2 lista o Spotify entre os assistentes de IA",
      correct_value: "No lugar de Spotify, um assistente de IA real — por exemplo, Perplexity ou Copilot",
    };
    const text = composeRevealText(prev);
    // NÃO deve ter "o correto era <cláusula inteira>" (agramatical)
    assert.doesNotMatch(text, /o correto era No lugar de/);
    // NÃO deve ter label interno
    assert.doesNotMatch(text, /DESTAQUE\s+\d/);
    // Fallback seguro genérico
    assert.match(text, /escondemos um erro proposital/);
  });

  /**
   * Fixture 4 (bug #2417): frontmatter empurrado para ~linha 40 (após bloco TÍTULO/SUBTÍTULO)
   * → campo `reveal` é lido corretamente (scanLines=60, #2417).
   */
  it("Fixture 4 (#2417): frontmatter em linha ~40 (após TÍTULO/SUBTÍTULO) → reveal lido via scanLines=60", () => {
    // Simula o caso: insert-titulo-subtitulo.ts empurra o frontmatter além da linha 30.
    const headerLines = Array.from({ length: 30 }, (_, i) => `Linha de conteúdo ${i + 1}.`);
    const md = [
      ...headerLines,
      "---",
      "intentional_error:",
      '  description: "DESTAQUE 2 lista X"',
      '  location: "DESTAQUE 2"',
      '  category: "factual"',
      '  correct_value: "Y"',
      '  reveal: "Na última edição, escrevi X onde o correto é Y."',
      "---",
      "",
      "Corpo.",
    ].join("\n");

    // extractNarrativeFromFrontmatter deve encontrar o campo reveal (scanLines=60)
    const narrative = extractNarrativeFromFrontmatter(md);
    assert.equal(
      narrative,
      "Na última edição, escrevi X onde o correto é Y.",
      "extractNarrativeFromFrontmatter deve ler reveal em frontmatter após linha 30 (scanLines=60)",
    );

    // extractRevealFromFrontmatter também deve encontrar
    const reveal = extractRevealFromFrontmatter(md);
    assert.equal(reveal, "Na última edição, escrevi X onde o correto é Y.");

    // composeRevealText com o `reveal` propagado deve retornar verbatim
    const prev: IntentionalError = {
      edition: "260620",
      error_type: "factual",
      is_feature: true,
      reveal: "Na última edição, escrevi X onde o correto é Y.",
    };
    const text = composeRevealText(prev);
    assert.equal(text, "Na última edição, escrevi X onde o correto é Y.");
  });

  /**
   * Fixture 5 (bug #2 — stage-4 lint catalog-shaped): quando o campo `reveal` do
   * frontmatter aponta para narrative que seria catalog-shaped (edge case) →
   * stage-4 lint emite warning apontando para o campo correto.
   */
  it("Fixture 5 (bug #2 fix): stage-4 lint detecta narrative catalog-shaped no frontmatter narrative legado → warning com ref ao campo reveal", () => {
    const dir = mkdtempSync(join(tmpdir(), "lint-fm-catalog-2419-"));
    try {
      const mdPath = join(dir, "02-reviewed.md");
      writeFileSync(
        mdPath,
        [
          "---",
          "intentional_error:",
          '  description: "DESTAQUE 3: empresa X aparece como Y"',
          '  narrative: "DESTAQUE 3: empresa X aparece como Y"',
          '  location: "DESTAQUE 3"',
          '  category: "ortografico"',
          '  correct_value: "Y"',
          "---",
          "",
          "**ERRO INTENCIONAL**",
          "",
          "Na última edição, foo.",
          "",
          "Nessa edição, {PREENCHER_NARRATIVA_DO_ERRO}.",
          "",
          "---",
          "",
          "**ASSINE**",
          "X",
        ].join("\n"),
        "utf8",
      );
      const violations = checkNarrativeNotGenericPlaceholder(dir);
      // Deve emitir warning (não verde silencioso)
      assert.equal(violations.length, 1, "deve detectar narrative catalog-shaped (bug #2 fix)");
      assert.equal(violations[0].severity, "warning");
      // Mensagem deve apontar para campo `reveal` (#2419)
      assert.match(violations[0].message, /reveal/, "mensagem deve referenciar campo reveal");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * Fixture 6: campo `reveal` preenchido corretamente no frontmatter →
   * composeRevealText usa VERBATIM, sem transformações.
   */
  it("Fixture 6: campo `reveal` preenchido → composeRevealText usa verbatim (sem síntese)", () => {
    // Caso feliz: editor preencheu `reveal` com frase completa first-person.
    const prev: IntentionalError = {
      edition: "260620",
      error_type: "numeric",
      is_feature: true,
      detail: "DESTAQUE 1: ano de fundação errado",
      correct_value: "1998",
      reveal: "Na última edição, escrevi que a empresa foi fundada em 1990. O correto é 1998.",
    };
    const text = composeRevealText(prev);
    // Usado verbatim — não transforma, não adiciona prefixo, não consulta detail/correct_value
    assert.equal(
      text,
      "Na última edição, escrevi que a empresa foi fundada em 1990. O correto é 1998.",
    );
    // NÃO faz auto-append de "o correto é" (field já é completo)
    assert.doesNotMatch(text, /o correto é 1998\..*o correto é/, "não deve duplicar correção");
  });

  it("Fixture 6b: campo `reveal` lido do frontmatter via extractNarrativeFromFrontmatter (prioridade sobre narrative legado)", () => {
    const md = [
      "---",
      "intentional_error:",
      '  description: "Catalog description"',
      '  narrative: "escrevi algo legado"',
      '  reveal: "Na última edição, escrevi que X. O correto é Y."',
      '  correct_value: "Y"',
      "---",
      "",
      "Corpo.",
    ].join("\n");
    // extractNarrativeFromFrontmatter deve preferir `reveal` sobre `narrative`
    const narrative = extractNarrativeFromFrontmatter(md);
    assert.equal(
      narrative,
      "Na última edição, escrevi que X. O correto é Y.",
      "deve preferir campo `reveal` sobre `narrative` legado",
    );

    // extractRevealFromFrontmatter também deve encontrar
    const reveal = extractRevealFromFrontmatter(md);
    assert.equal(reveal, "Na última edição, escrevi que X. O correto é Y.");
  });
});

// ── Fixtures obrigatórias do self-review #2431 ──────────────────────────────────────────────────

describe("#2431 self-review — F1: guard de pontuação terminal", () => {
  it("F1: reveal terminando em '?' não recebe ponto extra (evita 'viu?.')", () => {
    // Reveal que termina DIRETAMENTE em '?' (sem texto após a pontuação)
    const prev: IntentionalError = {
      edition: "260620",
      error_type: "factual",
      is_feature: true,
      reveal: "Na última edição, isso era realmente verdade?",
    };
    const text = composeRevealText(prev);
    // Termina em ? → NÃO deve anexar ponto → sem "?."
    assert.doesNotMatch(text, /\?\./);
    assert.ok(text.endsWith("?"), `deve terminar em ? (got: ${text.slice(-5)})`);
  });

  it("F1: reveal terminando em '!' não recebe ponto extra", () => {
    const prev: IntentionalError = {
      edition: "260620",
      error_type: "factual",
      is_feature: true,
      reveal: "Na última edição, errei feio!",
    };
    const text = composeRevealText(prev);
    assert.doesNotMatch(text, /!\./);
    assert.ok(text.endsWith("!"), `deve terminar em ! (got: ${text.slice(-5)})`);
  });

  it("F1: reveal terminando em '.' não duplica ponto", () => {
    const prev: IntentionalError = {
      edition: "260620",
      error_type: "factual",
      is_feature: true,
      reveal: "Na última edição, escrevi 1990 onde o correto é 1998.",
    };
    const text = composeRevealText(prev);
    assert.doesNotMatch(text, /\.\./);
    assert.ok(text.endsWith("."), `deve terminar em . (got: ${text.slice(-5)})`);
  });

  it("F1: reveal sem pontuação terminal recebe ponto", () => {
    const prev: IntentionalError = {
      edition: "260620",
      error_type: "factual",
      is_feature: true,
      reveal: "Na última edição, escrevi 1990 onde o correto é 1998",
    };
    const text = composeRevealText(prev);
    assert.ok(text.endsWith("."), `deve receber ponto terminal (got: ${text.slice(-5)})`);
  });
});

describe("#2431 self-review — F2: fallback genérico unificado (prioridade 4)", () => {
  it("F2: entry sem reveal/narrative/detail → fallback unificado (não 'houve um erro intencional')", () => {
    const prev: IntentionalError = {
      edition: "260504",
      error_type: "factual",
      is_feature: true,
      // sem reveal, narrative, detail, gabarito — apenas campos mínimos
    };
    const text = composeRevealText(prev);
    // F2: string unificada com outros caminhos de fallback
    assert.match(text, /escondemos um erro proposital — obrigado a quem respondeu apontando/);
    // Não deve usar a frase rasa antiga
    assert.doesNotMatch(text, /houve um erro intencional/);
  });

  it("F2: entry com detail catalog-shaped → mesmo fallback unificado", () => {
    const prev: IntentionalError = {
      edition: "260617",
      error_type: "factual",
      is_feature: true,
      detail: "DESTAQUE 2 lista o Spotify entre os assistentes de IA",
    };
    const text = composeRevealText(prev);
    assert.match(text, /escondemos um erro proposital — obrigado a quem respondeu apontando/);
  });
});

describe("#2431 self-review — F3: stage-4 lint inspeciona campo reveal", () => {
  it("F3: reveal catalog-shaped ('DESTAQUE N...') no frontmatter → 1 warning do stage-4 lint", () => {
    const dir = mkdtempSync(join(tmpdir(), "stage4-reveal-catalog-"));
    try {
      const mdPath = join(dir, "02-reviewed.md");
      writeFileSync(
        mdPath,
        [
          "---",
          "intentional_error:",
          '  description: "DESTAQUE 2 lista o Spotify entre os assistentes de IA"',
          '  location: "DESTAQUE 2"',
          '  category: "factual"',
          '  correct_value: "Perplexity ou Copilot"',
          // Editor copiou description para reveal por engano
          '  reveal: "DESTAQUE 2 lista o Spotify entre os assistentes de IA"',
          "---",
          "",
          "**ERRO INTENCIONAL**",
          "",
          "Na última edição, foo.",
          "",
          "Nessa edição, {PREENCHER_NARRATIVA_DO_ERRO}.",
          "",
          "---",
          "",
          "**ASSINE**",
          "X",
        ].join("\n"),
        "utf8",
      );
      const violations = checkNarrativeNotGenericPlaceholder(dir);
      assert.equal(violations.length, 1, "reveal catalog-shaped deve gerar 1 warning");
      assert.equal(violations[0].severity, "warning", "decisão editorial 260619 — lints ficam warning");
      assert.match(violations[0].message, /reveal/, "mensagem deve mencionar campo reveal");
      assert.match(violations[0].message, /catálogo|DESTAQUE/i, "mensagem deve descrever o problema");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("F3: reveal correto (first-person) → 0 violations do stage-4 lint", () => {
    const dir = mkdtempSync(join(tmpdir(), "stage4-reveal-ok-"));
    try {
      const mdPath = join(dir, "02-reviewed.md");
      writeFileSync(
        mdPath,
        [
          "---",
          "intentional_error:",
          '  description: "DESTAQUE 2 lista o Spotify entre os assistentes de IA"',
          '  location: "DESTAQUE 2"',
          '  category: "factual"',
          '  correct_value: "Perplexity ou Copilot"',
          '  reveal: "Na última edição, listei o Spotify como assistente de IA, mas o Spotify é um serviço de streaming."',
          "---",
          "",
          "**ERRO INTENCIONAL**",
          "",
          "Na última edição, foo.",
          "",
          "Nessa edição, {PREENCHER_NARRATIVA_DO_ERRO}.",
          "",
          "---",
          "",
          "**ASSINE**",
          "X",
        ].join("\n"),
        "utf8",
      );
      const violations = checkNarrativeNotGenericPlaceholder(dir);
      assert.equal(violations.length, 0, "reveal first-person correto não deve gerar violation");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("#2431 self-review — F4: boldQuotedStrings aplicado ao campo reveal", () => {
  it("F4: reveal com string entre aspas duplas → boldQuotedStrings aplicado corretamente", () => {
    const prev: IntentionalError = {
      edition: "260620",
      error_type: "factual",
      is_feature: true,
      reveal: 'Na última edição, escrevi "iPhone 5" onde o correto é "iPhone 15".',
    };
    const text = composeRevealText(prev);
    assert.match(text, /\*\*"iPhone 5"\*\*/, "aspas duplas devem virar negrito");
    assert.match(text, /\*\*"iPhone 15"\*\*/, "aspas duplas devem virar negrito");
    // Não deve duplicar negrito
    assert.doesNotMatch(text, /\*\*\*\*/, "não deve duplicar negrito");
  });

  it("F4: reveal com aspas simples → boldQuotedStrings aplicado corretamente", () => {
    const prev: IntentionalError = {
      edition: "260620",
      error_type: "factual",
      is_feature: true,
      reveal: "Na última edição, escrevi 'V4' onde o correto é 'V8'.",
    };
    const text = composeRevealText(prev);
    assert.match(text, /\*\*'V4'\*\*/, "aspas simples devem virar negrito");
    assert.match(text, /\*\*'V8'\*\*/, "aspas simples devem virar negrito");
  });

  it("F4: reveal sem aspas → boldQuotedStrings não altera o texto (preserva verbatim)", () => {
    const reveal = "Na última edição, escrevi 1990 onde o correto é 1998.";
    const prev: IntentionalError = {
      edition: "260620",
      error_type: "factual",
      is_feature: true,
      reveal,
    };
    const text = composeRevealText(prev);
    assert.equal(text, reveal, "reveal sem aspas deve sair verbatim (boldQuotedStrings não altera)");
  });
});

describe("#2431 self-review — F5: round-trip JSONL (frontmatterToEntry → serialize → parse → find → resolve → compose)", () => {
  it("F5: frontmatter com reveal → serializa pro JSONL → parseia → resolve da edição anterior → composeRevealText retorna o reveal correto (não-genérico)", () => {
    // Simula o caminho completo que produziria um reveal em produção:
    // 1. Editor preenche frontmatter com campo `reveal`
    // 2. sync-intentional-error.ts chama frontmatterToEntry → escreve no JSONL
    // 3. render-erro-intencional chama loadIntentionalErrors → findPreviousIntentionalError
    //    → resolvePreviousError → composeRevealText

    const revealText = "Na última edição, escrevi que a empresa foi fundada em 1990. O correto é 1998.";

    // Passo 1: frontmatter → entry
    const entry = frontmatterToEntry(
      {
        description: "DESTAQUE 1: ano de fundação errado",
        location: "DESTAQUE 1",
        category: "factual",
        correct_value: "1998",
        reveal: revealText,
      },
      "260619",
    );

    // Verifica que frontmatterToEntry preserva o campo reveal
    assert.equal(entry.reveal, revealText, "frontmatterToEntry deve propagar campo reveal");
    assert.equal(entry.edition, "260619");

    // Passo 2: serializa pro JSONL
    const jsonlLine = JSON.stringify(entry);

    // Passo 3: parseia do JSONL
    const parsed = parseIntentionalErrorsJsonl(jsonlLine);
    assert.equal(parsed.length, 1, "deve parsear 1 entry do JSONL");
    assert.equal(parsed[0].reveal, revealText, "campo reveal deve sobreviver ao round-trip JSONL");

    // Passo 4: findPreviousIntentionalError encontra a entry (edição 260619 < 260620)
    const found = findPreviousIntentionalError(parsed, "260620");
    assert.ok(found !== null, "findPreviousIntentionalError deve encontrar a entry");
    assert.equal(found!.reveal, revealText, "entry encontrada deve ter o campo reveal");

    // Passo 5: resolvePreviousError (sem MD — só JSONL)
    const { prev } = resolvePreviousError(found, null);
    assert.ok(prev !== null, "resolvePreviousError deve retornar entry");
    assert.equal(prev!.reveal, revealText, "entry resolvida deve ter o campo reveal");

    // Passo 6: composeRevealText retorna o reveal correto (não-genérico, não fallback)
    const text = composeRevealText(prev as IntentionalError & { narrative?: string; gabarito?: string });
    assert.equal(text, revealText, "composeRevealText deve retornar o reveal verbatim (não fallback)");
    assert.doesNotMatch(text, /escondemos um erro proposital/, "não deve usar fallback genérico");
    assert.doesNotMatch(text, /DESTAQUE\s+\d/, "não deve vazar label interno");
  });

  it("F5b: frontmatterToEntry sem reveal → composeRevealText cai no fallback (regressão: frontmatterToEntry não silencia reveal)", () => {
    // Se frontmatterToEntry descartasse o campo reveal, o round-trip retornaria
    // fallback genérico mesmo quando o editor preencheu o campo — essa regressão
    // deve ser detectada.
    const entry = frontmatterToEntry(
      {
        description: "DESTAQUE 2 lista o Spotify",
        location: "DESTAQUE 2",
        category: "factual",
        correct_value: "Perplexity",
        // sem `reveal` — editor não preencheu
      },
      "260619",
    );

    assert.equal(entry.reveal, undefined, "sem reveal no frontmatter → entry sem reveal");

    // composeRevealText deve usar fallback (detail é catalog-shaped)
    const text = composeRevealText(entry as IntentionalError & { narrative?: string; gabarito?: string });
    assert.match(text, /escondemos um erro proposital/, "sem reveal + detail catalog → fallback genérico");
    assert.doesNotMatch(text, /Perplexity/, "correct_value não deve vazar em fallback catalog");
  });
});

describe("#2438 — guards adicionais (block-scalar, CRLF, caso 3)", () => {
  // Item 3: block-scalar YAML (`reveal: |`) deve ser tratado como campo AUSENTE.
  describe("extractRevealFromFrontmatter — guard block-scalar (#2438 Item 3)", () => {
    it("reveal: | (block-scalar isolado) → null (campo tratado como ausente)", () => {
      // Bug: o regex de linha única captura "|" como valor literal, publicando "|."
      // como texto de reveal. Após o guard, "|" isolado é tratado como ausente.
      const md = [
        "---",
        "intentional_error:",
        '  description: "DESTAQUE 2 lista o Spotify"',
        "  reveal: |",
        "    Na última edição, escrevi algo errado.",
        "---",
        "",
        "Body.",
      ].join("\n");
      assert.equal(extractRevealFromFrontmatter(md), null,
        "reveal: | deve retornar null (block-scalar não capturado pelo regex de linha única)");
    });

    it("reveal: > (folded block-scalar) → null (campo tratado como ausente)", () => {
      const md = [
        "---",
        "intentional_error:",
        '  description: "DESTAQUE 3"',
        "  reveal: >",
        "    Na última edição, a empresa era outra.",
        "---",
      ].join("\n");
      assert.equal(extractRevealFromFrontmatter(md), null,
        "reveal: > deve retornar null (block-scalar folded não capturado)");
    });

    it("reveal: |- (block-scalar com strip) → null", () => {
      const md = [
        "---",
        "intentional_error:",
        "  reveal: |-",
        "    texto aqui",
        "---",
      ].join("\n");
      assert.equal(extractRevealFromFrontmatter(md), null,
        "reveal: |- deve retornar null");
    });

    it("reveal com texto real entre aspas → retorna o valor corretamente", () => {
      // Guard não deve afetar valores legítimos.
      const md = [
        "---",
        "intentional_error:",
        '  reveal: "Na última edição, escrevi 1990 onde o correto é 1998."',
        "---",
      ].join("\n");
      assert.equal(extractRevealFromFrontmatter(md), "Na última edição, escrevi 1990 onde o correto é 1998.",
        "reveal com valor real não deve ser afetado pelo guard");
    });
  });

  // Item 3: extractNarrativeFromFrontmatter também deve respeitar o guard de block-scalar
  // (compartilhado via extractIeFields).
  describe("extractNarrativeFromFrontmatter — guard block-scalar (#2438 Item 3)", () => {
    it("narrative: | → null (block-scalar tratado como ausente)", () => {
      const md = [
        "---",
        "intentional_error:",
        "  narrative: |",
        "    Algum texto aqui.",
        "---",
      ].join("\n");
      assert.equal(extractNarrativeFromFrontmatter(md), null,
        "narrative: | deve retornar null");
    });
  });

  // Finding 1 (#2438 self-review): block-scalar guard em extractCorrectValueFromFrontmatter.
  // O loop manual anterior bypassa o guard BLOCK_SCALAR_RE — correct_value: |
  // retornava "|" literal em vez de null.
  describe("extractCorrectValueFromFrontmatter — guard block-scalar (#2438 finding 1)", () => {
    it("correct_value: | (block-scalar) → null (não retorna '|' literal)", () => {
      const md = [
        "---",
        "intentional_error:",
        '  description: "Teste"',
        "  correct_value: |",
        "    valor real aqui",
        "---",
      ].join("\n");
      assert.equal(extractCorrectValueFromFrontmatter(md), null,
        "correct_value: | deve retornar null (block-scalar, valor real em linhas seguintes não capturadas)");
    });

    it("correct_value: > (folded) → null", () => {
      const md = [
        "---",
        "intentional_error:",
        '  description: "Teste"',
        "  correct_value: >",
        "    valor aqui",
        "---",
      ].join("\n");
      assert.equal(extractCorrectValueFromFrontmatter(md), null,
        "correct_value: > deve retornar null (block-scalar folded)");
    });

    it("correct_value: |- → null", () => {
      const md = [
        "---",
        "intentional_error:",
        "  correct_value: |-",
        "    valor aqui",
        "---",
      ].join("\n");
      assert.equal(extractCorrectValueFromFrontmatter(md), null,
        "correct_value: |- deve retornar null");
    });

    it("correct_value com valor real → retorna corretamente (guard não afeta caso normal)", () => {
      const md = [
        "---",
        "intentional_error:",
        '  correct_value: "1998"',
        "---",
      ].join("\n");
      assert.equal(extractCorrectValueFromFrontmatter(md), "1998",
        "correct_value com valor normal não deve ser afetado pelo guard");
    });

    it("correct_value: {PREENCHER} → null (guard placeholder também via extractField)", () => {
      const md = [
        "---",
        "intentional_error:",
        '  correct_value: "{PREENCHER — valor correto}"',
        "---",
      ].join("\n");
      assert.equal(extractCorrectValueFromFrontmatter(md), null,
        "correct_value com placeholder {PREENCHER} deve retornar null");
    });
  });

  // Finding 2 (#2438 self-review): BLOCK_SCALAR_RE não cobria indicadores
  // combinados indent+chomping (|2-, >2+, |2-, >2+ são headers YAML válidos).
  describe("BLOCK_SCALAR_RE — indicadores combinados indent+chomping (#2438 finding 2)", () => {
    it("|2- (indent+chomping) → null em extractRevealFromFrontmatter", () => {
      const md = [
        "---",
        "intentional_error:",
        "  reveal: |2-",
        "    texto aqui",
        "---",
      ].join("\n");
      assert.equal(extractRevealFromFrontmatter(md), null,
        "reveal: |2- deve retornar null (block-scalar com indent+chomping)");
    });

    it(">2+ (indent+chomping folded) → null em extractRevealFromFrontmatter", () => {
      const md = [
        "---",
        "intentional_error:",
        "  reveal: >2+",
        "    texto aqui",
        "---",
      ].join("\n");
      assert.equal(extractRevealFromFrontmatter(md), null,
        "reveal: >2+ deve retornar null (block-scalar folded com indent+chomping)");
    });

    it("|2 (só indent, sem chomping) → null em extractRevealFromFrontmatter", () => {
      const md = [
        "---",
        "intentional_error:",
        "  reveal: |2",
        "    texto aqui",
        "---",
      ].join("\n");
      assert.equal(extractRevealFromFrontmatter(md), null,
        "reveal: |2 deve retornar null (block-scalar com indicador de indent)");
    });

    it("|2- → null em extractCorrectValueFromFrontmatter (via extractField)", () => {
      const md = [
        "---",
        "intentional_error:",
        "  correct_value: |2-",
        "    1998",
        "---",
      ].join("\n");
      assert.equal(extractCorrectValueFromFrontmatter(md), null,
        "correct_value: |2- deve retornar null");
    });
  });

  // Item 7: CRLF-safety em extractCorrectValueFromFrontmatter.
  describe("extractCorrectValueFromFrontmatter — CRLF-safety (#2438 Item 7)", () => {
    it("CRLF no frontmatter → correct_value extraído corretamente (sem \\r trailing)", () => {
      // Bug: split('\\n') em checkout Windows gerava correct_value com \\r trailing
      // (ex: "2014\\r") → trim() resolve o \\r, mas com CRLF em certos casos o parser
      // falhava. Usar extractFrontmatter (CRLF-safe) resolve.
      const md = [
        "---",
        "intentional_error:",
        '  description: "Teste"',
        '  correct_value: "2014"',
        "---",
        "",
        "Body.",
      ].join("\r\n"); // Simula checkout Windows com CRLF
      assert.equal(extractCorrectValueFromFrontmatter(md), "2014",
        "CRLF no frontmatter deve retornar correct_value sem \\r trailing");
    });

    it("LF normal → correct_value extraído corretamente (regressão: não quebra case LF)", () => {
      const md = [
        "---",
        "intentional_error:",
        '  correct_value: "2025"',
        "---",
      ].join("\n");
      assert.equal(extractCorrectValueFromFrontmatter(md), "2025");
    });

    it("CRLF com frontmatter após bloco TÍTULO (até linha 60) → ainda detectado", () => {
      // #1378: frontmatter pode estar além da linha 30 quando TÍTULO/SUBTÍTULO injetados.
      const lines = [
        "**TÍTULO**",
        "",
        "Manchete",
        "",
        "**SUBTÍTULO**",
        "",
        "Sub",
        "",
        "---",
        "intentional_error:",
        '  correct_value: "42"',
        "---",
        "",
        "Body.",
      ];
      const md = lines.join("\r\n");
      assert.equal(extractCorrectValueFromFrontmatter(md), "42",
        "CRLF com frontmatter após TÍTULO deve retornar correct_value");
    });
  });
});

// ── #2667: checkNoErrorBodyConsistent ────────────────────────────────────────────────────────
//
// Validator: quando frontmatter declara `intentional_error: none` (sem erro) mas
// o corpo ainda tem uma narrativa "Nessa edição, ..." plantada → violation.
//
// Cobre o cenário exato do incidente: 260629 tinha erro plantado no corpo + reveal
// no frontmatter, editor decidiu "sem erro", mas ninguém limpou o corpo nem o frontmatter.
// A edição seguinte (260630) usou o reveal fantasma.
// (#2667 — regressão obrigatória #633)

describe("checkNoErrorBodyConsistent (#2667 — validator)", () => {
  it("violation quando frontmatter none + corpo com narrativa plantada (cenário exato do bug)", () => {
    // Este é o cenário exato do incidente 260629→260630:
    // - frontmatter: intentional_error: none (editor decidiu sem erro)
    // - corpo ERRO INTENCIONAL: "Nessa edição, escrevi Sol onde deveria ser Luna."
    // → Inconsistência: corpo ainda tem erro plantado; próxima edição geraria reveal fantasma.
    const dir = mkdtempSync(join(tmpdir(), "no-error-inconsistent-"));
    try {
      const md = [
        "---",
        "intentional_error: none",
        "---",
        "",
        "**DESTAQUE 1**",
        "",
        "Texto do destaque.",
        "",
        "---",
        "",
        "**ERRO INTENCIONAL**",
        "",
        "A edição anterior não trazia erro intencional declarado.",
        "",
        "Nessa edição, escrevi Sol onde deveria ser Luna.",
        "",
        "---",
        "",
        "**ASSINE**",
        "Texto.",
      ].join("\n");
      writeFileSync(join(dir, "02-reviewed.md"), md, "utf8");
      const violations = checkNoErrorBodyConsistent(dir);
      assert.equal(violations.length, 1, "deve retornar 1 violation quando no_error + narrativa plantada no corpo");
      assert.equal(violations[0].rule, "no-error-body-consistent");
      assert.equal(violations[0].severity, "error");
      assert.match(
        violations[0].message,
        /intentional_error: none.*ainda tem uma narrativa|nenhum\s+|declara.*none|frontmatter declara/i,
        "mensagem deve descrever a inconsistência",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sem violation quando frontmatter none + corpo só com placeholder (edição consistente)", () => {
    // Após o fix correto (#2667): editor setou none + substituiu narrativa por placeholder
    // → sem inconsistência.
    const dir = mkdtempSync(join(tmpdir(), "no-error-consistent-"));
    try {
      const md = [
        "---",
        "intentional_error: none",
        "---",
        "",
        "**ERRO INTENCIONAL**",
        "",
        "A edição anterior não trazia erro intencional declarado.",
        "",
        "Nessa edição, {PREENCHER_NARRATIVA_DO_ERRO}.",
        "",
        "---",
        "",
        "**ASSINE**",
        "Texto.",
      ].join("\n");
      writeFileSync(join(dir, "02-reviewed.md"), md, "utf8");
      const violations = checkNoErrorBodyConsistent(dir);
      assert.equal(violations.length, 0, "sem violation quando no_error + placeholder no corpo");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sem violation quando frontmatter tem erro completo (is_feature=true via 4 campos) — não é edição none", () => {
    // Sem regressão: edições normais (com erro declarado) não devem gerar violation.
    const dir = mkdtempSync(join(tmpdir(), "no-error-normal-"));
    try {
      const md = [
        "---",
        "intentional_error:",
        '  description: "Erro factual"',
        '  location: "DESTAQUE 1"',
        '  category: "factual"',
        '  correct_value: "2025"',
        "---",
        "",
        "**ERRO INTENCIONAL**",
        "",
        "A edição anterior não trazia erro intencional declarado.",
        "",
        "Nessa edição, escrevi 2024 onde deveria ser 2025.",
        "",
        "---",
        "",
        "**ASSINE**",
        "Texto.",
      ].join("\n");
      writeFileSync(join(dir, "02-reviewed.md"), md, "utf8");
      const violations = checkNoErrorBodyConsistent(dir);
      assert.equal(violations.length, 0, "edição normal com erro declarado não deve gerar violation");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sem violation quando 02-reviewed.md não existe", () => {
    const dir = mkdtempSync(join(tmpdir(), "no-error-nofile-"));
    try {
      const violations = checkNoErrorBodyConsistent(dir);
      assert.equal(violations.length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

