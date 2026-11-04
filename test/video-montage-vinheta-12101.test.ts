/**
 * test/video-montage-vinheta-12101.test.ts — a vinheta do logo diar.ia.br
 * depois do título (#12101). O editor a inseria à mão no Premiere nas 4 de 4
 * edições analisadas (e abria à mão um respiro de ~0,7 s no horizontal):
 *   - o XML leva o MOV (ProRes 4444 com alpha, `publishing.video.vinheta_logo`)
 *     na faixa de vídeo do topo, no fim do bloco `titulo` (sem título: aos 2 s),
 *     com o som numa faixa de áudio própria;
 *   - o horizontal abre o respiro de `VINHETA_BREATH_S` depois do título;
 *   - sem o arquivo, o build segue sem vinheta e avisa.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { speechJoinWarnings } from "../scripts/lib/diaria/video-cut-refine.ts";
import {
  VINHETA_AFTER_SPEECH_S,
  VINHETA_BREATH_S,
  titleBreathS,
  blockRunEndFrame,
  buildSequencePlan,
  buildXmeml,
  parseVinhetaProbe,
  previewVinhetaFilter,
  vinhetaBreathFor,
  vinhetaConfigFrom,
  vinhetaScalePct,
  vinhetaSpan,
  type PlannedClip,
  type ResolvedItem,
  type SequencePlan,
  type SequenceSpec,
  type SourceInfo,
  type VinhetaAsset,
  type Word,
} from "../scripts/lib/diaria/video-montage.ts";
import { loadVinheta, xmlVersionHashOf, type XmlBuildOptions } from "../scripts/video-montagem.ts";

const SOURCE: SourceInfo = { path: "G:/Meu Drive/YouTube/261103/bruto.mp4", fps: 30, durationS: 600, width: 3840, height: 2160, mirrored: false };
const FRAMING = { faceX: 0.5, eyeY: 0.5 };
const SPEC_H: SequenceSpec = { target: "youtube", name: "Diaria comentada_Youtube_V1", width: 1920, height: 1080, order: ["titulo", "abertura"], scales: [60, 85] };
const SPEC_V: SequenceSpec = { target: "outras-redes", name: "Diaria comentada_Vertical_V1", width: 1080, height: 1920, order: ["titulo", "abertura"], scales: [115, 130] };
const VIN: VinhetaAsset = { path: "G:/Meu Drive/Work/Mentoria Fluxo VTSD/YouTube/_marca/vinheta-logo-diaria.mov", durationS: 1.2, width: 1920, height: 1080, hasAudio: true };

const w = (text: string, start: number, end: number): Word => ({ text, start, end });
const item = (start: number, end: number, text: string, words: Word[], holdLimit: number): ResolvedItem => ({
  interval: { start, end },
  text,
  words,
  lastWordEnd: words.length ? words[words.length - 1].end : null,
  holdLimit,
  how: "explicit",
});

function clip(block: PlannedClip["block"], seqStart: number, len: number, frameIn: number, parts?: PlannedClip["parts"]): PlannedClip {
  return { block, srcIn: frameIn / 30, srcOut: (frameIn + len) / 30, frameIn, frameOut: frameIn + len, seqStart, seqEnd: seqStart + len, scale: 115, ...(parts ? { parts } : {}) };
}
function plan(spec: SequenceSpec, clips: PlannedClip[]): SequencePlan {
  return { spec, clips, durationFrames: clips.length ? clips[clips.length - 1].seqEnd : 0, script: "", missingBlocks: [], dropped: [] };
}

/** Faixas de vídeo/áudio da 1ª sequência do XML, na ordem (V1, V2, ...); o `<video>`/`<audio>` dos `<file>` fica fora. */
function tracks(xml: string, kind: "video" | "audio"): string[] {
  const seq = xml.slice(xml.indexOf("<sequence "), xml.indexOf("</sequence>"));
  const body = kind === "video"
    ? seq.slice(seq.indexOf("<video><format>"), seq.indexOf("<audio><numOutputChannels>"))
    : seq.slice(seq.indexOf("<audio><numOutputChannels>"));
  return body.split("<track>").slice(1);
}

describe("#12101: respiro de 0,7 s depois do título no horizontal", () => {
  it("só o horizontal com título ganha o respiro; verticais e entrevista ficam como estão", () => {
    assert.deepEqual(vinhetaBreathFor(SPEC_H), { titulo: VINHETA_BREATH_S });
    assert.equal(VINHETA_BREATH_S, 0.7);
    assert.equal(vinhetaBreathFor(SPEC_V), undefined);
    assert.equal(vinhetaBreathFor({ target: "youtube", order: ["abertura", "comentario", "cta_yt", "fecho"] }), undefined);
  });

  // título falado 1,0–2,9 s; pausa no bruto até 5,0 s; abertura 5,0–7,0 s.
  const resolved = (holdLimit: number) => ({
    titulo: [item(1, 3, "a vinheta", [w("a", 1, 1.5), w("vinheta", 1.6, 2.9)], holdLimit)],
    abertura: [item(5, 7, "olá eu sou", [w("olá", 5, 5.5), w("eu", 5.6, 6), w("sou", 6.1, 7)], 7)],
  });
  const silences = [{ start: 2.95, end: 5 }];
  const src = { fps: 30, durationS: 600 };

  it("o último trecho do título vai até 0,7 s depois da última palavra, tirado do bruto (sem fala)", () => {
    const p = buildSequencePlan(SPEC_H, resolved(4.9), silences, src, { breathAfter: vinhetaBreathFor(SPEC_H) });
    const titulo = p.clips.filter((c) => c.block === "titulo");
    assert.equal(titulo[titulo.length - 1].srcOut, 3.6);
    assert.equal(p.warnings, undefined);
    // Sem o respiro (a vertical), o título termina antes, no corte da pausa.
    const pv = buildSequencePlan(SPEC_V, resolved(4.9), silences, src, { breathAfter: vinhetaBreathFor(SPEC_V) });
    const tv = pv.clips.filter((c) => c.block === "titulo");
    assert.ok(tv[tv.length - 1].srcOut < 3.2, `vertical sem respiro: ${tv[tv.length - 1].srcOut}`);
    assert.ok(p.durationFrames > pv.durationFrames, "o horizontal ficou mais longo pelo respiro");
  });

  it("encadeado (plano com respiro + vinhetaSpan): a vinheta entra 0,3 s depois da última palavra, DENTRO do respiro", () => {
    const p = buildSequencePlan(SPEC_H, resolved(4.9), silences, src, { breathAfter: vinhetaBreathFor(SPEC_H) });
    assert.equal(p.titleSpeechEndS, 2.9);
    const titulo = p.clips.filter((c) => c.block === "titulo");
    const last = titulo[titulo.length - 1];
    const vs = vinhetaSpan(p, 30, VIN);
    assert.ok(vs);
    // A última palavra (2,9 s do bruto) cai em seqStart + (87 - frameIn); a vinheta, 9 quadros (0,3 s) depois.
    const speechEndSeq = last.seqStart + (Math.round(2.9 * 30) - last.frameIn);
    assert.equal(vs.start, speechEndSeq + Math.round(VINHETA_AFTER_SPEECH_S * 30));
    assert.ok(vs.start < last.seqEnd, `a vinheta (${vs.start}) entra antes do fim do respiro (${last.seqEnd}), não depois`);
    assert.equal(last.seqEnd - vs.start, Math.round((VINHETA_BREATH_S - VINHETA_AFTER_SPEECH_S) * 30), "sobram 0,4 s de respiro com a vinheta já no ar");
    assert.equal(titleBreathS(p, 30), 0.7);
  });

  it("vertical (sem respiro): a fala seguinte vem antes de 0,3 s, a vinheta fica no fim do bloco titulo", () => {
    const p = buildSequencePlan(SPEC_V, resolved(4.9), silences, src, { breathAfter: vinhetaBreathFor(SPEC_V) });
    const titleEnd = blockRunEndFrame(p.clips, "titulo", 30);
    assert.equal(vinhetaSpan(p, 30, VIN)?.start, titleEnd);
  });

  it("fala seguinte logo depois no bruto: o respiro para antes dela e o build avisa", () => {
    const p = buildSequencePlan(SPEC_H, resolved(3.2), silences, src, { breathAfter: vinhetaBreathFor(SPEC_H) });
    const titulo = p.clips.filter((c) => c.block === "titulo");
    assert.equal(titulo[titulo.length - 1].srcOut, 3.2);
    assert.equal(p.warnings?.length, 1);
    assert.match(p.warnings![0], /respiro depois de titulo de 0\.30 s, abaixo dos 0\.7 s/);
    assert.match(p.warnings![0], /a vinheta entra 0\.3 s depois da última palavra e pode cobrir o começo da fala seguinte/);
    assert.doesNotMatch(p.warnings![0], /passa por cima da fala/);
  });

  it("titleBreathS: o respiro efetivo no plano final (o refino que encolhe a saída aparece aqui)", () => {
    const p = { clips: [clip("titulo", 0, 90, 30)], titleSpeechEndS: 3.4 };
    // clipe do bruto 1,0–4,0 s; fala até 3,4 s = 0,6 s de respiro.
    assert.equal(titleBreathS(p, 30), 0.6);
    assert.equal(titleBreathS({ clips: [clip("titulo", 0, 90, 30)] }, 30), null);
    assert.equal(titleBreathS({ clips: [clip("titulo", 0, 30, 30)], titleSpeechEndS: 3.4 }, 30), null, "palavra fora dos clipes");
  });

  it("emenda longa depois do título não avisa quando é o respiro (longJoinOkAfter); sem a opção, avisa", () => {
    const clips = [
      { block: "titulo", frameIn: 30, frameOut: 108, seqStart: 0 },
      { block: "abertura", frameIn: 147, frameOut: 210, seqStart: 78 },
    ];
    const islands = [{ start: 1, end: 2.9 }, { start: 5, end: 7 }];
    assert.ok(speechJoinWarnings(clips, islands, 30).some((w) => /emenda/.test(w)));
    assert.ok(!speechJoinWarnings(clips, islands, 30, { longJoinOkAfter: ["titulo"] }).some((w) => /emenda/.test(w)));
  });
});

describe("#12101: onde a vinheta entra na sequência", () => {
  it("no fim do bloco titulo, com a duração do MOV", () => {
    const p = plan(SPEC_V, [clip("titulo", 0, 60, 300), clip("titulo", 60, 45, 400), clip("abertura", 105, 300, 900)]);
    assert.deepEqual(vinhetaSpan(p, 30, VIN), { start: 105, end: 141, afterTitle: true });
  });

  it("título longo: a vinheta vem depois da fala, sem o teto de 7,5 s do título na tela", () => {
    const p = plan(SPEC_H, [clip("titulo", 0, 300, 300), clip("abertura", 300, 300, 900)]);
    assert.equal(vinhetaSpan(p, 30, VIN)?.start, 300);
  });

  it("sem bloco titulo (vertical soberana, 261029): aos 2 s", () => {
    const p = plan(SPEC_V, [clip("comentario", 0, 900, 300)]);
    assert.deepEqual(vinhetaSpan(p, 30, VIN), { start: 60, end: 96, afterTitle: false });
  });

  it("título fundido num clipe com o gancho: o fim do pedaço do título", () => {
    // gancho 10–12 s e título 12–14 s no bruto num clipe só; abertura em clipe separado.
    const merged = clip("gancho", 0, 120, 300, [
      { block: "gancho", srcIn: 10, srcOut: 12 },
      { block: "titulo", srcIn: 12, srcOut: 14 },
    ]);
    const p = plan(SPEC_H, [merged, clip("abertura", 120, 90, 900)]);
    assert.equal(blockRunEndFrame(p.clips, "titulo", 30), 120);
    // Clipe com o título no meio (gancho, titulo, abertura): fim do pedaço do título.
    const three = clip("gancho", 0, 180, 300, [
      { block: "gancho", srcIn: 10, srcOut: 12 },
      { block: "titulo", srcIn: 12, srcOut: 14 },
      { block: "abertura", srcIn: 14, srcOut: 16 },
    ]);
    assert.equal(blockRunEndFrame([three], "titulo", 30), 120);
  });

  it("sequência que acaba antes: a vinheta é cortada no fim; curta demais = null", () => {
    assert.deepEqual(vinhetaSpan(plan(SPEC_V, [clip("titulo", 0, 60, 300), clip("abertura", 60, 20, 900)]), 30, VIN), { start: 60, end: 80, afterTitle: true });
    assert.equal(vinhetaSpan(plan(SPEC_V, [clip("comentario", 0, 50, 300)]), 30, VIN), null);
  });

  it("escala: cabe no quadro e nunca amplia", () => {
    assert.equal(vinhetaScalePct(VIN, SPEC_H), 100);
    assert.equal(vinhetaScalePct(VIN, SPEC_V), 56.25);
    assert.equal(vinhetaScalePct({ width: 1080, height: 1920 }, SPEC_V), 100);
    assert.equal(vinhetaScalePct({ width: 960, height: 540 }, SPEC_H), 100);
  });
});

describe("#12101: a vinheta no XML", () => {
  const V = plan(SPEC_V, [clip("titulo", 0, 60, 300), clip("abertura", 60, 300, 900)]);
  const H = plan(SPEC_H, [clip("titulo", 0, 90, 300), clip("abertura", 90, 300, 900)]);

  it("vertical: na faixa de vídeo do topo, acima do bruto e do título (PNG), com o som numa faixa de áudio própria", () => {
    const xml = buildXmeml([V], SOURCE, FRAMING, { screenTitle: { text: "Título", mode: "png", pngPath: "G:/x/titulo.png" }, vinheta: VIN });
    const video = tracks(xml, "video");
    assert.equal(video.length, 3, "V1 bruto, V2 título, V3 vinheta");
    assert.match(video[1], /titulo-tela/);
    assert.match(video[2], /<clipitem id="vinheta-v1"><name>vinheta-logo<\/name>/);
    assert.match(video[2], /<start>60<\/start><end>96<\/end><in>0<\/in><out>36<\/out>/);
    assert.match(video[2], /<pathurl>file:\/\/localhost\/G:\/Meu%20Drive\/Work\/Mentoria%20Fluxo%20VTSD\/YouTube\/_marca\/vinheta-logo-diaria\.mov<\/pathurl>/);
    assert.match(video[2], /<width>1920<\/width><height>1080<\/height>/);
    assert.match(video[2], /<parameterid>scale<\/parameterid><name>Scale<\/name><valuemin>0<\/valuemin><valuemax>1000<\/valuemax><value>56\.25<\/value>/);
    const audio = tracks(xml, "audio");
    assert.equal(audio.length, 2, "A1 bruto, A2 som da vinheta");
    assert.match(audio[1], /<clipitem id="vinheta-a1">/);
    assert.match(audio[1], /<start>60<\/start><end>96<\/end>/);
    assert.match(audio[1], /<linkclipref>vinheta-v1<\/linkclipref>/);
  });

  it("horizontal (sem título na tela): V2 = vinheta, escala 100, no fim do título falado", () => {
    const xml = buildXmeml([H], SOURCE, FRAMING, { vinheta: VIN });
    const video = tracks(xml, "video");
    assert.equal(video.length, 2);
    assert.match(video[1], /<start>90<\/start><end>126<\/end>/);
    assert.match(video[1], /<value>100<\/value>/);
  });

  it("MOV sem som: nenhuma faixa de áudio extra, sem link de áudio", () => {
    const xml = buildXmeml([H], SOURCE, FRAMING, { vinheta: { ...VIN, hasAudio: false } });
    assert.equal(tracks(xml, "audio").length, 1);
    assert.doesNotMatch(xml, /vinheta-a1/);
    assert.doesNotMatch(tracks(xml, "video")[1], /<audio>/);
  });

  it("duas sequências no mesmo XML: o <file> da vinheta é definido uma vez e referenciado depois", () => {
    const xml = buildXmeml([H, V], SOURCE, FRAMING, { vinheta: VIN });
    assert.equal(xml.match(/<file id="file-vinheta"><name>/g)?.length, 1);
    assert.equal(xml.match(/<file id="file-vinheta"\/>/g)?.length, 3, "áudio da 1ª + vídeo e áudio da 2ª");
    assert.match(xml, /vinheta-v2/);
  });

  it("fps, canais e taxa do MOV vêm do probe e vão no <file> (o clipitem fica na taxa da sequência)", () => {
    const vin = parseVinhetaProbe(
      JSON.stringify({ streams: [{ codec_type: "video", width: 1920, height: 1080, r_frame_rate: "25/1" }, { codec_type: "audio", channels: 1, sample_rate: "44100" }], format: { duration: "1.2" } }),
      VIN.path,
    );
    assert.deepEqual({ fps: vin.fps, ch: vin.audioChannels, sr: vin.audioSampleRate }, { fps: 25, ch: 1, sr: 44100 });
    const xml = buildXmeml([H], SOURCE, FRAMING, { vinheta: vin });
    const file = xml.slice(xml.indexOf('<file id="file-vinheta">'), xml.indexOf("</file>", xml.indexOf('<file id="file-vinheta">')));
    assert.match(file, /<rate><timebase>25<\/timebase><ntsc>FALSE<\/ntsc><\/rate><duration>30<\/duration>/);
    assert.match(file, /<samplerate>44100<\/samplerate><\/samplecharacteristics><channelcount>1<\/channelcount>/);
    assert.match(xml, /<clipitem id="vinheta-v1"><name>vinheta-logo<\/name><enabled>TRUE<\/enabled><duration>36<\/duration>\n<rate><timebase>30<\/timebase>/);
    // r_frame_rate ilegível: sem fps, o XML declara o da sequência.
    assert.equal(parseVinhetaProbe(JSON.stringify({ streams: [{ codec_type: "video", width: 2, height: 2, r_frame_rate: "0/0" }], format: { duration: "1" } }), "x").fps, undefined);
  });

  it("sem vinheta (arquivo ausente): o XML é o de antes, sem nenhum clipe dela", () => {
    const xml = buildXmeml([V], SOURCE, FRAMING, {});
    assert.doesNotMatch(xml, /vinheta/);
    assert.equal(xml, buildXmeml([V], SOURCE, FRAMING, { vinheta: null }));
  });
});

describe("#12101: config, arquivo ausente e probe", () => {
  it("o platform.config.json real aponta um MOV em publishing.video.vinheta_logo.path", () => {
    const cfg = vinhetaConfigFrom(JSON.parse(readFileSync(join(import.meta.dirname, "..", "platform.config.json"), "utf8")));
    assert.ok(cfg);
    assert.match(cfg.path, /\.mov$/i);
  });

  it("config sem caminho, vazio ou não string = null", () => {
    assert.equal(vinhetaConfigFrom({}), null);
    assert.equal(vinhetaConfigFrom({ publishing: { video: { vinheta_logo: { path: "  " } } } }), null);
    assert.equal(vinhetaConfigFrom({ publishing: { video: { vinheta_logo: { path: 3 } } } }), null);
  });

  const config = { publishing: { video: { vinheta_logo: { path: VIN.path } } } };
  const probeJson = JSON.stringify({
    streams: [{ codec_type: "video", codec_name: "prores", width: 1920, height: 1080 }, { codec_type: "audio" }],
    format: { duration: "1.200000" },
  });

  it("arquivo ausente nesta máquina: sem vinheta e um aviso com o caminho (nunca falha)", () => {
    const warns: string[] = [];
    const v = loadVinheta({ readConfig: () => config, exists: () => false, probe: () => { throw new Error("não deveria medir"); }, warn: (m) => warns.push(m) });
    assert.equal(v, null);
    assert.equal(warns.length, 1);
    assert.ok(warns[0].includes(VIN.path), warns[0]);
    assert.match(warns[0], /XML sem a vinheta/);
  });

  it("config sem a chave: sem vinheta e aviso", () => {
    const warns: string[] = [];
    assert.equal(loadVinheta({ readConfig: () => ({}), warn: (m) => warns.push(m) }), null);
    assert.match(warns[0], /vinheta_logo\.path/);
  });

  it("probe falho: sem vinheta e aviso", () => {
    const warns: string[] = [];
    const v = loadVinheta({ readConfig: () => config, exists: () => true, probe: () => JSON.stringify({ streams: [{ codec_type: "audio" }], format: { duration: "1" } }), warn: (m) => warns.push(m) });
    assert.equal(v, null);
    assert.match(warns[0], /vinheta do logo ilegível/);
  });

  it("arquivo presente: o asset medido pelo ffprobe, sem aviso", () => {
    const warns: string[] = [];
    const v = loadVinheta({ readConfig: () => config, exists: () => true, probe: () => probeJson, warn: (m) => warns.push(m) });
    assert.deepEqual(v, VIN);
    assert.deepEqual(warns, []);
    assert.deepEqual(parseVinhetaProbe(JSON.stringify({ streams: [{ codec_type: "video", width: 1080, height: 1920, duration: "2.5" }] }), "x.mov"), { path: "x.mov", durationS: 2.5, width: 1080, height: 1920, hasAudio: false });
  });
});

describe("#12101: prévia e versão do XML", () => {
  it("a prévia sobrepõe o MOV no mesmo instante, legenda por cima, som misturado antes do loudnorm", () => {
    const f = previewVinhetaFilter({ startS: 3.5, scale: 0.375, hasAudio: true, subtitles: "subtitles=leg.srt", loudnorm: "loudnorm=I=-16" });
    assert.match(f, /\[1:v\]format=yuva420p,scale=iw\*0\.375:-2,setpts=PTS-STARTPTS\+3\.500\/TB\[vin\]/);
    assert.match(f, /\[0:v\]\[vin\]overlay=\(W-w\)\/2:\(H-h\)\/2:eof_action=pass,subtitles=leg\.srt\[vout\]/);
    assert.match(f, /\[1:a\]adelay=3500\|3500/);
    assert.match(f, /amix=inputs=2:duration=first:normalize=0,loudnorm=I=-16\[aout\]/);
    const mudo = previewVinhetaFilter({ startS: 2, scale: 1, hasAudio: false, loudnorm: "loudnorm=I=-16" });
    assert.doesNotMatch(mudo, /\[1:a\]/);
    assert.match(mudo, /\[0:a\]loudnorm=I=-16\[aout\]/);
    assert.match(mudo, /eof_action=pass\[vout\]/);
  });

  it("versão do XML: sem vinheta o hash é o de antes; com ela, muda", () => {
    const base: XmlBuildOptions = { speechDetect: true, audioRefine: true, audioGain: true, titleMode: "png" };
    const p = plan(SPEC_H, [clip("titulo", 0, 90, 300)]);
    assert.equal(xmlVersionHashOf("abc", p, base), xmlVersionHashOf("abc", p, { ...base, vinheta: null }));
    assert.notEqual(xmlVersionHashOf("abc", p, base), xmlVersionHashOf("abc", p, { ...base, vinheta: VIN }));
    // O asset inteiro conta: o mesmo arquivo reexportado em outro tamanho ou sem som muda o XML.
    assert.notEqual(xmlVersionHashOf("abc", p, { ...base, vinheta: VIN }), xmlVersionHashOf("abc", p, { ...base, vinheta: { ...VIN, width: 1080, height: 1920 } }));
    assert.notEqual(xmlVersionHashOf("abc", p, { ...base, vinheta: VIN }), xmlVersionHashOf("abc", p, { ...base, vinheta: { ...VIN, hasAudio: false } }));
  });
});
