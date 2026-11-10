/**
 * test/video-montage-screen-title-11941.test.ts — feedback do editor no import
 * da 261103: o título na tela das verticais (#11756)
 *   1. saía grande demais (fontsize 80 no gerador "Text" do FCP7 passava da
 *      largura de 1080 px no Premiere);
 *   2. vinha numa caixa por linha (linhas juntas com `&#13;`);
 *   3. não tinha fundo (pedido: preto a 70%).
 * O gerador "Text" do FCP7 e o fundo Color+Crop saíram no #12104 (decisão do
 * editor): o título vai só no PNG, que precisa sair numa caixa só, no tamanho
 * novo, com o fundo preto a 70% desenhado atrás do texto.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  SCREEN_TITLE_STYLE,
  buildXmeml,
  screenTitleLayout,
  screenTitleSvg,
  wrapScreenTitle,
  type PlannedClip,
  type SequencePlan,
  type SequenceSpec,
  type SourceInfo,
} from "../scripts/lib/diaria/video-montage.ts";

const SOURCE: SourceInfo = { path: "G:/Meu Drive/YouTube/261103/bruto.mp4", fps: 30, durationS: 600, width: 3840, height: 2160, mirrored: false };
const FRAMING = { faceX: 0.5, eyeY: 0.5 };
const SPEC_H: SequenceSpec = { target: "youtube", name: "Diaria comentada_Youtube_V1", width: 1920, height: 1080, order: ["titulo", "comentario"], scales: [50, 62] };
const SPEC_V: SequenceSpec = { target: "outras-redes", name: "Diaria comentada_Vertical_V1", width: 1080, height: 1920, order: ["titulo", "comentario"], scales: [115, 130] };
// Título longo de verdade (3 linhas): o caso que estourava a largura.
const TITLE = "GPT 6.1 Terra está mais barato e mais eficaz que o anterior";
const PNG_PATH = "G:/Meu Drive/YouTube/261103/261103_titulo_vertical.png";

function clip(block: PlannedClip["block"], seqStart: number, len: number, frameIn: number): PlannedClip {
  return { block, srcIn: frameIn / 30, srcOut: (frameIn + len) / 30, frameIn, frameOut: frameIn + len, seqStart, seqEnd: seqStart + len, scale: 115 };
}
const CLIPS = [clip("titulo", 0, 105, 30), clip("comentario", 105, 300, 300)];
function plan(spec: SequenceSpec): SequencePlan {
  return { spec, clips: CLIPS, durationFrames: 405 } as SequencePlan;
}

function verticalVideo(xml: string): string {
  const seq = xml.split("<sequence ").slice(1).find((s) => s.includes(SPEC_V.name)) ?? "";
  // Fim do vídeo da SEQUÊNCIA: os <file> (bruto, PNG) têm um <video> próprio dentro.
  return seq.slice(seq.indexOf("<video>"), seq.indexOf("</video>\n<audio><numOutputChannels>"));
}

describe("#11941 título da vertical: caixa única, tamanho e fundo (PNG, #12104)", () => {
  const xml = buildXmeml([plan(SPEC_H), plan(SPEC_V)], SOURCE, FRAMING, { screenTitle: { text: TITLE, mode: "png", pngPath: PNG_PATH } });
  const video = verticalVideo(xml);

  it("uma caixa só: o PNG leva o título inteiro, linhas quebradas dentro da mesma caixa", () => {
    const svg = screenTitleSvg(TITLE, 1080, 1920);
    assert.equal((svg.match(/<rect /g) ?? []).length, 1, "um fundo só, não um por linha (261103)");
    const lines = [...svg.matchAll(/<text [^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);
    assert.ok(lines.length >= 2, "título longo ainda quebra");
    assert.equal(lines.join(" "), TITLE, "nenhuma palavra perdida");
    assert.doesNotMatch(svg, /&#10;|&#13;/);
  });

  it("tamanho: a letra não é mais 80 e a linha mais longa cabe na largura com margem", () => {
    const { fontPx } = screenTitleLayout(TITLE, SPEC_V.width, SPEC_V.height);
    assert.ok(fontPx > 0 && fontPx < 80, `fontPx ${fontPx} (era 80)`);
    const longest = Math.max(...wrapScreenTitle(TITLE).map((l) => l.length));
    const lineW = longest * SCREEN_TITLE_STYLE.avgCharEm * fontPx;
    assert.ok(lineW <= SPEC_V.width - 2 * SCREEN_TITLE_STYLE.marginPx, `linha de ${Math.round(lineW)} px passa de 1080 menos margem`);
  });

  it("maxLineChars coerente com a largura útil", () => {
    const st = SCREEN_TITLE_STYLE;
    assert.ok(st.maxLineChars * st.avgCharEm * st.fontPx + 2 * st.padXPx <= st.refWidth - 2 * st.marginPx);
  });

  it("faixas: clipes (V1) e o PNG do título (V2), no trecho do título, sem gerador", () => {
    const tracks = video.split("<track>").slice(1);
    assert.equal(tracks.length, 2);
    assert.match(tracks[1], /<clipitem id="titulo-\d+"><name>titulo-tela<\/name>/);
    assert.match(tracks[1], /<start>0<\/start><end>105<\/end><in>0<\/in><out>105<\/out>/);
    assert.doesNotMatch(xml, /generatoritem|titulo-fundo/);
  });

  it("a caixa do fundo contém o texto inteiro e fica dentro do quadro", () => {
    const L = screenTitleLayout(TITLE, 1080, 1920);
    const textH = L.lines.length * L.lineH;
    assert.ok(L.box.h > textH);
    assert.ok(L.box.y < L.centerY - textH / 2 && L.box.y + L.box.h > L.centerY + textH / 2);
    assert.ok(L.box.x >= SCREEN_TITLE_STYLE.marginPx - 1 && L.box.x + L.box.w <= 1080 - SCREEN_TITLE_STYLE.marginPx + 1);
    assert.ok(L.box.y > 0);
  });

  it("outra largura escala junto (prévia 720x1280)", () => {
    const a = screenTitleLayout(TITLE, 1080, 1920);
    const b = screenTitleLayout(TITLE, 720, 1280);
    assert.ok(Math.abs(b.fontPx - (a.fontPx * 720) / 1080) < 1e-9);
  });

  it("o horizontal continua sem título nem fundo", () => {
    const h = xml.split("<sequence ").slice(1).find((s) => s.includes(SPEC_H.name)) ?? "";
    assert.doesNotMatch(h, /titulo-tela|generatoritem/);
  });

  it("PNG: fundo preto a 70% atrás do texto, no tamanho novo", () => {
    const svg = screenTitleSvg(TITLE, 1080, 1920);
    const { box, fontPx } = screenTitleLayout(TITLE, 1080, 1920);
    assert.match(svg, new RegExp(`<rect x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}" rx="24" ry="24" fill="#000000" fill-opacity="0.7"/>`));
    assert.ok(svg.indexOf("<rect") < svg.indexOf("<text"), "o fundo é desenhado antes (atrás) do texto");
    assert.match(svg, new RegExp(`font-size="${Math.round(fontPx)}"`));
    assert.doesNotMatch(svg, /font-size="80"/);
  });

  it("#12267: raio do PNG escala para 12 px em 540x960", () => {
    assert.equal(SCREEN_TITLE_STYLE.cornerRadiusPx, 24);
    assert.match(screenTitleSvg(TITLE, 540, 960), /rx="12" ry="12"/);
  });

  it("#12267: raio limitado à metade da altura e da largura da caixa", () => {
    // Força cada limite sem alterar as métricas de texto em produção.
    const original = SCREEN_TITLE_STYLE.cornerRadiusPx;
    try {
      Object.defineProperty(SCREEN_TITLE_STYLE, "cornerRadiusPx", { value: 1000 });
      for (const title of [TITLE, "IA"]) {
        const { box } = screenTitleLayout(title, 540, 960);
        const radius = Math.min(box.w, box.h) / 2;
        assert.match(screenTitleSvg(title, 540, 960), new RegExp(`rx="${radius}" ry="${radius}"`));
      }
    } finally {
      Object.defineProperty(SCREEN_TITLE_STYLE, "cornerRadiusPx", { value: original });
    }
  });

  it("modo png não ganha matte extra: o fundo já vem no PNG", () => {
    const x = buildXmeml([plan(SPEC_V)], SOURCE, FRAMING, { screenTitle: { text: TITLE, mode: "png", pngPath: "G:/x/261103_titulo_vertical.png" } });
    assert.doesNotMatch(x, /generatoritem/);
    assert.equal((verticalVideo(x).match(/<track>/g) ?? []).length, 2);
  });
});
