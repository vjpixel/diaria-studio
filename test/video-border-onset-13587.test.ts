/**
 * #13587 (resíduo) — medição da borda de início dos itens do `blocks.json`:
 * energia de janela curta, ilha de fala, pré-rolagem e o placar contra o
 * início aprovado. Só medição; envelopes e WAV sintéticos, nada de Python.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BORDER_CRITERION_S,
  BORDER_FALLBACK_TOLERANCE_S,
  anchorWord,
  approvedStarts,
  borderReport,
  conditionalKey,
  energyOnset,
  islandOnset,
  measureBorder,
  nearestWordStart,
  quietBeforeS,
  scoreMethod,
  type BorderMeasure,
} from "../scripts/lib/diaria/video-border-onset.ts";
import type { Envelope } from "../scripts/lib/diaria/video-cut-refine.ts";
import type { BlocksFile, Transcript } from "../scripts/lib/diaria/video-montage.ts";
import { main, measureEdition } from "../scripts/video-bordas-13587.ts";

const HOP = 0.01;
/** Envelope com piso `floor` dB e trechos `[start, end, db]` por cima. */
function envelope(durS: number, floor: number, loud: Array<[number, number, number]>): Envelope {
  const db = new Float64Array(Math.round(durS / HOP)).fill(floor);
  for (const [a, b, v] of loud) for (let i = Math.round(a / HOP); i < Math.round(b / HOP); i++) db[i] = v;
  return { hopS: HOP, db };
}

describe("energyOnset", () => {
  it("acha o 1º som sustentado depois do piso e ignora o estalo de 30 ms", () => {
    const env = envelope(10, -40, [[4.0, 4.03, -10], [5.0, 6.0, -12]]);
    assert.equal(energyOnset(env, 4.8), 5);
  });
  it("som que já vinha antes da janela de busca: devolve o começo da busca", () => {
    const env = envelope(10, -40, [[3.5, 6.0, -12]]);
    assert.equal(energyOnset(env, 5.0), 4.4);
  });
  it("sem som na janela: null", () => {
    assert.equal(energyOnset(envelope(10, -40, []), 5.0), null);
  });
});

describe("quietBeforeS", () => {
  it("mede o silêncio antes da palavra, tolerando pico curto", () => {
    const env = envelope(12, -40, [[1.0, 2.0, -10], [4.0, 4.03, -10], [6.0, 7.0, -10]]);
    assert.equal(quietBeforeS(env, 6.0), 4);
  });
  it("palavra colada na fala anterior: silêncio ~0", () => {
    const env = envelope(12, -40, [[3.0, 7.0, -10]]);
    assert.ok(quietBeforeS(env, 6.0) <= 0.01);
  });
});

describe("islandOnset", () => {
  const islands = [{ start: 1, end: 2 }, { start: 4.9, end: 7 }];
  it("início da ilha que cobre a palavra, sem recorte", () => {
    assert.equal(islandOnset(islands, 5.2), 4.9);
    assert.equal(islandOnset([{ start: 0, end: 30 }], 20), 0); // ilha que engole a tomada anterior: erro grande, não acerto
  });
  it("nenhuma ilha perto: null", () => {
    assert.equal(islandOnset(islands, 12), null);
    assert.equal(islandOnset([{ start: 9, end: 10 }], 5), null);
  });
});

const seg = (words: Array<[string, number]>) => ({
  start: words[0][1],
  end: words[words.length - 1][1] + 0.3,
  text: words.map((w) => w[0]).join(" "),
  words: words.map(([text, start]) => ({ text, start, end: start + 0.28 })),
});

describe("approvedStarts", () => {
  const blocks = {
    edition: "261118",
    blocks: {
      comentario: [
        { start: 4.3, end: 9, text: "A venda de chips", falaId: "H7" },
        { start: 10.0, end: 12, text: "Isso vale", falaId: "H7" },
        { text: "Só texto, sem borda" },
      ],
      resumo_curto: [{ start: 10.0, end: 12, text: "Isso vale", falaId: "H7" }],
    },
  } as unknown as BlocksFile;
  const transcript: Transcript = { segments: [seg([["A", 5.53], ["venda", 5.8]]), seg([["Isso", 10.08], ["vale", 10.4]])] };
  const retranscriptions: Transcript[] = [{ segments: [seg([["A", 5.48], ["venda", 5.7]])] }];

  it("uma linha por início explícito, com as palavras e a marca de borda acertada à mão", () => {
    const rows = approvedStarts({ blocks, transcript, retranscriptions, templateStarts: [10.0] });
    assert.equal(rows.length, 2); // o item repetido em resumo_curto conta uma vez; item só com texto fica fora
    assert.deepEqual(
      rows.map((r) => [r.start, r.firstWord, r.wordLong, r.wordShort, r.handSet]),
      [
        [4.3, "a", 5.53, 5.48, true],
        [10.0, "isso", 10.08, null, false],
      ],
    );
    assert.equal(anchorWord(rows[0]), 5.48);
  });

  it("nearestWordStart só aceita a palavra entre -1 e +4 s do aprovado", () => {
    const ws = transcript.segments.flatMap((s) => s.words ?? []);
    assert.equal(nearestWordStart(ws, "isso", 5.0), null);
    assert.equal(nearestWordStart(ws, "isso", 7.0), 10.08);
  });
});

describe("placar e o caso da issue (H7 da 261118)", () => {
  // Como medido no bruto da 261118: o editor abriu 424,3, a 1ª palavra está em
  // 425,48, o som começa em 426,0, e antes disso há 4,5 s de piso de ruído sem
  // nada que um detector possa achar.
  const env = envelope(440, -33, [[416, 420.8, -12], [426.0, 430, -12]]);
  const row = measureBorder(
    { block: "comentario", falaId: "H7", start: 424.3, firstWord: "a", wordLong: 425.53, wordShort: 425.48, handSet: true },
    { env, sileroIslands: [{ start: 426.18, end: 430 }] },
  )!;

  it("nenhum detector acústico chega a 0,6 s do início aprovado; a palavra fica dentro de 1,5 s", () => {
    const e = (m: string) => +((row.predicted[m] as number) - row.start).toFixed(2);
    assert.equal(row.anchor, 425.48);
    assert.equal(e("energia, janela de 20 ms"), 1.7);
    assert.equal(e("Silero (início da ilha)"), 1.88);
    assert.ok(e("palavra (a mais cedo das duas)") > BORDER_CRITERION_S);
    assert.ok(e("palavra (a mais cedo das duas)") <= BORDER_FALLBACK_TOLERANCE_S);
    assert.ok(row.quietBeforeS > 4);
    assert.ok(e(conditionalKey(3, 0.4)) > BORDER_CRITERION_S); // nem a melhor pré-rolagem da grade
  });

  it("scoreMethod conta critério, tolerância e lista as que passam", () => {
    const rows: BorderMeasure[] = [
      { ...row, predicted: { x: 424.5 } },
      { ...row, start: 10, predicted: { x: 11.2 } },
      { ...row, start: 20, predicted: { x: null } },
    ];
    const s = scoreMethod("x", rows);
    assert.deepEqual([s.n, s.withinCriterion, s.withinTolerance, s.maxAbsErrS], [2, 1, 2, 1.2]);
    assert.deepEqual(s.misses, ["10 (+1.20)"]);
    const rep = borderReport("261118", rows);
    assert.equal(rep.handSet.find((m) => m.method === "x")!.n, 2);
  });
});

/** WAV PCM 16 bits mono 16 kHz: silêncio com ruído baixo e fala (tom) nos trechos dados. */
function wav(durS: number, loud: Array<[number, number]>): Buffer {
  const sr = 16000, n = Math.round(durS * sr), data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const on = loud.some(([a, b]) => t >= a && t < b);
    const v = on ? Math.round(8000 * Math.sin(2 * Math.PI * 220 * t)) : ((i * 7919) % 41) - 20;
    data.writeInt16LE(v, i * 2);
  }
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + data.length, 4); h.write("WAVE", 8); h.write("fmt ", 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(sr, 24);
  h.writeUInt32LE(sr * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

describe("CLI", () => {
  it("measureEdition lê o state dir, o molde e o WAV", () => {
    const dir = mkdtempSync(join(tmpdir(), "bordas-13587-"));
    try {
      const st = join(dir, "st");
      mkdirSync(st);
      writeFileSync(join(dir, "a.wav"), wav(12, [[5.0, 7.0]]));
      writeFileSync(join(st, "blocks.json"), JSON.stringify({ edition: "261118", blocks: { comentario: [{ start: 4.9, end: 7, text: "Oito dias" }] } }));
      writeFileSync(join(st, "transcript.json"), JSON.stringify({ segments: [seg([["Oito", 5.02], ["dias", 5.4]])] }));
      writeFileSync(join(st, "retranscribe-4.0-8.0.json"), JSON.stringify({ segments: [] }));
      writeFileSync(join(st, "blocks.template.json"), JSON.stringify({ comentario: [{ start: 5.02, end: 7 }] }));
      const rep = measureEdition("261118", { audio: join(dir, "a.wav"), stateDir: st });
      assert.equal(rep.rows.length, 1);
      assert.equal(rep.rows[0].handSet, true);
      assert.equal(rep.rows[0].anchor, 5.02);
      const onset = rep.rows[0].predicted["energia, janela de 20 ms"] as number;
      assert.ok(Math.abs(onset - 5.0) <= 0.03, `onset ${onset}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("listas de tamanho diferente das edições: uso (exit 2)", () => {
    const err = console.error;
    console.error = () => {};
    try {
      assert.equal(main(["261117", "261118", "--audio", "a.wav"]), 2);
      assert.equal(main([]), 2);
    } finally {
      console.error = err;
    }
  });
});
