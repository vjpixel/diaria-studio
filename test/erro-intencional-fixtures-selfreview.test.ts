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


