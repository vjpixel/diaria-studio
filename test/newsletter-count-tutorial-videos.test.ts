/**
 * test/newsletter-count-tutorial-videos.test.ts (#1574/#1578)
 *
 * Cobre extensão de `countSelectedItems` para incluir USE MELHOR (tutorial)
 * + VÍDEOS sections. Caso pré-fix: edição com USE MELHOR + 1 vídeo era
 * sub-contada, e intro line "Selecionamos os Z" desbatia.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { countSelectedItems, lintIntroCount } from "../scripts/lib/newsletter-count.ts";

describe("countSelectedItems — USE MELHOR + VÍDEOS (#1574)", () => {
  it("conta item em USE MELHOR (bucket tutorial)", () => {
    const md = `
**DESTAQUE 1 | 🚀 LANÇAMENTO**

**[Título D1](https://example.com/d1)**

Texto.

---

**📰 OUTRAS NOTÍCIAS**

**[Item 1](https://x.com/1)**

Frase.

---

**🛠️ USE MELHOR**

**[Tutorial X](https://tools.com/x)**

Como usar (5 min).

---

**🎁 SORTEIO**

Texto.
`;
    const counts = countSelectedItems(md);
    assert.equal(counts.destaques, 1);
    assert.equal(counts.noticias, 1);
    assert.equal(counts.tutoriais, 1, "USE MELHOR deve contar como 1 tutorial");
    assert.equal(counts.total, 3);
  });

  it("conta items em VÍDEOS", () => {
    const md = `
**DESTAQUE 1**

**[Título](https://example.com/d1)**

Texto.

---

**VÍDEOS**

**[Vídeo 1](https://yt.com/v1)**

Descrição.

**[Vídeo 2](https://yt.com/v2)**

Descrição.

---

**PARA ENCERRAR**

Texto.
`;
    const counts = countSelectedItems(md);
    assert.equal(counts.destaques, 1);
    assert.equal(counts.videos, 2);
    assert.equal(counts.total, 3);
  });

  it("OUTROS LINKS (#1569) também conta como noticias", () => {
    const md = `
**DESTAQUE 1**

**[D1](https://example.com/d1)**

Texto.

---

**📰 OUTROS LINKS**

**[Item 1](https://x.com/1)**

Frase.

**[Item 2](https://y.com/2)**

Frase.
`;
    const counts = countSelectedItems(md);
    assert.equal(counts.noticias, 2);
    assert.equal(counts.total, 3);
  });

  it("intro count valida total incluindo tutorial + vídeos", () => {
    const md = `Para esta edição, eu (o editor) enviei 1 submissões e a Diar.ia encontrou outros 50 artigos. Selecionamos os 4 mais relevantes.

---

**DESTAQUE 1**

**[D1](https://example.com/d1)**

---

**📰 OUTRAS NOTÍCIAS**

**[N1](https://x.com/1)**

---

**🛠️ USE MELHOR**

**[Tutorial](https://tools.com/t)**

---

**VÍDEOS**

**[Vídeo](https://yt.com/v)**
`;
    const result = lintIntroCount(md);
    assert.equal(result.ok, true);
    assert.equal(result.claimed, 4);
    assert.equal(result.actual, 4);
  });

  it("emoji com VS16 (🛠️) match header sem cair em null", () => {
    const md = `**🛠️ USE MELHOR**

**[Tutorial](https://tools.com/t)**

Descrição.
`;
    const counts = countSelectedItems(md);
    assert.equal(counts.tutoriais, 1);
    assert.equal(counts.total, 1);
  });

  it("emoji ZWJ + skin-tone (🙋🏼‍♀️ PARA ENCERRAR) é SKIP, não bucket", () => {
    const md = `**DESTAQUE 1**

**[D1](https://example.com/d1)**

---

**🙋🏼‍♀️ PARA ENCERRAR**

**[Wispr](https://wisprflow.ai/r?X=Y)**

Texto.
`;
    const counts = countSelectedItems(md);
    assert.equal(counts.destaques, 1);
    assert.equal(counts.total, 1, "PARA ENCERRAR não conta como bucket");
  });

  it("frontmatter com 'Selecionamos os' não polui extractIntroClaimedCount", () => {
    const md = `---
description: "Selecionamos os 99 mais relevantes — fake"
---

Para esta edição, eu (o editor) enviei 1 submissões e a Diar.ia encontrou outros 50 artigos. Selecionamos os 1 mais relevantes.

---

**DESTAQUE 1**

**[D1](https://example.com/d1)**
`;
    const result = lintIntroCount(md);
    assert.equal(result.claimed, 1, "frontmatter '99' deve ser ignorado");
    assert.equal(result.actual, 1);
    assert.equal(result.ok, true);
  });

  it("intro count detecta mismatch quando declared < real (caso 260529)", () => {
    const md = `Para esta edição, eu (o editor) enviei 9 submissões e a Diar.ia encontrou outros 265 artigos. Selecionamos os 6 mais relevantes.

---

**DESTAQUE 1**
**[D1](https://example.com/d1)**

---

**DESTAQUE 2**
**[D2](https://example.com/d2)**

---

**DESTAQUE 3**
**[D3](https://example.com/d3)**

---

**🔬 PESQUISAS**

**[P1](https://arxiv.org/1)**
**[P2](https://arxiv.org/2)**
**[P3](https://arxiv.org/3)**
**[P4](https://arxiv.org/4)**

---

**📰 OUTRAS NOTÍCIAS**

**[N1](https://x.com/1)**
**[N2](https://x.com/2)**
**[N3](https://x.com/3)**
**[N4](https://x.com/4)**
`;
    const result = lintIntroCount(md);
    assert.equal(result.ok, false);
    assert.equal(result.claimed, 6);
    assert.equal(result.actual, 11);
  });
});
