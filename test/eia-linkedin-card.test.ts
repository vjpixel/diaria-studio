/**
 * eia-linkedin-card.test.ts
 *
 * Cobre o miolo PURE de `scripts/lib/eia-linkedin-card.ts` — os dois
 * builders de SVG. `renderEia*Card` chama sharp de verdade e não é
 * exercitado aqui (mesma disciplina de `weekly-flat-card.test.ts` /
 * `daily-carousel-card.test.ts`).
 *
 * O invariante que importa: o carimbo da opção existe, é LEGÍVEL (fundo
 * cheio, não translúcido) e cai DENTRO da área da foto. Foi a ausência
 * desse rótulo que motivou o arquivo — no LinkedIn o voto vai nos
 * comentários, então "A" e "B" precisam vir na arte.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildEiaCompositeOverlaySvg,
  buildEiaSingleOverlaySvg,
  CARD_W,
  COMPOSITE_H,
  SINGLE_H,
  PHOTO_W,
  PHOTO_H,
  COMPOSITE_PHOTO_A_Y,
  COMPOSITE_PHOTO_B_Y,
  SINGLE_PHOTO_Y,
  VOTE_CALL,
} from "../scripts/lib/eia-linkedin-card.ts";
import { COLORS } from "../scripts/lib/shared/design-tokens.ts";

/** Todos os `<rect>` do SVG como objetos com os atributos numéricos já parseados. */
function rects(svg: string): { x: number; y: number; width: number; height: number; fill: string }[] {
  return [...svg.matchAll(/<rect\b[^>]*>/g)].map((m) => {
    const tag = m[0];
    const attr = (name: string): string => tag.match(new RegExp(`${name}="([^"]*)"`))?.[1] ?? "";
    return {
      x: Number(attr("x")),
      y: Number(attr("y")),
      width: Number(attr("width")),
      height: Number(attr("height")),
      fill: attr("fill"),
    };
  });
}

/** O carimbo é o único `<rect>` preenchido em tinta. */
function badges(svg: string) {
  return rects(svg).filter((r) => r.fill === COLORS.ink);
}

describe("buildEiaCompositeOverlaySvg", () => {
  const svg = buildEiaCompositeOverlaySvg();

  it("declara a moldura 4:5 do card social", () => {
    assert.match(svg, new RegExp(`width="${CARD_W}" height="${COMPOSITE_H}"`));
    assert.equal(COMPOSITE_H / CARD_W, 1.25);
    assert.equal(PHOTO_H, Math.round((PHOTO_W * 450) / 800)); // 16:9 preservado
  });

  it("carimba A e B, um por foto", () => {
    const letters = [...svg.matchAll(/>([AB])<\/text>/g)].map((m) => m[1]);
    assert.deepEqual(letters, ["A", "B"]);
  });

  it("põe cada carimbo dentro da área da sua foto", () => {
    const stamps = badges(svg);
    assert.equal(stamps.length, 2);
    for (const [i, photoY] of [COMPOSITE_PHOTO_A_Y, COMPOSITE_PHOTO_B_Y].entries()) {
      const b = stamps[i];
      assert.ok(b.x >= 60 && b.x + b.width <= 60 + PHOTO_W, "carimbo vaza na horizontal");
      assert.ok(b.y >= photoY && b.y + b.height <= photoY + PHOTO_H, "carimbo vaza na vertical");
    }
  });

  it("mantém as duas fotos e o rodapé dentro do card", () => {
    assert.ok(COMPOSITE_PHOTO_A_Y + PHOTO_H <= COMPOSITE_PHOTO_B_Y, "fotos se sobrepõem");
    assert.ok(COMPOSITE_PHOTO_B_Y + PHOTO_H < COMPOSITE_H, "foto B estoura o card");
  });

  it("chama o voto e assina a marca", () => {
    assert.ok(svg.includes(VOTE_CALL));
    assert.match(svg, /diar<tspan[^>]*>\.<\/tspan>ia/);
  });

  it("usa fundo cheio no carimbo (nada translúcido sobre foto imprevisível)", () => {
    assert.doesNotMatch(svg, /<rect[^>]*fill-opacity=/);
    assert.doesNotMatch(svg, /<rect[^>]*opacity=/);
  });
});

describe("buildEiaSingleOverlaySvg", () => {
  it("carimba só a letra da opção e a nomeia por extenso", () => {
    for (const letter of ["A", "B"] as const) {
      const svg = buildEiaSingleOverlaySvg(letter);
      const stamps = badges(svg);
      assert.equal(stamps.length, 1);
      assert.equal(stamps[0].y >= SINGLE_PHOTO_Y, true);
      assert.match(svg, new RegExp(`>${letter}</text>`));
      assert.ok(svg.includes(`Opção ${letter}`));

      const other = letter === "A" ? "B" : "A";
      assert.doesNotMatch(svg, new RegExp(`>${other}</text>`));
      assert.ok(!svg.includes(`Opção ${other}`));
    }
  });

  it("é quadrado — a colagem multi-imagem do LinkedIn corta menos", () => {
    assert.match(buildEiaSingleOverlaySvg("A"), new RegExp(`width="${CARD_W}" height="${SINGLE_H}"`));
    assert.equal(SINGLE_H, CARD_W);
  });

  it("mantém a legenda abaixo da foto e acima do rodapé", () => {
    const svg = buildEiaSingleOverlaySvg("A");
    const captionY = Number(svg.match(/y="(\d+)"[^>]*text-anchor="middle"/)?.[1] ?? 0);
    assert.ok(captionY > SINGLE_PHOTO_Y + PHOTO_H, "legenda invade a foto");
    assert.ok(captionY < SINGLE_H - 80, "legenda colide com o rodapé");
  });
});
