/**
 * test/intro-callout-explicit-marker-12240.test.ts (#12240)
 *
 * Callout de intro com marcador explícito `<!-- callout -->`: o editor pode
 * escrever o aviso sem emoji, com a 1ª frase em negrito e com mais de um
 * parágrafo na mesma caixa. Antes, só dois sinais criavam a caixa: o parágrafo
 * INTEIRO em negrito (`**...**`) ou o emoji 🎉 (box de campeões/sorteio). Um
 * parágrafo com negrito parcial ("**Temos ganhadores!** ...") virava texto
 * comum da introdução, sem caixa (caso real 261105).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractCoverageLine,
  extractCoverageLineTrailer,
  extractIntroCallout,
  INTRO_CALLOUT_MARKER,
} from "../scripts/lib/newsletter-parse.ts";
import { lintStackedIntroCallouts } from "../scripts/lib/lint-checks/callout-placement.ts";
import { renderHTML } from "../scripts/lib/newsletter-render-html.ts";
import type { NewsletterContent } from "../scripts/lib/newsletter-parse.ts";

const COVERAGE =
  "Olá! Eu sou o Pixel, editor desta newsletter.\n\nNesta edição, a IA analisou 353 conteúdos e selecionei os 10 mais relevantes.\n\nSe este trabalho faz diferença para você, [considere apoiar o projeto](https://apoia.se/diaria).";
const AVISO =
  "**Temos ganhadores!** Fulano ganhou o sorteio dos apoiadores e Beltrano levou o sorteio do erro intencional.";

function buildMd(introBlock: string): string {
  return `TÍTULO

Um título qualquer

SUBTÍTULO

Sub um | Sub dois

---

${COVERAGE}

${introBlock}

---

**DESTAQUE 1 | 🧠 FRONTEIRA**

**[Título do destaque](https://example.com/d1)**

Corpo do destaque.

Por que isso importa:

Importa por isso.`;
}

function render(introCallout: string, coverageLine = COVERAGE): string {
  const content: NewsletterContent = {
    title: "Título do destaque",
    subtitle: "Sub um | Sub dois",
    coverImage: "04-d1-2x1.jpg",
    coverageLine,
    introCallout,
    destaques: [
      {
        n: 1,
        category: "FRONTEIRA",
        title: "Título do destaque",
        body: "Corpo do destaque.",
        why: "Importa por isso.",
        url: "https://example.com/d1",
        emoji: "🧠",
      },
      {
        n: 2,
        category: "PRODUTO",
        title: "Segundo destaque",
        body: "Corpo do destaque dois.",
        why: "Importa também.",
        url: "https://example.com/d2",
        emoji: "📦",
      },
    ],
    eia: { credit: "", imageA: "01-eia-A.jpg", imageB: "01-eia-B.jpg", edition: "260710" },
    sections: [],
  };
  return renderHTML(content);
}

describe("#12240 — callout de intro com marcador explícito", () => {
  it("extrai o aviso com negrito parcial e sem emoji, sem o marcador no texto", () => {
    const md = buildMd(`${INTRO_CALLOUT_MARKER}\n${AVISO}`);
    const cta = extractIntroCallout(md);
    assert.equal(cta, AVISO);
    assert.ok(!cta!.includes("<!--"), "o marcador nunca vai pro conteúdo");
  });

  it("sem o marcador, o mesmo parágrafo com negrito parcial NÃO é callout (comportamento anterior preservado)", () => {
    assert.equal(extractIntroCallout(buildMd(AVISO)), null);
  });

  it("aceita mais de um parágrafo e para no `---` que fecha o bloco", () => {
    const md = buildMd(`${INTRO_CALLOUT_MARKER}\n${AVISO}\n\nPara concorrer no próximo, responda dizendo qual é o erro.`);
    const cta = extractIntroCallout(md);
    assert.equal(cta, `${AVISO}\n\nPara concorrer no próximo, responda dizendo qual é o erro.`);
    assert.ok(!cta!.includes("DESTAQUE"), "não invade o 1º destaque");
    assert.equal(extractCoverageLineTrailer(md), null, "nada sobra como trailer de cobertura");
  });

  it("marcador sem texto depois é ignorado e cai no bold-wrap antigo", () => {
    const md = buildMd(`${INTRO_CALLOUT_MARKER}\n\n---\n\n**Aviso inteiro em negrito.**`);
    assert.equal(extractIntroCallout(md), "Aviso inteiro em negrito.");
  });

  it("marcador aceita espaços internos e fim de linha CRLF", () => {
    const md = buildMd(`<!--  callout  -->\r\n${AVISO}`);
    assert.equal(extractIntroCallout(md), AVISO);
  });

  it("renderHTML: 1 parágrafo vira caixa com 1ª frase em <strong>, sem emoji e sem o marcador", () => {
    const html = render(AVISO);
    assert.match(html, /intro callout \(sorteio\/CTA\)/, "a caixa de callout é emitida");
    assert.match(html, /<strong[^>]*>Temos ganhadores!<\/strong> Fulano ganhou o sorteio/);
    assert.ok(!html.includes("🎉"), "sem emoji");
    assert.ok(!html.includes("&lt;!-- callout"), "marcador não vaza");
  });

  it("renderHTML: callout de 2 parágrafos fica na MESMA caixa (os dois textos entre o mesmo <table> da caixa)", () => {
    const html = render(`${AVISO}\n\nPara concorrer no próximo, responda dizendo qual é o erro.`);
    const start = html.indexOf("intro callout (sorteio/CTA)");
    assert.ok(start >= 0);
    const end = html.indexOf("</table>", start);
    const box = html.slice(start, end);
    assert.match(box, /Temos ganhadores!/);
    assert.match(box, /Para concorrer no próximo, responda dizendo qual é o erro\./);
  });

  it("layout real da 261105: marcador logo depois do bloco de boas-vindas; a cobertura não engole o aviso", () => {
    const md = buildMd(`${INTRO_CALLOUT_MARKER}\n${AVISO}`);
    const coverage = extractCoverageLine(md);
    assert.ok(coverage, "a cobertura é reconhecida");
    assert.ok(!coverage!.includes("Temos ganhadores"), "o aviso não vaza para a cobertura");
    assert.ok(!coverage!.includes("<!--"), "o marcador não vaza para a cobertura");
    assert.equal(extractIntroCallout(md), AVISO);
  });

  it("marcador só vale no começo de uma linha (no meio de um parágrafo é texto comum)", () => {
    const md = buildMd(`Veja ${INTRO_CALLOUT_MARKER} aqui.`);
    assert.equal(extractIntroCallout(md), null);
  });

  it("marcador solto (2º marcador, fora da intro) não vira texto visível no HTML final", () => {
    const html = render(AVISO, `${COVERAGE}\n\n<!-- callout -->`);
    assert.ok(!/callout\s*--&gt;/.test(html), "marcador escapado não aparece no e-mail");
    assert.ok(!html.includes("<!-- callout"), "marcador cru não aparece no e-mail");
  });

  it("a caixa do callout de 2 parágrafos é uma só", () => {
    const html = render(`${AVISO}\n\nSegundo parágrafo do aviso.`);
    assert.equal(html.split("intro callout (sorteio/CTA)").length - 1, 1);
  });
});

describe("#12240 — lint de callouts empilhados vê o marcador", () => {
  const intro = (block: string) => `${COVERAGE}\n\n${block}\n\n---\n\n**DESTAQUE 1 | X**\n`;

  it("marcador sozinho (1 parágrafo ou vários) conta como 1 callout", () => {
    assert.equal(lintStackedIntroCallouts(intro(`${INTRO_CALLOUT_MARKER}\n${AVISO}`)).ok, true);
    const multi = `${INTRO_CALLOUT_MARKER}\n${AVISO}\n\n**Segundo parágrafo em negrito.**`;
    const r = lintStackedIntroCallouts(intro(multi));
    assert.equal(r.ok, true);
    assert.equal(r.count, 1);
  });

  it("marcador + bold-wrap na mesma intro (blocos separados por ---) são 2 callouts empilhados", () => {
    const md = `${COVERAGE}\n\n**Agradecimento inteiro em negrito.**\n\n---\n\n${INTRO_CALLOUT_MARKER}\n${AVISO}\n\n---\n\n**DESTAQUE 1 | X**\n`;
    const r = lintStackedIntroCallouts(md);
    assert.equal(r.ok, false);
    assert.equal(r.count, 2);
  });
});
