/**
 * test/product-box.test.ts (edição 260629)
 *
 * Box de produtos (🛒) entre D2 e D3 — prateleira de afiliados Amazon com
 * categorias e múltiplos links inline. Pedido do editor na 260629: um box de
 * venda de dispositivos Alexa+ logo após o destaque da Alexa+.
 *
 * Regressão coberta: colocar o box inline no corpo do D2 fazia o renderer de
 * destaque cuspir markdown cru (`[Show 5](https://link.amazon/…)`) — links NÃO
 * clicáveis. A solução: `extractBoxDivulgacao2` o separa do corpo e
 * `renderIntroCallout` o renderiza como box estilizado preservando TODOS os
 * links inline (≠ renderMidCallout, que extrai só o 1º link como CTA).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractBoxDivulgacao2,
  stripBoxDivulgacao2,
} from "../scripts/lib/newsletter-parse.ts";
import { renderIntroCallout } from "../scripts/render-newsletter-html.ts";

const REVIEWED = `**DESTAQUE 1 | 🚀 LANÇAMENTO**

**[D1](https://example.com/d1)**

Corpo do D1.

Por que isso importa:

Why do D1.

---

**DESTAQUE 2 | 🏠 CASA INTELIGENTE**

**[Alexa+ chegou ao Brasil](https://www.amazon.com.br/Amazon-Alexa/dp/B0GPCVDCBQ)**

Corpo do D2.

Por que isso importa:

Why do D2.

---

🛒 Equipe sua casa com a Alexa+. Veja os dispositivos compatíveis:

Smart displays Echo: [Show 5](https://link.amazon/B0bSeNbs9) · [Show 8](https://link.amazon/B00RlxPou)

Fire TV: [Stick HD](https://link.amazon/B0hs12yXc)

---

**DESTAQUE 3 | ⚖️ REGULAÇÃO**

**[D3](https://example.com/d3)**

Corpo do D3.

Por que isso importa:

Why do D3.`;

describe("product box (🛒) entre D2 e D3", () => {
  it("extractBoxDivulgacao2 captura o bloco 🛒 com todas as categorias", () => {
    const box = extractBoxDivulgacao2(REVIEWED);
    assert.ok(box, "box deve ser extraído");
    assert.match(box!, /^🛒 Equipe sua casa/);
    assert.match(box!, /Smart displays Echo/);
    assert.match(box!, /Fire TV/);
    assert.match(box!, /link\.amazon\/B0hs12yXc/);
  });

  it("não confunde o box com o boxDivulgacao1 (sem 🛒 → null)", () => {
    const semBox = REVIEWED.replace(/🛒[\s\S]*?\n---\n/, "");
    assert.equal(extractBoxDivulgacao2(semBox), null);
  });

  it("stripBoxDivulgacao2 remove o bloco e colapsa os --- órfãos", () => {
    const stripped = stripBoxDivulgacao2(REVIEWED);
    assert.ok(!/🛒/.test(stripped), "🛒 não deve sobrar no texto");
    assert.ok(!/link\.amazon/.test(stripped), "links do box não devem sobrar");
    // D3 ainda presente e parseável após o strip.
    assert.match(stripped, /\*\*DESTAQUE 3/);
    // Sem `---` duplicado órfão deixado pela remoção.
    assert.ok(!/---[ \t]*\n\s*\n---/.test(stripped), "--- duplicado não deve sobrar");
  });

  it("stripBoxDivulgacao2 é idempotente quando não há box", () => {
    const semBox = "**DESTAQUE 1**\n\nx\n\n---\n\n**DESTAQUE 2**\n\ny";
    assert.equal(stripBoxDivulgacao2(semBox), semBox);
  });

  it("2 destaques: 🛒 numa seção NÃO é extraído como box (#review 260629)", () => {
    const twoD = [
      "**DESTAQUE 1**", "", "a", "", "---", "",
      "**DESTAQUE 2**", "", "b", "", "---", "",
      "**📡 RADAR**", "", "🛒 alguma loja de IA",
    ].join("\n");
    assert.equal(extractBoxDivulgacao2(twoD), null, "sem 3º destaque → sem box");
    assert.equal(stripBoxDivulgacao2(twoD), twoD, "strip é no-op sem box");
  });

  it("CRLF: o separator --- é reconhecido (não over-captura D3)", () => {
    const crlf = REVIEWED.replace(/\n/g, "\r\n");
    const box = extractBoxDivulgacao2(crlf);
    assert.ok(box, "box extraído sob CRLF");
    assert.ok(!box!.includes("DESTAQUE 3"), "não engole o D3");
    assert.ok(!stripBoxDivulgacao2(crlf).includes("🛒"), "strip remove o box sob CRLF");
  });

  it("strip NÃO funde separadores --- não-relacionados em outras partes", () => {
    const doc = [
      "**DESTAQUE 1**", "", "a", "", "---", "",
      "**DESTAQUE 2**", "", "b", "", "---", "",
      "🛒 box", "", "Cat: [A](https://link.amazon/A)", "", "---", "",
      "**DESTAQUE 3**", "", "c", "", "---", "", "---", "", "rodapé",
    ].join("\n");
    const out = stripBoxDivulgacao2(doc);
    // O par `---` duplo do rodapé (não-relacionado ao box) deve sobreviver.
    assert.match(out, /c\n\n---\n\n---\n\nrodapé/);
  });

  it("renderIntroCallout(box) mantém TODOS os links como anchors clicáveis", () => {
    const box = extractBoxDivulgacao2(REVIEWED)!;
    const html = renderIntroCallout(box);
    assert.match(html, /href="https:\/\/link\.amazon\/B0bSeNbs9"/);
    assert.match(html, /href="https:\/\/link\.amazon\/B00RlxPou"/);
    assert.match(html, /href="https:\/\/link\.amazon\/B0hs12yXc"/);
    // Não deve sobrar markdown cru de link no HTML.
    assert.ok(!/\]\(https:\/\/link\.amazon/.test(html), "markdown de link não deve vazar");
  });
});
