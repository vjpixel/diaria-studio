/**
 * #13536: lacunas do trecho inserido (formato react, #13437). (1) O
 * `review-final` não acusa a fala do vídeo citado como fala extra e compara o
 * resto no tempo do plano; (2) o áudio do trecho recebe o ganho medido nele;
 * (3) a prévia, que segue sem o trecho, avisa.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { defaultSequences, type SequencePlan, type Word } from "../scripts/lib/diaria/video-montage.ts";
import {
  intervalsSemTrechos,
  planTimeToExport,
  trechoExportSpans,
  trechoInseridoTracksXml,
  trechoRipple,
  wordsSemTrechos,
  type TrechoInseridoClip,
} from "../scripts/lib/diaria/video-trecho-inserido.ts";
import { checkTextWithTrechos, measureTrechoGain, previewTrechosAviso } from "../scripts/video-montagem.ts";
import { checkText } from "../scripts/lib/diaria/video-final-review.ts";

const clip = (over: Partial<TrechoInseridoClip> = {}): TrechoInseridoClip => ({
  id: "H3",
  at: 60, // 2 s no plano (30 fps)
  frames: 45, // 1,5 s
  path: "/out/261120_trecho_H3-0123.mov",
  xmlPath: "G:/x/261120_trecho_H3-0123.mov",
  width: 1920,
  height: 1080,
  video: "youtu.be/abc",
  inicioS: 10,
  fimS: 11.5,
  fonte: "/v/fonte.mp4",
  ...over,
});

describe("#13536 tempo do export x tempo do plano", () => {
  it("as palavras do trecho saem e as seguintes voltam 1,5 s", () => {
    const spans = trechoExportSpans([clip()], 30);
    assert.deepEqual(spans, [{ id: "H3", start: 2, end: 3.5 }]);
    const r = wordsSemTrechos([{ start: 1, end: 1.5, text: "antes" }, { start: 2.2, end: 2.6, text: "citado" }, { start: 3.6, end: 4, text: "depois" }], spans);
    assert.deepEqual(r.dropped.map((w) => w.text), ["citado"]);
    assert.deepEqual(r.words, [{ start: 1, end: 1.5, text: "antes" }, { start: 2.1, end: 2.5, text: "depois" }]);
    assert.equal(planTimeToExport(1, [clip()], 30), 1);
    assert.equal(planTimeToExport(2.1, [clip()], 30), 3.6);
  });

  it("silêncios: o pedaço dentro do trecho sai e os vizinhos emendam", () => {
    const spans = trechoExportSpans([clip()], 30);
    assert.deepEqual(intervalsSemTrechos([{ start: 1.8, end: 2.4 }, { start: 3.2, end: 3.8 }, { start: 5, end: 6 }], spans), [{ start: 1.8, end: 2.3 }, { start: 3.5, end: 4.5 }]);
    const merged = intervalsSemTrechos([{ start: 1.8, end: 3.8 }], spans);
    assert.deepEqual(merged.map((x) => ({ start: +x.start.toFixed(6), end: +x.end.toFixed(6) })), [{ start: 1.8, end: 2.3 }]);
  });

  it("sem trecho: nada muda", () => {
    assert.deepEqual(trechoExportSpans([], 30), []);
    const w = [{ start: 1, end: 2, text: "a" }];
    assert.deepEqual(wordsSemTrechos(w, []).words, w);
  });
});

describe("#13536 review-final com trecho inserido", () => {
  const spec = defaultSequences()[0];
  const plan: SequencePlan = {
    spec,
    clips: [
      { block: "comentario", srcIn: 100, srcOut: 102, frameIn: 3000, frameOut: 3060, seqStart: 0, seqEnd: 60, scale: 50 },
      { block: "comentario", srcIn: 110, srcOut: 112, frameIn: 3300, frameOut: 3360, seqStart: 60, seqEnd: 120, scale: 62 },
    ],
    durationFrames: 120,
    script: "as eleições para presidente começam agora",
    missingBlocks: [],
    dropped: [],
  };
  // export: 0–2 s fala do plano, 2–3,5 s o trecho (fala do vídeo citado), 3,5–5,5 s o resto do plano
  const words: Word[] = [
    { start: 0.2, end: 0.4, text: "as" },
    { start: 0.5, end: 1.1, text: "eleições" },
    { start: 1.2, end: 1.8, text: "para" },
    { start: 2.1, end: 2.6, text: "Nós" },
    { start: 2.7, end: 3.2, text: "lançamos" },
    { start: 3.6, end: 4.2, text: "presidente" },
    { start: 4.3, end: 4.8, text: "começam" },
    { start: 4.9, end: 5.3, text: "agora" },
  ];

  it("a fala do vídeo citado não vira fala-extra (antes do #13536 virava)", () => {
    const sem = checkText({ words, plan, fps: 30, durationS: 5.5 });
    assert.ok(sem.some((f) => f.kind === "fala-extra" && /lançamos/i.test(f.what)), JSON.stringify(sem));
    const com = checkTextWithTrechos({ words, plan, fps: 30, durationS: 5.5 }, [clip()]);
    assert.ok(!com.some((f) => /lançamos|Nós/i.test(f.what)), JSON.stringify(com));
    assert.ok(!com.some((f) => f.kind === "fala-faltando"), JSON.stringify(com));
  });

  it("o achado depois do trecho sai no tempo do EXPORT, e o do bruto pelo plano", () => {
    const sem = words.filter((w) => w.text !== "começam");
    const f = checkTextWithTrechos({ words: sem, plan, fps: 30, durationS: 5.5 }, [clip()]);
    const missing = f.find((x) => x.kind === "fala-faltando");
    assert.ok(missing, JSON.stringify(f));
    assert.match(missing.what, /come[cç]am/);
    assert.ok(missing.at! >= 3.5, `tempo no export depois do trecho (${missing.at})`);
    assert.ok(missing.rawAt !== null && missing.rawAt! >= 110, `tempo no bruto do 2º clipe (${missing.rawAt})`);
  });
});

describe("#13536 ganho do trecho", () => {
  it("medido no clipe: alvo -14 LUFS com teto de true peak", () => {
    const json = (i: number, tp: number) => `[Parsed_loudnorm_0] \n{\n"input_i" : "${i}",\n"input_tp" : "${tp}",\n"input_lra" : "5"\n}`;
    assert.deepEqual(measureTrechoGain("/x.mov", () => json(-20, -8)).gain?.db, 6);
    assert.equal(measureTrechoGain("/x.mov", () => json(-10, 0)).gain?.db, -4);
    assert.equal(measureTrechoGain("/x.mov", () => "sem resumo").gain, null);
    assert.match(measureTrechoGain("/x.mov", () => { throw new Error("ffmpeg: no such file"); }).detail, /não medido: ffmpeg: no such file/);
  });

  it("o clipitem de áudio do trecho leva o Audio Levels; sem levels (--no-audio-gain), nada", () => {
    const placed = trechoRipple([clip({ gain: { db: 6, linear: 1.995262 } })]).placed;
    const levels = (l: number) => `<filter>LEVEL ${l}</filter>\n`;
    const com = trechoInseridoTracksXml({ placed, rate: "<rate/>", idPrefix: "trecho-1", url: (p) => p, audioTrackIndex: 2, levels });
    assert.match(com.audio, /<filter>LEVEL 1\.995262<\/filter>/);
    assert.doesNotMatch(com.video, /LEVEL/);
    const sem = trechoInseridoTracksXml({ placed, rate: "<rate/>", idPrefix: "trecho-1", url: (p) => p, audioTrackIndex: 2 });
    assert.doesNotMatch(sem.audio, /LEVEL/);
  });
});

describe("#13536 prévia sem o trecho", () => {
  it("avisa quais trechos ficaram fora e quanto o tempo fica atrás", () => {
    const msg = previewTrechosAviso([clip()], 30)!;
    assert.match(msg, /prévia SEM 1 trecho\(s\) inserido\(s\).*H3 em 2\.0 s \(1\.5 s\)/);
    assert.equal(previewTrechosAviso([], 30), null);
  });
});
