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
import { COLORS, FONTS, BOX } from "../scripts/lib/design-tokens.ts";
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

  it("BOX espelha guidelines/boxes.html — contorno (papel+rule) e painel (paperAlt); sem teal estrutural", () => {
    assert.equal(BOX.contornoBg, COLORS.paper); // #FBFAF6
    assert.equal(BOX.contornoBorder, COLORS.rule); // #EBE5D0 bege
    assert.equal(BOX.painelBg, COLORS.paperAlt); // #EBE5D0 bege filled
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

  it("serif Georgia em título + corpo sans Geist + ink + teal só em acento", () => {
    assert.match(html, /Georgia, 'Times New Roman', serif/); // títulos
    assert.match(html, /'Geist',/); // corpo/labels sans
    assert.match(html, /#171411/);
    assert.match(html, /#00A0A0/); // kickers/links
  });

  it("réguas são bege #EBE5D0, não teal (DS: teal nunca é estrutura)", () => {
    assert.match(html, /border-bottom:1px solid #EBE5D0/); // régua do kicker = --rule bege
    assert.doesNotMatch(html, /border-bottom:1px solid #00A0A0/); // nunca teal
    assert.doesNotMatch(html, /border-left:[0-9]px solid #00A0A0/); // sem barra teal
  });

  it("'Por que isso importa' é box contorno (papel + borda bege + kicker teal)", () => {
    assert.match(html, /Por que isso importa/);
    assert.match(html, /border:1px solid #EBE5D0/); // box contorno
  });

  it("underline teal das manchetes é email-safe (border-bottom, não text-decoration-color)", () => {
    // #1936/diaria-design#2: Gmail/Outlook removem text-decoration-color → teal
    // sumiria. border-bottom teal aparece em todo cliente.
    assert.match(html, /border-bottom:2px solid #00A0A0/); // manchete
    assert.doesNotMatch(html, /text-decoration-color/);
  });

  it("não vaza valores ad-hoc da extração antiga do canvas", () => {
    assert.doesNotMatch(html, /Newsreader/);
    assert.doesNotMatch(html, /#F4EFE2/i); // paper antigo
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

  it("serif Georgia em título + corpo sans Geist + papel #FBFAF6 + ink + teal acento", () => {
    assert.match(html, /Georgia, 'Times New Roman', serif/); // h2/h3 títulos
    assert.match(html, /'Geist',/); // corpo + labels sans
    assert.match(html, /#FBFAF6/);
    assert.match(html, /#171411/);
    assert.match(html, /#00A0A0/); // kickers/links
  });

  it("divider entre seções é bege #EBE5D0, não teal", () => {
    assert.match(html, /border-top:1px solid #EBE5D0/);
    assert.doesNotMatch(html, /border-top:1px solid #00A0A0/);
  });

  it("não vaza valores ad-hoc (ink #1a1a1a, cinzas, Arial, shell #f2f2f2)", () => {
    assert.doesNotMatch(html, /#1a1a1a/i);
    assert.doesNotMatch(html, /Arial/);
    assert.doesNotMatch(html, /#f2f2f2/i);
    assert.doesNotMatch(html, /#444\b/);
    assert.doesNotMatch(html, /Newsreader/);
  });
});
