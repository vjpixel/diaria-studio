/**
 * test/social-cards-section-12094.test.ts (#12094)
 *
 * Decisão do editor (briefing overnight 261104c, opção (a)): o texto do post
 * fica separado do texto dos cards. O `social-writer` escreve, por destaque,
 * `## d{N}` (legenda corrida, lida por todos os publishers) e `## d{N}-cards`
 * (os 3 blocos do carrossel, lidos só pelo gerador de cards e pelos
 * invariantes do carrossel).
 *
 * Cobre o que quebraria em silêncio se o `-cards` fosse lido como um destaque
 * a mais ou ignorado: o carrossel continuar rasterizando a legenda; o
 * overflow/carimbo medirem o texto errado; `[^\n]*` em
 * `extractSocialSections` aceitar `## d1-cards` como um 2º `d1` (sobrescrevia
 * o hash da legenda no selo do humanizador); publishers colando os cards na
 * legenda; reorder renumerando só o `## d{N}`; e o fallback pra edição antiga.
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  extractSection,
  extractDestaqueBlock,
  extractCarouselCardsBlock,
  carouselCardsSectionId,
} from "../scripts/lib/extract-section.ts";
import { CAROUSEL_SLIDE_SLOTS, hashCarouselSlideTexts } from "../scripts/lib/daily-carousel-card.ts";
import { checkCarouselCardsStale, checkCarouselTextOverflow } from "../scripts/lib/invariant-checks/stage-4.ts";
import { genCarouselCards, type RenderCarouselSlidesFn } from "../scripts/gen-carousel-cards.ts";
import type { UseMelhorPostConfigState } from "../scripts/lib/use-melhor-post.ts";
import {
  extractSocialSections,
  lintInstagramEmailCTA,
  lintTrailingQuestion,
  parseDestaqueHeaders,
} from "../scripts/lib/social-lint-rules.ts";
import { reorderSocialMd } from "../scripts/reorder-destaques.ts";
import { extractPostText as extractInstagramPostText } from "../scripts/publish-instagram.ts";
import { extractDestaquesFromLinkedInMd } from "../scripts/publish-linkedin.ts";
import { parseSocialByDestaque } from "../scripts/lint-social-numbers.ts";
import { applySocialTextSubstitution } from "../scripts/apply-factcheck-autofix.ts";
import { parsePlatforms, groupByDestaque, cardBoldSpans, renderDestaqueGroup } from "../scripts/render-social-html.ts";

const OFF: UseMelhorPostConfigState = { enabled: false, time: null, reason: "off" };

const LEGENDA = (n: number) =>
  `Legenda corrida do destaque ${n}, com um parágrafo que puxa o seguinte.\n\nE o segundo parágrafo, mais curto, que retoma o primeiro.\n\n#InteligenciaArtificial #Agentes`;
const CARDS = (n: number) =>
  [`Card um do destaque ${n}. **Resumo do slide um.**`, `Card dois do destaque ${n}. **Resumo do slide dois.**`, `Card três do destaque ${n}. **Resumo do slide três.**`].join("\n\n");

function socialMd(opts: { cards?: boolean; cardsD1?: string; legendaD1?: string } = {}): string {
  const out = ["# Social", ""];
  for (const n of [1, 2, 3]) {
    out.push(`## d${n}`, "", n === 1 && opts.legendaD1 ? opts.legendaD1 : LEGENDA(n), "");
    if (opts.cards !== false) out.push(`## d${n}-cards`, "", n === 1 && opts.cardsD1 ? opts.cardsD1 : CARDS(n), "");
  }
  out.push("# Curto", "", "## d1", "", "Curto 1.", "", "## d2", "", "Curto 2.", "", "## d3", "", "Curto 3.", "");
  return out.join("\n");
}

/** Parágrafo denso de `n` caracteres, sem pontuação — mesmo padrão de test/carousel-text-overflow-stage2.test.ts. */
function paraDe(n: number): string {
  let s = "";
  while (s.length < n) s += (s ? " " : "") + "palavra";
  return s.slice(0, n).trim();
}

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function makeEdition(md: string): string {
  const dir = mkdtempSync(join(tmpdir(), "diaria-cards-12094-"));
  dirs.push(dir);
  mkdirSync(join(dir, "_internal"), { recursive: true });
  writeFileSync(join(dir, "_internal", "01-approved-capped.json"), JSON.stringify({ highlights: [{}, {}, {}] }));
  writeFileSync(join(dir, "03-social.md"), md, "utf8");
  return dir;
}

function fakeRender(calls: string[]): RenderCarouselSlidesFn {
  return async (genericText, outPaths) => {
    calls.push(genericText);
    for (const slot of CAROUSEL_SLIDE_SLOTS) writeFileSync(outPaths[slot], `arte:${genericText.length}`);
    return outPaths;
  };
}

describe("extractCarouselCardsBlock (#12094, pure)", () => {
  const section = extractSection(socialMd(), "Social")!;

  it("com `## d{N}-cards`: devolve os cards, não a legenda", () => {
    const r = extractCarouselCardsBlock(section, "d1");
    assert.ok(r);
    assert.equal(r!.source, "cards");
    assert.equal(r!.sectionId, "d1-cards");
    assert.equal(r!.text.trim(), CARDS(1));
  });

  it("a legenda `## d1` não absorve o bloco `## d1-cards` (nem casa com ele)", () => {
    assert.equal(extractDestaqueBlock(section, "d1")!.trim(), LEGENDA(1));
    assert.equal(carouselCardsSectionId("d2"), "d2-cards");
  });

  it("edição antiga, sem a seção: cai na legenda", () => {
    const old = extractSection(socialMd({ cards: false }), "Social")!;
    const r = extractCarouselCardsBlock(old, "d2");
    assert.equal(r!.source, "caption");
    assert.equal(r!.sectionId, "d2");
    assert.equal(r!.text.trim(), LEGENDA(2));
  });

  it("seção `-cards` vazia: cai na legenda (nunca rasteriza card em branco)", () => {
    const md = socialMd().replace(CARDS(1), "");
    const r = extractCarouselCardsBlock(extractSection(md, "Social")!, "d1");
    assert.equal(r!.source, "caption");
  });

  it("sem nenhuma das duas: null", () => {
    assert.equal(extractCarouselCardsBlock("## d1\n\ntexto\n", "d3"), null);
  });
});

describe("gen-carousel-cards rasteriza `## d{N}-cards` (#12094)", () => {
  it("o render recebe o texto dos cards, não a legenda", async () => {
    const dir = makeEdition(socialMd());
    const calls: string[] = [];
    await genCarouselCards(dir, { render: fakeRender(calls), useMelhorConfig: OFF });
    assert.equal(calls.length, 3);
    for (const [i, text] of calls.entries()) {
      assert.equal(text, CARDS(i + 1));
      assert.ok(!text.includes("Legenda corrida"), "a legenda não pode ir pros cards");
    }
  });

  it("edição antiga (sem `-cards`): segue rasterizando a legenda", async () => {
    const dir = makeEdition(socialMd({ cards: false }));
    const calls: string[] = [];
    await genCarouselCards(dir, { render: fakeRender(calls), useMelhorConfig: OFF });
    assert.equal(calls.length, 3);
    assert.ok(calls[0].includes("Legenda corrida do destaque 1"));
  });

  it("card que não cabe aborta nomeando a seção `## d1-cards`", async () => {
    const dir = makeEdition(socialMd({ cardsD1: [paraDe(420), "Card dois.", "Card três."].join("\n\n") }));
    await assert.rejects(
      genCarouselCards(dir, { render: fakeRender([]), useMelhorConfig: OFF }),
      /d1 \(seção '## d1-cards'\)/,
    );
  });

  it("legenda longa NÃO aborta o carrossel quando os cards cabem (a legenda não é medida)", async () => {
    const dir = makeEdition(socialMd({ legendaD1: `${paraDe(420)}\n\n#InteligenciaArtificial` }));
    const calls: string[] = [];
    await genCarouselCards(dir, { render: fakeRender(calls), useMelhorConfig: OFF });
    assert.equal(calls.length, 3);
  });
});

describe("invariantes do carrossel leem `## d{N}-cards` (#12094)", () => {
  it("carousel-text-overflow: card estourado é error nomeando `## d1-cards`", () => {
    const dir = makeEdition(socialMd({ cardsD1: [paraDe(420), "Card dois.", "Card três."].join("\n\n") }));
    const v = checkCarouselTextOverflow(dir, OFF).filter((x) => x.rule === "carousel-text-overflow");
    assert.equal(v.length, 1);
    assert.equal(v[0].severity, "error");
    assert.match(v[0].message, /'## d1-cards'/);
  });

  it("carousel-text-overflow: legenda longa com cards que cabem não acusa nada", () => {
    const dir = makeEdition(socialMd({ legendaD1: `${paraDe(420)}\n\n#InteligenciaArtificial` }));
    assert.deepEqual(checkCarouselTextOverflow(dir, OFF).filter((x) => x.rule === "carousel-text-overflow"), []);
  });

  it("carousel-cards-stale: carimbo do gen bate (mesmo texto dos cards); editar só a legenda não acusa arte velha", async () => {
    const dir = makeEdition(socialMd());
    await genCarouselCards(dir, { render: fakeRender([]), useMelhorConfig: OFF });
    assert.deepEqual(checkCarouselCardsStale(dir), []);
    writeFileSync(join(dir, "03-social.md"), socialMd({ legendaD1: "Legenda reescrita pelo editor no gate.\n\n#InteligenciaArtificial" }));
    assert.deepEqual(checkCarouselCardsStale(dir), [], "a legenda não está rasterizada — mudar ela não deixa a arte velha");
    writeFileSync(join(dir, "03-social.md"), socialMd({ cardsD1: CARDS(1).replace("Card um", "Card 1 reescrito") }));
    const v = checkCarouselCardsStale(dir);
    assert.equal(v.length, 1);
    assert.equal(v[0].severity, "error");
    assert.match(v[0].message, /slides de d1/);
  });

  it("o carimbo é o hash dos cards, não da legenda", () => {
    assert.notEqual(hashCarouselSlideTexts(CARDS(1)), hashCarouselSlideTexts(LEGENDA(1)));
  });
});

describe("parsers de 03-social.md não confundem `-cards` com destaque (#12094)", () => {
  it("extractSocialSections: `main_d1` é a legenda e `main_d1-cards` é seção própria (antes os cards sobrescreviam a legenda)", () => {
    const s = extractSocialSections(socialMd());
    assert.ok(s.main_d1.includes("Legenda corrida do destaque 1"));
    assert.ok(!s.main_d1.includes("Card um"));
    assert.ok(s["main_d1-cards"].includes("Card um do destaque 1"));
  });

  it("parseDestaqueHeaders / publish-linkedin: d1..d3, sem destaque extra", () => {
    const section = extractSection(socialMd(), "Social")!;
    assert.deepEqual(parseDestaqueHeaders(section), ["d1", "d2", "d3"]);
    assert.deepEqual(extractDestaquesFromLinkedInMd(socialMd()), ["d1", "d2", "d3"]);
  });

  it("publish-instagram: legenda do d1 sai sem o texto dos cards", () => {
    const text = extractInstagramPostText(socialMd(), "d1");
    assert.ok(text.includes("Legenda corrida do destaque 1"));
    assert.ok(!text.includes("Card um"));
    assert.ok(!text.includes("cards"));
  });

  it("lint channel-neutral cobre os cards (CTA de canal no card é pego)", () => {
    const md = socialMd({ cardsD1: ["Card um. **Resumo.**", "Card dois. **Resumo.**", "Link na bio. **Resumo.**"].join("\n\n") });
    const r = lintInstagramEmailCTA(md);
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.section === "d1-cards"));
  });

  it("lint de pergunta no fim cobre os cards", () => {
    const md = socialMd({ cardsD1: ["Card um. **Resumo.**", "Card dois. **Resumo.**", "E você, já usou?"].join("\n\n") });
    const r = lintTrailingQuestion(md);
    assert.ok(r.matches.some((m) => m.destaque === "d1-cards"));
  });

  it("lint de cifras (lint-social-numbers): o texto dos cards conta como do d1", () => {
    const map = parseSocialByDestaque(socialMd({ cardsD1: "Card com US$ 5 bilhões. **Resumo.**" }));
    assert.ok(map.get(1)!.includes("US$ 5 bilhões"));
  });

  it("autofix do fact-check corrige a legenda E os cards do destaque", () => {
    const md = socialMd({ legendaD1: "A empresa captou US$ 5 bilhões.\n\n#InteligenciaArtificial", cardsD1: "Captou US$ 5 bilhões. **Resumo.**" });
    const r = applySocialTextSubstitution(md, 1, "US$ 5 bilhões", "US$ 4 bilhões");
    assert.equal(r.changed, true);
    assert.ok(!r.content.includes("US$ 5 bilhões"));
    assert.ok(r.modifiedRanges >= 2);
  });
});

describe("reorder-destaques move `## d{N}-cards` junto com o `## d{N}` (#12094)", () => {
  it("--new-order 3,1,2: d1-cards passa a ser o do antigo d3, e fica logo depois do d1", () => {
    const out = reorderSocialMd(socialMd(), [3, 1, 2]);
    const section = extractSection(out, "Social")!;
    assert.equal(extractDestaqueBlock(section, "d1")!.trim(), LEGENDA(3));
    assert.equal(extractDestaqueBlock(section, "d1-cards")!.trim(), CARDS(3));
    assert.equal(extractDestaqueBlock(section, "d2-cards")!.trim(), CARDS(1));
    assert.equal(extractDestaqueBlock(section, "d3-cards")!.trim(), CARDS(2));
    const headers = section.split("\n").filter((l) => l.startsWith("## "));
    assert.deepEqual(headers, ["## d1", "## d1-cards", "## d2", "## d2-cards", "## d3", "## d3-cards"]);
  });
});

describe("preview social (render-social-html) mostra os cards à parte (#12094)", () => {
  it("`## d1-cards` entra no grupo D1, não vira um 4º post", () => {
    const groups = groupByDestaque(parsePlatforms(socialMd()), {});
    const keys = groups.map((g) => g.key);
    assert.ok(!keys.some((k) => k.endsWith("-cards")), `grupos: ${keys.join(",")}`);
    const d1 = groups.find((g) => g.key === "d1")!;
    assert.ok(d1.cardsPost?.main.includes("Card um do destaque 1"));
    assert.ok(d1.blocks.every((b) => !b.post.main.includes("Card um")));
    assert.deepEqual(cardBoldSpans(d1), ["Resumo do slide um.", "Resumo do slide dois.", "Resumo do slide três."]);
    const html = renderDestaqueGroup(d1, "#000");
    assert.match(html, /Texto dos cards do carrossel/);
    assert.match(html, /<strong>Resumo do slide um\.<\/strong>/);
  });
});
