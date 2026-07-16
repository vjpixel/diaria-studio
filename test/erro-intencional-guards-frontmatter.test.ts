/**
 * test/erro-intencional-guards-frontmatter.test.ts (#911)
 *
 * Cobre helpers puros + guards de defesa da seção ERRO INTENCIONAL na
 * newsletter. Concurso mensal "Ache o erro" — newsletter revela gabarito
 * da edição anterior + chama leitor pra acertar erro da atual.
 *
 * #3222: os campos estruturados (description/location/category/correct_value/
 * reveal) migraram de frontmatter YAML em `02-reviewed.md` pra
 * `_internal/intentional-error.json`. `02-reviewed.md` sincroniza com o
 * Google Drive/Docs — o round-trip do Docs colapsava blocos YAML multi-linha
 * numa única linha corrompida (#3205, reproduzido 4x). `_internal/*` nunca
 * sincroniza com o Drive (convenção #959), então o JSON nunca passa por esse
 * round-trip. Testes que exercitavam especificamente o parsing de YAML
 * (aspas, block-scalars, CRLF, colapso) foram removidos — essa classe de bug
 * não existe mais porque não há mais YAML a ser parseado aqui.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  composeRevealText,
  extractCurrentDeclarationFromMd,
  extractPreviousRevealFromRecord,
  extractNarrativeFromFrontmatter,
  narrativeIsGenericPlaceholder,
} from "../scripts/render-erro-intencional.ts";
import type { IntentionalError } from "../scripts/lib/intentional-errors.ts";
import type { IntentionalErrorJson } from "../scripts/lib/intentional-errors.ts";
import {
  checkNarrativeNotGenericPlaceholder,
} from "../scripts/lib/invariant-checks/stage-4.ts";

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

// ── #3222: extractNarrativeFromFrontmatter agora lê record JSON (era frontmatter YAML) ──
//
// #2411 reverteu a prioridade do fix #2398: `description` é catálogo (lint/catalog),
// NÃO é fonte do reveal. Apenas o campo `reveal` do record é fonte do reveal
// (#3222: o antigo alias legado `narrative:` no frontmatter não existe mais no
// schema JSON — só `reveal` é lido).

/** Helper: escreve `_internal/intentional-error.json` num dir temporário. */
function writeIntentionalErrorJsonFixture(dir: string, record: IntentionalErrorJson): void {
  const internalDir = join(dir, "_internal");
  mkdirSync(internalDir, { recursive: true });
  writeFileSync(join(internalDir, "intentional-error.json"), JSON.stringify(record, null, 2), "utf8");
}

describe("extractNarrativeFromFrontmatter (#2398 + #2411, migrado pra JSON #3222)", () => {
  it("#2411: só description no record → null (description é catálogo, não fonte do reveal)", () => {
    // #2398 retornava description; #2411 reverte: description é catálogo, não reveal.
    const record: IntentionalErrorJson = {
      description: "DESTAQUE 2 lista o Spotify entre os assistentes de IA que teriam evoluído",
      location: "DESTAQUE 2",
      category: "factual",
      correct_value: "Perplexity ou Copilot",
    };
    const r = extractNarrativeFromFrontmatter(record);
    // #2411: description é catálogo → null (não é fonte do reveal)
    assert.equal(r, null, "#2411: description é catálogo, não deve ser retornada como narrative do reveal");
  });

  it("campo `reveal` presente → retorna reveal (#3222: campo canônico, sem alias legado)", () => {
    const record: IntentionalErrorJson = {
      reveal: "escrevi Microsoft onde deveria ser Macrosoft",
      location: "DESTAQUE 3",
      category: "ortografico",
      correct_value: "Microsoft",
    };
    const r = extractNarrativeFromFrontmatter(record);
    assert.equal(r, "escrevi Microsoft onde deveria ser Macrosoft");
  });

  it("retorna null quando record é null", () => {
    assert.equal(extractNarrativeFromFrontmatter(null), null);
  });

  it("retorna null quando record é undefined", () => {
    assert.equal(extractNarrativeFromFrontmatter(undefined), null);
  });

  it("retorna null quando record sem reveal", () => {
    const record: IntentionalErrorJson = {
      location: "D1",
      category: "factual",
      correct_value: "2014",
    };
    assert.equal(extractNarrativeFromFrontmatter(record), null);
  });

  it("retorna null quando reveal é placeholder {PREENCHER}", () => {
    const record: IntentionalErrorJson = {
      description: "DESTAQUE X usa Y",
      reveal: "{PREENCHER — o que o assinante deve identificar}",
      location: "{PREENCHER}",
    };
    assert.equal(extractNarrativeFromFrontmatter(record), null);
  });

  it("retorna null quando reveal é string vazia ou só espaços", () => {
    assert.equal(extractNarrativeFromFrontmatter({ reveal: "" }), null);
    assert.equal(extractNarrativeFromFrontmatter({ reveal: "   " }), null);
  });
});

describe("extractPreviousRevealFromRecord — prioridade record JSON (#2398 + #2411, migrado #3222, split #3494)", () => {
  it("(a) #2411: record.description catálogo + corpo genérico → null (não vaza label)", () => {
    // #2398 retornava description catálogo como narrative; #2411 reverte.
    // Com o fix: body genérico é filtrado, description catálogo não é fonte → null.
    const md = [
      "**ERRO INTENCIONAL**",
      "",
      "Na última edição, X.",
      "",
      "Nessa edição, há um erro proposital escondido em um dos destaques. Responda este e-mail com a correção para concorrer ao sorteio.",
      "",
    ].join("\n");
    const record: IntentionalErrorJson = {
      description: "DESTAQUE 3 usa Macrosoft em vez de Microsoft no primeiro parágrafo",
      location: "DESTAQUE 3, primeiro parágrafo",
      category: "ortografico",
      correct_value: "Microsoft",
    };
    const r = extractPreviousRevealFromRecord(md, record);
    // #2411: description é catálogo + body é genérico → null
    assert.equal(r, null, "#2411: description catálogo + body genérico → null");
  });

  it("(b) sem record.reveal, corpo específico → fallback pro corpo funciona (back-compat)", () => {
    // Edição legada: sem record, corpo tem narrativa específica.
    const md = [
      "**ERRO INTENCIONAL**",
      "",
      "Nessa edição, escrevi que a OpenAI foi fundada em 1914, quando o correto é 2014.",
      "",
    ].join("\n");
    const r = extractPreviousRevealFromRecord(md, null);
    assert.ok(r !== null, "fallback para corpo deve funcionar");
    assert.equal(r!.narrative, "escrevi que a OpenAI foi fundada em 1914, quando o correto é 2014");
    assert.equal(narrativeIsGenericPlaceholder(r!.narrative), false);
  });

  it("(c) #2411: sem record, corpo genérico → extractCurrentDeclarationFromMd=null", () => {
    // #2411: corpo genérico é filtrado (não retornado).
    // (O lint Stage 4 checkNarrativeNotGenericPlaceholder detecta isso diretamente.)
    const md = [
      "**ERRO INTENCIONAL**",
      "",
      "Na última edição, X.",
      "",
      "Nessa edição, há um erro proposital escondido em um dos destaques. Responda este e-mail com a correção para concorrer ao sorteio.",
      "",
    ].join("\n");
    const r = extractCurrentDeclarationFromMd(md);
    // #2411: genérico filtrado → null (o lint acessa o corpo diretamente)
    assert.equal(r, null, "#2411: corpo genérico filtrado → null");
  });
});

describe("checkNarrativeNotGenericPlaceholder — fix #2411 (guard Stage 4, migrado pra JSON #3222)", () => {
  it("#2411: 1 violation (warning) quando record só tem description catálogo + corpo genérico", () => {
    // Este é o caso real 260617/260618: editor preencheu description (catálogo) mas
    // não preencheu reveal first-person. O lint deve sinalizar que falta a declaração.
    const dir = mkdtempSync(join(tmpdir(), "stage4-2411-description-catalog-"));
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
      writeIntentionalErrorJsonFixture(dir, {
        description: "DESTAQUE 2 lista o Spotify entre os assistentes de IA",
        location: "DESTAQUE 2, parágrafo dos motivos",
        category: "factual",
        correct_value: "Perplexity ou Copilot",
      });
      const violations = checkNarrativeNotGenericPlaceholder(dir);
      // #2411: sem reveal first-person → lint deve sinalizar (warning)
      assert.equal(violations.length, 1,
        `description catálogo + corpo genérico deve gerar 1 violation (falta reveal first-person). Got: ${JSON.stringify(violations)}`);
      assert.equal(violations[0].severity, "warning");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("#3494 (revisa expectativa pré-#3494 do #2411): record.reveal específico NÃO silencia corpo genérico", () => {
    // Pré-#3494 este teste esperava 0 violations aqui — extractIntentionalErrorFromMd
    // caía na PRIORIDADE 2 (record.reveal) quando o corpo era filtrado, e o gate
    // considerava o `record.reveal` válido como se fosse também a declaração
    // CORRENTE do corpo. Mas `record.reveal` é prosa pré-escrita para a PRÓXIMA
    // edição revelar o erro DESTA edição — não substitui a prosa "Nessa edição, …"
    // que OS LEITORES DESTA edição leem. Um corpo com o convite genérico ainda
    // preenchido é um problema real (o leitor não tem pista do que procurar),
    // mesmo que `record.reveal` já esteja pronto para a próxima edição — por
    // isso o Stage 4 deve continuar sinalizando (issue #3494).
    const dir = mkdtempSync(join(tmpdir(), "stage4-3494-record-reveal-does-not-mask-body-"));
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
      writeIntentionalErrorJsonFixture(dir, {
        description: "DESTAQUE 2 lista o Spotify entre os assistentes de IA",
        reveal: "listei o Spotify como assistente de IA, mas o correto é Perplexity",
        location: "DESTAQUE 2",
        category: "factual",
        correct_value: "Perplexity ou Copilot",
      });
      const violations = checkNarrativeNotGenericPlaceholder(dir);
      assert.equal(violations.length, 1,
        `corpo genérico deve continuar sinalizado mesmo com record.reveal válido (#3494). Got: ${JSON.stringify(violations)}`);
      assert.equal(violations[0].severity, "warning");
      assert.equal(violations[0].source_issue, "#2411");
      // Guard central do #3494: a mensagem nunca deriva de record.reveal (prosa em
      // 1ª pessoa PASSADA) — nunca produz a corrupção "Nessa edição, Na última edição, …".
      assert.doesNotMatch(
        violations[0].message,
        /Nessa edição,\s*Na última edição/i,
        "mensagem não pode misturar a declaração corrente com o reveal (prosa/tempo verbal diferentes)",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("#2411: 1 violation (warning) quando record ausente E corpo genérico", () => {
    // Sem description E sem reveal: o corpo genérico deve sinalizar.
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
      assert.equal(violations.length, 1, "sem record + corpo genérico deve gerar 1 violation");
      assert.equal(violations[0].severity, "warning");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── #2410/#2411 discriminants — migrado pra JSON #3222 ──────────────────────────────
//
// Os testes originais cobriam bugs de parsing de aspas simples/duplas dentro do
// bloco YAML do frontmatter (extractIeFields/extractField regex). Como o record
// agora é JSON (sem quoting manual a desembrulhar — JSON.parse já entrega a
// string limpa), essa classe de bug não existe mais. O que resta de valor real
// é o invariante "description NUNCA é fonte do reveal, só `reveal`" — mantido
// abaixo, mais enxuto.

describe("extractNarrativeFromFrontmatter — invariante description×reveal (#2410/#2411, migrado #3222)", () => {
  it("record só com description (sem reveal) → null", () => {
    const record: IntentionalErrorJson = {
      description: "DESTAQUE 3 diz que a Meta foi fundada em 1994",
      location: "DESTAQUE 3",
      category: "factual",
      correct_value: "2004",
    };
    assert.equal(
      extractNarrativeFromFrontmatter(record),
      null,
      "description é catálogo, não deve ser retornada por extractNarrativeFromFrontmatter",
    );
  });

  it("reveal preenchido → retorna reveal (description é ignorado)", () => {
    const record: IntentionalErrorJson = {
      description: "campo description catálogo (ignorado)",
      reveal: "escrevi X onde deveria ser Y (primeira pessoa)",
      location: "D1",
      category: "ortografico",
      correct_value: "correto",
    };
    assert.equal(
      extractNarrativeFromFrontmatter(record),
      "escrevi X onde deveria ser Y (primeira pessoa)",
      "reveal (primeira pessoa) tem precedência; description catálogo é ignorada",
    );
  });

  it("description vazia + prosa 'Nessa edição,' no corpo → extractPreviousRevealFromRecord usa corpo", () => {
    // Sem reveal preenchido no record → extractNarrativeFromFrontmatter=null
    // → extractPreviousRevealFromRecord deve cair no fallback do corpo.
    const md = [
      "**ERRO INTENCIONAL**",
      "",
      "Nessa edição, escrevi que a OpenAI foi fundada em 1904, o correto é 2015.",
      "",
    ].join("\n");
    const record: IntentionalErrorJson = {
      location: "DESTAQUE 2",
      category: "factual",
      correct_value: "2014",
    };
    // extractNarrativeFromFrontmatter deve retornar null (sem reveal)
    const fm = extractNarrativeFromFrontmatter(record);
    assert.equal(fm, null, "record sem reveal deve retornar null");
    // extractPreviousRevealFromRecord deve pegar o corpo como fallback
    const full = extractPreviousRevealFromRecord(md, record);
    assert.ok(full !== null, "fallback pro corpo deve funcionar");
    assert.ok(
      full!.narrative.includes("fundada em 1904"),
      "narrative deve vir do corpo quando record não tem reveal",
    );
  });

  it("integrado: description catálogo + corpo genérico → extractPreviousRevealFromRecord=null (#2411)", () => {
    // Com o fix #2411: description é catálogo (não fonte do reveal), corpo é genérico
    // (filtrado por narrativeIsGenericPlaceholder) → null.
    const md = [
      "**ERRO INTENCIONAL**",
      "",
      "Na última edição, houve um reveal anterior.",
      "",
      "Nessa edição, há um erro proposital escondido em um dos destaques. Responda este e-mail com a correção para concorrer ao sorteio.",
      "",
    ].join("\n");
    const record: IntentionalErrorJson = {
      description: "DESTAQUE 1 usa o número 42 onde o correto é 24",
      location: "DESTAQUE 1, parágrafo 2",
      category: "numeric",
      correct_value: "24",
    };
    const r = extractPreviousRevealFromRecord(md, record);
    // description é catálogo (ignorada), corpo é genérico (filtrado) → null
    assert.equal(r, null,
      "#2411: description catálogo + corpo genérico → null (não vaza label interno)");
  });
});

// ── narrativeIsGenericPlaceholder (#2377 root cause fix) — pure, inalterado pelo #3222 ──
//
// Root cause fix: o bug foi causado por um `narrative` genérico (copiado do bloco de convite
// ao sorteio) que acabou sendo formatado por composeRevealText como reveal real. O guard
// detecta esse texto genérico e bloqueia no Stage 4 antes da publicação.

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
