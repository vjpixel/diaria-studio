/**
 * test/video-montage-holdlimit-cru-13310.test.ts
 *
 * #13310 — na 261117 (vertical V9) o respiro da vinheta depois do gancho foi
 * tirado do bruto até 62,18 s, mas a tomada seguinte ("Fica até o final…") já
 * mexia boca e gesto em ~62,0 s. Com o limiar de silêncio relativo, a
 * inspiração e o ataque de "Fica" contavam como silêncio (60,89–62,23 s), o
 * `trimWordsToSilences` empurrava o início da palavra de 61,88 s (Whisper) para
 * 62,23 s, e o `holdLimit` do item saía desse início empurrado menos o guard.
 * O fix usa o início cru da palavra (o menor dos dois).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveBlocks, TAKE_DEFAULTS, trimWordsToSilences, type BlocksFile, type Word } from "../scripts/lib/diaria/video-montage.ts";

const w = (text: string, start: number, end: number): Word => ({ text, start, end });

// O gancho termina em 60,89; "Fica" começa no Whisper em 61,88; o silêncio vai até 62,23 (pega o ataque).
const words: Word[] = [
  w("Você", 59.6, 59.9), w("sabia", 59.9, 60.3), w("disso?", 60.3, 60.89),
  w("Fica", 61.88, 62.5), w("até", 62.5, 62.8), w("o", 62.8, 62.9), w("final.", 62.9, 63.5),
];
const silences = [{ start: 60.89, end: 62.23 }];

describe("#13310: holdLimit pelo início cru da palavra seguinte", () => {
  it("pré-condição: o trim empurra o início de 'Fica' para o fim do silêncio", () => {
    assert.equal(trimWordsToSilences(words, silences)[3].start, 62.23);
  });

  it("item explícito: o respiro para antes do início cru de 'Fica' (61,88 − guard), não de 62,23", () => {
    const file: BlocksFile = { edition: "261117", blocks: { titulo: [{ start: 59.5, end: 60.95, text: "Você sabia disso?" }] } };
    const r = resolveBlocks(file, words, { durationS: 120, silences });
    assert.deepEqual(r.errors, []);
    const it0 = r.blocks.titulo![0];
    assert.equal(it0.holdLimit, Number((61.88 - TAKE_DEFAULTS.guardS).toFixed(3)));
    assert.ok(it0.holdLimit < 62.0, `o respiro não chega à preparação visual da tomada seguinte (${it0.holdLimit})`);
  });

  it("item por tomada (frase): mesmo limite", () => {
    const file: BlocksFile = { edition: "261117", blocks: { titulo: [{ text: "Você sabia disso?" }] } };
    const r = resolveBlocks(file, words, { durationS: 120, silences });
    assert.deepEqual(r.errors, []);
    assert.equal(r.blocks.titulo![0].holdLimit, Number((61.88 - TAKE_DEFAULTS.guardS).toFixed(3)));
  });

  it("sem silêncio sobre a palavra seguinte, nada muda (início cru = início aparado)", () => {
    const file: BlocksFile = { edition: "261117", blocks: { titulo: [{ text: "Você sabia disso?" }] } };
    const r = resolveBlocks(file, words, { durationS: 120, silences: [{ start: 60.89, end: 61.5 }] });
    assert.equal(r.blocks.titulo![0].holdLimit, Number((61.88 - TAKE_DEFAULTS.guardS).toFixed(3)));
  });

  it("as palavras do item seguem aparadas (o fix só mexe no limite)", () => {
    const file: BlocksFile = { edition: "261117", blocks: { titulo: [{ text: "Você sabia disso?" }], comentario: [{ text: "Fica até o final." }] } };
    const r = resolveBlocks(file, words, { durationS: 120, silences });
    assert.equal(r.blocks.comentario![0].words[0].start, 62.23);
  });
});
