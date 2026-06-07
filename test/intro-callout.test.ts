/**
 * test/intro-callout.test.ts (#1648, edição 260601)
 *
 * extractIntroCallout + renderIntroCallout: CTA de destaque no topo da edição
 * (ex: convite pro sorteio ao vivo). Bug 260601: o convite pro sorteio estava
 * embutido na coverage line (cinza itálico 15px) e o editor não o encontrava no
 * topo. Solução: parágrafo `**🎉 ...**` na intro vira callout com borda teal.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractIntroCallout,
  renderIntroCallout,
} from "../scripts/render-newsletter-html.ts";

const SAMPLE = `TÍTULO

Título qualquer

SUBTÍTULO

Sub | qualquer

---

Para esta edição, eu (o editor) enviei 12 submissões e a Diar.ia encontrou outros 223 artigos. Selecionamos os 12 mais relevantes para as pessoas que assinam a newsletter.

**🎉 Sorteio de junho ao vivo: dia 2, às 13h, no [Google Meet](https://meet.google.com/awi-jter-dwm). Apareça para acompanhar o resultado.**

---

**DESTAQUE 1 | 📚 EDUCAÇÃO**

**[Título do destaque](https://exemplo.com)**

Corpo.`;

describe("extractIntroCallout (#1648)", () => {
  it("extrai o parágrafo 🎉 da intro, preservando markdown de link", () => {
    const cta = extractIntroCallout(SAMPLE);
    assert.ok(cta);
    assert.match(cta!, /^🎉 Sorteio de junho ao vivo/);
    assert.match(cta!, /\[Google Meet\]\(https:\/\/meet\.google\.com\/awi-jter-dwm\)/);
    // não vaza os ** delimitadores
    assert.doesNotMatch(cta!, /\*\*/);
  });

  it("aceita 📣 como marcador alternativo", () => {
    const cta = extractIntroCallout("Para esta edição...\n\n**📣 Aviso importante**\n\n**DESTAQUE 1 | X**");
    assert.equal(cta, "📣 Aviso importante");
  });

  it("ignora negrito dentro de um destaque (só olha a intro)", () => {
    const cta = extractIntroCallout("intro\n\n**DESTAQUE 1 | X**\n\n**🎉 isso é título de destaque, não CTA**");
    assert.equal(cta, null);
  });

  it("retorna null quando não há CTA", () => {
    assert.equal(extractIntroCallout("Para esta edição...\n\n**DESTAQUE 1 | X**"), null);
  });
});

describe("renderIntroCallout (#1648)", () => {
  it("renderiza callout como painel bege (DS #1936) e link clicável", () => {
    const html = renderIntroCallout(
      "🎉 Sorteio: [Google Meet](https://meet.google.com/awi-jter-dwm)",
    );
    // #1936: callout = box "painel" do DS (fundo bege #EBE5D0, sem borda teal).
    assert.match(html, /background:#EBE5D0/);
    assert.doesNotMatch(html, /border-left:[0-9]px solid #00A0A0/);
    assert.match(html, /<a href="https:\/\/meet\.google\.com\/awi-jter-dwm"/);
    assert.match(html, /font-weight:600/);
  });
});
