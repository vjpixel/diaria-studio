/**
 * test/send-edition-report-highlights-from-md.test.ts (#1586)
 *
 * Cobre `extractHighlightsFromMd` que reflete a ordem editorial final
 * pós-reorder mid-Stage 4. Pre-fix, send-edition-report lia de
 * 01-approved.json (ordem pre-Stage 2), email ficava com ordem stale.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractHighlightsFromMd } from "../scripts/send-edition-report.ts";

describe("extractHighlightsFromMd (#1586)", () => {
  it("extrai 3 destaques na ordem editorial", () => {
    const md = `
---

**DESTAQUE 1 | 🚀 LANÇAMENTO**

**[Claude Opus 4.8 chegou](https://anthropic.com/news/claude-opus-4-8)**

Parágrafo 1...

---

**DESTAQUE 2 | 💼 MERCADO**

**[99% dos líderes esperam demitir](https://exame.com/x)**

Parágrafo 2...

---

**DESTAQUE 3 | 🇧🇷 BRASIL**

**[C6 Bank permite conversar com a IA](https://c6.com.br/x)**

Parágrafo 3...
`;
    const result = extractHighlightsFromMd(md);
    assert.equal(result.length, 3);
    assert.equal(result[0].title, "Claude Opus 4.8 chegou");
    assert.equal(result[0].url, "https://anthropic.com/news/claude-opus-4-8");
    assert.equal(result[1].title, "99% dos líderes esperam demitir");
    assert.equal(result[2].title, "C6 Bank permite conversar com a IA");
  });

  it("aceita formato pós-Drive flip `[**Title**](url)` (#1582)", () => {
    const md = `
**DESTAQUE 1 | 🚀 LANÇAMENTO**

[**Título flipado**](https://example.com/x)

Texto.
`;
    const result = extractHighlightsFromMd(md);
    assert.equal(result.length, 1);
    assert.equal(result[0].title, "Título flipado");
  });

  it("preserva ordem editorial pós-reorder mid-Stage 4 (caso 260529)", () => {
    // Editor moveu Opus de D2 pra D1, Mercer de D1 pra D2.
    const md = `
**DESTAQUE 1 | 🚀 LANÇAMENTO**

**[Claude Opus 4.8 chegou](https://anthropic.com/x)**

---

**DESTAQUE 2 | 💼 MERCADO**

**[99% Mercer survey](https://exame.com/x)**

---

**DESTAQUE 3 | 🇧🇷 BRASIL**

**[C6 Bank IA](https://c6.com.br/x)**
`;
    const result = extractHighlightsFromMd(md);
    // Ordem do MD = ordem editorial final
    assert.equal(result[0].title, "Claude Opus 4.8 chegou");
    assert.equal(result[1].title, "99% Mercer survey");
    assert.equal(result[2].title, "C6 Bank IA");
  });

  it("emoji + pipe + categoria com whitespace flexível", () => {
    const md = `
**DESTAQUE 1   |   📈 TENDÊNCIA**

**[Título flex](https://x.com/y)**
`;
    const result = extractHighlightsFromMd(md);
    assert.equal(result[0].title, "Título flex");
  });

  it("MD sem destaques → array vazio (caller fallback pra 01-approved.json)", () => {
    const md = `
**🚀 LANÇAMENTOS**

**[Item](https://x.com)**
`;
    assert.equal(extractHighlightsFromMd(md).length, 0);
  });

  it("MD com 5 destaques → trunca pra 3", () => {
    const md = `
**DESTAQUE 1 | A**

**[T1](https://1.com)**

---

**DESTAQUE 2 | B**

**[T2](https://2.com)**

---

**DESTAQUE 3 | C**

**[T3](https://3.com)**

---

**DESTAQUE 4 | D**

**[T4](https://4.com)**

---

**DESTAQUE 5 | E**

**[T5](https://5.com)**
`;
    const result = extractHighlightsFromMd(md);
    assert.equal(result.length, 3);
    assert.equal(result[2].title, "T3");
  });

  it("string vazia → array vazio", () => {
    assert.equal(extractHighlightsFromMd("").length, 0);
  });
});
