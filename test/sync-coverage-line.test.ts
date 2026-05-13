/**
 * test/sync-coverage-line.test.ts (#1097)
 *
 * Cobertura dos helpers pure de sync-coverage-line.ts.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  countEditorVsAuto,
  countSelectedItems,
  rewriteCoverageLine,
} from "../scripts/sync-coverage-line.ts";

describe("countEditorVsAuto", () => {
  it("conta editor_submitted como X", () => {
    const pool = [
      { flag: "editor_submitted", url: "u1" },
      { flag: "editor_submitted", url: "u2" },
      { url: "u3" },
    ];
    assert.deepEqual(countEditorVsAuto(pool), { x: 2, y: 1 });
  });

  it("conta newsletter_extracted como X (#1095)", () => {
    const pool = [
      { flag: "newsletter_extracted", url: "u1" },
      { flag: "newsletter_extracted", url: "u2" },
      { url: "u3" },
      { url: "u4" },
    ];
    assert.deepEqual(countEditorVsAuto(pool), { x: 2, y: 2 });
  });

  it("conta source: inbox como X (back-compat)", () => {
    const pool = [
      { source: "inbox", url: "u1" },
      { url: "u2" },
    ];
    assert.deepEqual(countEditorVsAuto(pool), { x: 1, y: 1 });
  });

  it("mix completo (editor + extracted + inbox + auto)", () => {
    const pool = [
      { flag: "editor_submitted", url: "1" },
      { flag: "newsletter_extracted", url: "2" },
      { source: "inbox", url: "3" },
      { url: "4" },
      { url: "5" },
    ];
    assert.deepEqual(countEditorVsAuto(pool), { x: 3, y: 2 });
  });

  it("pool vazio", () => {
    assert.deepEqual(countEditorVsAuto([]), { x: 0, y: 0 });
  });
});

describe("countSelectedItems", () => {
  it("conta destaques + seções, ignora afiliados", () => {
    const md = `Para esta edição...

---

**DESTAQUE 1**

**[Título A](https://example.com/a)**

Texto.

---

**OUTRAS NOTÍCIAS**

**[Item 1](https://x.com/1)**
Frase.

**[Item 2](https://y.com/2)**
Frase.

---

**🎁 SORTEIO**

[Link afiliado](https://diaria.beehiiv.com/livros-sobre-ia)

---

**🙋🏼‍♀️ PARA ENCERRAR**

[Wispr](https://wisprflow.ai/r?X=Y)
[LinkedIn](https://www.linkedin.com/company/diaria/)
`;
    // 3 itens editoriais: 1 destaque + 2 outras notícias. Pula sorteio + encerrar.
    assert.equal(countSelectedItems(md), 3);
  });

  it("ignora É IA? (links wikipedia/wikimedia/creativecommons)", () => {
    const md = `---

**DESTAQUE 1**

**[Real](https://example.com/d1)**

---

É IA?

Vista aérea... [Takht-i-Bahi](https://pt.wikipedia.org/wiki/Takht-i-Bahi). [Autor](https://commons.wikimedia.org/wiki/User:X) / [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0).
`;
    // Mesmo se "É IA?" não tem markdown explícito, links interno são filtrados.
    // Mas o split por --- preserva o bloco "É IA?" — SKIP_HEADERS o filtra.
    assert.equal(countSelectedItems(md), 1);
  });

  it("deduplica URLs repetidas no mesmo destaque (3 títulos pré-poda)", () => {
    const md = `---

**DESTAQUE 1**

**[Título A](https://example.com/d1)**

**[Título B](https://example.com/d1)**

**[Título C](https://example.com/d1)**

Texto.

---

**OUTRAS NOTÍCIAS**

**[Outro](https://x.com/y)**
`;
    // 3 títulos da mesma URL = 1 item editorial + 1 outra = 2
    assert.equal(countSelectedItems(md), 2);
  });
});

describe("rewriteCoverageLine", () => {
  it("substitui números corretamente", () => {
    const md = `Para esta edição, eu (o editor) enviei 5 submissões e a Diar.ia encontrou outros 130 artigos. Selecionamos os 34 mais relevantes para as pessoas que assinam a newsletter.

---

Resto.`;
    const r = rewriteCoverageLine(md, 13, 125, 12);
    assert.ok(r.changed);
    assert.match(r.md, /enviei 13 submissões e a Diar\.ia encontrou outros 125 artigos\. Selecionamos os 12/);
  });

  it("também aceita 'cinco' por extenso na linha original", () => {
    const md = `Para esta edição, eu (o editor) enviei cinco submissões e a Diar.ia encontrou outros 130 artigos. Selecionamos os 34 mais relevantes para as pessoas que assinam a newsletter.

Resto.`;
    const r = rewriteCoverageLine(md, 13, 125, 12);
    assert.ok(r.changed);
    assert.match(r.md, /enviei 13 submissões/);
  });

  it("no-op quando números já corretos", () => {
    const md = `Para esta edição, eu (o editor) enviei 13 submissões e a Diar.ia encontrou outros 125 artigos. Selecionamos os 12 mais relevantes para as pessoas que assinam a newsletter.

Resto.`;
    const r = rewriteCoverageLine(md, 13, 125, 12);
    assert.equal(r.changed, false);
  });

  it("retorna changed: false quando linha ausente", () => {
    const md = `Texto qualquer sem linha de cobertura.

Outro parágrafo.`;
    const r = rewriteCoverageLine(md, 1, 2, 3);
    assert.equal(r.changed, false);
    assert.equal(r.md, md);
  });

  it("#1179: tolera YAML frontmatter no topo (intentional_error declarado)", () => {
    const md = `---
intentional_error:
  description: "Mythos é atribuído à OpenAI, mas o modelo é da Anthropic."
  location: "DESTAQUE 3, parágrafo 1, segunda frase"
  category: "attribution"
  correct_value: "Anthropic"
---

Para esta edição, eu (o editor) enviei 5 submissões e a Diar.ia encontrou outros 130 artigos. Selecionamos os 34 mais relevantes para as pessoas que assinam a newsletter.

---

Resto.`;
    const r = rewriteCoverageLine(md, 13, 125, 12);
    assert.ok(r.changed, "deve atualizar mesmo com frontmatter");
    assert.match(r.md, /enviei 13 submissões/);
    // Frontmatter preservado.
    assert.match(r.md, /intentional_error:/);
  });

  it("#1179: tolera vírgula após 'submissões' (Clarice às vezes adiciona)", () => {
    // Caso real edição 260513: Clarice sugeriu "submissões" → "submissões,"
    // e o regex original não tolerava — script falhava silenciosamente.
    const md = `Para esta edição, eu (o editor) enviei 8 submissões, e a Diar.ia encontrou outros 120 artigos. Selecionamos os 15 mais relevantes para as pessoas que assinam a newsletter.

Resto.`;
    const r = rewriteCoverageLine(md, 8, 120, 12);
    assert.ok(r.changed, "deve normalizar pra forma canônica (sem vírgula extra)");
    // Resultado canônico: sem vírgula entre "submissões" e "e".
    assert.match(r.md, /enviei 8 submissões e a Diar\.ia/);
    // Número Z atualizado de 15 → 12.
    assert.match(r.md, /Selecionamos os 12 mais relevantes/);
    // Vírgula extra removida.
    assert.doesNotMatch(r.md, /submissões, e/);
  });

  it("#1179: combina frontmatter + vírgula Clarice (caso real 260513)", () => {
    const md = `---
intentional_error:
  description: "..."
  location: "..."
  category: "attribution"
  correct_value: "Anthropic"
---

Para esta edição, eu (o editor) enviei 8 submissões, e a Diar.ia encontrou outros 120 artigos. Selecionamos os 15 mais relevantes para as pessoas que assinam a newsletter.

Resto.`;
    const r = rewriteCoverageLine(md, 8, 120, 12);
    assert.ok(r.changed);
    assert.match(r.md, /enviei 8 submissões e a Diar\.ia/);
    assert.match(r.md, /Selecionamos os 12 mais relevantes/);
  });
});
