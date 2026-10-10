/**
 * test/use-melhor-text-channel-breaks-9999.test.ts (#9999)
 *
 * 1º post pessoal real do LinkedIn (edição 261009): os 8 itens do `## um` saíram
 * colados em pares (1+2, 3+4, 5+6, 7+8), herdando o agrupamento de 2 itens por
 * card do carrossel (#9791). Decisão do editor (10/10): nos canais de TEXTO
 * (LinkedIn página + pessoal, Facebook) cada item sai separado por linha em
 * branco; o carrossel do Instagram segue com 2 itens por card.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { separateUseMelhorListItems } from "../scripts/lib/use-melhor-card-break.ts";
import { buildUseMelhorSlides } from "../scripts/lib/use-melhor-carousel.ts";
import {
  finalizeUseMelhorPostText,
  finalizeUseMelhorTextChannelPostText,
  type UseMelhorReadyPlan,
} from "../scripts/lib/use-melhor-dispatch.ts";
import { useMelhorSlideImageKey } from "../scripts/lib/use-melhor-slide-files.ts";
import { buildUseMelhorLinkedInPost } from "../scripts/publish-linkedin.ts";
import { buildUseMelhorFacebookPost } from "../scripts/publish-facebook.ts";
import { buildUseMelhorInstagramPost } from "../scripts/publish-instagram.ts";
import { extractPersonalPostText } from "../scripts/resolve-post-pixel.ts";

const ITEMS = [
  "1) **Peça o primeiro rascunho** de e-mails e propostas.",
  "2) **Resuma documentos longos** pedindo os pontos principais.",
  "3) **Prepare reuniões** pedindo a pauta e as objeções possíveis.",
  "4) **Analise e-mails** perguntando qual é a solicitação.",
  "5) **Aprenda mais rápido** contando o seu nível.",
  "6) **Peça exemplos** antes de aplicar a regra nova.",
  "7) **Revise planilhas** pedindo as fórmulas com erro.",
  "8) **Treine apresentações** pedindo perguntas difíceis.",
];
const PAIRS = [0, 2, 4, 6].map((i) => `${ITEMS[i]}\n${ITEMS[i + 1]}`);
const UM = [...PAIRS, "#Produtividade #IA"].join("\n\n");
const TITLE = "Oito usos de IA no trabalho";

/** Nenhum item colado ao anterior: todo item (exceto o 1º) é precedido de linha em branco. */
function assertEveryItemSeparated(text: string): void {
  for (let n = 2; n <= 8; n++) {
    assert.match(text, new RegExp(`\\n\\n(?:\\*\\*)?${n}\\)`), `item ${n} colado ao anterior:\n${text}`);
  }
  assert.doesNotMatch(text, /\n\n\n/, "linha em branco duplicada");
  assert.doesNotMatch(text, /\{quebra\}/);
}

describe("separateUseMelhorListItems (#9999)", () => {
  it("8 itens em pares viram 8 parágrafos; hashtags intocadas", () => {
    const out = separateUseMelhorListItems(UM);
    assert.equal(out, [...ITEMS, "#Produtividade #IA"].join("\n\n"));
  });

  it("idempotente: aplicar 2x dá o mesmo texto", () => {
    const once = separateUseMelhorListItems(UM);
    assert.equal(separateUseMelhorListItems(once), once);
  });

  it("não duplica a linha em branco onde o editor já pôs {quebra}", () => {
    const withMarker = UM.replace(`${ITEMS[4]}\n${ITEMS[5]}`, `${ITEMS[4]}\n{quebra}\n${ITEMS[5]}`);
    assertEveryItemSeparated(finalizeUseMelhorTextChannelPostText(withMarker));
  });

  it("número em negrito e formato `N.` também contam como item", () => {
    assert.equal(separateUseMelhorListItems("**1)** a\n**2)** b"), "**1)** a\n\n**2)** b");
    assert.equal(separateUseMelhorListItems("1. a\n2. b"), "1. a\n\n2. b");
  });

  it("linha que não abre item (texto antes da lista, prosa) não ganha quebra", () => {
    assert.equal(separateUseMelhorListItems("Intro\nlinha 2"), "Intro\nlinha 2");
    assert.equal(separateUseMelhorListItems("Em 2026 o uso cresceu.\n3 coisas mudaram."), "Em 2026 o uso cresceu.\n3 coisas mudaram.");
  });

  it("CRLF preservado", () => {
    assert.equal(separateUseMelhorListItems("1) a\r\n2) b"), "1) a\r\n\n2) b");
  });
});

describe("publicadores de texto separam os itens; carrossel/Instagram não mudam (#9999)", () => {
  const md = [
    "# Social", "", "## d1", "", "Texto do destaque.", "", "#Tag", "",
    "## um", "", UM, "",
    "# Curto", "", "## d1", "", "Curto. Mais em https://diar.ia.br/p/x #Tag", "",
  ].join("\n");
  const slides = buildUseMelhorSlides(UM, TITLE);
  const slots = slides.map((s) => s.slot);
  const plan: UseMelhorReadyPlan = {
    status: "ready",
    time: "08:00",
    item: { url: "https://example.com/guia", title: TITLE, summary: "S", score: 80 },
    slots,
  };
  const images: Record<string, { url?: string }> = {};
  for (const s of slots) images[useMelhorSlideImageKey(s)] = { url: `https://cdn/um-${s}.jpg` };

  it("LinkedIn página", () => {
    const r = buildUseMelhorLinkedInPost({ socialMd: md, plan, images });
    assert.ok(r.ok, JSON.stringify(r));
    if (r.ok) assertEveryItemSeparated(r.text);
  });

  it("LinkedIn pessoal", () => {
    const r = extractPersonalPostText(md);
    assert.equal(r?.source, "um");
    assertEveryItemSeparated(r!.text);
  });

  it("Facebook", () => {
    const r = buildUseMelhorFacebookPost({ socialMd: md, plan, images, editionDir: "x", fileExists: () => false });
    assert.ok(r.ok, JSON.stringify(r));
    if (r.ok) assertEveryItemSeparated(r.caption);
  });

  it("carrossel continua com 2 itens por card", () => {
    // A regra é só de publicação: o carrossel sai do 03-social.md, que não muda.
    const texts = slides.map((s) => JSON.stringify(s.text));
    for (const [a, b] of [[1, 2], [3, 4], [5, 6], [7, 8]]) {
      const card = texts.find((t) => t.includes(ITEMS[a - 1].slice(3, 20)));
      assert.ok(card, `card do item ${a} ausente`);
      assert.ok(card!.includes(ITEMS[b - 1].slice(3, 20)), `item ${b} fora do card do item ${a}`);
    }
  });

  it("Instagram (legenda junto do carrossel) mantém os pares", () => {
    const r = buildUseMelhorInstagramPost({ socialMd: md, plan, images, editionDir: "x", fileExists: () => true });
    assert.ok(r.ok, JSON.stringify(r));
    if (r.ok) assert.match(r.caption, /contando o seu nível\.\n(?:\*\*)?6\)/);
  });

  it("finalizeUseMelhorPostText (Instagram/Curto) segue sem separar", () => {
    assert.equal(finalizeUseMelhorPostText(PAIRS[0]), PAIRS[0]);
  });
});
