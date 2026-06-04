/**
 * render-newsletter-midcallout.test.ts
 *
 * Cobre o box do meio (entre D1 e D2) adicionado ao render-newsletter-html.ts:
 * promo da página de livros com imagem + texto + botão CTA. Sem imagem, cai
 * no box só-texto (renderIntroCallout). Regressão pro caso 260604.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractMidCallout, renderMidCallout } from "../scripts/render-newsletter-html.ts";

const MD = `Para esta edição, selecionamos 15 itens.

---

**DESTAQUE 1 | 🚀 LANÇAMENTO**

**[Título D1](https://example.com/d1)**

Corpo do destaque 1.

Por que isso importa:

Algo importante.

---

**📚 Nossa curadoria de livros sobre IA ganhou página nova. [Confira a nova página](https://livros.diaria.workers.dev).**

---

**DESTAQUE 2 | 🚀 LANÇAMENTO**

**[Título D2](https://example.com/d2)**

Corpo do destaque 2.
`;

describe("midCallout — box entre D1 e D2", () => {
  it("extractMidCallout pega o box bold-wrapped 📚 entre D1 e D2", () => {
    const c = extractMidCallout(MD);
    assert.ok(c, "deveria achar o box");
    assert.match(c!, /^📚 Nossa curadoria/);
    assert.match(c!, /\[Confira a nova página\]\(https:\/\/livros\.diaria\.workers\.dev\)/);
  });

  it("extractMidCallout retorna null quando não há box", () => {
    const semBox = MD.replace(/\*\*📚[^\n]*\n/, "");
    assert.equal(extractMidCallout(semBox), null);
  });

  it("extractMidCallout não casa títulos de destaque (começam com [)", () => {
    const c = extractMidCallout(MD);
    assert.ok(!/Título D1/.test(c ?? ""), "não deve capturar o título do destaque");
  });

  it("renderMidCallout sem imagem cai no box só-texto (sem <img> nem botão)", () => {
    const html = renderMidCallout("📚 Promo. [Confira](https://livros.diaria.workers.dev).", null);
    assert.ok(!html.includes("<img"), "não deve ter imagem");
    assert.ok(!html.includes("Ver os livros"), "não deve ter botão CTA");
    // ainda deve renderizar o texto + link inline
    assert.ok(html.includes("Confira") || html.includes("livros.diaria.workers.dev"));
  });

  it("renderMidCallout com imagem inclui <img>, botão CTA e o link do box", () => {
    const url = "https://poll.diaria.workers.dev/img/img-260604-04-livros-promo.jpg";
    const html = renderMidCallout(
      "📚 Promo da página. [Confira a nova página](https://livros.diaria.workers.dev).",
      url,
    );
    assert.match(html, new RegExp(`<img[^>]+src="${url.replace(/[.?*+^$()[\]{}|\\/]/g, "\\$&")}"`));
    assert.ok(html.includes("Ver os livros"), "deve ter o botão CTA");
    assert.ok(html.includes("https://livros.diaria.workers.dev"), "imagem/botão linkam pro destino do box");
    // o texto do body não deve mais conter o markdown-link cru
    assert.ok(!html.includes("[Confira a nova página]"), "markdown-link removido do corpo");
  });
});
