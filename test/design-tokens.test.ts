/**
 * test/design-tokens.test.ts (#1936)
 *
 * Trava os tokens canônicos do design system (vjpixel/diaria-design) e garante
 * que os 3 renderers de email os aplicam — guard de drift. O arco de design de
 * 2026-06 derivou da extração antiga do canvas (Newsreader/#F4EFE2/system-ui),
 * que DIVERGE do DS canônico (Georgia/#FBFAF6/Geist). Este teste evita a volta
 * dos valores ad-hoc.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { COLORS, FONTS, RULE_ACCENT } from "../scripts/lib/design-tokens.ts";
import { renderHTML } from "../scripts/render-newsletter-html.ts";
import { draftToEmail } from "../scripts/publish-monthly.ts";

describe("design-tokens — valores canônicos (vjpixel/diaria-design)", () => {
  it("COLORS espelha tokens/colors.css (paleta de 4 cores)", () => {
    assert.equal(COLORS.brand, "#00A0A0"); // --brand (teal)
    assert.equal(COLORS.ink, "#171411"); // --ink
    assert.equal(COLORS.paper, "#FBFAF6"); // --paper
    assert.equal(COLORS.paperAlt, "#EBE5D0"); // --paper-alt / --brand-tint
    assert.equal(COLORS.rule, "#EBE5D0"); // --rule (hairline bege)
    assert.equal(COLORS.ruleStrong, "#171411"); // --rule-strong
    assert.equal(COLORS.onInk, "#FBFAF6"); // --on-ink
  });

  it("FONTS espelha tokens/typography.css — serif Georgia (email-safe), sans Geist", () => {
    assert.equal(FONTS.serif, "Georgia, 'Times New Roman', serif");
    assert.match(FONTS.sans, /^'Geist',/);
    assert.match(FONTS.mono, /^'Geist Mono',/);
  });

  it("RULE_ACCENT = teal (decisão editorial #1936: réguas no brand, não no --rule bege)", () => {
    assert.equal(RULE_ACCENT, COLORS.brand);
  });
});

const baseDestaque = {
  n: 1 as const,
  category: "RISCO",
  title: "Modelos se replicam sozinhos",
  body: "Parágrafo 1.\nParágrafo 2.",
  why: "Por que importa.",
  url: "https://example.com/d1",
  emoji: "⚠️",
  imageFile: "04-d1-2x1.jpg",
};
const dailyFixture = {
  title: "Edição teste",
  subtitle: "Teste",
  coverImage: "04-d1-2x1.jpg",
  destaques: [baseDestaque],
  eia: { credit: "Foto: x.", imageA: "01-eia-A.jpg", imageB: "01-eia-B.jpg", edition: "260999" },
  sections: [],
};

describe("diária — render-newsletter-html aplica os tokens canônicos", () => {
  const html = renderHTML(dailyFixture);

  it("usa serif Georgia + ink #171411 + acento teal #00A0A0", () => {
    assert.match(html, /Georgia, 'Times New Roman', serif/);
    assert.match(html, /#171411/);
    assert.match(html, /#00A0A0/);
  });

  it("não vaza valores ad-hoc da extração antiga do canvas", () => {
    assert.doesNotMatch(html, /Newsreader/);
    assert.doesNotMatch(html, /#F4EFE2/i); // paper antigo
    assert.doesNotMatch(html, /#6E6A60/i); // cinza muted antigo
    assert.doesNotMatch(html, /#E0D9C4/i); // régua bege antiga
    assert.doesNotMatch(html, /#f0fafa/i); // box É IA? teal-tint ad-hoc
  });
});

const MONTHLY_DRAFT = `**ASSUNTO**

1. Diar.ia | Teste

**PREVIEW**

Preview do teste.

**INTRO**

Resumo do mês de teste.

**DESTAQUE 1 | ANTHROPIC**

Título do destaque

Parágrafo um do destaque com um [link](https://example.com).

Parágrafo final do destaque.
`;

describe("mensal — monthly-render aplica os tokens canônicos", () => {
  const { html } = draftToEmail(MONTHLY_DRAFT, null, "2605");

  it("usa serif Georgia + sans Geist + papel #FBFAF6 + ink #171411 + teal #00A0A0", () => {
    assert.match(html, /Georgia, 'Times New Roman', serif/);
    assert.match(html, /'Geist',/);
    assert.match(html, /#FBFAF6/);
    assert.match(html, /#171411/);
    assert.match(html, /#00A0A0/);
  });

  it("não vaza valores ad-hoc (ink #1a1a1a, cinzas, Arial, shell #f2f2f2)", () => {
    assert.doesNotMatch(html, /#1a1a1a/i);
    assert.doesNotMatch(html, /Arial/);
    assert.doesNotMatch(html, /#f2f2f2/i);
    assert.doesNotMatch(html, /#444\b/);
    assert.doesNotMatch(html, /Newsreader/);
  });
});
