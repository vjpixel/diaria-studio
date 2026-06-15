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
  extractCorrectValueFromFrontmatter,
  findPreviousIntentionalErrorFromMd,
  narrativeHasCorrection,
  resolvePreviousError,
  ensureIntentionalErrorFrontmatter,
} from "../scripts/render-erro-intencional.ts";
import type { IntentionalError } from "../scripts/lib/intentional-errors.ts";

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

  it("fallback genérico quando detail/gabarito/narrative todos ausentes", () => {
    const prev: IntentionalError = {
      edition: "260504",
      error_type: "factual",
      is_feature: true,
    };
    const text = composeRevealText(prev);
    assert.match(text, /^Na última edição, houve um erro intencional/);
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
  it("passa correct_value do frontmatter pra estrutura retornada", () => {
    const md = [
      "---",
      "intentional_error:",
      "  description: x",
      "  location: y",
      "  category: factual",
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

  it("#1443: integração — auto-append 'o correto é Y' lendo prev MD com frontmatter + narrative sem correção", () => {
    const dir = mkdtempSync(join(tmpdir(), "render-erro-int-1443-"));
    try {
      const editionsRoot = join(dir, "editions");
      mkdirSync(join(editionsRoot, "260520"), { recursive: true });
      mkdirSync(join(editionsRoot, "260521"), { recursive: true });

      // Edição anterior 260520: frontmatter com correct_value + narrative sem correção
      writeFileSync(
        join(editionsRoot, "260520", "02-reviewed.md"),
        [
          "---",
          "intentional_error:",
          '  description: "Ano de fundação da OpenAI no DESTAQUE 2"',
          '  location: "DESTAQUE 2"',
          '  category: "factual"',
          '  correct_value: "2014"',
          "---",
          "",
          "Body.",
          "",
          "**ERRO INTENCIONAL**",
          "",
          "Na última edição, foo.",
          "",
          "Nessa edição, contei que Karpathy cofundou a OpenAI em 1914, depois liderou a IA da Tesla.",
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
      assert.equal(out.prev_source, "md");
      assert.equal(out.prev_edition, "260520");
      assert.equal(out.prev_revealed, true);
      const updated = readFileSync(mdPath, "utf8");
      // O reveal precisa ter "o correto é 2014" (auto-appended)
      assert.match(updated, /Na última edição, contei que Karpathy[^\n]*, o correto é 2014\./);
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

  it("integração CLI: prev no_error=true gera frase natural, não concatenação mecânica", () => {
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
      assert.equal(out.prev_revealed, true);
      assert.equal(out.prev_edition, "260605");
      const updated = readFileSync(mdPath, "utf8");
      // Frase natural (#2078)
      assert.match(updated, /Na última edição, não havia erro intencional/);
      assert.match(updated, /quem respondeu que não há erro, acertou/);
      // NÃO pode ter a concatenação mecânica antiga
      assert.doesNotMatch(updated, /o correto é não há erro/);
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

