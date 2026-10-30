import { it } from "node:test";
import assert from "node:assert/strict";
import { resolveBlocks, buildSequencePlan, trimWordsToSilences, mapWordsToSequence, type Word, type SequenceSpec } from "../scripts/lib/diaria/video-montage.ts";

const spec: SequenceSpec = { target: "outras-redes", name: "teste", width: 1080, height: 1920, order: ["comentario"], scales: [115, 130] };
const source = { fps: 30, durationS: 600 };
// Janela da emenda reportada na edição 261030; tempos internos sintéticos.
const words: Word[] = [{ start: 484.84, end: 490.9, text: "que" }, { start: 491, end: 493.46, text: "funciona" }];
const silences = [{ start: 484.8, end: 490 }];

it("#11677: início esticado sobre silêncio não causa fala difere no intervalo explícito", () => {
  const result = resolveBlocks({ edition: "261030", blocks: { comentario: [{ start: 490, end: 493.46, text: "que funciona" }] } }, words, { ...source, silences });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.blocks.comentario?.[0].words[0].start, 490);
  assert.equal(words[0].start, 484.84, "não modifica o transcript");
});

it("#11677: palavra na emenda pertence ao clipe com o núcleo audível", () => {
  const result = resolveBlocks({ edition: "261030", blocks: { comentario: [{ start: 484.84, end: 490.4 }, { start: 490.4, end: 493.46 }] } }, words, { ...source, silences });
  const plan = buildSequencePlan(spec, result.blocks, silences, source);
  assert.deepEqual(plan.dropped, []);
  const mapped = mapWordsToSequence(trimWordsToSilences(words, silences), plan.clips, source.fps);
  assert.deepEqual(mapped.map((w) => w.text), ["que", "funciona"]);
});

it("apara as duas bordas, preserva silêncio interno e palavras inteiras no silêncio", () => {
  const input = [{ start: 1, end: 5, text: "fala" }, { start: 1, end: 1.5, text: "incerta" }];
  assert.deepEqual(trimWordsToSilences(input, [{ start: 0, end: 2 }, { start: 3, end: 3.5 }, { start: 4, end: 6 }]), [{ start: 2, end: 4, text: "fala" }, input[1]]);
});

it("não esconde palavra cujo núcleo realmente ficou fora de todos os clipes", () => {
  const result = resolveBlocks({ edition: "261030", blocks: { comentario: [{ start: 484.84, end: 490.4 }] } }, words, source);
  const plan = buildSequencePlan(spec, result.blocks, silences, source);
  assert.match(plan.dropped.join("\n"), /palavra\(s\) fora dos clipes/);
});
