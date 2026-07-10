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
  it("emite kicker 'Divulgação' quando o boxDivulgacao1 começa com 📣", () => {
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

  it("promo interna (📚) no mid TAMBÉM recebe '● Divulgação' (260611, supersede #1940)", () => {
    const dir = buildEdition("**📚 Nossa curadoria de livros. [Confira](https://livros.diaria.workers.dev).**");
    try {
      const html = renderHTML(extractContent(dir));
      assert.ok(html.includes("Divulgação"), "todo boxDivulgacao1 ganha o kicker Divulgação");
      assert.ok(html.indexOf("Divulgação") < html.indexOf("curadoria de livros"), "kicker antes do box");
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
  it("isSponsoredCallout (#3232, marcador-agnóstico): detecta por link de afiliado (?via=/tag=), não pelo emoji 📣", () => {
    // Link de afiliado presente → patrocinado, COM ou SEM o marcador 📣.
    assert.equal(isSponsoredCallout("📣 Anúncio. [Acesse](https://ex.com/x?via=diaria)"), true);
    assert.equal(
      isSponsoredCallout("Anúncio SEM emoji nenhum, mas com link de afiliado. [Acesse](https://ex.com/x?tag=abc123)"),
      true,
      "marcador-agnóstico: link de afiliado basta, mesmo sem 📣",
    );
    // Emoji 📣 sozinho, SEM link de afiliado, não basta mais.
    assert.equal(
      isSponsoredCallout("📣 Anúncio sem link de afiliado nenhum"),
      false,
      "emoji sozinho não é mais suficiente — precisa do link de afiliado",
    );
    assert.equal(isSponsoredCallout("🎉 Sorteio"), false);
    assert.equal(isSponsoredCallout("📚 Promo"), false);
    assert.equal(isSponsoredCallout("Texto comum"), false);
    assert.equal(isSponsoredCallout(null), false);
    assert.equal(isSponsoredCallout(undefined), false);
  });

  it("kicker '● DIVULGAÇÃO' antes do boxDivulgacao1 não-patrocinado (📚) — 260611 v2", () => {
    const dir = buildEdition("**📚 Promo interna [link](https://x.com).**");
    try {
      const html = renderHTML(extractContent(dir));
      const boxIdx = html.indexOf("Promo interna");
      assert.ok(boxIdx > -1, "box renderizado");
      const kickerIdx = html.lastIndexOf("Divulgação", boxIdx);
      assert.ok(kickerIdx > -1 && kickerIdx > html.indexOf("Importa por isso."), "kicker Divulgação entre D1 e o box");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("boxDivulgacao1 patrocinado (📣) mantém o kicker Divulgação (com régua própria), sem régua dupla", () => {
    const dir = buildEdition("**📣 Anúncio pago [link](https://x.com).**");
    try {
      const html = renderHTML(extractContent(dir));
      const boxIdx = html.indexOf("Anúncio pago");
      const between = html.slice(html.indexOf("Importa por isso."), boxIdx);
      assert.ok(between.includes("Divulgação"), "kicker Divulgação presente antes do anúncio");
      const naked = (between.match(/<tr><td class="pad"[^>]*><table[^>]*><tr><td style="border-bottom:1px solid/g) || []).length;
      assert.equal(naked, 0, "sem régua simples extra além do kicker");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("anúncio com link de afiliado na região de intro (topo) também recebe 'Divulgação' — mesmo sem marcador 📣 (#3232)", () => {
    const dir = buildEdition("**📚 Promo interna [link](https://x.com).**");
    try {
      const content = extractContent(dir);
      // injeta um introCallout patrocinado no topo — sem marcador 📣, detectado
      // pelo link de afiliado (?via=), marcador-agnóstico (#3232).
      content.introCallout = "Patrocínio no topo, sem emoji de marcação. [Acesse](https://anunciante.com/?via=diaria).";
      const html = renderHTML(content);
      assert.ok(html.includes("Divulgação"), "anúncio no topo deve ter disclosure (via link de afiliado)");
      assert.ok(
        html.indexOf("Divulgação") < html.indexOf("Patrocínio no topo"),
        "separador antes do anúncio do topo",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("#260701: patrocinado (link de afiliado) multi-parágrafo no intro mantém título serif 26px (não body 16px)", () => {
    const dir = buildEdition("**📚 Promo interna [link](https://x.com).**");
    try {
      const content = extractContent(dir);
      // patrocinado multi-parágrafo no slot do intro (via link de afiliado,
      // #3232): NÃO deve cair no titleStyle="body"
      content.introCallout =
        "📣 Patrocínio no topo\n\nCorpo do anúncio aqui.\n\n[Acesse](https://anunciante.com/?via=diaria)";
      const html = renderHTML(content);
      const idx = html.indexOf("Patrocínio no topo");
      assert.ok(idx > -1, "título do anúncio presente");
      // o <p> do título (antes do texto) deve ter 26px serif, não 16px
      const titleP = html.slice(html.lastIndexOf("<p", idx), idx);
      assert.match(titleP, /font-size:26px/, "patrocinado mantém título 26px serif");
      assert.doesNotMatch(titleP, /font-size:16px/, "patrocinado NÃO regride pra 16px");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("#3232: patrocinado (link de afiliado) SEM marcador emoji nenhum também mantém título serif 26px", () => {
    const dir = buildEdition("**📚 Promo interna [link](https://x.com).**");
    try {
      const content = extractContent(dir);
      content.introCallout =
        "Patrocínio sem emoji\n\nCorpo do anúncio aqui.\n\n[Acesse](https://anunciante.com/?tag=abc123)";
      const html = renderHTML(content);
      const idx = html.indexOf("Patrocínio sem emoji");
      assert.ok(idx > -1, "título do anúncio presente");
      const titleP = html.slice(html.lastIndexOf("<p", idx), idx);
      assert.match(titleP, /font-size:26px/, "patrocinado sem emoji ainda mantém título 26px serif (detecção por link)");
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

  // Teste canônico de single-parágrafo COM imagem em render-newsletter-midcallout.test.ts
  // (removido daqui para evitar duplicata — #2067 Point 3).
});

describe("#1942 review #3 — strip do marcador 📣 no callout de 1 parágrafo", () => {
  it("anúncio 📣 de 1 parágrafo (com link de afiliado, patrocinado) remove o emoji (o kicker 'Divulgação' rotula)", () => {
    // #3232: a decisão de stripar o marcador no caminho de 1 parágrafo é
    // gated por `sponsored` (isSponsoredCallout), que agora depende do link
    // de afiliado — não basta mais o emoji 📣 sozinho (ver review #1 acima).
    // URL real da Clarice (com ?via=) preserva o comportamento de produção.
    const html = renderIntroCallout("📣 Escreva melhor com a Clarice.ai. [Acesse](https://clarice.ai/precos-planos?via=diaria).");
    assert.ok(!html.includes("📣"), "📣 removido do anúncio de 1 parágrafo");
    assert.ok(html.includes("Escreva melhor com a Clarice.ai"), "texto preservado");
  });

  it("#3232: SEM link de afiliado, o marcador 📣 de 1 parágrafo NÃO é mais removido (cosmético, item 2 do #3232)", () => {
    // Documenta a mudança de contrato: como `stripCalloutMarker` no caminho
    // de 1 parágrafo é condicional a `sponsored`, e `sponsored` agora exige
    // link de afiliado, um 📣 "solto" (sem link de afiliado real) deixa de
    // ser stripado — cosmético, não silent-drop (nenhum conteúdo se perde).
    const html = renderIntroCallout("📣 Anúncio sem link de afiliado nenhum.");
    assert.ok(html.includes("📣"), "sem link de afiliado, marcador fica visível (cosmético)");
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
