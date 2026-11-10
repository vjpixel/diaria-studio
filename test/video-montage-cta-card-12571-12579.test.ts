/**
 * test/video-montage-cta-card-12571-12579.test.ts
 *
 * #12571 — o CTA padrão é o card (decisão do editor, 09/11/2026): o card entra
 * como último clipe da V1 em todas as sequências (4 s, fade-in de 0,5 s
 * embutido no MP4, sem áudio), os CTAs falados viram opcionais, e o
 * verify-xml/review contam com ele. Na 261109 o card entrou à mão no Premiere.
 *
 * #12579 — legendas só depois da aprovação das prévias: a prévia com SRT
 * ausente ou mais velho que o build sai sem legenda e com aviso, em vez de
 * recusar (na 261109 isso custou uma rodada de legendas jogada fora).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import {
  CTA_CARD,
  CTA_CARD_DEFAULT_SHARE,
  ctaCardClipItem,
  ctaCardFrames,
  ctaCardLayout,
  ctaCardPreviewClipArgs,
  ctaCardRenderArgs,
  ctaCardSvg,
  ctaCardXmlIssues,
  ctaShareLine,
  wrapCardText,
  type CtaCardAsset,
} from "../scripts/lib/diaria/video-cta-card.ts";
import {
  OPTIONAL_BLOCKS,
  buildSequencePlan,
  buildXmeml,
  parseBlocksFile,
  type PlannedClip,
  type ResolvedItem,
  type SequencePlan,
  type SequenceSpec,
  type SourceInfo,
  type Word,
} from "../scripts/lib/diaria/video-montage.ts";
import { parseXmlAudio, xmlPlanIssues } from "../scripts/lib/diaria/video-xml-verify.ts";
import { previewSubtitleDecision, renderCtaCard, reviewCardScope, sequenceHasSpokenCta, xmlVersionHashOf, type XmlBuildOptions } from "../scripts/video-montagem.ts";

const SOURCE: SourceInfo = { path: "G:/Meu Drive/YouTube/261109/bruto.mp4", fps: 30, durationS: 600, width: 3840, height: 2160, mirrored: false };
const FRAMING = { faceX: 0.5, eyeY: 0.5 };
const SPEC_H: SequenceSpec = { target: "youtube", name: "Diaria comentada_Youtube_V1", width: 1920, height: 1080, order: ["titulo", "comentario", "cta_yt", "fecho"], scales: [60, 85] };
const SPEC_V: SequenceSpec = { target: "outras-redes", name: "Diaria comentada_Vertical_V1", width: 1080, height: 1920, order: ["titulo", "comentario", "cta_vertical", "fecho"], scales: [115, 130] };

function clip(block: PlannedClip["block"], seqStart: number, len: number, frameIn: number): PlannedClip {
  return { block, srcIn: frameIn / 30, srcOut: (frameIn + len) / 30, frameIn, frameOut: frameIn + len, seqStart, seqEnd: seqStart + len, scale: 115 };
}
function plan(spec: SequenceSpec, clips: PlannedClip[]): SequencePlan {
  return { spec, clips, durationFrames: clips.length ? clips[clips.length - 1].seqEnd : 0, script: "", missingBlocks: [], dropped: [] };
}
const card = (spec: SequenceSpec, path = "/cache/out/261109_cta_card_vertical-abc.mp4"): CtaCardAsset => ({
  path,
  xmlPath: `G:/Meu Drive/YouTube/261109/${path.split("/").pop()}`,
  width: spec.width,
  height: spec.height,
  fps: 30,
  frames: ctaCardFrames(30),
  share: CTA_CARD_DEFAULT_SHARE,
});

describe("card de CTA: conteúdo (#12571)", () => {
  it("linha de compartilhar: default genérico, frase inteira ou só o complemento", () => {
    assert.equal(ctaShareLine(undefined), "Compartilhe com quem se interessa por IA");
    assert.equal(ctaShareLine("  "), CTA_CARD_DEFAULT_SHARE);
    assert.equal(ctaShareLine("quem usa o ChatGPT"), "Compartilhe com quem usa o ChatGPT");
    assert.equal(ctaShareLine("compartilhe com quem usa o ChatGPT"), "Compartilhe com quem usa o ChatGPT");
  });

  it("o SVG tem o fundo #111111, o 'Gostou?', o fio teal e os 3 itens; o texto é escapado", () => {
    const svg = ctaCardSvg({ width: 1080, height: 1920, share: "quem usa <ChatGPT> & cia" });
    assert.match(svg, /fill="#111111"/);
    assert.match(svg, />Gostou\?</);
    assert.match(svg, /fill="#00A0A0"/);
    assert.match(svg, />Curta o vídeo</);
    assert.match(svg, />Siga a diar\.ia\.br</);
    assert.match(svg, /&lt;ChatGPT&gt; &amp;/);
    assert.match(svg, /font-weight="700"[^>]*>Gostou/);
    assert.match(svg, /Georgia/);
  });

  it("a linha longa quebra na vertical (cabe na largura) e não quebra no horizontal", () => {
    const v = ctaCardLayout(1080, 1920, CTA_CARD_DEFAULT_SHARE);
    const h = ctaCardLayout(1920, 1080, CTA_CARD_DEFAULT_SHARE);
    assert.ok(v.rows[1].lines.length >= 2, `vertical: ${JSON.stringify(v.rows[1].lines)}`);
    for (const l of v.rows.flatMap((r) => r.lines)) assert.ok(l.length <= v.maxChars, l);
    assert.equal(h.rows[1].lines.length, 1);
    assert.deepEqual(wrapCardText("a b c", 3), ["a b", "c"]);
  });

  it("o SVG renderiza no tamanho da sequência (vertical e horizontal)", async () => {
    for (const [w, hgt] of [[1080, 1920], [1920, 1080]] as const) {
      const meta = await sharp(Buffer.from(ctaCardSvg({ width: w, height: hgt }))).png().metadata();
      assert.equal(meta.width, w);
      assert.equal(meta.height, hgt);
    }
  });

  it("ffmpeg: 4 s com fade-in de 0,5 s do preto, sem áudio; a prévia ganha áudio em silêncio e o formato de pixel dos clipes", () => {
    const a = ctaCardRenderArgs({ png: "c.png", out: "c.mp4", fps: 30 });
    assert.ok(a.includes("-an"));
    assert.equal(a[a.indexOf("-t") + 1], "4.000");
    assert.match(a[a.indexOf("-vf") + 1], /^fade=t=in:st=0:d=0\.5,/);
    assert.equal(CTA_CARD.durationS, 4);
    assert.equal(ctaCardFrames(30), 120);
    const p = ctaCardPreviewClipArgs({ src: "c.mp4", out: "x.mp4", fps: 30, width: 720, height: 1280, pixFmt: "yuv420p10le" });
    assert.ok(p.includes("anullsrc=r=48000:cl=stereo"));
    assert.match(p[p.indexOf("-vf") + 1], /scale=720:1280.*format=yuv420p10le$/);
    const bad = ctaCardPreviewClipArgs({ src: "c.mp4", out: "x.mp4", fps: 30, width: 720, height: 1280, pixFmt: "yuv;rm" });
    assert.doesNotMatch(bad[bad.indexOf("-vf") + 1], /format=/);
  });
});

describe("card de CTA no XML (#12571)", () => {
  const pv = plan(SPEC_V, [clip("titulo", 0, 90, 300), clip("fecho", 90, 60, 900)]);
  const ph = plan(SPEC_H, [clip("titulo", 0, 90, 300), clip("fecho", 90, 60, 900)]);

  it("último clipe da V1, logo depois da fala; a sequência dura a montagem + o card; nenhum clipe de áudio a mais", () => {
    const asset = card(SPEC_V);
    const xml = buildXmeml([pv], SOURCE, FRAMING, { ctaCard: { "outras-redes": asset } });
    const v1 = xml.slice(xml.indexOf("<video><format>"), xml.indexOf("</track>", xml.indexOf("<video><format>")));
    assert.match(v1, /<clipitem id="cta-card-1"><name>cta-card<\/name>[\s\S]*<start>150<\/start><end>270<\/end><in>0<\/in><out>120<\/out>/);
    assert.ok(v1.lastIndexOf('id="cta-card-1"') > v1.lastIndexOf('id="v2"'), "o card vem depois do último clipe do bruto");
    assert.match(xml, /<name>Diaria comentada_Vertical_V1<\/name><duration>270<\/duration>/);
    assert.match(xml, /<file id="file-cta-card"><name>261109_cta_card_vertical-abc\.mp4<\/name><pathurl>file:\/\/localhost\/G:\/Meu%20Drive\/YouTube\/261109\/261109_cta_card_vertical-abc\.mp4<\/pathurl>/);
    // O áudio segue só com os clipes do bruto: o verify-xml não muda.
    const parsed = parseXmlAudio(xml);
    assert.equal(parsed.clips.length, 2);
    assert.deepEqual(xmlPlanIssues(parsed, { clips: 2, durationFrames: pv.durationFrames }), []);
    assert.deepEqual(ctaCardXmlIssues(xml, { durationFrames: pv.durationFrames, cardFrames: asset.frames }), []);
  });

  it("um <file> por MP4: duas sequências do mesmo formato referenciam o mesmo arquivo", () => {
    const pv2 = plan({ ...SPEC_V, target: "instagram", name: "Diaria comentada_Vertical_V1-x", corte: "x" }, pv.clips);
    const asset = card(SPEC_V);
    const xml = buildXmeml([pv, pv2], SOURCE, FRAMING, { ctaCard: { "outras-redes": asset, x: asset } });
    assert.equal((xml.match(/<file id="file-cta-card"><name>/g) ?? []).length, 1);
    assert.equal((xml.match(/<file id="file-cta-card"\/>/g) ?? []).length, 1);
  });

  it("sem ctaCard o XML fica como antes (sem clipe de card, duração da montagem)", () => {
    const xml = buildXmeml([ph], SOURCE, FRAMING, {});
    assert.doesNotMatch(xml, /cta-card/);
    assert.match(xml, /<duration>150<\/duration>/);
    assert.deepEqual(ctaCardXmlIssues(xml, { durationFrames: 150, cardFrames: null }), []);
  });

  it("verify-xml acusa card ausente, fora do lugar, com outra duração ou inesperado", () => {
    const asset = card(SPEC_H, "/o/261109_cta_card_horizontal-abc.mp4");
    const ok = buildXmeml([ph], SOURCE, FRAMING, { ctaCard: { youtube: asset } });
    const without = buildXmeml([ph], SOURCE, FRAMING, {});
    assert.match(ctaCardXmlIssues(without, { durationFrames: 150, cardFrames: 120 }).join(), /ausente/);
    assert.match(ctaCardXmlIssues(ok, { durationFrames: 150, cardFrames: null }).join(), /plano não tem card/);
    assert.match(ctaCardXmlIssues(ok, { durationFrames: 140, cardFrames: 120 }).join(), /começa no quadro 150/);
    assert.match(ctaCardXmlIssues(ok, { durationFrames: 150, cardFrames: 90 }).join(), /120 quadros no XML, 90 no plano/);
  });

  it("o card entra no hash da versão do XML (card novo = _V{n} novo); sem card o hash fica o de antes", () => {
    const opts: XmlBuildOptions = { speechDetect: true, audioRefine: true, audioGain: true, titleMode: "png" };
    const base = xmlVersionHashOf("h", ph, opts);
    assert.equal(xmlVersionHashOf("h", ph, { ...opts, ctaCard: {} }), base);
    const a = xmlVersionHashOf("h", ph, { ...opts, ctaCard: { youtube: card(SPEC_H, "/o/a-1.mp4") } });
    assert.notEqual(a, base);
    // O caminho local da prévia não muda o XML.
    assert.equal(xmlVersionHashOf("h", ph, { ...opts, ctaCard: { youtube: { ...card(SPEC_H, "/o/a-1.mp4"), path: "/outro/a-1.mp4" } } }), a);
    assert.notEqual(xmlVersionHashOf("h", ph, { ...opts, ctaCard: { youtube: card(SPEC_H, "/o/a-2.mp4") } }), a);
  });
});

describe("CTA falado vira opcional (#12571)", () => {
  const item = (start: number, end: number, text: string): ResolvedItem => {
    const words: Word[] = text.split(" ").map((t, i) => ({ text: t, start: start + i * 0.3, end: start + i * 0.3 + 0.25 }));
    return { interval: { start, end }, text, words, lastWordEnd: words[words.length - 1].end, holdLimit: end + 2, how: "explicit" };
  };

  it("sequência sem cta_* gravado não acusa bloco faltando; outro bloco faltando continua acusado", () => {
    for (const k of ["cta_yt", "cta_vertical", "cta_ig", "cta_out"] as const) assert.ok(OPTIONAL_BLOCKS.includes(k), k);
    const blocks = { titulo: [item(1, 3, "Título aqui")], comentario: [item(5, 8, "Um comentário curto")], fecho: [item(10, 12, "Até amanhã")] };
    const p = buildSequencePlan(SPEC_V, blocks, [], { fps: 30, durationS: 40 });
    assert.deepEqual(p.missingBlocks, []);
    assert.equal(sequenceHasSpokenCta(p), false);
    const withResumo = buildSequencePlan({ ...SPEC_V, order: ["titulo", "resumo_curto", "comentario", "fecho"] }, blocks, [], { fps: 30, durationS: 40 });
    assert.deepEqual(withResumo.missingBlocks, ["resumo_curto"]);
    const spoken = buildSequencePlan(SPEC_V, { ...blocks, cta_vertical: [item(13, 15, "Siga a diária")] }, [], { fps: 30, durationS: 40 });
    assert.equal(sequenceHasSpokenCta(spoken), true);
  });

  it("blocks.json: ctaCard booleano e ctaShare texto (arquivo e sequência)", () => {
    const base = { edition: "261109", blocks: { titulo: [{ text: "x" }] } };
    assert.equal(parseBlocksFile({ ...base, ctaCard: false, ctaShare: "quem usa o ChatGPT" }).ok, true);
    const bad = parseBlocksFile({ ...base, ctaCard: "sim", ctaShare: 3 });
    assert.equal(bad.ok, false);
    if (!bad.ok) {
      assert.ok(bad.errors.some((e) => /ctaCard/.test(e)), bad.errors.join("; "));
      assert.ok(bad.errors.some((e) => /ctaShare/.test(e)), bad.errors.join("; "));
    }
    const seqBad = parseBlocksFile({ ...base, sequences: [{ ...SPEC_V, ctaShare: 1 }] });
    assert.equal(seqBad.ok, false);
    if (!seqBad.ok) assert.ok(seqBad.errors.some((e) => /ctaShare/.test(e)), seqBad.errors.join("; "));
  });
});

describe("renderCtaCard (#12571)", () => {
  it("grava o MP4 no out dir com o nome por conteúdo, aponta o XML para a pasta do bruto e reaproveita no 2º build", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cta-card-"));
    try {
      let renders = 0;
      const render = (png: string, out: string) => {
        renders++;
        assert.ok(existsSync(png), "o PNG intermediário existe antes do render");
        writeFileSync(out, "mp4");
      };
      const input = { outDir: join(dir, "out"), workDir: join(dir, "work"), mediaPath: "G:/Meu Drive/YouTube/261109/bruto.mp4", edition: "261109", width: 1080, height: 1920, fps: 30, share: "quem usa o ChatGPT", render };
      const { mkdirSync } = await import("node:fs");
      mkdirSync(input.outDir, { recursive: true });
      const a = await renderCtaCard(input);
      assert.equal(a.reused, false);
      assert.match(a.asset.path, /261109_cta_card_vertical-[0-9a-f]{16}\.mp4$/);
      assert.equal(readFileSync(a.asset.path, "utf8"), "mp4");
      assert.ok(a.asset.xmlPath.startsWith("G:/Meu Drive/YouTube/261109/261109_cta_card_vertical-"));
      assert.equal(a.asset.frames, 120);
      assert.equal(a.asset.share, "Compartilhe com quem usa o ChatGPT");
      const b = await renderCtaCard(input);
      assert.equal(b.reused, true);
      assert.equal(renders, 1);
      const c = await renderCtaCard({ ...input, share: undefined });
      assert.notEqual(c.asset.path, a.asset.path, "outra linha de compartilhar = outro arquivo");
      const h = await renderCtaCard({ ...input, width: 1920, height: 1080 });
      assert.match(h.asset.path, /_cta_card_horizontal-/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("autorrevisão com o card no fim (#12571)", () => {
  const words: Word[] = [{ text: "Até", start: 9, end: 9.3 }, { text: "amanhã.", start: 9.3, end: 9.8 }];

  it("mede só a montagem: palavras e silêncios do card ficam fora; final e ritmo como antes do card", () => {
    const s = reviewCardScope({ durationS: 14.3, montageS: 10.3, cardS: 4, words, silences: [{ start: 4, end: 4.5 }, { start: 9.8, end: 14.3 }] });
    assert.equal(s.speechS, 10.3);
    assert.deepEqual(s.silences, [{ start: 4, end: 4.5 }, { start: 9.8, end: 10.3 }]);
    assert.deepEqual(s.warnings, []);
    assert.equal(s.words.length, 2);
  });

  it("acusa fala dentro do card e prévia sem o card inteiro", () => {
    const talk = reviewCardScope({ durationS: 14.3, montageS: 10.3, cardS: 4, words: [...words, { text: "inscreva", start: 11, end: 11.4 }], silences: [] });
    assert.match(talk.warnings.join(), /fala dentro do card de CTA \(inscreva\)/);
    assert.equal(talk.words.length, 2);
    const short = reviewCardScope({ durationS: 10.4, montageS: 10.3, cardS: 4, words, silences: [] });
    assert.match(short.warnings.join(), /não entrou inteiro/);
  });

  it("sem card, nada muda", () => {
    const s = reviewCardScope({ durationS: 10.3, montageS: 10.3, cardS: 0, words, silences: [{ start: 9.8, end: 10.3 }] });
    assert.equal(s.speechS, 10.3);
    assert.deepEqual(s.warnings, []);
    assert.equal(s.cardS, 0);
  });
});

describe("prévia sem legenda até a aprovação (#12579)", () => {
  it("SRT mais velho que o build não recusa mais: sai sem legenda, com aviso", () => {
    const d = previewSubtitleDecision({ srtPath: "x.srt", exists: true, srtMtimeMs: 100, builtAtMs: 200, noSubs: false });
    assert.equal(d.use, false);
    assert.match(d.message ?? "", /^\[aviso\].*mais velho.*sem legenda.*#12579/);
  });

  it("sem SRT: sem legenda com aviso que aponta a ordem nova", () => {
    const d = previewSubtitleDecision({ srtPath: "x.srt", exists: false, builtAtMs: 200, noSubs: false });
    assert.equal(d.use, false);
    assert.match(d.message ?? "", /depois da aprovação das prévias/);
  });

  it("SRT em dia: legenda queimada; --no-subs tira mesmo assim", () => {
    assert.deepEqual(previewSubtitleDecision({ srtPath: "x.srt", exists: true, srtMtimeMs: 300, builtAtMs: 200, noSubs: false }), { use: true, message: null });
    const n = previewSubtitleDecision({ srtPath: "x.srt", exists: true, srtMtimeMs: 300, builtAtMs: 200, noSubs: true });
    assert.equal(n.use, false);
    assert.match(n.message ?? "", /--no-subs/);
  });

  it("o cmdPreview não tem mais o throw do SRT defasado (regressão)", () => {
    const src = readFileSync(join(import.meta.dirname, "..", "scripts", "video-montagem.ts"), "utf8");
    const body = src.slice(src.indexOf("async function cmdPreview("), src.indexOf("function cmdReview("));
    assert.doesNotMatch(body, /rode srt de novo antes da prévia/);
    assert.match(body, /previewSubtitleDecision\(/);
  });
});
