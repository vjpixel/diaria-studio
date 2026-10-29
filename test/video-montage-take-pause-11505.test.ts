/**
 * #11505 — frase com pausas longas entre as palavras não achava tomada completa.
 *
 * Caso real (edição 261029): o `roteiro` recusou duas frases que estão no bruto
 * inteiras e uma vez só ("nenhuma tomada completa de ... (21 parcial(is))"). O
 * Whisper deixou buracos de mais de 2,5 s entre palavras seguidas ("exemplo,"
 * acaba em 139,74 s e "a" começa em 143,80 s; "a" acaba em 161,16 s e
 * "atingir" começa em 163,69 s), e a pausa quebrava a tomada mesmo com a
 * palavra seguinte sendo a esperada do roteiro. Fixture: as palavras do
 * `transcript.json` da 261029 entre 128 e 168 s, tempos como saíram.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chooseTake, findTakes, resolveBlocks, TAKE_DEFAULTS, type BlocksFile, type Word } from "../scripts/lib/diaria/video-montage.ts";

const RAW: Array<[number, number, string]> = [
  [128.123, 128.503, "fazer"],
  [128.503, 129.363, "novas"],
  [129.363, 129.663, "IAs"],
  [129.663, 130.443, "brasileiras,"],
  [131.543, 132.103, "não"],
  [132.103, 132.663, "elimina"],
  [132.663, 132.843, "a"],
  [132.843, 133.403, "necessidade"],
  [133.403, 133.543, "de"],
  [133.543, 133.643, "se"],
  [133.643, 133.803, "criar"],
  [133.803, 134.223, "outras"],
  [134.223, 134.723, "IAs."],
  [134.723, 134.963, "Mas"],
  [134.963, 135.103, "se"],
  [135.103, 135.223, "a"],
  [135.223, 135.363, "gente"],
  [135.363, 135.863, "pensar,"],
  [136.143, 136.983, "mesmo"],
  [136.983, 137.443, "os"],
  [137.443, 138.083, "principais"],
  [138.083, 138.683, "laboratórios"],
  [138.683, 138.783, "que"],
  [138.783, 138.863, "a"],
  [138.863, 139.003, "gente"],
  [139.003, 139.183, "tem,"],
  [139.283, 139.363, "por"],
  [139.363, 139.743, "exemplo,"],
  [143.803, 147.303, "a"],
  [147.303, 148.023, "Antropic"],
  [148.023, 148.363, "tem"],
  [148.363, 148.843, "quatro"],
  [148.843, 149.303, "modelos"],
  [149.303, 149.803, "diferentes."],
  [149.803, 151.563, "Então,"],
  [153.483, 155.163, "ter"],
  [157.243, 157.703, "modelos"],
  [157.703, 158.263, "diferentes"],
  [158.263, 160.303, "ajuda"],
  [160.303, 161.163, "a"],
  [163.693, 165.233, "atingir"],
  [165.233, 166.053, "objetivos"],
  [166.053, 166.893, "específicos"],
  [166.893, 167.393, "diferentes."],
];
const WORDS: Word[] = RAW.map(([start, end, text]) => ({ start, end, text: ` ${text}` }));

// O texto do blocks.json da 261029 (as duas frases recusadas).
const PHRASE_1 = "Mas se a gente pensar, mesmo os principais laboratórios que a gente tem, por exemplo, a Anthropic tem quatro modelos diferentes.";
const PHRASE_2 = "Então, ter modelos diferentes ajuda a atingir objetivos específicos diferentes.";

describe("tomada com pausa longa entre palavras seguidas do roteiro (#11505)", () => {
  it("as pausas da fixture passam do maxGapS (o cenário real do bug)", () => {
    const gap = (a: string, b: string) => {
      const i = RAW.findIndex(([, , t], k) => t === a && RAW[k + 1]?.[2] === b);
      return RAW[i + 1][0] - RAW[i][1];
    };
    assert.ok(gap("exemplo,", "a") > TAKE_DEFAULTS.maxGapS);
    assert.ok(gap("a", "atingir") > TAKE_DEFAULTS.maxGapS);
  });

  it("frase 1: acha a tomada completa, de 'Mas' a 'diferentes.'", () => {
    const c = chooseTake(WORDS, PHRASE_1);
    assert.equal(c.ok, true, c.ok ? "" : c.reason);
    if (!c.ok) return;
    assert.equal(WORDS[c.take.firstWord].text.trim(), "Mas");
    assert.equal(WORDS[c.take.lastWord].start, 149.303);
    assert.ok(c.interval.start >= 134.6 && c.interval.start <= 134.75, `start ${c.interval.start}`);
    assert.ok(c.interval.end >= 149.8 && c.interval.end < 149.81, `end ${c.interval.end}`);
  });

  it("frase 2: acha a tomada completa, de 'Então,' a 'diferentes.'", () => {
    const c = chooseTake(WORDS, PHRASE_2);
    assert.equal(c.ok, true, c.ok ? "" : c.reason);
    if (!c.ok) return;
    assert.equal(WORDS[c.take.firstWord].start, 149.803);
    assert.equal(WORDS[c.take.lastWord].start, 166.893);
  });

  it("o roteiro resolve as duas frases sem intervalo explícito (o workaround da 261029)", () => {
    const file: BlocksFile = { edition: "261029", blocks: { comentario: [{ text: PHRASE_1 }, { text: PHRASE_2 }] } };
    const r = resolveBlocks(file, WORDS, { durationS: 701.109 });
    assert.deepEqual(r.errors, []);
    assert.equal(r.blocks.comentario?.length, 2);
  });
});

describe("pausa longa ainda encerra a tomada quando a fala não segue o roteiro (#11505)", () => {
  const w = (start: number, end: number, text: string): Word => ({ start, end, text });

  it("palavra fora do esperado depois da pausa: tomada incompleta", () => {
    // "um dois três [5 s] cinco seis sete": a 4ª palavra do roteiro ("quatro") não vem.
    const words = [w(0, 0.4, "um"), w(0.4, 0.8, "dois"), w(0.8, 1.2, "três"), w(6.2, 6.6, "cinco"), w(6.6, 7, "seis"), w(7, 7.4, "sete")];
    const takes = findTakes(words, "um dois três quatro cinco seis sete");
    assert.equal(takes.some((t) => t.complete), false);
  });

  it("depois da pausa nenhuma tolerância (palavra trocada) atravessa: incompleta", () => {
    // "quatro" virou "quarto" do outro lado da pausa: com a pausa curta seria troca tolerada.
    const words = [w(0, 0.4, "um"), w(0.4, 0.8, "dois"), w(0.8, 1.2, "três"), w(6.2, 6.6, "quarto"), w(6.6, 7, "cinco"), w(7, 7.4, "seis"), w(7.4, 7.8, "sete"), w(7.8, 8.2, "oito")];
    const phrase = "um dois três quatro cinco seis sete oito";
    assert.equal(findTakes(words, phrase).some((t) => t.complete), false);
    const close = words.map((x, i) => (i >= 3 ? { ...x, start: x.start - 4.9, end: x.end - 4.9 } : x));
    assert.equal(findTakes(close, phrase).some((t) => t.complete), true);
  });

  it("recomeço depois da pausa continua virando outra tomada (fica a última)", () => {
    // Tomada falsa "um dois", pausa de 4 s, tomada boa inteira.
    const words = [w(0, 0.4, "um"), w(0.4, 0.8, "dois"), w(4.8, 5.2, "um"), w(5.2, 5.6, "dois"), w(5.6, 6, "três"), w(6, 6.4, "quatro")];
    const c = chooseTake(words, "um dois três quatro");
    assert.equal(c.ok, true);
    if (c.ok) assert.equal(c.take.firstWord, 2);
  });
});
