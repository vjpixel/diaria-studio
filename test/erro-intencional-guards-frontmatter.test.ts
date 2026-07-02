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
