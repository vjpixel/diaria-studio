/**
 * #13611: o A/B de redução de ruído escolhe a janela pela densidade de fala do
 * `transcript.json` (o de 16/11 saiu com `--start 120` fixo, quase todo
 * silêncio). Transcript sintético: fala concentrada num trecho.
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  bestSpeechWindow,
  mergeIntervals,
  speechIntervals,
  speechSecondsIn,
  usarIntervalsFromBlocks,
  windowSpeech,
} from "../scripts/lib/diaria/audio-ab-window.ts";
import { resolveAbWindow } from "../scripts/video-audio-denoise-ab.ts";
import type { Word } from "../scripts/lib/diaria/video-montage.ts";

/** Palavras de 0,4 s com 0,1 s de pausa entre [from, to). */
function talk(from: number, to: number): Word[] {
  const out: Word[] = [];
  for (let t = from; t + 0.4 <= to; t += 0.5) out.push({ text: "x", start: t, end: t + 0.4 });
  return out;
}

/** Como o bruto da 261116: bastidor no começo, voz esparsa em 120-180, fala contínua em 690-740. */
const words: Word[] = [...talk(10, 100), ...talk(170, 180), ...talk(400, 405), ...talk(690, 740)];

describe("#13611: intervalos de fala", () => {
  it("junta palavras que se tocam e mede segundos dentro da janela", () => {
    assert.deepEqual(mergeIntervals([{ start: 2, end: 3 }, { start: 0, end: 1 }, { start: 0.5, end: 2 }]), [{ start: 0, end: 3 }]);
    const sp = speechIntervals(talk(0, 10));
    assert.ok(Math.abs(speechSecondsIn(sp, 0, 10) - 8) < 1e-9, "80% de fala");
  });

  it("decupagem: só a fala dentro dos trechos 'usar' conta", () => {
    const sp = speechIntervals(words, [{ start: 690, end: 700 }]);
    assert.ok(Math.abs(speechSecondsIn(sp, 0, 10_000) - 8) < 1e-9);
  });

  it("usarIntervalsFromBlocks lê só itens com intervalo", () => {
    const blocks = { edition: "261116", blocks: { abertura: [{ start: 700, end: 710 }, { text: "só texto" }], d1: [{ start: 705, end: 720, falaId: "d1-1" }] } };
    assert.deepEqual(usarIntervalsFromBlocks(blocks), [{ start: 700, end: 720 }]);
    assert.deepEqual(usarIntervalsFromBlocks(null), []);
  });
});

describe("#13611: janela de mais fala", () => {
  it("fala concentrada num trecho: a janela cai nele, não no --start fixo de 120 s", () => {
    const w = bestSpeechWindow(speechIntervals(words), 45, 120);
    assert.ok(w);
    assert.ok(w.start >= 690 && w.end <= 740.5, `janela ${w.start}-${w.end}`);
    assert.ok(w.coverage >= 0.75, `cobertura ${w.coverage}`);
    // A janela fixa de antes (120 a 180) tinha 8 s de fala em 60.
    assert.ok(windowSpeech(speechIntervals(words), 120, 60).coverage < 0.5);
  });

  it("sem decupagem, o bastidor do começo fica de fora (minStart)", () => {
    const w = bestSpeechWindow(speechIntervals(talk(0, 100).concat(talk(300, 320))), 30, 120);
    assert.ok(w && w.start >= 120, `janela ${w?.start}`);
  });

  it("nenhuma fala depois do início: null", () => {
    assert.equal(bestSpeechWindow(speechIntervals(talk(0, 50)), 30, 120), null);
  });
});

describe("#13611: resolveAbWindow (CLI)", () => {
  const withFiles = (fn: (paths: { transcript: string; blocks: string }) => void) => {
    const root = mkdtempSync(join(tmpdir(), "ab-window-13611-"));
    try {
      const transcript = join(root, "transcript.json");
      writeFileSync(transcript, JSON.stringify({ segments: [{ words }] }));
      fn({ transcript, blocks: join(root, "blocks.json") });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };

  it("sem --start: escolhe pela fala e imprime janela e segundos de fala", () => {
    withFiles(({ transcript, blocks }) => {
      const r = resolveAbWindow({ dur: 45, transcript, blocks: [blocks], force: false });
      assert.ok(r.start >= 690, `start ${r.start}`);
      assert.match(r.log[0], /^Janela: \d+(\.\d)?s a \d+(\.\d)?s \(\d+(\.\d)?s de fala em 45s, \d+%\)/);
      assert.ok("chosenBy" in r.window && r.window.chosenBy === "fala");
    });
  });

  it("com decupagem: só os trechos 'usar' (o bastidor com mais fala fica de fora)", () => {
    withFiles(({ transcript, blocks }) => {
      writeFileSync(blocks, JSON.stringify({ edition: "261116", blocks: { d1: [{ start: 690, end: 740 }] } }));
      const r = resolveAbWindow({ dur: 45, transcript, blocks: [blocks], force: false });
      assert.ok(r.start >= 690 && r.start + 45 <= 741, `start ${r.start}`);
      assert.match(r.log[0], /trechos "usar" de blocks\.json/);
    });
  });

  it("janela com menos de 50% de fala: recusa; com --force, avisa e segue", () => {
    withFiles(({ transcript, blocks }) => {
      assert.throws(() => resolveAbWindow({ start: 120, dur: 60, transcript, blocks: [blocks], force: false }), /fala cobre \d+% da janela \(mínimo 50%\)/);
      const r = resolveAbWindow({ start: 120, dur: 60, transcript, blocks: [blocks], force: true });
      assert.equal(r.start, 120);
      assert.ok(r.log.some((l) => /^\[aviso\] fala cobre/.test(l)));
    });
  });

  it("dur maior que o trecho de fala: a melhor janela ainda fica abaixo de 50% e recusa", () => {
    withFiles(({ transcript, blocks }) => {
      assert.throws(() => resolveAbWindow({ dur: 300, transcript, blocks: [blocks], force: false }), /diminua --dur/);
    });
  });

  it("sem transcript: janela de antes, com aviso de fala não conferida", () => {
    const r = resolveAbWindow({ dur: 60, transcript: undefined, blocks: [], force: false });
    assert.equal(r.start, 120);
    assert.match(r.log[0], /^\[aviso\] sem transcript\.json/);
  });
});
