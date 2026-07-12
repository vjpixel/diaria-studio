/**
 * test/box-divulgacao-bold.test.ts (#3372)
 *
 * `isBoxDivulgacao1Bold`/`isBoxDivulgacao2Bold` detectam se o box de 1
 * parágrafo (sem imagem/CTA-pill) veio embrulhado em `**...**` na fonte —
 * sinal que `renderBoxDivulgacao` usa pra decidir o peso da fonte. Editor
 * escreve `**...**` pra negrito, texto plano pra peso normal (260712).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isBoxDivulgacao1Bold, isBoxDivulgacao2Bold } from "../scripts/lib/newsletter-parse.ts";

function d(n: number, cat: string, url: string): string {
  return `**DESTAQUE ${n} | ${cat}**

**[Título D${n}](${url})**

Corpo do destaque ${n}.

Por que isso importa:

Explicação ${n}.`;
}

describe("isBoxDivulgacao1Bold / isBoxDivulgacao2Bold (#3372)", () => {
  it("box bold-wrapped (**...**) → true", () => {
    const md = `${d(1, "CAT", "https://a.com")}

---

**🙋🏼‍♀️ Apoie a curadoria. [Conheça](https://apoia.se/diaria).**

---

${d(2, "CAT", "https://b.com")}`;
    assert.equal(isBoxDivulgacao1Bold(md), true);
  });

  it("box em texto plano (sem **...**) → false", () => {
    const md = `${d(1, "CAT", "https://a.com")}

---

🙋🏼‍♀️ Apoie a curadoria. [Conheça](https://apoia.se/diaria).

---

${d(2, "CAT", "https://b.com")}`;
    assert.equal(isBoxDivulgacao1Bold(md), false);
  });

  it("slot 2 (gap D2/D3) segue a mesma lógica", () => {
    const boldMd = `${d(1, "CAT", "https://a.com")}
${d(2, "CAT", "https://b.com")}

---

**📚 Nossa curadoria de livros. [Confira](https://livros.diaria.workers.dev).**

---

${d(3, "CAT", "https://c.com")}`;
    const plainMd = boldMd.replace(
      "**📚 Nossa curadoria de livros. [Confira](https://livros.diaria.workers.dev).**",
      "📚 Nossa curadoria de livros. [Confira](https://livros.diaria.workers.dev).",
    );
    assert.equal(isBoxDivulgacao2Bold(boldMd), true);
    assert.equal(isBoxDivulgacao2Bold(plainMd), false);
  });

  it("sem box na lacuna → default true (inofensivo, nunca consultado nesse caso)", () => {
    const md = `${d(1, "CAT", "https://a.com")}
${d(2, "CAT", "https://b.com")}`;
    assert.equal(isBoxDivulgacao1Bold(md), true);
  });

  it("texto plano com múltiplos parágrafos (não é bold-line) → false, mesmo com ** interno", () => {
    const md = `${d(1, "CAT", "https://a.com")}

---

Primeiro parágrafo do box.

Segundo parágrafo com **ênfase** interna, não o bloco inteiro.

---

${d(2, "CAT", "https://b.com")}`;
    assert.equal(isBoxDivulgacao1Bold(md), false);
  });
});
