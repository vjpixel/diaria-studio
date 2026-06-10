/**
 * render-newsletter-fixes-1939-1940-1941.test.ts
 *
 * Regressão dos 3 fixes da PR fix/newsletter-render-1939-1940-1941:
 *  - #1941: título de destaque multi-linha sublinha TODAS as linhas
 *    (text-decoration:underline + teal), não só a última (era border-bottom).
 *  - #1940: separador "Divulgação" antes de bloco patrocinado (📣); ausente
 *    em promo interna (📚).
 *  - #1938 (correlato): renderIntroCallout multi-parágrafo → 1º parágrafo título
 *    serif (emoji removido), demais peso normal; 1 parágrafo mantém negrito.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  renderIntroCallout,
  renderMidCallout,
  isSponsoredCallout,
  extractContent,
  renderHTML,
} from "../scripts/render-newsletter-html.ts";

const EIA_MD = `**É IA?**

Legenda da foto ([fonte](https://commons.wikimedia.org/wiki/x)). [Autor](https://commons.wikimedia.org/wiki/y) / [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0).

Resultado da última edição: 80% das pessoas acertaram.`;

function buildEdition(midCalloutLine: string): string {
  const dir = mkdtempSync(join(tmpdir(), "nl-fixes-"));
  const md = `TÍTULO

Um título de destaque deliberadamente longo que quebra em mais de uma linha no email

SUBTÍTULO

Sub um | Sub dois

---

Para esta edição, eu (o editor) enviei 3 submissões e a Diar.ia encontrou outros 10 artigos. Selecionamos os 5 mais relevantes para as pessoas que assinam a newsletter.

---

**DESTAQUE 1 | 🧠 FRONTEIRA**

**[Um título de destaque deliberadamente longo que quebra em mais de uma linha no email](https://example.com/d1)**

Corpo do destaque um, primeiro parágrafo.

Por que isso importa:

Importa por isso.

---

${midCalloutLine}

---

**DESTAQUE 2 | 💼 TRABALHO**

**[Título D2](https://example.com/d2)**

Corpo do destaque dois.

Por que isso importa:

Importa também.

---

${EIA_MD}

---

**DESTAQUE 3 | 🇧🇷 BRASIL**

**[Título D3](https://example.com/d3)**

Corpo do destaque três.

Por que isso importa:

Importa no Brasil.
`;
  writeFileSync(join(dir, "02-reviewed.md"), md);
  writeFileSync(join(dir, "01-eia.md"), EIA_MD);
  return dir;
}

describe("#1941 — título de destaque sublinha todas as linhas", () => {
  it("headline usa text-decoration:underline + teal, sem border-bottom", () => {
    const dir = buildEdition("**📣 Patrocínio. [Link](https://ex.com).**");
    try {
      const html = renderHTML(extractContent(dir));
      const m = html.match(/<a class="headline"[^>]*style="([^"]*)"/);
      assert.ok(m, "deve haver uma manchete de destaque");
      const style = m![1];
      assert.match(style, /text-decoration:underline/, "deve sublinhar via text-decoration (multi-linha)");
      assert.match(style, /text-decoration-color:#00A0A0/, "underline teal");
      assert.ok(!/border-bottom/.test(style), "não deve mais usar border-bottom (só traça a última linha)");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("#1940 — separador Divulgação antes de bloco patrocinado", () => {
  it("emite kicker 'Divulgação' quando o midCallout começa com 📣", () => {
    const dir = buildEdition("**📣 Escreva melhor com a Clarice.ai\n\nCorpo do anúncio.\n\n[Acesse](https://clarice.ai/x)**");
    try {
      const html = renderHTML(extractContent(dir));
      assert.ok(html.includes("Divulgação"), "deve ter o separador Divulgação");
      // kicker vem ANTES do conteúdo do anúncio
      assert.ok(
        html.indexOf("Divulgação") < html.indexOf("Escreva melhor com a Clarice.ai"),
        "o separador deve vir antes do bloco patrocinado",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("NÃO emite 'Divulgação' para promo interna (📚)", () => {
    const dir = buildEdition("**📚 Nossa curadoria de livros. [Confira](https://livros.diaria.workers.dev).**");
    try {
      const html = renderHTML(extractContent(dir));
      assert.ok(!html.includes("Divulgação"), "promo interna não é anúncio — sem separador");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("#1938 — renderIntroCallout multi-parágrafo segue o DS", () => {
  it("1º parágrafo vira título serif (emoji removido) e corpo fica peso normal", () => {
    const html = renderIntroCallout(
      "📣 Escreva melhor com a Clarice.ai\n\nA única IA criada por brasileiros.\n\n[Acesse e use os cupons](https://clarice.ai/x)",
    );
    // título: serif (Georgia), sem o emoji de marcação
    assert.match(html, /font-family:Georgia[^"]*"[^>]*>Escreva melhor com a Clarice\.ai/, "título serif sem emoji");
    assert.ok(!html.includes("📣"), "emoji de marcação removido do render");
    // corpo: sem negrito (font-weight:600) no parágrafo de corpo
    assert.ok(!/font-weight:600;font-size:16px;line-height:1\.5;[^>]*>A única IA/.test(html), "corpo não deve ser peso 600");
    // link preservado
    assert.ok(html.includes("https://clarice.ai/x"), "link preservado");
  });

  it("callout de 1 parágrafo mantém negrito e emoji (sorteio/intro)", () => {
    const html = renderIntroCallout("🎉 Sorteio ao vivo nesta edição!");
    assert.match(html, /font-weight:600/, "1 parágrafo mantém peso 600");
    assert.ok(html.includes("🎉"), "emoji preservado no callout de 1 parágrafo");
  });
});

// ── Review #1942: endereçando os 4 comentários ────────────────────────

describe("#1942 review #1 — isSponsoredCallout + disclosure em ambos os slots", () => {
  it("isSponsoredCallout: 📣 = patrocinado; 🎉/📚/texto/null = não", () => {
    assert.equal(isSponsoredCallout("📣 Anúncio"), true);
    assert.equal(isSponsoredCallout("🎉 Sorteio"), false);
    assert.equal(isSponsoredCallout("📚 Promo"), false);
    assert.equal(isSponsoredCallout("Texto comum"), false);
    assert.equal(isSponsoredCallout(null), false);
    assert.equal(isSponsoredCallout(undefined), false);
  });

  it("anúncio 📣 na região de intro (topo) também recebe 'Divulgação'", () => {
    const dir = buildEdition("**📚 Promo interna [link](https://x.com).**");
    try {
      const content = extractContent(dir);
      // injeta um introCallout patrocinado no topo
      content.introCallout = "📣 Patrocínio no topo. [Acesse](https://anunciante.com).";
      const html = renderHTML(content);
      assert.ok(html.includes("Divulgação"), "anúncio no topo deve ter disclosure");
      assert.ok(
        html.indexOf("Divulgação") < html.indexOf("Patrocínio no topo"),
        "separador antes do anúncio do topo",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("#1942 review #2 — renderMidCallout com imagem renderiza multi-parágrafo", () => {
  it("corpo multi-parágrafo COM imagem não vira blocão (título serif + 2 parágrafos)", () => {
    const html = renderMidCallout(
      "📣 Título do anúncio\n\nPrimeiro parágrafo do corpo.\n\nSegundo parágrafo. [Acesse](https://anunciante.com)",
      "https://img.example/p.jpg",
    );
    // título serif (FONT_HEADING) sem o marcador 📣
    assert.match(html, /font-family:Georgia[^"]*"[^>]*>Título do anúncio/, "título serif sem 📣");
    assert.ok(!html.includes("📣"), "marcador removido do título");
    // dois parágrafos de corpo (não um <p> só)
    const bodyParas = (html.match(/font-size:16px;line-height:1\.62/g) || []).length;
    assert.ok(bodyParas >= 2, `esperava ≥2 parágrafos de corpo, achou ${bodyParas}`);
  });

  it("corpo de 1 parágrafo COM imagem usa estilo DS body, sem marcador (260611)", () => {
    const html = renderMidCallout(
      "📚 Curadoria de livros. [Confira](https://livros.diaria.workers.dev).",
      "https://img.example/p.jpg",
    );
    assert.ok(!/font-weight:600/.test(html.split("Ver os livros")[0]), "corpo sem bold 600 (imagem já identifica a promo)");
    assert.match(html, /line-height:1\.62/, "corpo usa line-height DS 1.62");
    assert.ok(!html.includes("📚"), "marcador removido");
    assert.ok(html.includes("Ver os livros"), "botão CTA presente");
  });
});

describe("#1942 review #3 — strip do marcador 📣 no callout de 1 parágrafo", () => {
  it("anúncio 📣 de 1 parágrafo remove o emoji (o kicker 'Divulgação' rotula)", () => {
    const html = renderIntroCallout("📣 Escreva melhor com a Clarice.ai. [Acesse](https://clarice.ai/x).");
    assert.ok(!html.includes("📣"), "📣 removido do anúncio de 1 parágrafo");
    assert.ok(html.includes("Escreva melhor com a Clarice.ai"), "texto preservado");
  });
});

describe("#1942 review #4 — stripCalloutMarker não engole '[' de título com link", () => {
  it("título multi-parágrafo começando com link mantém o link vivo", () => {
    const html = renderIntroCallout(
      "[Confira o parceiro](https://parceiro.com) lançou novidade\n\nCorpo do bloco.",
    );
    assert.ok(html.includes('href="https://parceiro.com"'), "link do título sobrevive");
    assert.ok(!html.includes("](https://parceiro.com)"), "markdown cru não vaza");
  });
});
