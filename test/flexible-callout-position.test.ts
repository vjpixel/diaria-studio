/**
 * test/flexible-callout-position.test.ts (#2665)
 *
 * Posição flexível dos boxes entre destaques. Antes, o midCallout (📚/📣/🎉) só
 * era detectado entre D1/D2 e o productBox (🛒) só entre D2/D3 — a posição era
 * amarrada ao tipo. Pedido do editor na 260630: box de afiliados Alexa+ (🛒)
 * logo após o D1 (Alexa+) e a promo de livros (📚) depois, entre D2 e D3.
 *
 * #2665: os dois finders varrem TODAS as lacunas entre destaques e gravam
 * `midCalloutAfter`/`productBoxAfter` (índice do destaque que precede a lacuna).
 * Back-compat: o layout legado (📚 em D1/D2, 🛒 em D2/D3) continua → after 0 / 1.
 * O render remove o marcador 🛒 do HTML (estrutural, não aparece ao leitor).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractContent } from "../scripts/lib/newsletter-parse.ts";
import { renderHTML } from "../scripts/lib/newsletter-render-html.ts";

const EIA = `**É IA?**

Foto teste. [Autor](https://example.com/a) / CC.

Resultado da última edição: 40% das pessoas acertaram.
`;

function d(n: number, cat: string, url: string): string {
  return `**DESTAQUE ${n} | ${cat}**

**[Título D${n}](${url})**

Corpo do destaque ${n}.

Por que isso importa:

Why do D${n}.
`;
}

const BOX_ALEXA = `🛒 Equipe sua casa com a Alexa+

Veja os dispositivos: [Show 8](https://link.amazon/B00RlxPou) · [Dot Max](https://link.amazon/B08Vl81qA)

Ao comprar por esses links, a Diar.ia recebe comissão.`;

const BOX_LIVROS =
  `**📚 A Diar.ia mantém uma curadoria de livros sobre IA. [Confira a página de livros](https://livros.diaria.workers.dev).**`;

function buildReviewed(box1: string, box2: string): string {
  return `Para esta edição, selecionamos 12 itens.

---

${d(1, "🚀 LANÇAMENTO", "https://example.com/d1")}

---

${box1}

---

${d(2, "💼 MERCADO", "https://example.com/d2")}

---

${box2}

---

${d(3, "💼 TRABALHO", "https://example.com/d3")}

---

${EIA}

---

**📡 RADAR**

**[Item de radar](https://example.com/r1)**
Resumo do item.
`;
}

function withEdition(reviewed: string, fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "ed-"));
  try {
    writeFileSync(join(dir, "02-reviewed.md"), reviewed, "utf8");
    writeFileSync(join(dir, "01-eia.md"), EIA, "utf8");
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("#2665 — posição flexível dos boxes entre destaques", () => {
  it("🛒 entre D1/D2 e 📚 entre D2/D3 → productBoxAfter=0, midCalloutAfter=1", () => {
    withEdition(buildReviewed(BOX_ALEXA, BOX_LIVROS), (dir) => {
      const c = extractContent(dir);
      assert.ok(c.productBox, "deveria achar o box 🛒");
      assert.match(c.productBox!, /Equipe sua casa com a Alexa/);
      assert.equal(c.productBoxAfter, 0, "🛒 está na lacuna após o D1");
      assert.ok(c.midCallout, "deveria achar o box 📚");
      assert.match(c.midCallout!, /curadoria de livros/);
      assert.equal(c.midCalloutAfter, 1, "📚 está na lacuna após o D2");
    });
  });

  it("back-compat: 📚 entre D1/D2 e 🛒 entre D2/D3 → midCalloutAfter=0, productBoxAfter=1", () => {
    withEdition(buildReviewed(BOX_LIVROS, BOX_ALEXA), (dir) => {
      const c = extractContent(dir);
      assert.equal(c.midCalloutAfter, 0, "📚 na lacuna após o D1 (legado)");
      assert.equal(c.productBoxAfter, 1, "🛒 na lacuna após o D2 (legado)");
    });
  });

  it("render: ambos os boxes aparecem e o marcador 🛒 NÃO vaza pro HTML", () => {
    withEdition(buildReviewed(BOX_ALEXA, BOX_LIVROS), (dir) => {
      const html = renderHTML(extractContent(dir));
      assert.ok(html.includes("Equipe sua casa com a Alexa"), "box Alexa renderizado");
      assert.ok(html.includes("curadoria de livros"), "box livros renderizado");
      assert.ok(html.includes("link.amazon/B00RlxPou"), "links de afiliado preservados");
      assert.ok(!html.includes("🛒"), "marcador 🛒 removido do HTML");
      // #2665: ordem importa — o box Alexa (productBoxAfter=0) vem ANTES do box
      // livros (midCalloutAfter=1). Presença sozinha não pega regressão de posição.
      assert.ok(
        html.indexOf("Equipe sua casa") < html.indexOf("curadoria de livros"),
        "box Alexa (após D1) deve vir antes do box livros (após D2)",
      );
    });
  });

  it("back-compat renderiza: 📚 após D1, 🛒 após D2 (ordem legada)", () => {
    withEdition(buildReviewed(BOX_LIVROS, BOX_ALEXA), (dir) => {
      const html = renderHTML(extractContent(dir));
      assert.ok(html.includes("curadoria de livros"), "box livros renderizado");
      assert.ok(html.includes("Equipe sua casa"), "box Alexa renderizado");
      assert.ok(
        html.indexOf("curadoria de livros") < html.indexOf("Equipe sua casa"),
        "layout legado: livros (após D1) antes de Alexa (após D2)",
      );
    });
  });

  it("**negrito** dentro do box vira <strong> (não vaza com asteriscos)", () => {
    const boxBold = `🛒 Compre agora

Veja: [Dot](https://link.amazon/B08O9g9Dj)

**Não compre ainda.** Espere os descontos de amanhã.`;
    withEdition(buildReviewed(boxBold, BOX_LIVROS), (dir) => {
      const html = renderHTML(extractContent(dir));
      assert.ok(html.includes("<strong>Não compre ainda.</strong>"), "negrito renderizado");
      assert.ok(!html.includes("**Não compre"), "sem asteriscos literais");
    });
  });

  it("link markdown no CORPO do destaque renderiza <a> (não vaza markdown)", () => {
    const reviewed = `Para esta edição, selecionamos 12 itens.

---

**DESTAQUE 1 | 🚀 LANÇAMENTO**

**[Título D1](https://example.com/d1)**

Acesse [amazon.com.br/alexaplus](https://link.amazon/B0249coGp) para entrar.

Por que isso importa:

Why do D1.

---

${d(2, "💼 MERCADO", "https://example.com/d2")}

---

${EIA}

---

**📡 RADAR**

**[Item](https://example.com/r1)**
Resumo.
`;
    withEdition(reviewed, (dir) => {
      const html = renderHTML(extractContent(dir));
      assert.ok(
        html.includes('href="https://link.amazon/B0249coGp"'),
        "link do corpo vira <a href>",
      );
      assert.ok(html.includes(">amazon.com.br/alexaplus</a>"), "label do link preservado");
      assert.ok(!html.includes("[amazon.com.br/alexaplus]"), "sem markdown literal");
    });
  });

  it("🛒 sozinho na primeira linha do box não deixa <p> vazio (strip do \\n)", () => {
    const boxSoEmoji = `🛒\n\nSmart speakers: [Dot](https://link.amazon/B08O9g9Dj)\n\nAo comprar, a Diar.ia recebe comissão.`;
    withEdition(buildReviewed(boxSoEmoji, BOX_LIVROS), (dir) => {
      const html = renderHTML(extractContent(dir));
      assert.ok(!html.includes("🛒"), "marcador 🛒 removido mesmo sozinho na linha");
      assert.ok(html.includes("Smart speakers"), "conteúdo do box preservado");
    });
  });
});
