/**
 * test/arrow-glyph-residuos-9735.test.ts (#9735 itens 1, 2 e 4, regressão #633)
 *
 *  1. Número em negrito/itálico MARKDOWN antes da seta (`**5,4%** → [18%](u)`)
 *     não era reconhecido como transição: virava `**5,4%**: [18%](u)` nos
 *     callouts (que recebem markdown), invertendo o sentido.
 *  2. Rótulo de link que só COMEÇA com dígito (`Passo 1 → [2026: o ano](u)`)
 *     virava `para`, mudando o sentido em silêncio — também no HTML inteiro
 *     via `renderHTML` (`<a>10 ferramentas</a>`).
 *  4. `stripCtaArrows` sozinho, com dois espaços antes da seta, numa
 *     transição numérica (`5,4%  → [18%](u)`) virava `5,4% : [18%](u)`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeNumericArrows, stripCtaArrows, normalizeArrowsForSite } from "../scripts/lib/shared/arrow-glyph.ts";
import { renderIntroCallout } from "../scripts/lib/newsletter-render-html.ts";

describe("#9735 item 1: número com ênfase markdown antes da seta", () => {
  const CASES: Array<[string, string]> = [
    ["**5,4%** → [18%](https://x.y/a)", "**5,4%** para [18%](https://x.y/a)"],
    ["_5,4%_ → [18%](https://x.y/a)", "_5,4%_ para [18%](https://x.y/a)"],
    ["*5,4%* → 18%", "*5,4%* para 18%"],
    ["__US$ 20__ → [US$ 10](https://x.y/b)", "__US$ 20__ para [US$ 10](https://x.y/b)"],
  ];
  for (const [input, expected] of CASES) {
    it(`REGRESSÃO: ${input}`, () => {
      assert.equal(normalizeNumericArrows(input), expected);
      assert.equal(stripCtaArrows(normalizeNumericArrows(input)), expected);
      // stripCtaArrows sozinho também não converte em lead-in (`:`)
      assert.ok(!stripCtaArrows(input).includes("**:") && !/[%_*]: \[/.test(stripCtaArrows(input)), stripCtaArrows(input));
    });
  }

  it("callout (markdown) não inverte o sentido", () => {
    const html = renderIntroCallout("A taxa foi de **5,4%** → [18%](https://x.y/a) em um ano.");
    assert.ok(!html.includes("→"), html);
    assert.ok(/5,4%.*para.*18%/.test(html.replace(/<[^>]+>/g, "")), html);
  });
});

describe("#9735 item 2: rótulo de link que só começa com dígito não é transição", () => {
  const MD: Array<[string, string]> = [
    ["Passo 1 → [2026: o ano](https://x.y/a)", "Passo 1: [2026: o ano](https://x.y/a)"],
    ["Top 5 → [10 ferramentas](https://x.y/b)", "Top 5: [10 ferramentas](https://x.y/b)"],
    ["Edição 260 → [261 dias depois](https://x.y/c)", "Edição 260: [261 dias depois](https://x.y/c)"],
  ];
  for (const [input, expectedCta] of MD) {
    it(`REGRESSÃO normalizeNumericArrows não mexe: ${input}`, () => {
      assert.equal(normalizeNumericArrows(input), input);
    });
    it(`REGRESSÃO em CTA vira lead-in: ${input}`, () => {
      assert.equal(stripCtaArrows(normalizeNumericArrows(input)), expectedCta);
    });
  }

  it("REGRESSÃO HTML: `<a>10 ferramentas</a>` não vira 'para'", () => {
    const html = 'Top 5 → <a href="u">10 ferramentas</a>';
    assert.equal(normalizeNumericArrows(html), html);
  });

  it("site: rótulo não numérico cai no passe genérico (meia-risca), não em 'para'", () => {
    assert.equal(normalizeArrowsForSite('Top 5 → <a href="u">10 ferramentas</a>'), 'Top 5 – <a href="u">10 ferramentas</a>');
  });

  it("transição numérica de verdade segue virando 'para'", () => {
    const OK: Array<[string, string]> = [
      ["5,4% → [18%](u)", "5,4% para [18%](u)"],
      ["US$ 20 → [US$ 10](u)", "US$ 20 para [US$ 10](u)"],
      ["5 → [-3](u)", "5 para [-3](u)"],
      ['5,4% → <a href="u">18%</a>', '5,4% para <a href="u">18%</a>'],
      ["US$ 20 → <a><b>US$ 10</b></a>", "US$ 20 para <a><b>US$ 10</b></a>"],
      ["5,4% → <b>18%</b>", "5,4% para <b>18%</b>"],
      ["5,4% → 18%", "5,4% para 18%"],
      ["1.234 → [2.345](u)", "1.234 para [2.345](u)"],
    ];
    for (const [input, expected] of OK) assert.equal(normalizeNumericArrows(input), expected, input);
  });
});

describe("#9735 item 4: stripCtaArrows sozinho com dois espaços antes da seta", () => {
  it("REGRESSÃO: `5,4%  → [18%](u)` não vira `5,4% : [18%](u)`", () => {
    const out = stripCtaArrows("5,4%  → [18%](https://x.y/a)");
    assert.ok(!out.includes(" : "), out);
    assert.ok(!out.includes("%:"), out);
  });

  it("lead-in com dois espaços depois de texto não numérico continua virando ':'", () => {
    assert.equal(stripCtaArrows("Veja o ranking  → [aqui](u)"), "Veja o ranking: [aqui](u)");
  });
});
