/**
 * test/flexible-callout-position.test.ts (#2665, rescoped #2978, #3475)
 *
 * Boxes de divulgação são um SLOT fixo por POSIÇÃO: boxDivulgacao1 = box na
 * lacuna D1/D2 (gap 0), boxDivulgacao2 = box na lacuna D2/D3 (gap 1) —
 * independente do FORMATO do conteúdo (bold-line vs carrinho). O formato é
 * decidido pela ESTRUTURA do conteúdo no momento do render
 * (`renderBoxDivulgacao`/`shouldForceCtaPill`), não pelo slot nem por
 * marcador emoji (sistema removido em #3475). Pedido do editor na 260630:
 * box de afiliados Alexa+ logo após o D1 e a promo de livros depois, entre
 * D2 e D3 — o inverso do layout legado (livros em D1/D2, Alexa+ em D2/D3).
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

const BOX_ALEXA = `Equipe sua casa com a Alexa+

Veja os dispositivos: [Show 8](https://link.amazon/B00RlxPou) · [Dot Max](https://link.amazon/B08Vl81qA)

Ao comprar por esses links, a Diar.ia recebe comissão.`;

const BOX_LIVROS =
  `**A Diar.ia mantém uma curadoria de livros sobre IA. [Confira a página de livros](https://livros.diaria.workers.dev).**`;

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

describe("#2978 — box em cada slot detectado por POSIÇÃO, independente do formato", () => {
  it("Alexa+ na lacuna D1/D2 → boxDivulgacao1; livros na lacuna D2/D3 → boxDivulgacao2 (formato invertido do legado)", () => {
    withEdition(buildReviewed(BOX_ALEXA, BOX_LIVROS), (dir) => {
      const c = extractContent(dir);
      assert.ok(c.boxDivulgacao1, "slot 1 (D1/D2) deveria achar o box Alexa+");
      assert.match(c.boxDivulgacao1!, /Equipe sua casa com a Alexa/);
      assert.ok(c.boxDivulgacao2, "slot 2 (D2/D3) deveria achar o box livros");
      assert.match(c.boxDivulgacao2!, /curadoria de livros/);
    });
  });

  it("layout legado: livros na lacuna D1/D2 → boxDivulgacao1; Alexa+ na lacuna D2/D3 → boxDivulgacao2", () => {
    withEdition(buildReviewed(BOX_LIVROS, BOX_ALEXA), (dir) => {
      const c = extractContent(dir);
      assert.match(c.boxDivulgacao1!, /curadoria de livros/, "slot 1 (D1/D2) = livros (legado)");
      assert.match(c.boxDivulgacao2!, /Equipe sua casa com a Alexa/, "slot 2 (D2/D3) = Alexa (legado)");
    });
  });

  it("render: ambos os boxes aparecem, na ORDEM posicional (slot 1 antes de slot 2)", () => {
    withEdition(buildReviewed(BOX_ALEXA, BOX_LIVROS), (dir) => {
      const html = renderHTML(extractContent(dir));
      assert.ok(html.includes("Equipe sua casa com a Alexa"), "box Alexa renderizado");
      assert.ok(html.includes("curadoria de livros"), "box livros renderizado");
      assert.ok(html.includes("link.amazon/B00RlxPou"), "links de afiliado preservados");
      assert.ok(
        html.indexOf("Equipe sua casa") < html.indexOf("curadoria de livros"),
        "box do slot 1 (Alexa, D1/D2) deve vir antes do box do slot 2 (livros, D2/D3)",
      );
    });
  });

  it("layout legado renderiza na ordem legada: livros (slot 1) antes de Alexa (slot 2)", () => {
    withEdition(buildReviewed(BOX_LIVROS, BOX_ALEXA), (dir) => {
      const html = renderHTML(extractContent(dir));
      assert.ok(html.includes("curadoria de livros"), "box livros renderizado");
      assert.ok(html.includes("Equipe sua casa"), "box Alexa renderizado");
      assert.ok(
        html.indexOf("curadoria de livros") < html.indexOf("Equipe sua casa"),
        "layout legado: livros (slot 1) antes de Alexa (slot 2)",
      );
    });
  });

  it("**negrito** dentro do box vira <strong> (não vaza com asteriscos)", () => {
    const boxBold = `Compre agora

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

  // #3475: o teste "🛒 sozinho na primeira linha do box não deixa <p> vazio"
  // cobria o strip do marcador `🛒` (legado, removido de `renderBoxDivulgacao`
  // junto com o resto do sistema de marcadores) — sem marcador nenhum pra
  // stripar, o cenário deixou de existir.
});
