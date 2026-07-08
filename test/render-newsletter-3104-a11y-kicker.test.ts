/**
 * test/render-newsletter-3104-a11y-kicker.test.ts
 *
 * #3104 — o kicker teal 12/16px bold (`● CATEGORIA`, "POR QUE ISSO IMPORTA",
 * resultado do É IA?) mede ~3.2:1 de contraste sobre papel/branco — abaixo
 * de AA (4.5:1) pra texto normal (16px bold não qualifica como "large text"
 * do WCAG, que exige ≥18.66px bold).
 *
 * Fix sem mexer na paleta: o PONTO `●` continua teal (o DS já usa o ponto
 * como assinatura de cor), só o LABEL/texto vira ink (~14:1 de contraste).
 * Aplicado nos 3 padrões nomeados pela issue:
 *   - renderKicker (kicker de seção — "● CATEGORIA", "● DIVULGAÇÃO", etc.)
 *   - renderWhyBoxInner (label "Por que isso importa")
 *   - renderEIA / prevResultLine ("Resultado da última edição: X% acertaram")
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  renderKicker,
  renderWhyBoxInner,
  renderEIA,
} from "../scripts/lib/newsletter-render-html.ts";
import type { EIA } from "../scripts/lib/newsletter-parse.ts";

describe("#3104 — a11y: kicker ponto teal + label ink (era label teal, ~3.2:1)", () => {
  it("renderKicker: o <td> do label é ink (#171411), o ponto ● continua teal (#00A0A0)", () => {
    const html = renderKicker("USE MELHOR");
    // O <td> que envolve o ponto + label não deve mais estar em teal.
    const tdMatch = html.match(/<td style="([^"]+)">/);
    assert.ok(tdMatch, `<td> do kicker não encontrado: ${html}`);
    assert.match(tdMatch![1], /color:#171411/, "label do kicker deve ser ink");
    assert.doesNotMatch(tdMatch![1], /color:#00A0A0/, "label do kicker não deve mais ser teal");
    // O ponto ● preserva o teal (assinatura de cor do DS).
    assert.match(html, /<span style="color:#00A0A0;">&#9679;<\/span>/, "ponto ● deve continuar teal");
    // Label ainda presente e legível (texto plano, não escondido).
    assert.match(html, /USE MELHOR/);
  });

  it("renderKicker: extractLinks (build-link-ctr.ts) continua reconhecendo o <td> (signature inalterada)", () => {
    // Guard de regressão cruzada: a assinatura que scripts/build-link-ctr.ts usa
    // pra achar headings de seção é font-weight:bold + letter-spacing:2px +
    // text-transform:uppercase no <td> — NÃO depende da cor. Mudar color:teal→ink
    // não pode quebrar essa detecção.
    const html = renderKicker("RADAR");
    const tdMatch = html.match(/<td style="([^"]+)">/);
    assert.ok(tdMatch);
    assert.match(tdMatch![1], /font-weight:\s*bold/);
    assert.match(tdMatch![1], /letter-spacing:\s*2px/);
    assert.match(tdMatch![1], /text-transform:\s*uppercase/);
  });

  it("renderWhyBoxInner: label 'Por que isso importa' é ink, ponto ● antes do label é teal", () => {
    const html = renderWhyBoxInner("Razão do destaque.");
    const labelMatch = html.match(/<p style="([^"]+)">(?:<span[^>]*>&#9679;<\/span>&nbsp;)?Por que isso importa<\/p>/);
    assert.ok(labelMatch, `label 'Por que isso importa' não encontrado: ${html}`);
    assert.match(labelMatch![1], /color:#171411/, "label deve ser ink");
    assert.doesNotMatch(labelMatch![1], /color:#00A0A0/, "label não deve mais ser teal");
    assert.match(html, /<span style="color:#00A0A0;">&#9679;<\/span>&nbsp;Por que isso importa/, "ponto ● deve preceder o label");
  });

  it("renderEIA: prevResultLine tem ponto ● teal + texto ink (era 100% teal)", () => {
    const baseEia: EIA = {
      credit: "Foto: x.",
      imageA: "01-eia-A.jpg",
      imageB: "01-eia-B.jpg",
      edition: "260999",
      prevResultLine: "Resultado da última edição: 67% acertaram.",
    };
    const html = renderEIA(baseEia);
    const match = html.match(/<p style="([^"]+)">(?:<span[^>]*>&#9679;<\/span>&nbsp;)?Resultado da última edição[^<]*<\/p>/);
    assert.ok(match, `prevResultLine <p> não encontrado: ${html}`);
    assert.match(match![1], /color:#171411/, "prevResultLine deve ser ink");
    assert.doesNotMatch(match![1], /color:#00A0A0/, "prevResultLine não deve mais ser teal");
    assert.match(
      html,
      /<span style="color:#00A0A0;">&#9679;<\/span>&nbsp;Resultado da última edição/,
      "ponto ● deve preceder o texto do resultado",
    );
  });

  it("renderEIA: sem prevResultLine, nada quebra (guard negativo)", () => {
    const baseEia: EIA = {
      credit: "Foto: x.",
      imageA: "01-eia-A.jpg",
      imageB: "01-eia-B.jpg",
      edition: "260999",
    };
    const html = renderEIA(baseEia);
    assert.doesNotMatch(html, /Resultado da última edição/);
  });
});
