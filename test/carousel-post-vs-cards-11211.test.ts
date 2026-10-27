/**
 * test/carousel-post-vs-cards-11211.test.ts (#11211)
 *
 * Caso real (edição 261027, gate 4): o editor reparagrafou a LEGENDA de d2/d3
 * (mesmas palavras, mais parágrafos) sem querer mexer na arte do carrossel.
 * `splitIntoParagraphCards` juntava os parágrafos extras no 3º card, que
 * estourava (`carousel-text-overflow`), e o carimbo mudava
 * (`carousel-cards-stale`). Desde o #11211 a divisão em cards usada no render
 * fica gravada e vale enquanto as palavras forem as mesmas.
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CAROUSEL_SLIDE_SLOTS,
  buildCarouselSlideTexts,
  carouselCardParagraphs,
  carouselCardParagraphsPath,
  readCarouselCardParagraphs,
  resolveCarouselCardText,
  findOverflowingCarouselSlides,
} from "../scripts/lib/daily-carousel-card.ts";
import { checkCarouselCardsStale, checkCarouselTextOverflow } from "../scripts/lib/invariant-checks/stage-4.ts";
import { genCarouselCards, type RenderCarouselSlidesFn } from "../scripts/gen-carousel-cards.ts";
import type { UseMelhorPostConfigState } from "../scripts/lib/use-melhor-post.ts";

const OFF: UseMelhorPostConfigState = { enabled: false, time: null, reason: "off" };

// Cada parágrafo-card tem 2 frases e ~200 chars: cabe sozinho no card, mas
// 3 deles juntos no p3 estouram.
const frase = (tag: string): string => `A frase ${tag} explica com calma o que aconteceu e por que importa ao leitor.`;
const P1 = `${frase("um")} ${frase("dois")}`;
const P2 = `${frase("três")} ${frase("quatro")}`;
const P3 = `${frase("cinco")} ${frase("seis")}`;
const ORIGINAL = [P1, P2, P3].join("\n\n");
// Mesmas palavras, 5 parágrafos, frases isoladas — o que o editor fez em 261027.
const REPARAGRAFADO = [frase("um"), frase("dois"), frase("três"), frase("quatro"), P3].join("\n\n");
const TAGS = "#ia #tecnologia";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function makeEdition(texts: { d1: string; d2: string; d3: string }): string {
  const dir = mkdtempSync(join(tmpdir(), "diaria-post-vs-cards-11211-"));
  dirs.push(dir);
  mkdirSync(join(dir, "_internal"), { recursive: true });
  writeFileSync(join(dir, "_internal", "01-approved-capped.json"), JSON.stringify({ highlights: [{}, {}, {}] }));
  writeSocial(dir, texts);
  return dir;
}

function writeSocial(dir: string, texts: { d1: string; d2: string; d3: string }): void {
  const md = ["# Social", "", "## d1", "", texts.d1, "", "## d2", "", texts.d2, "", "## d3", "", texts.d3, ""];
  writeFileSync(join(dir, "03-social.md"), md.join("\n"), "utf8");
}

function fakeRender(calls: string[]): RenderCarouselSlidesFn {
  return async (genericText, outPaths) => {
    calls.push(genericText);
    for (const slot of CAROUSEL_SLIDE_SLOTS) writeFileSync(outPaths[slot], `arte:${genericText.length}`);
    return outPaths;
  };
}

describe("resolveCarouselCardText (#11211, pure)", () => {
  const stored = { d2: [P1, P2, P3] };

  it("só reparagrafado (mesmas palavras): devolve a divisão gravada", () => {
    assert.equal(resolveCarouselCardText(REPARAGRAFADO, stored), ORIGINAL);
    assert.deepEqual(buildCarouselSlideTexts(resolveCarouselCardText(REPARAGRAFADO, stored)).p3, buildCarouselSlideTexts(ORIGINAL).p3);
  });

  it("hashtags e espaços extras não atrapalham o casamento", () => {
    const comTags = `${REPARAGRAFADO.replace(/ /g, "  ")}\n\n${TAGS}`;
    assert.equal(resolveCarouselCardText(comTags, stored), ORIGINAL);
  });

  it("parágrafos fundidos (menos que 3) também seguem a divisão gravada", () => {
    assert.equal(resolveCarouselCardText(`${P1} ${P2} ${P3}`, stored), ORIGINAL);
  });

  it("palavra, pontuação ou negrito mudou: texto volta como veio (arte precisa regerar)", () => {
    const outraPalavra = REPARAGRAFADO.replace("calma", "pressa");
    assert.equal(resolveCarouselCardText(outraPalavra, stored), outraPalavra);
    const comBold = REPARAGRAFADO.replace("calma", "**calma**");
    assert.equal(resolveCarouselCardText(comBold, stored), comBold);
  });

  it("casamento é por conteúdo, não pela posição (reorder/swap)", () => {
    assert.equal(resolveCarouselCardText(REPARAGRAFADO, { d1: [P1, P2, P3] }), ORIGINAL);
  });

  it("sem gravação ou entrada malformada: comportamento de antes", () => {
    assert.equal(resolveCarouselCardText(REPARAGRAFADO, null), REPARAGRAFADO);
    assert.equal(resolveCarouselCardText(REPARAGRAFADO, {}), REPARAGRAFADO);
    const malformado = { d2: [P1, 3, P3] } as unknown as Record<string, string[]>;
    assert.equal(resolveCarouselCardText(REPARAGRAFADO, malformado), REPARAGRAFADO);
  });

  it("premissa do teste: sem a divisão gravada, a legenda reparagrafada estoura o p3", () => {
    const over = findOverflowingCarouselSlides(REPARAGRAFADO);
    assert.deepEqual(over.map((o) => o.slot), ["p3"]);
    assert.deepEqual(findOverflowingCarouselSlides(ORIGINAL), []);
  });
});

describe("gate 4 depois de reparagrafar só a legenda (#11211, regressão 261027)", () => {
  async function geradaEReparagrafada(): Promise<{ dir: string; calls: string[] }> {
    const dir = makeEdition({ d1: ORIGINAL, d2: ORIGINAL, d3: ORIGINAL });
    const calls: string[] = [];
    await genCarouselCards(dir, { render: fakeRender(calls), useMelhorConfig: OFF });
    assert.equal(calls.length, 3);
    assert.deepEqual(readCarouselCardParagraphs(dir).d2, [P1, P2, P3], "divisão do render fica gravada");
    writeSocial(dir, { d1: ORIGINAL, d2: REPARAGRAFADO, d3: `${REPARAGRAFADO}\n\n${TAGS}` });
    return { dir, calls };
  }

  it("carousel-cards-stale e carousel-text-overflow não disparam", async () => {
    const { dir } = await geradaEReparagrafada();
    assert.deepEqual(checkCarouselCardsStale(dir), []);
    assert.deepEqual(checkCarouselTextOverflow(dir, OFF), []);
  });

  it("gen-carousel-cards não regera a arte (nem com --force muda a divisão)", async () => {
    const { dir, calls } = await geradaEReparagrafada();
    const r = await genCarouselCards(dir, { render: fakeRender(calls), useMelhorConfig: OFF });
    assert.equal(calls.length, 3, "nenhum render novo");
    assert.deepEqual(r.refreshed, []);
    await genCarouselCards(dir, { render: fakeRender(calls), useMelhorConfig: OFF, force: true });
    assert.deepEqual(calls.slice(3), [ORIGINAL, ORIGINAL, ORIGINAL], "--force regera com a MESMA divisão em cards");
  });

  it("sem a divisão gravada (edição anterior ao #11211): os dois erros seguem como antes", async () => {
    const { dir } = await geradaEReparagrafada();
    rmSync(carouselCardParagraphsPath(dir));
    const stale = checkCarouselCardsStale(dir);
    assert.ok(stale.some((v) => v.severity === "error" && v.message.includes("slides de d2")));
    const over = checkCarouselTextOverflow(dir, OFF);
    assert.ok(over.some((v) => v.severity === "error" && v.message.includes("'## d2'")));
  });

  it("palavra mudada: arte velha de verdade, carousel-cards-stale segue ERROR", async () => {
    const { dir } = await geradaEReparagrafada();
    writeSocial(dir, { d1: ORIGINAL, d2: ORIGINAL.replace("calma", "pressa"), d3: ORIGINAL });
    const stale = checkCarouselCardsStale(dir);
    assert.equal(stale.length, 1);
    assert.equal(stale[0].severity, "error");
  });

  it("edição gerada antes do #11211 ganha a divisão no próximo gen sem re-render", async () => {
    const dir = makeEdition({ d1: ORIGINAL, d2: ORIGINAL, d3: ORIGINAL });
    const calls: string[] = [];
    await genCarouselCards(dir, { render: fakeRender(calls), useMelhorConfig: OFF });
    rmSync(carouselCardParagraphsPath(dir));
    assert.equal(existsSync(carouselCardParagraphsPath(dir)), false);
    await genCarouselCards(dir, { render: fakeRender(calls), useMelhorConfig: OFF });
    assert.equal(calls.length, 3, "carimbo batia: pulou o render");
    assert.deepEqual(readCarouselCardParagraphs(dir).d1, carouselCardParagraphs(ORIGINAL));
  });
});
