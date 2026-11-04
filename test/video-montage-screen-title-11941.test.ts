/**
 * test/video-montage-screen-title-11941.test.ts — feedback do editor no import
 * da 261103: o título na tela das verticais (#11756)
 *   1. saía grande demais (fontsize 80 no gerador "Text" do FCP7 passava da
 *      largura de 1080 px no Premiere);
 *   2. vinha numa caixa por linha (linhas juntas com `&#13;`);
 *   3. não tinha fundo (pedido: preto a 70%).
 * O XML gerado precisa sair com uma caixa só, tamanho convertido pela premissa
 * declarada (`xmlSizeRefWidth`) e o fundo presente; o PNG de reserva também.
 * Desde o #12091 o gerador só sai com `--title-mode text` (o padrão é o PNG);
 * estes casos passam `mode: "text"` explícito.
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

function paramValue(block: string, pid: string): string | undefined {
  return new RegExp(`<parameterid>${pid}</parameterid><name>[^<]*</name>(?:<valuemin>[^<]*</valuemin><valuemax>[^<]*</valuemax>)?<value>([\\s\\S]*?)</value>`).exec(block)?.[1];
}

describe("#11941 título da vertical: caixa única, tamanho e fundo", () => {
  const xml = buildXmeml([plan(SPEC_H), plan(SPEC_V)], SOURCE, FRAMING, { screenTitle: { text: TITLE, mode: "text" } });
  const video = verticalVideo(xml);
  const gens = video.match(/<generatoritem[\s\S]*?<\/generatoritem>/g) ?? [];
  const text = gens.find((g) => g.includes("<effectid>Text</effectid>")) ?? "";
  const bg = gens.find((g) => g.includes("<effectid>Color</effectid>")) ?? "";

  it("uma caixa só: um gerador de texto, o título inteiro num str, sem entidade de quebra", () => {
    assert.equal(gens.filter((g) => g.includes("<effectid>Text</effectid>")).length, 1);
    const str = paramValue(text, "str") ?? "";
    assert.doesNotMatch(str, /&#13;/, "a entidade CR abria uma caixa por linha no Premiere (261103)");
    // #12091: o Premiere mostrou o `&#10;` literal na tela (261104); a quebra vai como CR literal.
    assert.doesNotMatch(str, /&#10;/);
    assert.equal(SCREEN_TITLE_STYLE.xmlLineBreak, "\r");
    const lines = str.split(SCREEN_TITLE_STYLE.xmlLineBreak);
    assert.ok(lines.length >= 2, "título longo ainda quebra, dentro da mesma caixa");
    assert.equal(lines.join(" "), TITLE, "nenhuma palavra perdida");
  });

  it("tamanho: o fontsize do XML não é mais 80 e a letra resultante cabe na largura com margem", () => {
    const size = Number(paramValue(text, "fontsize"));
    assert.ok(size > 0 && size < 80, `fontsize ${size} (era 80)`);
    // Pela premissa declarada: tamanho na tela = fontsize x largura / xmlSizeRefWidth.
    const onScreen = (size * SPEC_V.width) / SCREEN_TITLE_STYLE.xmlSizeRefWidth;
    const longest = Math.max(...wrapScreenTitle(TITLE).map((l) => l.length));
    const lineW = longest * SCREEN_TITLE_STYLE.avgCharEm * onScreen;
    assert.ok(lineW <= SPEC_V.width - 2 * SCREEN_TITLE_STYLE.marginPx, `linha de ${Math.round(lineW)} px passa de 1080 menos margem`);
    // O 80 antigo, pela mesma premissa, estourava (o defeito do 261103).
    const old = (80 * SPEC_V.width) / SCREEN_TITLE_STYLE.xmlSizeRefWidth;
    assert.ok(20 * SCREEN_TITLE_STYLE.avgCharEm * old > SPEC_V.width);
  });

  it("maxLineChars coerente com a largura útil", () => {
    const st = SCREEN_TITLE_STYLE;
    assert.ok(st.maxLineChars * st.avgCharEm * st.fontPx + 2 * st.padXPx <= st.refWidth - 2 * st.marginPx);
  });

  it("fundo: matte preto com Opacity 70 e Crop na caixa, na faixa abaixo do texto", () => {
    assert.ok(bg, "gerador Color do fundo presente");
    assert.match(bg, /<parameterid>fillcolor<\/parameterid><name>Color<\/name><value><alpha>255<\/alpha><red>0<\/red><green>0<\/green><blue>0<\/blue><\/value>/);
    assert.equal(paramValue(bg, "opacity"), "70");
    const crop = Object.fromEntries(["left", "right", "top", "bottom"].map((k) => [k, Number(paramValue(bg, k))]));
    const { box } = screenTitleLayout(TITLE, SPEC_V.width, SPEC_V.height);
    assert.ok(Math.abs(crop.left - (box.x / 1080) * 100) < 0.01);
    assert.ok(Math.abs(crop.top - (box.y / 1920) * 100) < 0.01);
    assert.ok(Math.abs(100 - crop.left - crop.right - (box.w / 1080) * 100) < 0.02);
    assert.ok(Math.abs(100 - crop.top - crop.bottom - (box.h / 1920) * 100) < 0.02);
    assert.ok(crop.left > 0 && crop.right > 0, "fundo dentro da largura, com margem");
    // Mesmo trecho do texto.
    assert.match(bg, /<start>0<\/start><end>105<\/end><in>0<\/in><out>105<\/out>/);
    // Ordem das faixas: clipes (V1), fundo (V2), texto (V3).
    const tracks = video.split("<track>").slice(1);
    assert.equal(tracks.length, 3);
    assert.match(tracks[1], /titulo-fundo/);
    assert.match(tracks[2], /titulo-tela/);
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
    assert.equal(b.xmlFontSize, a.xmlFontSize, "o fontsize do XML é relativo à largura, igual nas duas");
  });

  it("o horizontal continua sem título nem fundo", () => {
    const h = xml.split("<sequence ").slice(1).find((s) => s.includes(SPEC_H.name)) ?? "";
    assert.doesNotMatch(h, /generatoritem/);
  });

  it("PNG de reserva: fundo preto a 70% atrás do texto, no tamanho novo", () => {
    const svg = screenTitleSvg(TITLE, 1080, 1920);
    const { box, fontPx } = screenTitleLayout(TITLE, 1080, 1920);
    assert.match(svg, new RegExp(`<rect x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}" fill="#000000" fill-opacity="0.7"/>`));
    assert.ok(svg.indexOf("<rect") < svg.indexOf("<text"), "o fundo é desenhado antes (atrás) do texto");
    assert.match(svg, new RegExp(`font-size="${Math.round(fontPx)}"`));
    assert.doesNotMatch(svg, /font-size="80"/);
  });

  it("modo png não ganha matte extra: o fundo já vem no PNG", () => {
    const x = buildXmeml([plan(SPEC_V)], SOURCE, FRAMING, { screenTitle: { text: TITLE, mode: "png", pngPath: "G:/x/261103_titulo_vertical.png" } });
    assert.doesNotMatch(x, /generatoritem/);
    assert.equal((verticalVideo(x).match(/<track>/g) ?? []).length, 2);
  });
});
