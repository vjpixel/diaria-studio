/**
 * test/video-xml-vs-final-13417.test.ts
 *
 * #13417, dois bugs do `video-xml-vs-final.ts` achados ao medir a #13194 na
 * edição 261117:
 *
 *   1. Extração truncada do bruto virava cache válido: cada arquivo saía com
 *      `-af apad -t <duração>`, então a leitura que parava no meio (Drive for
 *      desktop, arquivo de 17,9 GB) saía com exit 0 e o resto em silêncio, e o
 *      cache só era conferido pela duração. Agora a extração confere a duração
 *      real antes do `apad` e o cache com trecho longo de zeros é descartado.
 *   2. A auto-comparação (final = o próprio XML) acusava clipes fora, pontas
 *      mexidas, trechos acrescentados, inversões e palavras recuperadas. Causas:
 *      busca grossa que perdia o clipe curto, lascas da rotulagem, fim mudo do
 *      export pareado com o bruto e corte solto na pausa entre clipes.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brutoWav, type BrutoLookup, type Finder, type PlanFileLite } from "../scripts/video-xml-vs-final.ts";
import {
  alignFinalToBruto,
  compareSequence,
  dropSlivers,
  extractionTruncated,
  finalSpansFromRuns,
  longestZeroRunS,
  trimDigitalSilenceEdges,
  type XmlClip,
} from "../scripts/lib/diaria/video-xml-vs-final.ts";
import { parseWavPcm16 } from "../scripts/lib/diaria/video-cut-refine.ts";
import type { Word } from "../scripts/lib/diaria/video-montage.ts";

// ── Bug 1: extração truncada ────────────────────────────────────────────

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
const fakeEdition = () => `7${String(Math.floor(Math.random() * 99999)).padStart(5, "0")}`;
const NO_LOOKUP: BrutoLookup = { archiveRoot: null, montageEditionCache: () => null };
const finderWith = (brutoFile: Finder["brutoFile"]): Finder => ({ mode: "local", list: async () => [], workDir: () => "/nao-existe-work", brutoFile });
const plan = (files: NonNullable<PlanFileLite["source"]["files"]>): PlanFileLite => ({ plans: [], source: { fps: 30, path: files[0]?.path, files } });

function tone(out: string, s: number, freq: number): void {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-v", "error", "-y", "-f", "lavfi", "-i", `sine=frequency=${freq}:sample_rate=48000:duration=${s}`, "-ac", "2", "-c:a", "aac", out]);
  assert.equal(r.status, 0, String(r.stderr));
}

/** WAV PCM 16 bits mono. */
function writeWav(path: string, samples: Int16Array, sampleRate = 16000): void {
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + samples.length * 2, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) buf.writeInt16LE(samples[i], 44 + 2 * i);
  writeFileSync(path, buf);
}

describe("#13417 bug 1: extração truncada do bruto", () => {
  it("extractionTruncated: folga de 1 s (o apad do #12559), além disso é truncada", () => {
    assert.equal(extractionTruncated(1487.4, 1487.9), false);
    assert.equal(extractionTruncated(73, 1487.9), true, "a reprodução da issue: 73 s de áudio para 1487,9 s esperados");
    assert.equal(extractionTruncated(Number.NaN, 10), true);
  });

  it("longestZeroRunS conta só zeros seguidos", () => {
    const s = new Int16Array(100);
    s.fill(5);
    s.fill(0, 10, 40);
    s.fill(0, 50, 60);
    assert.equal(longestZeroRunS(s, 10), 3);
  });

  describe("com ffmpeg", { skip: !hasFfmpeg && "ffmpeg ausente" }, () => {
    it("mp4 curto com duração esperada maior: pulo com motivo de extração truncada, sem cache gravado", async () => {
      const dir = mkdtempSync(join(tmpdir(), "xml-vs-final-13417-"));
      const a = join(dir, "a.mp4");
      const b = join(dir, "b.mp4");
      tone(a, 1.0, 440); // 1 s de áudio, 4 s (120 quadros) na linha do tempo: a leitura "parou" em 1 s
      tone(b, 1.0, 880);
      const edition = fakeEdition();
      const pf = plan([
        { id: "a", path: "/nao-existe/a.mp4", frames: 120, offsetFrames: 0 },
        { id: "b", path: "/nao-existe/b.mp4", frames: 30, offsetFrames: 120 },
      ]);
      const local: Record<string, string> = { "a.mp4": a, "b.mp4": b };
      const res = await brutoWav(edition, join(dir, "work"), pf, finderWith(async (_e, name) => local[name] ?? null), NO_LOOKUP);
      assert.equal(res.wav, null, "antes do #13417 o apad completava 3 s de silêncio e o cache valia");
      assert.ok(res.wav === null && /extração truncada/.test(res.reason) && /a\.mp4/.test(res.reason), JSON.stringify(res));
      assert.equal(existsSync(join(tmpdir(), "diaria-video-xml-vs-final", edition, "bruto-multi-16k.wav")), false, "nada vai para o cache");
    });

    it("cache com trecho longo de zeros digitais é descartado e o bruto é extraído de novo", async () => {
      const dir = mkdtempSync(join(tmpdir(), "xml-vs-final-13417-"));
      const a = join(dir, "a.mp4");
      const b = join(dir, "b.mp4");
      tone(a, 8.0, 440);
      tone(b, 1.0, 880);
      const edition = fakeEdition();
      const pf = plan([
        { id: "a", path: "/nao-existe/a.mp4", frames: 240, offsetFrames: 0 },
        { id: "b", path: "/nao-existe/b.mp4", frames: 30, offsetFrames: 240 },
      ]);
      // O cache corrompido da 261117 em miniatura: duração certa (9 s), som só no 1º segundo.
      const own = join(tmpdir(), "diaria-video-xml-vs-final", edition, "bruto-multi-16k.wav");
      mkdirSync(join(tmpdir(), "diaria-video-xml-vs-final", edition), { recursive: true });
      const bad = new Int16Array(9 * 16000);
      for (let i = 0; i < 16000; i++) bad[i] = Math.round(8000 * Math.sin(i / 5));
      writeWav(own, bad);
      const local: Record<string, string> = { "a.mp4": a, "b.mp4": b };
      const res = await brutoWav(edition, join(dir, "work"), pf, finderWith(async (_e, name) => local[name] ?? null), NO_LOOKUP);
      assert.ok(res.wav, JSON.stringify(res));
      const w = parseWavPcm16(readFileSync(res.wav as string));
      assert.ok(Math.abs(w.samples.length / w.sampleRate - 9) < 0.05, `duração ${w.samples.length / w.sampleRate}`);
      const xs = w.samples.subarray(4 * 16000, 5 * 16000);
      const rms = Math.sqrt(xs.reduce((acc, x) => acc + x * x, 0) / xs.length);
      assert.ok(rms > 1000, `o trecho 4–5 s volta com o som do arquivo (rms ${rms.toFixed(0)}), não os zeros do cache`);
    });
  });
});

// ── Bug 2: auto-comparação ──────────────────────────────────────────────

const HOP = 0.01;

/** PRNG determinístico (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Bruto sintético: palavras (rajadas de energia) separadas por pausas em ruído de sala, com a transcrição. */
function syntheticBruto(seed: number, durS: number): { db: Float64Array; words: Word[] } {
  const r = rng(seed);
  const db = new Float64Array(Math.round(durS / HOP));
  for (let i = 0; i < db.length; i++) db[i] = -55 + (r() - 0.5) * 2;
  const words: Word[] = [];
  let t = 0.5;
  let k = 0;
  while (t < durS - 1) {
    const len = 0.15 + r() * 0.35;
    const level = -30 + r() * 18;
    const a = Math.round(t / HOP);
    const b = Math.min(db.length, Math.round((t + len) / HOP));
    for (let i = a; i < b; i++) {
      const x = (i - a) / Math.max(1, b - a);
      db[i] = level + 6 * Math.sin(Math.PI * x) + (r() - 0.5) * 8 - 10 * (1 - Math.sin(Math.PI * x));
    }
    words.push({ text: `w${k++}`, start: t, end: t + len } as Word);
    t += len + (r() < 0.15 ? 0.6 + r() * 0.6 : 0.06 + r() * 0.3);
  }
  return { db, words };
}

/** Clipes do XML: trechos curtos e longos do bruto, sem sobreposição, em ordem embaralhada (a montagem pula para frente e para trás). */
function syntheticClips(seed: number, words: readonly Word[], n: number): XmlClip[] {
  const r = rng(seed);
  const picked: Array<{ srcIn: number; srcOut: number }> = [];
  let w = 2;
  while (picked.length < n && w < words.length - 12) {
    const nWords = 2 + Math.floor(r() * 8);
    const first = words[w];
    const last = words[w + nWords - 1];
    // Uma parte dos clipes corta no meio da última palavra (a montagem corta assim, a 261117 cortou o "O" do clipe 16).
    const midWord = r() < 0.3;
    const srcIn = Math.max(0, first.start - 0.05 - r() * 0.05);
    const srcOut = midWord ? last.start + (last.end - last.start) * 0.4 : last.end + 0.05 + r() * 0.05;
    picked.push({ srcIn: Math.round(srcIn * 100) / 100, srcOut: Math.round(srcOut * 100) / 100 });
    w += nWords + 1 + Math.floor(r() * 4);
  }
  for (let i = picked.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [picked[i], picked[j]] = [picked[j], picked[i]];
  }
  return picked.map((c, index) => ({ index, ...c }));
}

/** O final exportado do XML sem edição: os clipes em ordem, os 0,2 s iniciais no piso (atraso do codificador), 4 s de fim mudo. */
function finalFromXml(bruto: Float64Array, clips: readonly XmlClip[], edits: { extendTail?: { index: number; s: number }; drop?: number } = {}): Float64Array {
  const parts: number[] = [];
  const silence = (s: number) => {
    for (let i = 0; i < Math.round(s / HOP); i++) parts.push(-120);
  };
  for (const c of clips) {
    if (edits.drop === c.index) continue;
    const extra = edits.extendTail?.index === c.index ? edits.extendTail.s : 0;
    for (let i = Math.round(c.srcIn / HOP); i < Math.round((c.srcOut + extra) / HOP); i++) parts.push(bruto[i]);
  }
  for (let i = 0; i < Math.round(0.2 / HOP); i++) parts[i] = -120;
  silence(4);
  return Float64Array.from(parts);
}

function compare(seed: number, edits: Parameters<typeof finalFromXml>[2] = {}) {
  const { db, words } = syntheticBruto(seed, 240);
  const clips = syntheticClips(seed + 1, words, 24);
  const fin = finalFromXml(db, clips, edits);
  const al = alignFinalToBruto(fin, db, HOP, clips, { windowS: 10, windowHopS: 5, stepS: 0.05, subWinS: 1 }, 0.5);
  const cmp = compareSequence({ clips, spans: finalSpansFromRuns(al.runs), words, finalDurationS: fin.length * HOP });
  return { cmp, clips, words };
}

describe("#13417 bug 2: auto-comparação (final = o próprio XML)", () => {
  for (const seed of [11, 23, 37]) {
    it(`seed ${seed}: 0 clipes fora, 0 palavras recuperadas, 0 acrescentados, 0 inversões, pontas sem mexida`, () => {
      const { cmp } = compare(seed);
      const s = cmp.summary;
      assert.equal(s.clipsRemoved, 0, JSON.stringify(cmp.clips.filter((c) => c.status === "removed")));
      assert.equal(s.wordsRecovered, 0, JSON.stringify(cmp.wordsRecovered));
      assert.equal(s.added, 0, JSON.stringify(cmp.added));
      assert.equal(s.orderInversions, 0);
      assert.equal(s.clipsTouched, 0, JSON.stringify(cmp.clips.filter((c) => c.touched)));
    });
  }

  it("a ponta que o editor estendeu sobre a fala continua medida (o encaixe na borda do clipe não a apaga)", () => {
    const base = compare(11);
    // Um clipe que termina numa pausa e cujo bruto seguinte é fala: estender 0,6 s pega as palavras seguintes.
    const target = base.clips.find((c) => base.words.some((w) => w.start > c.srcOut + 0.05 && w.end < c.srcOut + 0.55) && !base.clips.some((o) => o.srcIn > c.srcOut && o.srcIn < c.srcOut + 1.5));
    assert.ok(target, "achar um clipe com fala logo depois no bruto");
    const { cmp } = compare(11, { extendTail: { index: target.index, s: 0.6 } });
    const c = cmp.clips.find((x) => x.index === target.index);
    assert.ok(c && c.tailMs !== null && c.tailMs >= 450, `ponta estendida medida: ${JSON.stringify(c)}`);
    assert.ok(cmp.summary.wordsRecovered >= 1, "as palavras da ponta estendida são recuperadas");
    assert.equal(cmp.summary.clipsRemoved, 0);
  });

  it("clipe tirado pelo editor sai como removido, e só ele", () => {
    const base = compare(23);
    const drop = base.clips[5].index;
    const { cmp } = compare(23, { drop });
    assert.deepEqual(cmp.clips.filter((c) => c.status === "removed").map((c) => c.index), [drop]);
  });
});

describe("#13417: limpeza dos trechos do alinhamento", () => {
  it("trimDigitalSilenceEdges tira o fim mudo da ponta solta e deixa o piso curto do começo", () => {
    const F = new Float64Array(1000).fill(-40);
    F.fill(-80, 0, 20); // 0,2 s de piso no começo: atraso do codificador, fica
    F.fill(-80, 600, 650); // 0,5 s de piso entre um trecho e um vão: sai
    F.fill(-80, 900); // 1 s de fim mudo: sai
    const out = trimDigitalSilenceEdges(
      [
        { audioStart: 0, audioEnd: 6.5, offset: 5 },
        { audioStart: 7, audioEnd: 10, offset: 9 },
      ],
      F,
      HOP,
      -80,
    );
    assert.deepEqual(out, [
      { audioStart: 0, audioEnd: 6, offset: 5 },
      { audioStart: 7, audioEnd: 9, offset: 9 },
    ]);
  });

  it("piso curto do começo sem par volta para o 1º trecho; vinheta muda de 2 s não", () => {
    const F = new Float64Array(1000).fill(-40);
    F.fill(-80, 0, 20);
    assert.deepEqual(trimDigitalSilenceEdges([{ audioStart: 0.1, audioEnd: 5, offset: 5 }], F, HOP, -80), [{ audioStart: 0, audioEnd: 5, offset: 5 }]);
    F.fill(-80, 0, 200);
    assert.deepEqual(trimDigitalSilenceEdges([{ audioStart: 0.3, audioEnd: 5, offset: 5 }], F, HOP, -80), [{ audioStart: 2, audioEnd: 5, offset: 5 }]);
  });

  it("dropSlivers tira a lasca entre dois trechos e o trecho curto fora de todo clipe", () => {
    const runs = [
      { audioStart: 0, audioEnd: 5, offset: 10 },
      { audioStart: 5, audioEnd: 5.05, offset: 300 }, // lasca
      { audioStart: 5.05, audioEnd: 8, offset: 20 },
      { audioStart: 8, audioEnd: 8.3, offset: 900 }, // curto, bruto 908–908,3 fora de clipe
      { audioStart: 8.3, audioEnd: 10, offset: 20 },
    ];
    const clips = [
      { srcIn: 10, srcOut: 15 },
      { srcIn: 25, srcOut: 30 },
      { srcIn: 305, srcOut: 306 },
    ];
    assert.deepEqual(dropSlivers(runs, clips), [
      { audioStart: 0, audioEnd: 5.025, offset: 10 },
      { audioStart: 5.025, audioEnd: 10, offset: 20 },
    ]);
  });
});
