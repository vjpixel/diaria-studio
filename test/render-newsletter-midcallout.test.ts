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

  // ── Regressão dos achados de code-review do PR #1807 ──────────────────

  it("link com parênteses na URL não trunca (#1634-safe, #3I)", () => {
    const html = renderMidCallout(
      "📚 Promo. [Baixe o guia](https://ex.com/Founders-Playbook%20(1).pdf).",
      "https://img.example/p.jpg",
    );
    assert.ok(
      html.includes("https://ex.com/Founders-Playbook%20(1).pdf"),
      "URL completa (com parênteses) deve sobreviver no href",
    );
    assert.ok(!html.includes(">.pdf"), "não deve vazar resto da URL como texto");
  });

  it("escapa aspas/< no src e href (#3G)", () => {
    const html = renderMidCallout(
      `📚 Promo. [Confira](https://ex.com/a"onmouseover=x).`,
      `https://img.example/p.jpg"><script>`,
    );
    assert.ok(!html.includes(`p.jpg"><script>`), "src cru não deve aparecer");
    assert.ok(html.includes("&quot;"), "aspas devem ser escapadas no atributo");
  });

  it("remove TODOS os links do corpo, não só o primeiro (#3J)", () => {
    const html = renderMidCallout(
      "📚 Veja [aqui](https://a.com) e também [ali](https://b.com).",
      "https://img.example/p.jpg",
    );
    assert.ok(!html.includes("[aqui]"), "1º markdown-link removido do corpo");
    assert.ok(!html.includes("[ali]"), "2º markdown-link também removido do corpo");
    // o destino da imagem/CTA é o primeiro link
    assert.ok(html.includes("https://a.com"), "CTA usa o primeiro link");
  });
});
