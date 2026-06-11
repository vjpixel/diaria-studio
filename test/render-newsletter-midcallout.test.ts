/**
 * render-newsletter-midcallout.test.ts
 *
 * Cobre o box do meio (entre D1 e D2) adicionado ao render-newsletter-html.ts:
 * promo da página de livros com imagem + texto + botão CTA. Sem imagem, cai
 * no box só-texto (renderIntroCallout). Regressão pro caso 260604.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractMidCallout,
  stripMidCalloutFromD1,
  renderMidCallout,
  readMidCalloutImage,
} from "../scripts/render-newsletter-html.ts";
import { parseDestaques } from "../scripts/extract-destaques.ts";

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
    // #2067: sem imagem, não há CTA pill (border-radius:999px é o marcador do pill)
    assert.ok(!html.includes("border-radius:999px"), "não deve ter botão CTA pill");
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
    // #2067: CTA label derivado do anchor text do 1º link
    assert.ok(html.includes("Confira a nova página"), "deve ter o botão CTA com o texto do link");
    assert.ok(html.includes("https://livros.diaria.workers.dev"), "imagem/botão linkam pro destino do box");
    // o texto do body não deve mais conter o markdown-link cru
    assert.ok(!html.includes("[Confira a nova página]"), "markdown-link removido do corpo");
  });

  it("single-parágrafo COM imagem: marcador 📚 removido e corpo em peso normal/1.62 (DS body, 260611)", () => {
    const html = renderMidCallout(
      "📚 Promo da página. [Confira a nova página](https://livros.diaria.workers.dev).",
      "https://poll.diaria.workers.dev/img/img-260604-04-livros-promo.jpg",
    );
    assert.ok(!html.includes("📚"), "emoji do marcador não deve renderizar no box com imagem");
    // #2067: corpo (parágrafo antes do CTA) não usa bold 600 — checa no bloco inteiro
    // excluindo o CTA pill (que pode ser bold). Nenhum <p> de 16px deve ter font-weight:600.
    assert.ok(!/font-size:16px[^"]*font-weight:600/.test(html), "corpo não usa bold 600 nos parágrafos");
    assert.match(html, /line-height:1\.62/);
  });

  it("review #2066: corpo que é só marcador+link não emite <p> fantasma", () => {
    const html = renderMidCallout(
      "📚 [Confira a nova página](https://livros.diaria.workers.dev).",
      "https://img.example/p.jpg",
    );
    assert.ok(!/<p[^>]*>\s*<\/p>/.test(html), "sem parágrafo vazio entre imagem e CTA");
    // #2067: CTA derivado do anchor text; "Confira a nova página" é o label do link
    assert.ok(html.includes("Confira a nova página"), "CTA preservado com label do link");
  });

  it("review #2066: stripCalloutMarker consome VS15 (U+FE0E) além do VS16", () => {
    const html = renderMidCallout(
      "📚︎ Promo da página. [Confira](https://livros.diaria.workers.dev).",
      "https://img.example/p.jpg",
    );
    assert.ok(!html.includes("︎"), "variation selector não vaza pro HTML");
    assert.ok(html.includes("Promo da página"), "corpo preservado");
  });

  it("callout multi-parágrafo (ex: Clarice) renderiza título serif em 26px (DS h4)", () => {
    // #DS callout/É IA? title h4: o 1º parágrafo vira título serif; antes 22px (h5), agora 26px (h4).
    const html = renderMidCallout(
      "📣 Escreva melhor com a Clarice.ai\n\nA IA brasileira que revisa textos.\n\n[Acesse](https://clarice.ai/precos-planos?via=diaria).",
      null,
    );
    const titleMatch = html.match(/<p style="([^"]+)">Escreva melhor com a Clarice\.ai<\/p>/);
    assert.ok(titleMatch, "título do callout multi-parágrafo deve sair num <p> próprio (marcador 📣 removido)");
    assert.match(titleMatch![1], /font-size:26px/, "título do callout é 26px (DS h4)");
    assert.doesNotMatch(titleMatch![1], /font-size:22px/, "não deve mais ser 22px (h5)");
  });

  it("callout multi-parágrafo COM imagem também renderiza título em 26px (DS h4)", () => {
    // O caminho com imagem (renderMidCallout, paras.length>1) espelha o sem imagem (#1938)
    // — o título serif deve sair em 26px igual, não 22px.
    const html = renderMidCallout(
      "📚 Curadoria de livros sobre IA\n\nPágina nova com filtros. [Confira](https://livros.diaria.workers.dev).",
      "https://poll.diaria.workers.dev/img/img-260604-04-livros-promo.jpg",
    );
    const titleMatch = html.match(/<p style="([^"]+)">Curadoria de livros sobre IA<\/p>/);
    assert.ok(titleMatch, "título serif do callout com imagem deve sair num <p> próprio (marcador 📚 removido)");
    assert.match(titleMatch![1], /font-size:26px/, "título do callout com imagem é 26px (DS h4)");
    assert.doesNotMatch(titleMatch![1], /font-size:22px/, "não deve mais ser 22px (h5)");
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

  // ── #1808: produtor (06-public-images.json) → consumidor (render) ──────

  it("e2e: entry livros_promo no JSON → readMidCalloutImage → renderMidCallout emite <img> + botão", () => {
    const dir = mkdtempSync(join(tmpdir(), "midcallout-"));
    try {
      // como o produtor (upload-images-public.ts --mode newsletter) grava:
      const cfUrl = "https://poll.diaria.workers.dev/img/img-260604-04-livros-promo.jpg";
      writeFileSync(
        join(dir, "06-public-images.json"),
        JSON.stringify({ images: { livros_promo: { cloudflare_url: cfUrl, url: cfUrl } } }),
      );
      const url = readMidCalloutImage(dir);
      assert.equal(url, cfUrl, "readMidCalloutImage deve ler a cloudflare_url do produtor");
      const html = renderMidCallout(
        "📚 Curadoria de livros. [Ver a página](https://livros.diaria.workers.dev).",
        url,
      );
      assert.match(html, /<img[^>]+src="[^"]*livros-promo/, "box deve emitir <img> da promo");
      // #2067: CTA label derivado do anchor text do link no texto do box
      assert.ok(html.includes("Ver a página"), "box deve ter o botão CTA com label do link");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("e2e: sem entry livros_promo → readMidCalloutImage null → box só-texto (degradação graciosa)", () => {
    const dir = mkdtempSync(join(tmpdir(), "midcallout-"));
    try {
      writeFileSync(join(dir, "06-public-images.json"), JSON.stringify({ images: { d1: { url: "x" } } }));
      assert.equal(readMidCalloutImage(dir), null);
      const html = renderMidCallout("📚 Promo. [Ver](https://livros.diaria.workers.dev).", null);
      assert.ok(!html.includes("<img"), "sem produtor → box degrada pra só-texto");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

describe("#1972 — callout colado ANTES do --- do D1 não duplica (de-dup determinístico)", () => {
  // Caso real 260609: o box da Clarice (**📣 …**) foi colado na região do D1
  // ANTES do `---` de fechamento. parseDestaques (que fatia em ^---$) absorveu
  // o bloco no why do D1 (corpo quebrado) E extractMidCallout o pegou (box teal)
  // → render 2×. O fix: stripMidCalloutFromD1 remove o bloco antes do parse.
  const MD_MISPLACED = `Para esta edição, selecionamos 15 itens.

---

**DESTAQUE 1 | 🚀 LANÇAMENTO**

**[Título D1](https://example.com/d1)**

Corpo do destaque 1.

Por que isso importa:

Algo importante sobre o D1.

**📣 Escreva melhor com a Clarice.ai. Cupons NEWS25/NEWS50. [Acesse](https://clarice.ai/precos-planos?via=diaria).**

---

**DESTAQUE 2 | 🚀 LANÇAMENTO**

**[Título D2](https://example.com/d2)**

Corpo do destaque 2.
`;

  it("sem strip o callout VAZA pro corpo/why do D1 (demonstra o bug)", () => {
    const raw = parseDestaques(MD_MISPLACED);
    assert.ok(
      raw[0].why.includes("Clarice.ai") || raw[0].body.includes("Clarice.ai"),
      "sem strip, o parser absorve o callout no D1 (bug original)",
    );
  });

  it("stripMidCalloutFromD1 remove o bloco → callout NÃO vaza pro D1", () => {
    const cleaned = stripMidCalloutFromD1(MD_MISPLACED);
    const d = parseDestaques(cleaned);
    assert.ok(!d[0].body.includes("Clarice.ai"), "callout fora do body do D1");
    assert.ok(!d[0].why.includes("Clarice.ai"), "callout fora do why do D1");
  });

  it("extractMidCallout ainda acha o callout no texto original (render 1×)", () => {
    const c = extractMidCallout(MD_MISPLACED);
    assert.ok(c, "callout extraído como midCallout");
    assert.match(c!, /^📣 Escreva melhor com a Clarice\.ai/);
  });

  it("stripMidCalloutFromD1 é idempotente quando o callout já está isolado", () => {
    // Posição correta: callout em sua própria seção entre dois `---`.
    const MD_OK = MD_MISPLACED.replace(
      /Algo importante sobre o D1\.\n\n(\*\*📣[^\n]*\*\*)\n/,
      "Algo importante sobre o D1.\n\n---\n\n$1\n",
    );
    const cleaned = stripMidCalloutFromD1(MD_OK);
    const d = parseDestaques(cleaned);
    assert.ok(!d[0].why.includes("Clarice.ai"), "callout não está no D1 (já isolado)");
    assert.match(extractMidCallout(MD_OK)!, /^📣 Escreva melhor/);
  });

  it("idempotente quando não há callout nenhum (texto inalterado)", () => {
    const semCallout = MD_MISPLACED.replace(/\n\*\*📣[^\n]*\*\*\n/, "\n");
    assert.equal(stripMidCalloutFromD1(semCallout), semCallout);
  });

  it("CRLF: strip não deixa seam órfão (\\r\\n intercalado) nem vaza pro D1", () => {
    // Sob CRLF o `\s*$` do MID_CALLOUT_BLOCK come o `\r` mas para antes do `\n`,
    // deixando o seam `\r\n\r\n\n\r\n` — newlines intercalados com `\r` que um
    // collapse `/\n{3,}/` não casaria. Regressão do collapse `(?:\r?\n){3,}`.
    const crlf = MD_MISPLACED.replace(/\n/g, "\r\n");
    const cleaned = stripMidCalloutFromD1(crlf);
    assert.ok(!/(?:\r?\n){3,}/.test(cleaned), "sem run de 3+ newlines órfão após o strip");
    const d = parseDestaques(cleaned);
    assert.ok(!d[0].body.includes("Clarice.ai"), "callout fora do body do D1 (CRLF)");
    assert.ok(!d[0].why.includes("Clarice.ai"), "callout fora do why do D1 (CRLF)");
    // extractMidCallout ainda acha no original CRLF (render 1×).
    assert.match(extractMidCallout(crlf)!, /^📣 Escreva melhor/);
  });
});
