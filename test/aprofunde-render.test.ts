import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  renderAprofundeInner,
  renderDestaque,
} from "../scripts/lib/newsletter-render-html.ts";
import { extractLinks } from "../scripts/build-link-ctr.ts";
import { resolveNewsletterSection } from "../scripts/lib/link-ctr-categorize.ts";
import type { RenderDestaque } from "../scripts/lib/newsletter-parse.ts";

describe("renderAprofundeInner (#3920)", () => {
  const items = [
    { title: "Cobertura TechCrunch", url: "https://techcrunch.com/x", source: "TechCrunch" },
    { title: "Análise The Verge", url: "https://theverge.com/x", source: "The Verge" },
  ];

  it("vazio/undefined → string vazia (destaque sem cluster inalterado)", () => {
    assert.equal(renderAprofundeInner(undefined), "");
    assert.equal(renderAprofundeInner([]), "");
  });

  it("emite kicker Aprofunde + links de cada fonte", () => {
    const html = renderAprofundeInner(items);
    assert.match(html, /APROFUNDE|Aprofunde/);
    assert.ok(html.includes("https://techcrunch.com/x"));
    assert.ok(html.includes("https://theverge.com/x"));
    assert.ok(html.includes("TechCrunch"));
    assert.ok(html.includes("The Verge"));
  });

  it("kicker tem a assinatura que build-link-ctr reconhece como seção", () => {
    const html = renderAprofundeInner(items);
    // KICKER_TD_OPEN_SRC: <td> com font-weight:bold + letter-spacing:2px + uppercase
    assert.match(html, /<td[^>]*font-weight:\s*bold[^>]*letter-spacing:\s*2px[^>]*text-transform:\s*uppercase/);
  });

  it("só fontes escapadas (sem HTML injetável cru)", () => {
    const html = renderAprofundeInner([
      { title: "T<script>", url: "https://a.com/x", source: "S&<b>" },
    ]);
    assert.ok(!html.includes("<script>"));
    assert.ok(html.includes("&lt;script&gt;") || html.includes("&lt;"));
  });
});

describe("renderDestaque + Aprofunde → CTR distingue título vs Aprofunde (#3920)", () => {
  const d: RenderDestaque = {
    n: 1,
    category: "MERCADO",
    emoji: "🚀",
    title: "Título do destaque",
    url: "https://canonico.com/x",
    body: "Corpo do destaque.",
    why: "Impacto prático em duas frases claras.",
    aprofunde: [
      { title: "Fonte extra A", url: "https://extra-a.com/x", source: "A" },
      { title: "Fonte extra B", url: "https://extra-b.com/x", source: "B" },
    ],
  };

  it("o link-título resolve para 'Destaque' e os links Aprofunde para 'Aprofunde'", () => {
    const html = renderDestaque(d);
    const links = extractLinks(html);
    const byUrl = new Map(links.map((l) => [l.baseUrl, l]));

    const canonico = byUrl.get("https://canonico.com/x");
    const extraA = byUrl.get("https://extra-a.com/x");
    const extraB = byUrl.get("https://extra-b.com/x");
    assert.ok(canonico, "link canônico deve ser extraído");
    assert.ok(extraA && extraB, "links Aprofunde devem ser extraídos");

    assert.equal(resolveNewsletterSection(canonico!.sectionTitle), "Destaque");
    assert.equal(resolveNewsletterSection(extraA!.sectionTitle), "Aprofunde");
    assert.equal(resolveNewsletterSection(extraB!.sectionTitle), "Aprofunde");
  });
});
