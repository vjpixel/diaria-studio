/**
 * carousel-cards-paragraph-count-14019.test.ts (#14019)
 *
 * Regressão: o carrossel diário perdia frases em silêncio quando o texto dos
 * cards tinha menos de 3 parágrafos. `splitIntoParagraphCards` remontava os
 * cards só com os trechos que `/[^.!?]+[.!?]+(?:\s+|$)/` casava, e descartava
 * o resto (frase sem ponto final, frase fechada por `."`/`.)`, trecho antes de
 * "GPT-5.5" ou "1.500"). O overflow media o texto já cortado e não acusava.
 *
 * Cobre as duas metades da correção:
 *   1. `splitIntoParagraphCards` não perde texto (corte por índice + assert).
 *   2. `## d{N}-cards` com 2 ou 4 parágrafos falha alto em `gen-carousel-cards`
 *      e no invariante `carousel-text-overflow` (Stages 2 e 4), nomeando o
 *      destaque e a contagem; com 3, segue normal.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CAROUSEL_SLIDE_SLOTS,
  carouselCardsParagraphCountProblem,
  countCarouselCardParagraphs,
  carouselSlideFilename,
  splitIntoParagraphCards,
} from "../scripts/lib/daily-carousel-card.ts";
import { checkCarouselTextOverflow } from "../scripts/lib/invariant-checks/stage-4.ts";
import { genCarouselCards, type RenderCarouselSlidesFn } from "../scripts/gen-carousel-cards.ts";
import type { UseMelhorPostConfigState } from "../scripts/lib/use-melhor-post.ts";

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

describe("splitIntoParagraphCards não perde texto (#14019)", () => {
  const casos: [string, string][] = [
    ["resto final sem ponto", "Primeiro.\n\nFrase um. Frase dois. E o resto sem ponto final"],
    [
      "citação fechada por `.\"` no meio",
      'Primeiro parágrafo curto.\n\nO CEO disse que "vamos mudar tudo." Depois saiu da sala. E voltou no dia seguinte com outra proposta.',
    ],
    ["frase fechada por `.)`", "Abertura do texto.\n\nO modelo saiu ontem (em beta.) Os testes vieram depois. E a empresa confirmou."],
    [
      "ponto colado em dígito (GPT-5.5, 1.500)",
      "A OpenAI lançou o GPT-5.5 ontem. O estudo ouviu 1.500 pessoas no Brasil. Resultado saiu hoje. Mais um fato aqui.",
    ],
  ];

  for (const [nome, body] of casos) {
    it(`${nome}: os cards somam exatamente o corpo`, () => {
      const cards = splitIntoParagraphCards(body, 3);
      assert.equal(norm(cards.join(" ")), norm(body.replace(/\n\s*\n/g, " ")));
      for (const c of cards) assert.ok(!/^["')]/.test(c), `card começa com fechamento solto: ${JSON.stringify(c)}`);
    });
  }

  it("a citação inteira fica num card, sem aspa solta no seguinte", () => {
    const cards = splitIntoParagraphCards(casos[1][1], 3);
    assert.equal(cards.length, 3);
    assert.ok(cards.some((c) => c.includes('"vamos mudar tudo."')), JSON.stringify(cards));
  });

  it("GPT-5.5 e 1.500 não viram fronteira de sentença", () => {
    const cards = splitIntoParagraphCards(casos[3][1], 3);
    assert.ok(cards.some((c) => c.includes("A OpenAI lançou o GPT-5.5 ontem.")), JSON.stringify(cards));
    assert.ok(cards.some((c) => c.includes("O estudo ouviu 1.500 pessoas no Brasil.")), JSON.stringify(cards));
  });
});

describe("contagem de parágrafos do `## d{N}-cards` (#14019, pure)", () => {
  it("conta parágrafos ignorando o bloco de hashtags", () => {
    assert.equal(countCarouselCardParagraphs("Um.\n\nDois.\n\nTrês.\n\n#IA #Agentes"), 3);
    assert.equal(countCarouselCardParagraphs("Um.\n\nDois."), 2);
  });

  it("3 parágrafos: sem problema; 2 ou 4: mensagem nomeia destaque, seção e contagem", () => {
    assert.equal(carouselCardsParagraphCountProblem("d1", "d1-cards", "Um.\n\nDois.\n\nTrês."), null);
    const dois = carouselCardsParagraphCountProblem("d2", "d2-cards", "Um.\n\nDois.");
    assert.match(dois ?? "", /d2: '## d2-cards' tem 2 parágrafo\(s\)/);
    const quatro = carouselCardsParagraphCountProblem("d3", "d3-cards", "Um.\n\nDois.\n\nTrês.\n\nQuatro.");
    assert.match(quatro ?? "", /d3: '## d3-cards' tem 4 parágrafo\(s\)/);
  });
});

const OFF: UseMelhorPostConfigState = { enabled: false, time: null, reason: "off" };
const CARDS_OK = (n: number) =>
  [`Card um do destaque ${n}.`, `Card dois do destaque ${n}.`, `Card três do destaque ${n}.`].join("\n\n");
const DOIS = 'Primeiro parágrafo curto.\n\nO CEO disse que "vamos mudar tudo." Depois saiu da sala. E voltou no dia seguinte.';
const QUATRO = "Card um.\n\nCard dois.\n\nCard três.\n\nCard quatro que sobrou.";

function socialMd(cardsD1: string, comCards = true): string {
  const out = ["# Social", ""];
  for (const n of [1, 2, 3]) {
    out.push(`## d${n}`, "", `Legenda do destaque ${n}.\n\nSegundo parágrafo da legenda ${n}.`, "");
    if (comCards) out.push(`## d${n}-cards`, "", n === 1 ? cardsD1 : CARDS_OK(n), "");
  }
  return out.join("\n");
}

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function makeEdition(md: string): string {
  const dir = mkdtempSync(join(tmpdir(), "diaria-cards-14019-"));
  dirs.push(dir);
  mkdirSync(join(dir, "_internal"), { recursive: true });
  writeFileSync(join(dir, "_internal", "01-approved-capped.json"), JSON.stringify({ highlights: [{}, {}, {}] }));
  writeFileSync(join(dir, "03-social.md"), md, "utf8");
  return dir;
}

function fakeRender(calls: string[]): RenderCarouselSlidesFn {
  return async (genericText, outPaths) => {
    calls.push(genericText);
    for (const slot of CAROUSEL_SLIDE_SLOTS) writeFileSync(outPaths[slot], "arte");
    return outPaths;
  };
}

describe("gen-carousel-cards aborta com `## d{N}-cards` fora de 3 parágrafos (#14019)", () => {
  for (const [nome, cards, n] of [
    ["2 parágrafos", DOIS, 2],
    ["4 parágrafos", QUATRO, 4],
  ] as const) {
    it(`${nome}: lança nomeando d1 e a contagem, sem gerar nenhum slide`, async () => {
      const dir = makeEdition(socialMd(cards));
      const calls: string[] = [];
      await assert.rejects(
        genCarouselCards(dir, { render: fakeRender(calls), useMelhorConfig: OFF }),
        new RegExp(`d1: '## d1-cards' tem ${n} parágrafo`),
      );
      assert.equal(calls.length, 0, "nenhum destaque pode ser renderizado");
      assert.equal(existsSync(join(dir, carouselSlideFilename("d2", "p1"))), false);
    });
  }

  it("3 parágrafos: gera os 3 destaques normalmente", async () => {
    const dir = makeEdition(socialMd(CARDS_OK(1)));
    const calls: string[] = [];
    await genCarouselCards(dir, { render: fakeRender(calls), useMelhorConfig: OFF });
    assert.equal(calls.length, 3);
  });

  it("legenda como fallback (sem `-cards`) com 2 parágrafos segue gerando, sem perder texto", async () => {
    const dir = makeEdition(socialMd("", false));
    const calls: string[] = [];
    await genCarouselCards(dir, { render: fakeRender(calls), useMelhorConfig: OFF });
    assert.equal(calls.length, 3);
  });
});

describe("invariante carousel-text-overflow acusa a contagem antes do gate (#14019)", () => {
  for (const [nome, cards, n] of [
    ["2 parágrafos", DOIS, 2],
    ["4 parágrafos", QUATRO, 4],
  ] as const) {
    it(`${nome}: error nomeando d1 e a contagem`, () => {
      const dir = makeEdition(socialMd(cards));
      const v = checkCarouselTextOverflow(dir, OFF).filter((x) => x.source_issue === "#14019");
      assert.equal(v.length, 1);
      assert.equal(v[0].rule, "carousel-text-overflow");
      assert.equal(v[0].severity, "error");
      assert.match(v[0].message, new RegExp(`d1: '## d1-cards' tem ${n} parágrafo`));
    });
  }

  it("3 parágrafos: nenhuma violação", () => {
    const dir = makeEdition(socialMd(CARDS_OK(1)));
    assert.deepEqual(checkCarouselTextOverflow(dir, OFF), []);
  });
});
