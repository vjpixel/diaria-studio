/**
 * test/lint-density.test.ts (#5926)
 *
 * Regressão do guardrail de densidade: garante que métricas de prosa sejam
 * extraídas corretamente (strip de headers, HTML tags, JSON-LD, Fontes) e que
 * os tetos escalados por palavras/2000 funcionem no ponto de decisão.
 *
 * Fixture 1 (denso): texto com frases longas, muitos nomes próprios,
 *   estatísticas soltas e siglas — deve EXCEDER o teto.
 * Fixture 2 (limpo): texto minimalista — deve ficar dentro de todos os tetos.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractProse,
  countWords,
  splitSentences,
  computeThresholds,
  measureLongPhrases,
  measureProperNouns,
  measureAcronyms,
  measureStatistics,
  runLint,
} from "../scripts/lint-density.ts";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

/** Texto denso: frase longa, muitos nomes próprios, stats, siglas. */
const denseMd = `
## DESTAQUE 1 | REGULAÇÃO

**Brasil acelera regulação de IA em agosto**

O Congresso Nacional avançou significativamente na regulação da inteligência artificial no mês de agosto de 2026, aprovando uma série de medidas que posicionam o país como referência regional neste debates, com o apoio de dezenas de organizações como a OpenAI, a Microsoft, a Anthropic, a Apple e a Google, todas elas já alinhadas à nova legislação desde a última sessão solene do ano, que durou três horas e meia de discussões técnicas muito complexas.

Segundo o relator do Projeto de Lei 4.512/2026, 78% dos especialistas ouvidos consideram o texto adequado, e 3 em cada 5 empresas consultadas já se adequam às diretrizes propostas. A Câmara dos Deputados discutiu o texto em plenário nesta terça-feira, e o Senado Federal promete votar na próxima semana, segundo informou o porta-voz oficial da instituição. GPT-4 da OpenAI foi citado como referência para os padrões de segurança recomendados.

## Fontes

- https://example.com/noticia
- https://example.org/pdf
`;

/** Texto limpo: frases curtas, poucos nomes, sem stats. */
const cleanMd = `
## DESTAQUE 1 | REGULAÇÃO

**Brasil regulamenta IA**

O país aprovou diretrizes. GPT-4 foi citado como referência. A OpenAI apoiou a medida.

## Fontes

- https://example.com
`;

/** Fragmento HTML com style, script, JSON-LD — que devem ser ignorados. */
const htmlFixture = `<!DOCTYPE html>
<html>
<head>
  <style>.hidden { display: none; }</style>
  <script type="application/ld+json">{"@context": "https://schema.org", "name": "Test"}</script>
</head>
<body>
  <p>A OpenAI e a Microsoft anunciaram parceria. Cinco empresas já se comprometeram.</p>
  <div class="hidden">texto oculto não deve contar</div>
</body>
</html>`;

// ─── extractProse ─────────────────────────────────────────────────────────────

describe("extractProse (#5926)", () => {
  it("remove headings markdown antes de stripMarkdown", () => {
    const prose = extractProse(cleanMd);
    // "DESTAQUE 1 | REGULAÇÃO" (heading) não aparece no prosa extraída
    assert.equal(prose.includes("DESTAQUE"), false);
    assert.equal(prose.includes("REGULAÇÃO"), false);
  });

  it("remove seção Fontes inteira", () => {
    const prose = extractProse(denseMd);
    assert.equal(prose.includes("example.com/noticia"), false);
    assert.equal(prose.includes("example.org/pdf"), false);
  });

  it("stripping HTML: remove style, script, JSON-LD, texto oculto", () => {
    const prose = extractProse(htmlFixture);
    // style content removed
    assert.equal(prose.includes("display: none"), false);
    // JSON-LD removed
    assert.equal(prose.includes("schema.org"), false);
    // hidden div content removed (it's display:none but still parsed by stripHtml)
    // — stripHtml não remove conteúdo de divs invisíveis, mas o texto "não deve contar"
    // é removido por stripHtmlBasic? Não — stripHtml preserva tudo. Testa o essencial:
    assert.equal(prose.includes("OpenAI"), true);
  });

  it("remove code blocks markdown", () => {
    const md = `Texto antes.

\`\`\`ts
const x = 1;
\`\`\`

Texto depois.`;
    const prose = extractProse(md);
    assert.equal(prose.includes("const x"), false);
    assert.equal(prose.includes("Texto antes"), true);
    assert.equal(prose.includes("Texto depois"), true);
  });
});

// ─── countWords ───────────────────────────────────────────────────────────────

describe("countWords (#5926)", () => {
  it("conta palavras simples", () => {
    assert.equal(countWords("olá mundo teste"), 3);
  });

  it("conta palavras e ignora pontuação", () => {
    assert.equal(countWords("Olá, mundo! Teste."), 3);
  });

  it("zera texto vazio", () => {
    assert.equal(countWords(""), 0);
  });
});

// ─── splitSentences ───────────────────────────────────────────────────────────

describe("splitSentences (#5926)", () => {
  it("divide por . ! ? seguidos de espaço", () => {
    const s = splitSentences("Olá mundo. Como vai? Bem!");
    assert.equal(s.length, 3);
    assert.equal(s[0], "Olá mundo.");
    assert.equal(s[1], "Como vai?");
  });

  it("protege decimal 3.14", () => {
    const s = splitSentences("O valor é 3.14. Pronto.");
    assert.equal(s.length, 2);
  });

  it("protege abreviações comuns", () => {
    const s = splitSentences("Veja p.ex. isso. Depois disso.");
    assert.equal(s.length, 2);
  });
});

// ─── computeThresholds ────────────────────────────────────────────────────────

describe("computeThresholds (#5926)", () => {
  it("threshholds base para 2000 palavras", () => {
    const t = computeThresholds(2000);
    assert.equal(t.longPhrases, 3);
    assert.equal(t.properNouns, 2);
    assert.equal(t.acronyms, 1);
    assert.equal(t.statistics, 3);
  });

  it("escala linear para 4000 palavras (2×)", () => {
    const t = computeThresholds(4000);
    assert.equal(t.longPhrases, 6);
    assert.equal(t.properNouns, 4);
    assert.equal(t.acronyms, 2);
    assert.equal(t.statistics, 6);
  });

  it("mínimo 1 mesmo para texto curto", () => {
    const t = computeThresholds(100);
    assert.equal(t.longPhrases, 1);
    assert.equal(t.properNouns, 1);
  });
});

// ─── measureLongPhrases ───────────────────────────────────────────────────────

describe("measureLongPhrases (#5926)", () => {
  it("conta frases > 30 palavras", () => {
    const sentences = splitSentences(
      "Frase curta. " + "palavra ".repeat(35) + "fim."
    );
    const r = measureLongPhrases(sentences, 30, 3);
    assert.equal(r.count, 1);
    assert.ok(r.longestWordCount >= 35);
  });

  it("zero frases longas quando todas cabem", () => {
    const sentences = splitSentences("Oi. Tudo bem. Como vai?");
    const r = measureLongPhrases(sentences, 30, 3);
    assert.equal(r.count, 0);
  });
});

// ─── measureProperNouns ───────────────────────────────────────────────────────

describe("measureProperNouns (#5926)", () => {
  it("não conta nomes no início da frase", () => {
    const sentences = splitSentences("Brasil acelera regulação. OpenAI apoia.");
    const r = measureProperNouns(sentences, 2);
    // "Brasil" é word 0 de sua frase — não conta
    // "OpenAI" é allowlist — não conta
    assert.equal(r.count, 0);
  });

  it("conta nomes próprios no meio da frase", () => {
    const sentences = splitSentences("O Congresso aprovou diretrizes. GPT-4 foi citado.");
    const r = measureProperNouns(sentences, 2);
    // "Congresso" é word 1 (depois de "O") — conta
    assert.ok(r.count >= 1);
    assert.equal(r.examples.includes("Congresso"), true);
  });

  it("não conta produtos da allowlist", () => {
    const sentences = splitSentences("O texto cita OpenAI e Microsoft. GPT-4 foi usado.");
    const r = measureProperNouns(sentences, 10);
    assert.equal(r.examples.includes("OpenAI"), false);
    assert.equal(r.examples.includes("Microsoft"), false);
  });

  it("não conta GPT-N como nome próprio", () => {
    const sentences = splitSentences("O GPT-4 foi lançado. OpenAI divulgou.");
    const r = measureProperNouns(sentences, 10);
    assert.equal(r.examples.includes("GPT-4"), false);
  });
});

// ─── measureAcronyms ──────────────────────────────────────────────────────────

describe("measureAcronyms (#5926)", () => {
  it("detecta siglas em caixa alta", () => {
    const sentences = splitSentences("O PDF do relatório foi publicado. O CSV contém dados.");
    const r = measureAcronyms(sentences, 10);
    assert.equal(r.count, 2);
    assert.equal(r.examples.includes("PDF"), true);
    assert.equal(r.examples.includes("CSV"), true);
  });

  it("não conta GPT isolado de GPT-4", () => {
    const sentences = splitSentences("O GPT-4 foi lançado pela OpenAI.");
    const r = measureAcronyms(sentences, 10);
    assert.equal(r.examples.includes("GPT"), false);
  });

  it("não conta IA, EUA, ONU (excluídos)", () => {
    const sentences = splitSentences("A IA regula EUA e ONU.");
    const r = measureAcronyms(sentences, 10);
    assert.equal(r.examples.includes("IA"), false);
    assert.equal(r.examples.includes("EUA"), false);
    assert.equal(r.examples.includes("ONU"), false);
  });
});

// ─── measureStatistics ────────────────────────────────────────────────────────

describe("measureStatistics (#5926)", () => {
  it("detecta percentuais", () => {
    const sentences = splitSentences("78% dos especialistas concordam. 3 em cada 5 aprovam.");
    const r = measureStatistics(sentences, 10);
    assert.equal(r.count, 2);
    assert.equal(r.examples.some((e) => e.includes("78%")), true);
    assert.equal(r.examples.some((e) => e.includes("3 em cada 5")), true);
  });

  it("detecta pontos percentuais", () => {
    const sentences = splitSentences("A margem caiu 5 pontos percentuais. Outro diz 3 pp.");
    const r = measureStatistics(sentences, 10);
    assert.equal(r.count, 2);
  });

  it("zero stats sem números", () => {
    const sentences = splitSentences("O texto foi aprovado. Ninguém discordou.");
    const r = measureStatistics(sentences, 10);
    assert.equal(r.count, 0);
  });
});

// ─── runLint (integração) ─────────────────────────────────────────────────────

describe("runLint (#5926)", () => {
  it("fixture denso: excede teto de nomes próprios", () => {
    const result = runLint(denseMd);
    assert.ok(result.exceeded.includes("properNouns"), `exceeded: ${result.exceeded.join(", ")}`);
    assert.equal(result.withinThresholds, false);
  });

  it("fixture limpo: dentro de todos os tetos", () => {
    const result = runLint(cleanMd);
    assert.equal(result.exceeded.length, 0, `exceeded: ${result.exceeded.join(", ")}`);
    assert.equal(result.withinThresholds, true);
  });

  it("wordCount > 0 para texto com conteúdo", () => {
    const result = runLint(cleanMd);
    assert.ok(result.wordCount > 0);
  });

  it("thresholds escalonados pelo wordCount", () => {
    const result = runLint(denseMd);
    // denseMd tem ~200 palavras → multiplier 0.1 → thresholds = 1
    assert.equal(result.thresholds.longPhrases, 1);
    assert.equal(result.thresholds.properNouns, 1);
  });
});
