/**
 * test/site-home-design-tokens-6986.test.ts (#6986)
 *
 * Trava que o `:root` gerado por `buildIndexHtml` bate com
 * `scripts/lib/shared/design-tokens.ts` (`COLORS`) — a fonte canônica dos
 * tokens de cor da marca. Antes desta issue, a home declarava os 4 tokens
 * canônicos como literais hex reescritos à mão no template, e o desvio
 * (`--rule` cinza em vez de bege, `--ink-soft`/`--ink-faint` derivados de um
 * `ink` com canais G/B trocados, pílula `#fff` em vez de `var(--paper)`)
 * passou despercebido justamente porque nada comparava os dois. Este teste
 * lê `COLORS` diretamente (nunca reafirma o hex esperado como literal aqui)
 * pra continuar valendo se a paleta mudar na fonte.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildIndexHtml } from "../scripts/lib/site-home-page.ts";
import { COLORS } from "../scripts/lib/shared/design-tokens.ts";

function extractRoot(html: string): string {
  const match = html.match(/:root\s*\{([\s\S]*?)\}/);
  assert.ok(match, ":root não encontrado no HTML gerado");
  return match![1];
}

function extractVar(root: string, name: string): string {
  const match = root.match(new RegExp(`--${name}:\\s*([^;]+);`));
  assert.ok(match, `--${name} não encontrado dentro de :root`);
  return match![1].trim();
}

function hexToRgbChannels(hex: string): [number, number, number] {
  const clean = hex.replace("#", "");
  return [
    parseInt(clean.slice(0, 2), 16),
    parseInt(clean.slice(2, 4), 16),
    parseInt(clean.slice(4, 6), 16),
  ];
}

describe(":root gerado bate com COLORS (design-tokens.ts) — #6986", () => {
  const html = buildIndexHtml({ feature: null, archive: [] });
  const root = extractRoot(html);

  it("--teal === COLORS.brand", () => {
    assert.equal(extractVar(root, "teal"), COLORS.brand);
  });

  it("--ink === COLORS.ink", () => {
    assert.equal(extractVar(root, "ink"), COLORS.ink);
  });

  it("--paper === COLORS.paper (NUNCA paperEmail — web usa paper, ver docstring de design-tokens.ts)", () => {
    assert.equal(extractVar(root, "paper"), COLORS.paper);
    assert.notEqual(COLORS.paper, COLORS.paperEmail, "sanity: paper e paperEmail devem ser distintos na fonte");
  });

  it("--paper-alt === COLORS.paperAlt", () => {
    assert.equal(extractVar(root, "paper-alt"), COLORS.paperAlt);
  });

  it("--rule === COLORS.rule (bege #EBE5D0, não cinza translúcido)", () => {
    assert.equal(extractVar(root, "rule"), COLORS.rule);
  });

  it("--ink-soft e --ink-faint derivam dos MESMOS canais r,g,b de COLORS.ink", () => {
    const [r, g, b] = hexToRgbChannels(COLORS.ink);
    const inkSoft = extractVar(root, "ink-soft");
    const inkFaint = extractVar(root, "ink-faint");
    assert.equal(inkSoft, `rgba(${r},${g},${b},0.72)`);
    assert.equal(inkFaint, `rgba(${r},${g},${b},0.5)`);
  });

  it(".signup-pill usa var(--paper), nunca #fff literal", () => {
    assert.ok(!/\.signup-pill\s*\{[^}]*#fff/i.test(html), ".signup-pill ainda tem #fff embutido");
    assert.match(html, /\.signup-pill\s*\{[^}]*background:\s*var\(--paper\)/);
  });

  it("nenhum dos 4 tokens canônicos aparece duplicado como hex literal fora de :root", () => {
    // Os valores canônicos só devem aparecer via var(--x) no restante do
    // CSS — não reescritos como hex cru em outro seletor (é exatamente essa
    // duplicação manual que causou o desvio original da #6986).
    const withoutRootBlock = html.replace(/:root\s*\{[\s\S]*?\}/, "");
    for (const hex of [COLORS.brand, COLORS.ink, COLORS.paper, COLORS.paperAlt, COLORS.rule]) {
      assert.ok(
        !withoutRootBlock.toLowerCase().includes(hex.toLowerCase()),
        `hex ${hex} reaparece fora de :root — deveria ser referenciado via var(--x)`,
      );
    }
  });
});
