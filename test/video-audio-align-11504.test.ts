/**
 * test/video-audio-align-11504.test.ts (#11504) — transcrição feita no áudio
 * separado (o mesmo som do bruto, com pausas cortadas) aproveitada no vídeo, e
 * o `transcript.json` existente nunca retranscrito por cima sem --force.
 *
 * Caso real (261029): o `.wav` (10:44) era o áudio do vídeo (11:41) com
 * pausas cortadas, deslocamento +47,075 → +50,643 → +53,209 → +56,643 s. O
 * remapeamento foi à mão; com `source.json` novo, o `transcribe` retranscreveu
 * o vídeo inteiro por cima do `transcript.json` remapeado.
 *
 * Partes: a lógica pura (`lib/diaria/video-audio-align.ts`) com envelopes
 * sintéticos; o CLI com ffmpeg/ffprobe/python FALSOS no PATH (só Linux/macOS:
 * os falsos são scripts de shell), gerando WAVs sintéticos de verdade.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ALIGN_DEFAULTS, alignEnvelopes, mergeRetranscribed, remapToVideo } from "../scripts/lib/diaria/video-audio-align.ts";
import type { Transcript, Word } from "../scripts/lib/diaria/video-montage.ts";
import { keptTranscriptWarning, main } from "../scripts/video-montagem.ts";

/**
 * Gerador determinístico (mulberry32) para os testes não dependerem de
 * Math.random. Não um LCG: sementes diferentes de um LCG caem no mesmo ciclo,
 * e o áudio "de outro som" sairia um trecho deslocado do vídeo.
 */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Envelope (dB, passo 10 ms) "de fala": rajadas de 0,5–3,5 s e pausas de 0,2–1,4 s. */
function speechEnvelope(n: number, seed: number): number[] {
  const r = rng(seed);
  const out: number[] = [];
  while (out.length < n) {
    const speech = Math.round((0.5 + r() * 3) / 0.01);
    for (let i = 0; i < speech; i++) out.push(-30 + (r() - 0.5) * 20);
    const pause = Math.round((0.2 + r() * 1.2) / 0.01);
    for (let i = 0; i < pause; i++) out.push(-70 + r() * 3);
  }
  return out.slice(0, n);
}

const HOP = 0.01;
const cut = (v: number[], a: number, b: number) => v.slice(Math.round(a / HOP), Math.round(b / HOP));

// Os deslocamentos da 261029: o áudio é o vídeo a partir de 47,075 s, com 3 pausas cortadas.
const PIECES_261029: Array<[number, number]> = [
  [47.075, 90.775], // até 0:43,7 do wav, +47,075
  [94.343, 200], // +50,643
  [202.909, 400], // +53,209 (≈; 200 → 202,909)
  [406.343, 700], // +59,643
];

describe("alignEnvelopes (#11504)", () => {
  const V = speechEnvelope(70100, 7);
  const A = PIECES_261029.flatMap(([a, b]) => cut(V, a, b));
  const r = alignEnvelopes(A, V, HOP);

  it("acha os 4 deslocamentos da 261029, na ordem", () => {
    const want = [47.075, 50.643, 53.552, 59.895];
    assert.equal(r.offsets.length, 4, JSON.stringify(r.offsets));
    r.offsets.forEach((o, i) => assert.ok(Math.abs(o - want[i]) <= 0.011, `offset ${i}: ${o} × ${want[i]}`));
    assert.ok(r.coverage > 0.99);
  });

  it("corta entre os trechos no quadro certo (não na largura do sub-trecho)", () => {
    const cuts = [43.7, 149.357, 346.448];
    assert.equal(r.runs.length, 4);
    cuts.forEach((c, i) => {
      assert.ok(Math.abs(r.runs[i].audioEnd - c) <= 0.02, `corte ${i}: ${r.runs[i].audioEnd} × ${c}`);
      assert.equal(r.runs[i].audioEnd, r.runs[i + 1].audioStart);
    });
    assert.equal(r.runs[0].audioStart, 0);
  });

  it("ganho diferente no áudio (outro nível de exportação) não muda nada", () => {
    const g = alignEnvelopes(A.map((x) => x + 6), V, HOP);
    assert.deepEqual(g.offsets, r.offsets);
    assert.deepEqual(g.runs.map((x) => x.audioEnd), r.runs.map((x) => x.audioEnd));
  });

  it("áudio que não é o mesmo som: cobertura abaixo do mínimo", () => {
    const outro = speechEnvelope(30000, 99);
    const x = alignEnvelopes(outro, V, HOP);
    assert.ok(x.coverage < ALIGN_DEFAULTS.minCoverage, `coverage ${x.coverage}`);
  });
});

describe("remapToVideo + mergeRetranscribed (#11504)", () => {
  const runs = [
    { audioStart: 0, audioEnd: 40, offset: 10 },
    { audioStart: 40, audioEnd: 106.5, offset: 13.5 },
  ];
  const w = (start: number, text: string): Word => ({ start, end: start + 0.3, text: ` ${text}` });
  const audioTr: Transcript = {
    duration: 106.5,
    model: "large-v3-turbo",
    segments: [
      { start: 1, end: 1.3, text: " antes", words: [w(1, "antes")] },
      { start: 39.5, end: 40.4, text: " corte no meio", words: [w(39.0, "corte"), w(39.8, "no"), w(40.1, "meio")] },
      { start: 60, end: 60.3, text: " depois", words: [w(60, "depois")] },
    ],
  };
  const rm = remapToVideo(audioTr, runs, 120, { audioDurS: 106.5 });

  it("palavra longe do corte vai com o deslocamento do trecho; a da borda sai", () => {
    const all = rm.segments.flatMap((s) => s.words ?? []);
    assert.deepEqual(all.map((x) => x.text.trim()), ["antes", "corte", "depois"]);
    assert.equal(all[0].start, 11);
    assert.equal(all[1].start, 49);
    assert.equal(all[2].start, 73.5);
    assert.equal(rm.dropped, 2, "'no' e 'meio' estão a menos de 0,3 s do corte");
    assert.equal(rm.segments[1].text, "corte", "segmento parcial refaz o texto das palavras que ficaram");
  });

  it("o vídeo sem par sai em uncovered: o começo antes do áudio e a pausa cortada com a folga", () => {
    assert.deepEqual(rm.uncovered, [
      { start: 0, end: 10 },
      { start: 49.7, end: 53.8 },
    ]);
  });

  it("retranscrição: só fica o que cai no vão, e tudo sai em ordem no tempo do vídeo", () => {
    const patch: Transcript = {
      segments: [
        { start: 49.5, end: 50.6, text: " fim corte pausa", words: [w(49.1, "corte"), w(50.2, "pausa")] },
        { start: 5, end: 5.3, text: " intro", words: [w(5, "intro")] },
      ],
    };
    const merged = mergeRetranscribed(rm.segments, [patch], rm.uncovered, 120, "large-v3-turbo");
    assert.equal(merged.duration, 120);
    const all = merged.segments.flatMap((s) => s.words ?? []).map((x) => x.text.trim());
    assert.deepEqual(all, ["intro", "antes", "corte", "pausa", "depois"], "'corte' da retranscrição (49,1) cai no trecho remapeado e sai");
    for (let i = 1; i < merged.segments.length; i++) assert.ok(merged.segments[i].start >= merged.segments[i - 1].start);
  });
});

describe("keptTranscriptWarning (#11504)", () => {
  it("diz que mantém e que só --force retranscreve", () => {
    assert.match(keptTranscriptWarning({ duration: 701.2 }, 701.5), /mantido.*--force/s);
    assert.doesNotMatch(keptTranscriptWarning({ duration: 701.2 }, 701.5), /--from-audio/);
  });
  it("duração diferente do bruto aponta para o --from-audio", () => {
    assert.match(keptTranscriptWarning({ duration: 644 }, 701.5), /644\.0 s.*701\.5 s.*--from-audio/s);
  });
});

// ── CLI com ffmpeg/ffprobe/python falsos ─────────────────────────────────

const SR = 16000;

/** PCM de "fala": rajadas de ruído com amplitude por quadro de 10 ms, pausas quase mudas. */
function speechPcm(seconds: number, seed: number): Int16Array {
  const env = speechEnvelope(Math.round(seconds / HOP), seed);
  const r = rng(seed + 1);
  const out = new Int16Array(Math.round(seconds * SR));
  for (let i = 0; i < out.length; i++) {
    const amp = 32767 * Math.pow(10, env[Math.min(env.length - 1, Math.floor(i / (SR * HOP)))] / 20);
    out[i] = Math.round((r() * 2 - 1) * amp);
  }
  return out;
}

function wavBytes(samples: Int16Array): Buffer {
  const b = Buffer.alloc(44 + samples.length * 2);
  b.write("RIFF", 0);
  b.writeUInt32LE(36 + samples.length * 2, 4);
  b.write("WAVE", 8);
  b.write("fmt ", 12);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(SR, 24);
  b.writeUInt32LE(SR * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36);
  b.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) b.writeInt16LE(samples[i], 44 + 2 * i);
  return b;
}

/**
 * ffmpeg/ffprobe/python falsos (um script Node só). ffprobe: vídeo 4K/30 fps
 * de FAKE_VIDEO_DUR s. ffmpeg: a extração do áudio copia FAKE_VIDEO_WAV e
 * imprime o loudnorm; o silencedetect não acha nada; a decodificação do
 * áudio separado copia FAKE_AUDIO_WAV; o corte de um trecho grava um WAV
 * mudo. python: transcrição inteira (com --vad) devolve "VIDEO INTEIRO";
 * trecho (sem --vad) devolve "lacuna" em 0,6 s. Cada chamada vai para FAKE_LOG.
 */
const FAKE = String.raw`
import { appendFileSync, copyFileSync, writeFileSync } from "node:fs";
const [tool, ...args] = process.argv.slice(2);
appendFileSync(process.env.FAKE_LOG, JSON.stringify([tool, ...args]) + "\n");
if (tool === "ffprobe") {
  process.stdout.write(JSON.stringify({ streams: [{ codec_type: "video", width: 3840, height: 2160, r_frame_rate: "30/1" }, { codec_type: "audio" }], format: { duration: process.env.FAKE_VIDEO_DUR } }));
  process.exit(0);
}
if (tool === "ffmpeg") {
  const af = args[args.indexOf("-af") + 1] ?? "";
  if (af.startsWith("silencedetect")) process.exit(0);
  const outs = args.filter((a, i) => a.endsWith(".wav") && args[i - 1] !== "-i");
  const input = args[args.indexOf("-i") + 1];
  if (af.includes("loudnorm")) {
    copyFileSync(process.env.FAKE_VIDEO_WAV, outs[0]);
    process.stderr.write('{\n "input_i" : "-20.0",\n "input_tp" : "-3.0",\n "input_lra" : "5.0"\n}\n');
    process.exit(0);
  }
  if (input === process.env.FAKE_AUDIO_SRC) copyFileSync(process.env.FAKE_AUDIO_WAV, outs[0]);
  else {
    const h = Buffer.alloc(44 + 3200);
    h.write("RIFF", 0); h.writeUInt32LE(36 + 3200, 4); h.write("WAVE", 8); h.write("fmt ", 12); h.writeUInt32LE(16, 16);
    h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(16000, 24); h.writeUInt32LE(32000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
    h.write("data", 36); h.writeUInt32LE(3200, 40);
    writeFileSync(outs[0], h);
  }
  process.exit(0);
}
if (tool === "python") {
  const out = args[3];
  const full = args.includes("--vad");
  const words = full ? [{ start: 1, end: 1.5, text: " VIDEO" }, { start: 1.5, end: 2, text: " INTEIRO" }] : [{ start: 0.6, end: 0.9, text: " lacuna" }];
  writeFileSync(out, JSON.stringify({ duration: 1, model: "fake", segments: [{ start: words[0].start, end: words[words.length - 1].end, text: words.map((w) => w.text).join(""), words }] }));
  process.exit(0);
}
process.exit(9);
`;

describe("transcribe com binários falsos (#11504)", { skip: process.platform === "win32" ? "os falsos são scripts de shell" : false }, () => {
  let root = "";
  let bin = "";
  let oldPath: string | undefined;
  const env: Record<string, string> = {};
  const VIDEO_DUR = 120;
  const AUDIO_PIECES: Array<[number, number]> = [
    [10, 50],
    [53.5, 120],
  ];

  before(() => {
    root = mkdtempSync(join(tmpdir(), "vm-11504-"));
    bin = join(root, "bin");
    const fake = join(root, "fake.mjs");
    writeFileSync(fake, FAKE);
    mkdirSync(bin, { recursive: true });
    for (const tool of ["ffmpeg", "ffprobe", "python"]) {
      const target = tool === "python" ? join(root, "fake-python") : join(bin, tool);
      writeFileSync(target, `#!/bin/sh\nexec "${process.execPath}" "${fake}" ${tool} "$@"\n`);
      chmodSync(target, 0o755);
    }
    const video = speechPcm(VIDEO_DUR, 11);
    const audio = new Int16Array(AUDIO_PIECES.reduce((n, [a, b]) => n + Math.round((b - a) * SR), 0));
    let o = 0;
    for (const [a, b] of AUDIO_PIECES) {
      const piece = video.subarray(Math.round(a * SR), Math.round(b * SR));
      audio.set(piece, o);
      o += piece.length;
    }
    writeFileSync(join(root, "video.wav"), wavBytes(video));
    writeFileSync(join(root, "audio.wav"), wavBytes(audio));
    writeFileSync(join(root, "bruto.mp4"), "não é vídeo de verdade");
    writeFileSync(join(root, "separado.wav"), "o falso decodifica para FAKE_AUDIO_WAV");
    Object.assign(env, {
      FAKE_LOG: join(root, "calls.log"),
      FAKE_VIDEO_DUR: String(VIDEO_DUR),
      FAKE_VIDEO_WAV: join(root, "video.wav"),
      FAKE_AUDIO_WAV: join(root, "audio.wav"),
      FAKE_AUDIO_SRC: join(root, "separado.wav"),
    });
    oldPath = process.env.PATH;
    process.env.PATH = `${bin}:${process.env.PATH}`;
    Object.assign(process.env, env);
  });

  after(() => {
    process.env.PATH = oldPath;
    for (const k of Object.keys(env)) delete process.env[k];
    rmSync(root, { recursive: true, force: true });
  });

  const state = (name: string) => join(root, name);
  async function transcribe(stateName: string, extra: string[]): Promise<{ code: number; err: string }> {
    const errs: string[] = [];
    const orig = console.error;
    const origLog = console.log;
    console.error = (...a: unknown[]) => void errs.push(a.join(" "));
    console.log = () => {};
    try {
      const code = await main(["transcribe", "261029", "--source", join(root, "bruto.mp4"), "--state-dir", state(stateName), "--work-dir", join(root, `${stateName}-work`), "--python", join(root, "fake-python"), ...extra]);
      return { code, err: errs.join("\n") };
    } finally {
      console.error = orig;
      console.log = origLog;
    }
  }
  const pythonCalls = () => readFileSync(env.FAKE_LOG, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as string[]).filter((c) => c[0] === "python");

  it("regressão 261029: transcript.json existente com source.json novo é mantido (sem --force)", async () => {
    const dir = state("keep");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "transcript.json"), JSON.stringify({ duration: 106.5, segments: [{ start: 1, end: 1.4, text: " MANUAL", words: [{ start: 1, end: 1.4, text: " MANUAL" }] }] }));
    writeFileSync(env.FAKE_LOG, "");
    const r = await transcribe("keep", []);
    assert.equal(r.code, 0);
    assert.equal(pythonCalls().length, 0, "não retranscreveu");
    assert.match(readFileSync(join(dir, "transcript.json"), "utf8"), /MANUAL/);
    assert.match(r.err, /mantido.*--from-audio/s, "duração 106,5 s × bruto 120 s aponta o --from-audio");
    assert.ok(existsSync(join(dir, "source.json")), "o resto do transcribe rodou");
  });

  it("--force retranscreve o bruto inteiro", async () => {
    writeFileSync(env.FAKE_LOG, "");
    const r = await transcribe("keep", ["--force"]);
    assert.equal(r.code, 0);
    assert.equal(pythonCalls().length, 1);
    assert.match(readFileSync(join(state("keep"), "transcript.json"), "utf8"), /VIDEO/);
  });

  it("--from-audio: guarda a transcrição do áudio, alinha, remapeia e retranscreve só o vídeo sem par", async () => {
    const dir = state("align");
    mkdirSync(dir, { recursive: true });
    // O editor transcreveu o áudio separado antes (source.json = o áudio, modo áudio).
    writeFileSync(join(dir, "source.json"), JSON.stringify({ path: env.FAKE_AUDIO_SRC, fps: 30, durationS: 106.5, width: 0, height: 0, mirrored: false, audioOnly: true }));
    const words = [5, 20, 39.9, 41, 70, 100].map((t, i) => ({ start: t, end: t + 0.3, text: ` p${i}` }));
    writeFileSync(join(dir, "transcript.json"), JSON.stringify({ duration: 106.5, model: "large-v3-turbo", segments: words.map((x) => ({ start: x.start, end: x.end, text: x.text, words: [x] })) }));
    writeFileSync(env.FAKE_LOG, "");
    const r = await transcribe("align", ["--from-audio", env.FAKE_AUDIO_SRC]);
    assert.equal(r.code, 0, r.err);
    assert.ok(existsSync(join(dir, "transcript-audio.json")), "transcrição do áudio guardada");
    assert.match(readFileSync(join(dir, "transcript-audio.json"), "utf8"), /p5/);
    const al = JSON.parse(readFileSync(join(dir, "audio-align.json"), "utf8")) as { ok: boolean; offsets: number[]; runs: Array<{ audioEnd: number }> };
    assert.equal(al.ok, true);
    assert.deepEqual(al.offsets, [10, 13.5]);
    assert.ok(Math.abs(al.runs[0].audioEnd - 40) <= 0.02, `corte em ${al.runs[0].audioEnd}`);
    const tr = JSON.parse(readFileSync(join(dir, "transcript.json"), "utf8")) as Transcript & { aligned_from_audio?: { audio: string } };
    assert.equal(tr.aligned_from_audio?.audio, env.FAKE_AUDIO_SRC);
    assert.equal(tr.duration, VIDEO_DUR);
    const got = tr.segments.flatMap((s) => s.words ?? []).map((x) => [x.text.trim(), Math.round(x.start * 10) / 10]);
    // p2 (39,9) está a 0,1 s do corte: sai e o vão do vídeo é retranscrito; "lacuna" entra 2× (antes do áudio e na pausa).
    assert.deepEqual(got, [
      ["lacuna", 0.6],
      ["p0", 15],
      ["p1", 30],
      ["lacuna", 49.8],
      ["p3", 54.5],
      ["p4", 83.5],
      ["p5", 113.5],
    ]);
    assert.equal(pythonCalls().length, 2, "só os 2 trechos sem par, nunca o vídeo inteiro");
    assert.ok(pythonCalls().every((c) => !c.includes("--vad")));
    const source = JSON.parse(readFileSync(join(dir, "source.json"), "utf8")) as { path: string; audioOnly?: boolean };
    assert.equal(source.audioOnly, undefined, "o bruto agora é o vídeo");

    // Rodar de novo não refaz nada.
    writeFileSync(env.FAKE_LOG, "");
    const again = await transcribe("align", ["--from-audio", env.FAKE_AUDIO_SRC]);
    assert.equal(again.code, 0);
    assert.equal(pythonCalls().length, 0);
    assert.match(again.err, /já alinhado/);
  });

  it("--from-audio sem nenhuma transcrição do áudio é erro, sem tocar no transcript.json", async () => {
    const dir = state("none");
    mkdirSync(dir, { recursive: true });
    await assert.rejects(transcribe("none", ["--from-audio", env.FAKE_AUDIO_SRC]), /nenhuma transcrição desse áudio/);
    assert.equal(existsSync(join(dir, "transcript.json")), false);
  });
});
