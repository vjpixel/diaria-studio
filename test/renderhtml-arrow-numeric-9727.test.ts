/**
 * test/renderhtml-arrow-numeric-9727.test.ts (#9727, regressão #633)
 *
 * Bug: `renderHTML` (newsletter) passava o HTML INTEIRO por `stripCtaArrows`,
 * cuja regra de lead-in de CTA (`texto → <a>` vira `texto: <a>`) também
 * pegava o corpo editorial dos destaques:
 *   `Antes 5,4% → <a>18%</a>`  virava `Antes 5,4%: <a>18%</a>`
 *   `US$ 20 → <a>US$ 10</a>`   virava `US$ 20: US$ 10`
 *   `A Meta → <a>Llama</a>`    virava `A Meta: Llama`
 * O sentido muda (transição vira aposição) no e-mail, e a página `/p/` é
 * feita do `newsletter-final.html` já estragado, então a proteção numérica
 * de `normalizeArrowsForSite` nunca via a seta.
 *
 * Resultado esperado (escolhido no fix):
 *  - transição numérica vira `para` no e-mail E na página
 *    (`5,4% para <a>18%</a>`, `US$ 20 para <a>US$ 10</a>`), que é como o
 *    português lê a notação e é o mesmo passo que o site já usava;
 *  - seta editorial não numérica antes de link (`A Meta → <a>Llama</a>`)
 *    fica INTACTA no e-mail (seta editorial no corpo é permitida, #9721) e
 *    vira meia-risca na página (`A Meta – Llama`, o backstop do site que não
 *    aceita seta nenhuma). Em nenhum dos dois vira `A Meta: Llama`;
 *  - o lead-in de CTA continua virando dois-pontos, mas só dentro de bloco
 *    de CTA conhecido (caixa de divulgação / callout).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractContent } from "../scripts/lib/newsletter-parse.ts";
import { isCtaOnlyParagraph, renderHTML } from "../scripts/lib/newsletter-render-html.ts";
import { publishEditionSitePage, readEditionInputs, type PublishPageDeps } from "../scripts/publish-edition-site-page.ts";
import { scanPublishedText } from "../scripts/lib/no-arrow-glyph-scan.ts";
import {
  ARROW_GLYPH,
  findArrowGlyphs,
  normalizeArrowsForSite,
  normalizeNumericArrows,
  stripCtaArrows,
  stripUnambiguousCtaArrows,
} from "../scripts/lib/shared/arrow-glyph.ts";

const EIA = `**É IA?**

Foto teste. [Autor](https://example.com/a) / CC.

Resultado da última edição: 40% das pessoas acertaram.
`;

const BODY_D1 = [
  "Antes 5,4% → [18%](https://example.com/n1) do tráfego.",
  "O plano caiu de US$ 20 → [US$ 10](https://example.com/n2) por mês.",
  "A Meta → [Llama](https://example.com/n3) é a aposta aberta.",
  // #9749: seta depois de tag de FECHAMENTO (negrito, link) é editorial
  "Do **Google** → [Gemini](https://example.com/n4) em um ano.",
  "Primeiro [Sora](https://example.com/n5) → [Veo](https://example.com/n6) depois.",
].join(" ");

const BOX = `Apoie a diar.ia.br

Quer ajudar a manter a newsletter? apoiar → [apoia.se](https://apoia.se/diaria)`;

function reviewed(): string {
  return `TÍTULO

Gemini sobe

SUBTÍTULO

Sub um | Sub dois

---

Para esta edição, selecionamos 12 itens.

---

**DESTAQUE 1 | 🚀 LANÇAMENTO**

**[Título D1](https://example.com/d1)**

${BODY_D1}

Por que isso importa:

Why do D1.

---

${BOX}

---

**DESTAQUE 2 | 💼 MERCADO**

**[Título D2](https://example.com/d2)**

Corpo do destaque 2.

Por que isso importa:

Why do D2.

---

**DESTAQUE 3 | 💼 TRABALHO**

**[Título D3](https://example.com/d3)**

Corpo do destaque 3.

Por que isso importa:

Why do D3.

---

${EIA}
`;
}

function withEdition<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "ed-9727-"));
  try {
    writeFileSync(join(dir, "02-reviewed.md"), reviewed(), "utf8");
    writeFileSync(join(dir, "01-eia.md"), EIA, "utf8");
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const SEM_TAGS = (html: string): string => html.replace(/<[^>]+>/g, "");

describe("#9727 renderHTML: seta antes de link no corpo editorial não vira ': '", () => {
  it("REGRESSÃO: os 3 exemplos da issue mantêm o sentido no e-mail", () => {
    const html = withEdition((dir) => renderHTML(extractContent(dir)));
    const text = SEM_TAGS(html);
    assert.match(text, /Antes 5,4% para 18% do tráfego/);
    assert.match(text, /US\$ 20 para US\$ 10 por mês/);
    assert.match(text, /A Meta → Llama é a aposta aberta/);
    assert.doesNotMatch(text, /5,4%: |US\$ 20: |A Meta: /);
  });

  it("lead-in dentro da caixa de divulgação (bloco de CTA) continua virando dois-pontos", () => {
    const html = withEdition((dir) => renderHTML(extractContent(dir)));
    assert.match(SEM_TAGS(html), /apoiar: apoia\.se/);
  });

  it("ponta a ponta: newsletter-final.html (renderHTML) → publish da página /p/ não inverte o sentido", () => {
    withEdition((dir) => {
      mkdirSync(join(dir, "_internal"), { recursive: true });
      // no fluxo real o Stage 4 troca `{{IMG:…}}` pela URL pública antes de
      // gravar o newsletter-final.html; aqui a troca é sintética
      const finalHtml = renderHTML(extractContent(dir)).replace(/\{\{IMG:([^}]+)\}\}/g, "https://img.example.com/$1");
      writeFileSync(join(dir, "_internal", "newsletter-final.html"), finalHtml, "utf8");
      const escritas: string[] = [];
      const deps: PublishPageDeps = {
        readEditionInputs: (d) => readEditionInputs(d, "gemini-sobe"),
        writePage: (_slug, html) => void escritas.push(html),
        publish: () => ({ pushed: true, prUrl: "https://github.com/x/y/pull/1", prNumber: 1, prCreated: true }),
        log: () => {},
      };
      const r = publishEditionSitePage(dir, deps, { skipPublish: true });
      assert.equal(r.code, 0, JSON.stringify(r));
      assert.equal(escritas.length, 1);
      const page = escritas[0];
      const text = SEM_TAGS(page);
      assert.match(text, /Antes 5,4% para 18% do tráfego/);
      assert.match(text, /US\$ 20 para US\$ 10 por mês/);
      assert.match(text, /A Meta – Llama é a aposta aberta/);
      assert.doesNotMatch(text, /5,4%: |US\$ 20: |A Meta: /);
      // e a página continua passando no check de CI
      assert.deepEqual(scanPublishedText("workers/site/public/p/gemini-sobe/index.html", page, []), []);
    });
  });
});

describe("#9749 seta depois de tag de fechamento não cola palavras", () => {
  it("REGRESSÃO: stripUnambiguousCtaArrows só tira a seta logo após tag de ABERTURA", () => {
    // os 2 casos da issue
    assert.equal(
      stripUnambiguousCtaArrows('<p><strong>Meta</strong> → <a href="u">Llama</a></p>'),
      '<p><strong>Meta</strong> → <a href="u">Llama</a></p>',
    );
    assert.equal(
      stripUnambiguousCtaArrows('<a href="u">A</a> → <a href="v">B</a>'),
      '<a href="u">A</a> → <a href="v">B</a>',
    );
    assert.equal(stripUnambiguousCtaArrows("</em> → [B](u)"), "</em> → [B](u)");
    // o caso legítimo (prefixo logo após abrir a tag) continua sendo removido
    assert.equal(stripUnambiguousCtaArrows('<p style="x">→ <a href="u">Ver</a></p>'), '<p style="x"><a href="u">Ver</a></p>');
    assert.equal(stripUnambiguousCtaArrows("<p>→ [Ver](u)</p>"), "<p>[Ver](u)</p>");
    assert.equal(stripUnambiguousCtaArrows('<P CLASS="x">→ <a href="u">Ver</a></P>'), '<P CLASS="x"><a href="u">Ver</a></P>');
  });

  it("e-mail (renderHTML) mantém a seta editorial e a página /p/ vira meia-risca, sem colar palavras", () => {
    const text = SEM_TAGS(withEdition((dir) => renderHTML(extractContent(dir))));
    assert.match(text, /Do Google → Gemini em um ano/);
    assert.match(text, /Primeiro Sora → Veo depois/);
    assert.doesNotMatch(text, /GoogleGemini|SoraVeo/);
    const site = SEM_TAGS(normalizeArrowsForSite('<p><strong>Meta</strong> → <a href="u">Llama</a></p>'));
    assert.equal(site, "Meta – Llama");
  });
});

describe("#9727 passos compartilhados de arrow-glyph", () => {
  it("normalizeNumericArrows é o passo usado pelos dois caminhos e é idempotente", () => {
    const s = 'Antes 5,4% → <a href="x">18%</a>; US$ 20 → <a href="y">US$ 10</a>';
    const once = normalizeNumericArrows(s);
    assert.equal(once, 'Antes 5,4% para <a href="x">18%</a>; US$ 20 para <a href="y">US$ 10</a>');
    assert.equal(normalizeNumericArrows(once), once);
    assert.equal(normalizeArrowsForSite(s), once);
  });

  it("stripCtaArrows não trata transição numérica como lead-in", () => {
    const s = "de 5% → [18%](https://x.y)";
    assert.equal(stripCtaArrows(s), s);
  });

  it("resíduo c: seta depois de separador só some (sem virar '·:'), e o parágrafo segue só-CTA", () => {
    const p = "[A](https://a.b) · → [B](https://c.d)";
    const clean = stripCtaArrows(p);
    assert.equal(clean, "[A](https://a.b) · [B](https://c.d)");
    assert.ok(isCtaOnlyParagraph(clean));
    // e o caso `·:` legado (já convertido por versão anterior) também é só-CTA
    assert.ok(isCtaOnlyParagraph("[A](https://a.b) ·: [B](https://c.d)"));
  });

  it("resíduo a: formas escapadas da seta são detectadas e normalizadas", () => {
    for (const form of ["&rarr;", "&RARR;", "&#8594;", "&#x2192;", "&#X2192;", "\\u2192", "\\u{2192}"]) {
      assert.equal(findArrowGlyphs(`<a>Ver ${form}</a>`).length, 1, form);
    }
    assert.equal(stripCtaArrows("<a>Ver &rarr;</a>"), "<a>Ver</a>");
    assert.equal(normalizeArrowsForSite("87% &#8594; 68%"), "87% para 68%");
    assert.ok(!normalizeArrowsForSite("A &#x2192; B").includes(ARROW_GLYPH));
    // allowlist por trecho exato vale também para a forma escapada
    assert.equal(findArrowGlyphs("x 87% &rarr; 68% y", ["87% &rarr; 68%"]).length, 0);
  });
});
