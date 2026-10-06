/**
 * test/arrow-leadin-cta-digit-9731.test.ts (#9731, regressão #633)
 *
 * Bug: a regra de lead-in de CTA de `stripCtaArrows` (`texto → [link](u)`
 * vira `texto: [link](u)`) pulava a conversão sempre que o texto ANTES da
 * seta terminava em dígito ou `%` (lookbehind), mesmo com rótulo de link não
 * numérico. `Use o cupom NEWS50 → [Assine](u)`, `Leia as 3 → [dicas](u)` e
 * `Retrospectiva 2025 → [Leia](u)` saíam com a seta crua no e-mail (callouts,
 * caixas de `data/snippets/`), e `normalizeNumericArrows` também não pegava
 * (o alvo não é número).
 *
 * Fix: só pula quando é transição numérica de verdade, número dos DOIS lados
 * (`5,4% → [18%](u)`), que segue virando `para`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractContent } from "../scripts/lib/newsletter-parse.ts";
import { renderHTML, renderIntroCallout, renderMidCallout } from "../scripts/lib/newsletter-render-html.ts";
import { readSnippetFile } from "../scripts/lib/shared/snippet-loader.ts";
import { ARROW_GLYPH, normalizeNumericArrows, stripCtaArrows } from "../scripts/lib/shared/arrow-glyph.ts";

const SEM_TAGS = (html: string): string => html.replace(/<[^>]+>/g, "");

const LEADIN_DIGITO: Array<[string, string]> = [
  ["Use o cupom NEWS50 → [Assine](https://x.y/a)", "Use o cupom NEWS50: [Assine](https://x.y/a)"],
  ["Leia as 3 → [dicas](https://x.y/b)", "Leia as 3: [dicas](https://x.y/b)"],
  ["Retrospectiva 2025 → [Leia](https://x.y/c)", "Retrospectiva 2025: [Leia](https://x.y/c)"],
  ['Retrospectiva 2025 → <a href="u">Leia</a>', 'Retrospectiva 2025: <a href="u">Leia</a>'],
  ["Ganhe 50% → [assine](https://x.y/d)", "Ganhe 50%: [assine](https://x.y/d)"],
];

describe("#9731 stripCtaArrows: lead-in depois de dígito com alvo não numérico", () => {
  for (const [input, expected] of LEADIN_DIGITO) {
    it(`REGRESSÃO: ${input}`, () => {
      assert.equal(stripCtaArrows(input), expected);
      assert.equal(stripCtaArrows(normalizeNumericArrows(input)), expected);
    });
  }

  it("transição numérica (número dos dois lados) não vira lead-in; normalizeNumericArrows a faz 'para'", () => {
    const casos: Array<[string, string]> = [
      ["5,4% → [18%](u)", "5,4% para [18%](u)"],
      ["US$ 20 → [US$ 10](u)", "US$ 20 para [US$ 10](u)"],
      ["de 3 → [R$ 5](u)", "de 3 para [R$ 5](u)"],
      ['5,4% → <a href="x">18%</a>', '5,4% para <a href="x">18%</a>'],
      ['5,4% → <a href="x"><b>18%</b></a>', '5,4% para <a href="x"><b>18%</b></a>'],
    ];
    for (const [input, expected] of casos) {
      assert.equal(stripCtaArrows(input), input, input);
      assert.equal(stripCtaArrows(normalizeNumericArrows(input)), expected, input);
    }
  });

  it("alvo numérico sem número antes continua lead-in (não deixa a seta crua)", () => {
    assert.equal(stripCtaArrows("Veja → [2026 em revisão](u)"), "Veja: [2026 em revisão](u)");
  });

  it("casos da #9727 seguem iguais", () => {
    assert.equal(stripCtaArrows("apoiar → [apoia.se](https://apoia.se/diaria)"), "apoiar: [apoia.se](https://apoia.se/diaria)");
    assert.equal(stripCtaArrows("de 5% → [18%](https://x.y)"), "de 5% → [18%](https://x.y)");
    assert.equal(stripCtaArrows("[A](https://a.b) · → [B](https://c.d)"), "[A](https://a.b) · [B](https://c.d)");
  });

  it("idempotente", () => {
    for (const [input] of LEADIN_DIGITO) {
      const once = stripCtaArrows(normalizeNumericArrows(input));
      assert.equal(stripCtaArrows(normalizeNumericArrows(once)), once);
    }
  });
});

describe("#9731 callouts ponta a ponta", () => {
  it("renderIntroCallout e renderMidCallout não deixam a seta crua", () => {
    for (const [input] of LEADIN_DIGITO.filter(([i]) => i.includes("]("))) {
      for (const html of [renderIntroCallout(input), renderMidCallout(input, null), renderMidCallout(input, "https://img.x/y.png")]) {
        assert.ok(!html.includes(ARROW_GLYPH), html);
      }
    }
    assert.match(SEM_TAGS(renderIntroCallout("Use o cupom NEWS50 → [Assine](https://x.y/a)")), /NEWS50: Assine/);
    assert.match(SEM_TAGS(renderIntroCallout("Antes 5,4% → [18%](https://x.y/n)")), /5,4% para 18%/);
  });

  it("renderHTML: caixa de divulgação com lead-in após dígito vira dois-pontos", () => {
    const BOX = `Apoie a diar.ia.br

Use o cupom NEWS50 → [Assine](https://x.y/a)`;
    const EIA = `**É IA?**

Foto teste. [Autor](https://example.com/a) / CC.

Resultado da última edição: 40% das pessoas acertaram.
`;
    const destaque = (n: number, cat: string) => `**DESTAQUE ${n} | ${cat}**

**[Título D${n}](https://example.com/d${n})**

Corpo do destaque ${n}.

Por que isso importa:

Why do D${n}.`;
    const md = `TÍTULO

Gemini sobe

SUBTÍTULO

Sub um | Sub dois

---

Para esta edição, selecionamos 12 itens.

---

${destaque(1, "🚀 LANÇAMENTO")}

---

${BOX}

---

${destaque(2, "💼 MERCADO")}

---

${destaque(3, "💼 TRABALHO")}

---

${EIA}
`;
    const dir = mkdtempSync(join(tmpdir(), "ed-9731-"));
    try {
      writeFileSync(join(dir, "02-reviewed.md"), md, "utf8");
      writeFileSync(join(dir, "01-eia.md"), EIA, "utf8");
      const html = renderHTML(extractContent(dir));
      assert.match(SEM_TAGS(html), /NEWS50: Assine/);
      assert.ok(!html.includes(ARROW_GLYPH));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("#9731 readSnippetFile (caixas de data/snippets/)", () => {
  it("lead-in após dígito vira dois-pontos e transição numérica vira 'para'", () => {
    const root = mkdtempSync(join(tmpdir(), "snip-9731-"));
    try {
      mkdirSync(join(root, "data", "snippets"), { recursive: true });
      writeFileSync(
        join(root, "data", "snippets", "box.md"),
        "<!-- header -->\nRetrospectiva 2025 → [Leia](https://x.y/c)\n\nCaiu de 5,4% → [18%](https://x.y/n)\n",
        "utf8",
      );
      const out = readSnippetFile("box.md", root);
      assert.equal(out, "Retrospectiva 2025: [Leia](https://x.y/c)\n\nCaiu de 5,4% para [18%](https://x.y/n)");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
