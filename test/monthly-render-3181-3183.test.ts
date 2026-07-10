/**
 * test/monthly-render-3181-3183.test.ts
 *
 * #3181/#3183 — porta pro renderer MENSAL (scripts/lib/mensal/monthly-render.ts)
 * os 2 fixes que a diária já tinha (scripts/lib/newsletter-render-html.ts):
 *
 *   - #3181 (port do PR#3179, Refs #3104): o kicker de seção, o label "O fio
 *     condutor" e (na issue original) o resultado do É IA? usavam texto teal
 *     (#00A0A0) a ~3.2:1 de contraste sobre papel/branco — abaixo de AA
 *     (4.5:1) para texto normal. Fix: o ponto ● continua teal (assinatura de
 *     cor do DS), só o texto do label vira ink (~14:1).
 *
 *   - #3183 (port do PR#3182, Refs #3104): 3 micro-drifts de token sem motivo
 *     funcional — padding do box "contorno" (22px 26px → 24px 28px),
 *     letter-spacing de labels uppercase (1px/1.5px → 2px) e line-height de
 *     título 26px serif (1.15 → 1.2).
 *
 * Nota (self-review, prevResultLine): a issue #3181 pedia portar o tratamento
 * do PR#3179 pro `prevResultLine` do É IA? mensal (ponto ● teal + label ink,
 * bold+uppercase+letter-spacing) — mas a diária já tinha ido ALÉM disso via
 * #3220 (commit 42c4a266/8a275b5e): destylizado a pedido do editor pra "ler
 * como frase comum, não como label gritado" — virou parágrafo de corpo puro,
 * sem bold/uppercase/letter-spacing/ponto. Portar o estado intermediário da
 * issue recriaria drift (mensal com label-style, diária sem) — os testes
 * abaixo cobrem o estado ATUAL da diária (parity real), não a issue ao pé da
 * letra. Ver comentário em monthly-render.ts (renderEia, prevResultHtml).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  renderKicker,
  renderDestaque,
  renderIntro,
  renderEncerramento,
  renderEia,
  renderCobrandHeader,
  renderSocialFooter,
} from "../scripts/lib/mensal/monthly-render.ts";

describe("#3181 — a11y: kicker ponto teal + label ink (era label inteiro teal)", () => {
  it("renderKicker: <td> do label é ink (#171411), ponto ● separado continua teal (#00A0A0)", () => {
    const html = renderKicker("USE MELHOR");
    const tdMatch = html.match(/<td style="([^"]+)">/);
    assert.ok(tdMatch, `<td> do kicker não encontrado: ${html}`);
    assert.match(tdMatch![1], /color:#171411/, "label do kicker deve ser ink");
    assert.doesNotMatch(tdMatch![1], /color:#00A0A0/, "label do kicker não deve mais ser teal");
    assert.match(html, /<span style="color:#00A0A0;">&#9679;<\/span>&nbsp;USE MELHOR/, "ponto ● separado deve preceder o label, continuar teal");
  });

  it("renderKicker: letter-spacing 2px preservado (#3183 — âncora do valor canônico)", () => {
    const html = renderKicker("RADAR");
    const tdMatch = html.match(/<td style="([^"]+)">/);
    assert.ok(tdMatch);
    assert.match(tdMatch![1], /letter-spacing:2px/);
  });

  it("renderIntro (usa renderKicker internamente): mesmo padrão dot-teal/label-ink", () => {
    const html = renderIntro("Sumário do mês.");
    assert.match(html, /<span style="color:#00A0A0;">&#9679;<\/span>&nbsp;Resumo do mês/);
    assert.doesNotMatch(html, /<td[^>]*color:#00A0A0[^>]*>/, "<td> do kicker não deve ser teal");
  });
});

describe("#3181/#3183 — 'O fio condutor': ponto teal + label ink, padding 24px 28px, letter-spacing 2px", () => {
  const chunk = "DESTAQUE 1 | TEMA\n\nTítulo\n\nParágrafo principal.\n\nO fio condutor: Insight final.";
  const html = renderDestaque(chunk);

  it("label ink, ponto ● teal precede 'O fio condutor'", () => {
    const labelMatch = html.match(/<p style="([^"]+)">(?:<span[^>]*>&#9679;<\/span>&nbsp;)?O fio condutor<\/p>/);
    assert.ok(labelMatch, `label 'O fio condutor' não encontrado: ${html}`);
    assert.match(labelMatch![1], /color:#171411/, "label deve ser ink");
    assert.doesNotMatch(labelMatch![1], /color:#00A0A0/, "label não deve mais ser teal");
    assert.match(html, /<span style="color:#00A0A0;">&#9679;<\/span>&nbsp;O fio condutor/, "ponto ● deve preceder o label");
  });

  it("padding do box: 24px 28px (era 22px 26px)", () => {
    assert.match(html, /padding:24px 28px;/, "box 'fio condutor' deve usar 24px 28px");
    assert.doesNotMatch(html, /padding:22px 26px;/, "não deve mais usar 22px 26px");
  });

  it("letter-spacing do label: 2px (era 1.5px)", () => {
    const labelMatch = html.match(/<p style="([^"]+)">(?:<span[^>]*>&#9679;<\/span>&nbsp;)?O fio condutor<\/p>/);
    assert.ok(labelMatch);
    assert.match(labelMatch![1], /letter-spacing:2px/);
    assert.doesNotMatch(labelMatch![1], /letter-spacing:1\.5px/);
  });

  it("legenda de hero (imagem do destaque): letter-spacing 2px (era 1px)", () => {
    const withImage = renderDestaque(chunk, undefined, "https://x/img.jpg", "Criada com Gemini");
    assert.match(withImage, /letter-spacing:2px;text-transform:uppercase;color:#171411;">Criada com Gemini/);
    assert.doesNotMatch(withImage, /letter-spacing:1px;text-transform:uppercase;color:#171411;">Criada com Gemini/);
  });
});

describe("#3183 — 'Acesse nossas curadorias:' e 'Siga a Clarice × Diar.ia': letter-spacing 2px (era 1px)", () => {
  it("renderEncerramento", () => {
    const body = "Fechamento do mês.\n\n- [Curso X](https://x.example/curso)";
    const html = renderEncerramento(body);
    assert.match(html, /Acesse nossas curadorias:<\/p>/);
    const m = html.match(/<p style="([^"]+)">Acesse nossas curadorias:<\/p>/);
    assert.ok(m);
    assert.match(m![1], /letter-spacing:2px/);
    assert.doesNotMatch(m![1], /letter-spacing:1px/);
  });

  it("renderSocialFooter", () => {
    const html = renderSocialFooter();
    const m = html.match(/<p style="([^"]+)">Siga a Clarice &times; Diar\.ia<\/p>/);
    assert.ok(m);
    assert.match(m![1], /letter-spacing:2px/);
    assert.doesNotMatch(m![1], /letter-spacing:1px/);
  });
});

describe("#3181/#3183 — renderCobrandHeader: wordmark 'Clarice' mantém teal (large text, fora de escopo #3181), line-height 1.2 (#3183); label 'Clarice × Diar.ia' letter-spacing 2px", () => {
  const html = renderCobrandHeader();

  it("wordmark continua teal (26px bold — WCAG large text, 3:1, teal passa)", () => {
    const m = html.match(/<div style="([^"]+)">Clarice<\/div>/);
    assert.ok(m, `wordmark não encontrado: ${html}`);
    assert.match(m![1], /color:#00A0A0/, "wordmark deve continuar teal (fora de escopo #3181)");
  });

  it("wordmark: line-height 1.2 (era 1.15)", () => {
    const m = html.match(/<div style="([^"]+)">Clarice<\/div>/);
    assert.ok(m);
    assert.match(m![1], /line-height:1\.2;/);
    assert.doesNotMatch(m![1], /line-height:1\.15;/);
  });

  it("'Clarice × Diar.ia': letter-spacing 2px (era 1.5px)", () => {
    const m = html.match(/<div style="([^"]+)">Clarice &times; Diar\.ia<\/div>/);
    assert.ok(m);
    assert.match(m![1], /letter-spacing:2px/);
    assert.doesNotMatch(m![1], /letter-spacing:1\.5px/);
  });
});

describe("#3183 — título do É IA? mensal: line-height 1.2 (era 1.15)", () => {
  it("'Clique na imagem que foi gerada por IA'", () => {
    const html = renderEia("É IA? — DESTAQUE DO MÊS\n[placeholder]", "2605", "https://x/A.jpg", "https://x/B.jpg", "Crédito.");
    const m = html.match(/<p style="([^"]+)">Clique na imagem que foi gerada por IA<\/p>/);
    assert.ok(m, `título do É IA? não encontrado: ${html}`);
    assert.match(m![1], /line-height:1\.2;/);
    assert.doesNotMatch(m![1], /line-height:1\.15;/);
  });
});

describe("#3181 — renderEia prevResultLine: parágrafo comum, ink, sem destaque (parity com o estado ATUAL da diária, não com o PR#3179 original)", () => {
  it("sem bold/uppercase/letter-spacing/ponto; cor ink", () => {
    const html = renderEia(
      "É IA? — DESTAQUE DO MÊS\n[placeholder]",
      "2605",
      "https://x/A.jpg",
      "https://x/B.jpg",
      "Crédito.",
      "Resultado da última edição: 67% acertaram.",
    );
    const m = html.match(/<p style="([^"]+)">Resultado da última edição[^<]*<\/p>/);
    assert.ok(m, `prevResultLine <p> não encontrado: ${html}`);
    assert.match(m![1], /color:#171411/, "prevResultLine deve ser ink");
    assert.doesNotMatch(m![1], /font-weight:bold/, "não deve ser bold");
    assert.doesNotMatch(m![1], /text-transform:uppercase/, "não deve ser uppercase");
    assert.doesNotMatch(m![1], /letter-spacing/, "não deve ter letter-spacing");
    assert.doesNotMatch(
      html,
      /<span style="color:#00A0A0;">&#9679;<\/span>&nbsp;Resultado da última edição/,
      "ponto ● não deve preceder o texto do resultado",
    );
  });

  it("sem prevResultLine, nada quebra (guard negativo)", () => {
    const html = renderEia("É IA? — DESTAQUE DO MÊS\n[placeholder]", "2605", "https://x/A.jpg", "https://x/B.jpg", "Crédito.");
    assert.doesNotMatch(html, /Resultado da última edição/);
  });
});
