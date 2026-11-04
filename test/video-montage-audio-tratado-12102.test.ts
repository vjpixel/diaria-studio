/**
 * test/video-montage-audio-tratado-12102.test.ts — a faixa de áudio tratada
 * do `build` (#12102). O editor aplicava o Enhance do Adobe Podcast
 * (Background 0%, Speech 40%) no Premiere, e o XML entregava o áudio cru do
 * bruto (pausas a -40/-46 dB). Decisão de 04/11/2026: usar sempre, aproximando
 * com ffmpeg (`afftdn` + `agate`, limiar do silêncio medido), com os clipitem de
 * áudio do XML e a prévia apontando para a faixa tratada; o vídeo segue o bruto.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AUDIO_CLEAN,
  audioCleanArgs,
  audioCleanFilter,
  audioCleanParams,
  buildXmeml,
  previewClipArgs,
  type PlannedClip,
  type SequencePlan,
  type SequenceSpec,
  type SourceInfo,
} from "../scripts/lib/diaria/video-montage.ts";
import { cleanAudioFileName, cleanAudioXmlPath, renderCleanAudio, xmlVersionHashOf, type XmlBuildOptions } from "../scripts/video-montagem.ts";

const SOURCE: SourceInfo = { path: "G:/Meu Drive/YouTube/261103/bruto.mp4", fps: 30, durationS: 600, width: 3840, height: 2160, mirrored: false };
const FRAMING = { faceX: 0.5, eyeY: 0.5 };
const SPEC: SequenceSpec = { target: "youtube", name: "Diaria comentada_Youtube_V1", width: 1920, height: 1080, order: ["titulo", "comentario"], scales: [60, 85] };
const clip = (block: PlannedClip["block"], seqStart: number, len: number, frameIn: number): PlannedClip => ({
  block, srcIn: frameIn / 30, srcOut: (frameIn + len) / 30, frameIn, frameOut: frameIn + len, seqStart, seqEnd: seqStart + len, scale: 60,
});
const PLAN: SequencePlan = { spec: SPEC, clips: [clip("titulo", 0, 90, 300), clip("comentario", 90, 300, 900)], durationFrames: 390, script: "", missingBlocks: [], dropped: [] };
const TREATED = "G:/Meu Drive/YouTube/261103/261103_audio_tratado.wav";

describe("#12102: comando do ffmpeg da faixa tratada", () => {
  it("bruto quente da 261028 (limiar de silêncio -35 dB): piso -41 no afftdn, gate em -35 dBFS com 40 dB de atenuação", () => {
    const p = audioCleanParams(-35);
    assert.deepEqual(p, { noiseFloorDb: -41, gateThresholdDb: -35 });
    assert.equal(audioCleanFilter(p), "afftdn=nr=12:nf=-41:tn=1,agate=threshold=0.017783:range=0.01:ratio=8:attack=10:release=150");
  });

  it("o piso do afftdn fica dentro da faixa aceita (-80 a -20)", () => {
    assert.equal(audioCleanParams(-10).noiseFloorDb, -20);
    assert.equal(audioCleanParams(-90).noiseFloorDb, -80);
    assert.equal(audioCleanParams(-45).noiseFloorDb, -51);
  });

  it("args: o áudio inteiro do bruto, sem vídeo, WAV PCM 16 bits mono a 48 kHz", () => {
    const args = audioCleanArgs({ src: "C:/x/bruto.mp4", out: "C:/out/a.wav", filter: "F" });
    assert.deepEqual(args, ["-y", "-v", "error", "-i", "C:/x/bruto.mp4", "-map", "0:a:0", "-vn", "-af", "F", "-ac", "1", "-ar", "48000", "-c:a", "pcm_s16le", "C:/out/a.wav"]);
    assert.ok(!args.includes("-ss"), "sem recorte: a linha do tempo é a do bruto");
    assert.equal(AUDIO_CLEAN.sampleRate, 48000);
  });
});

describe("#12102: os clipitem de áudio do XML apontam para a faixa tratada", () => {
  it("vídeo no bruto (file-1), áudio na faixa tratada (file-audio, definida uma vez), mesmos in/out", () => {
    const xml = buildXmeml([PLAN], SOURCE, FRAMING, { audioPath: TREATED });
    const audio = xml.slice(xml.indexOf("<audio><numOutputChannels>"));
    assert.equal(audio.match(/<file id="file-audio"><name>261103_audio_tratado\.wav<\/name><pathurl>file:\/\/localhost\/G:\/Meu%20Drive\/YouTube\/261103\/261103_audio_tratado\.wav<\/pathurl>/g)?.length, 1);
    assert.equal(audio.match(/<file id="file-audio"\/>/g)?.length, 1);
    assert.doesNotMatch(audio, /file-1/);
    assert.match(audio, /<channelcount>1<\/channelcount>/);
    assert.match(audio, /<clipitem id="a2">.*<in>900<\/in><out>1200<\/out>/s);
    const video = xml.slice(xml.indexOf("<video><format>"), xml.indexOf("<audio><numOutputChannels>"));
    assert.match(video, /<file id="file-1"><name>bruto\.mp4<\/name>/);
    assert.doesNotMatch(video, /file-audio/);
  });

  it("sem faixa tratada (falha no render ou --no-audio-clean): o XML é o de antes, áudio no bruto", () => {
    const xml = buildXmeml([PLAN], SOURCE, FRAMING, {});
    assert.doesNotMatch(xml, /file-audio/);
    assert.equal(xml, buildXmeml([PLAN], SOURCE, FRAMING, { audioPath: null }));
    assert.equal(xml.slice(xml.indexOf("<audio><numOutputChannels>")).match(/<file id="file-1"\/>/g)?.length, 2);
  });

  it("caminho no XML: ao lado do bruto no Neo, com o nome da edição", () => {
    assert.equal(cleanAudioFileName("261103"), "261103_audio_tratado.wav");
    assert.equal(cleanAudioXmlPath("G:\\Meu Drive\\YouTube\\261103\\bruto.mp4", "261103"), TREATED);
  });

  it("versão do XML: sem faixa tratada o hash é o de antes; com ela, muda", () => {
    const base: XmlBuildOptions = { speechDetect: true, audioRefine: true, audioGain: true, titleMode: "png" };
    assert.equal(xmlVersionHashOf("h", PLAN, base), xmlVersionHashOf("h", PLAN, { ...base, audioClean: null }));
    assert.notEqual(xmlVersionHashOf("h", PLAN, base), xmlVersionHashOf("h", PLAN, { ...base, audioClean: "afftdn" }));
  });
});

describe("#12102: prévia com a faixa tratada", () => {
  it("o áudio do clipe vem da faixa tratada, nos mesmos tempos do vídeo", () => {
    const args = previewClipArgs({ src: "b.mp4", audioSrc: "t.wav", start: 10, end: 12, crop: { x: 0, y: 0, w: 100, h: 100 }, mirrored: false, fps: 30, out: "c.mp4" });
    assert.deepEqual(args.slice(3, 17), ["-ss", "10.000", "-to", "12.000", "-i", "b.mp4", "-ss", "10.000", "-to", "12.000", "-i", "t.wav", "-map", "0:v:0"]);
    assert.ok(args.includes("1:a:0"));
    assert.deepEqual(previewClipArgs({ src: "b.mp4", start: 10, end: 12, crop: { x: 0, y: 0, w: 100, h: 100 }, mirrored: false, fps: 30, out: "c.mp4" }).filter((a) => a === "-i").length, 1);
  });
});

describe("#12102: render fail-soft e reaproveitamento", () => {
  const dirs = () => {
    const root = mkdtempSync(join(tmpdir(), "audio-tratado-12102-"));
    const src = join(root, "bruto.mp4");
    writeFileSync(src, "bruto");
    return { root, src, outDir: join(root, "out"), stateDir: join(root, "state") };
  };

  it("ffmpeg falho: null e aviso (o build segue com o áudio cru)", () => {
    const d = dirs();
    try {
      const warns: string[] = [];
      const r = renderCleanAudio({ src: d.src, outDir: d.outDir, stateDir: d.stateDir, edition: "261103", mediaPath: SOURCE.path, thresholdDb: -35 }, {
        ffmpeg: () => { throw new Error("ffmpeg: command not found"); },
        warn: (m) => warns.push(m),
      });
      assert.equal(r, null);
      assert.equal(warns.length, 1);
      assert.match(warns[0], /áudio cru do bruto/);
      assert.match(warns[0], /ffmpeg: command not found/);
    } finally { rmSync(d.root, { recursive: true, force: true }); }
  });

  it("sucesso: grava a faixa, devolve o caminho do XML; 2º build com o mesmo bruto e filtro reaproveita sem rodar o ffmpeg", () => {
    const d = dirs();
    try {
      const calls: string[][] = [];
      const ffmpeg = (args: string[]) => { calls.push(args); writeFileSync(args[args.length - 1], "wav"); };
      const input = { src: d.src, outDir: d.outDir, stateDir: d.stateDir, edition: "261103", mediaPath: SOURCE.path, thresholdDb: -35 };
      const r = renderCleanAudio(input, { ffmpeg, warn: () => assert.fail("sem aviso"), info: () => {} });
      assert.ok(r);
      assert.equal(r.xmlPath, TREATED);
      assert.ok(existsSync(join(d.outDir, "261103_audio_tratado.wav")));
      assert.equal(readFileSync(r.path, "utf8"), "wav");
      assert.equal(calls.length, 1);
      assert.ok(calls[0].includes(audioCleanFilter(audioCleanParams(-35))));
      const again = renderCleanAudio(input, { ffmpeg, info: () => {} });
      assert.deepEqual(again, r);
      assert.equal(calls.length, 1, "reaproveitou");
      // Limiar diferente (silêncios redetectados) = filtro novo = renderiza de novo.
      renderCleanAudio({ ...input, thresholdDb: -40 }, { ffmpeg, info: () => {} });
      assert.equal(calls.length, 2);
    } finally { rmSync(d.root, { recursive: true, force: true }); }
  });
});
