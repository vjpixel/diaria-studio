import { it } from "node:test";
import assert from "node:assert/strict";
import { audioEndFromSilences, parseSilenceDetect, reviewPreview, transcriptWords } from "../scripts/lib/diaria/video-montage.ts";

it("#12271 filtra duração até 20 ms, silêncio provável e créditos alucinados", () => {
  const real = { start: 0, end: 0.4, text: "Olá" };
  const words = transcriptWords({ segments: [
    { start: 0, end: 1, text: "Olá", words: [real, { start: 0.5, end: 0.52, text: "aí" }, { start: 1, end: 1, text: "Siga" }] },
    { start: 1, end: 2, text: "E aí E aí", no_speech_prob: 0.9, words: [{ start: 1, end: 2, text: "E aí E aí" }] },
    { start: 2, end: 3, text: "Transcrição e Legendas Pedro Negri", words: [{ start: 2, end: 3, text: "Transcrição" }] },
  ] });
  assert.deepEqual(words, [real]);
});

it("#12271 mede cauda pelo áudio apesar de alucinações além do fim", () => {
  const words = [{ start: 0, end: 1.64, text: "Olá" }, { start: 1.64, end: 1.64, text: "Siga" }];
  const audioEndS = audioEndFromSilences(parseSilenceDetect("silence_start: 0.6", 1), 1);
  assert.equal(audioEndS, 0.6);
  assert.deepEqual(reviewPreview({ words, script: "Olá", cuts: [], durationS: 1, audioEndS }), []);
  const findings = reviewPreview({ words, script: "Olá", cuts: [], durationS: 1, audioEndS: 0.9 });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, "final-seco");
  assert.equal(findings[0].at, 0.9);
  assert.match(findings[0].detail, /0.10 s/);
  assert.equal(audioEndFromSilences([], 1), 1);
  assert.equal(audioEndFromSilences([{ start: 0, end: 1 }], 1), 0);
  assert.equal(audioEndFromSilences([{ start: 0.1, end: 0.3 }], 1), 1);
});

it("#12271 continua detectando fala extra real", () => {
  const words = [{ start: 0, end: 0.3, text: "Olá" }, { start: 0.4, end: 0.8, text: "extra" }];
  assert.equal(reviewPreview({ words, script: "Olá", cuts: [], durationS: 1.5, audioEndS: 0.8 })[0].kind, "fala-extra");
});
