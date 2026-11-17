/**
 * #13413 — o refino de bordas cortou "Hydrogen" como som fora do roteiro na
 * 261116 (H12, sequência `guia`: saída 964,88 → 963,91 s), apesar da regra de
 * vocabulário da edição `\b[Hh]idrog[êe]nio\b` → `Hydrogen`.
 *
 * Causa: o `blocks.json` guardava a regra como `"\b[Hh]idrog[êe]nio\b"`. No
 * JSON, `\b` é o escape do BACKSPACE (U+0008), não a fronteira de palavra da
 * regex (que no JSON se escreve `"\\b"`). A regex compilada exigia um backspace
 * antes do "H" e nunca casava: a palavra ouvida ficava "hidrogênio.", não
 * casava com o "Hydrogen," do transcript e saía do clipe. Os textos aqui vêm do
 * JSON (`JSON.parse`), como no disco, e não de literal TS, que esconderia o bug.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { edgeExtras, edgeWindowsFor, trimEdgeExtras, type Envelope } from "../scripts/lib/diaria/video-cut-refine.ts";
import {
  applyVocabularyToWords,
  parseBlocksFile,
  validateVocabRules,
  vocabPatternSource,
  type RawClip,
  type VocabRule,
  type Word,
} from "../scripts/lib/diaria/video-montage.ts";
import { applyVocabularyToText } from "../scripts/lib/diaria/video-montage-docs.ts";

// O trecho do `blocks.json` da 261116 como está no arquivo (um só `\` antes do b).
const BLOCKS_VOCAB_JSON = String.raw`[{"pattern": "\b[Hh]idrog[êe]nio\b", "replacement": "Hydrogen"}]`;
const rules = JSON.parse(BLOCKS_VOCAB_JSON) as VocabRule[];

// A retranscrição da borda (`edge-retranscribe.json`, janela 962.29-965.17).
const heard: Word[] = [
  { start: 962.29, end: 962.95, text: "Para" },
  { start: 962.95, end: 963.17, text: "tirar" },
  { start: 963.17, end: 963.29, text: "o" },
  { start: 963.29, end: 963.65, text: "máximo" },
  { start: 963.65, end: 963.91, text: "do" },
  { start: 963.91, end: 964.63, text: "hidrogênio." },
];
// As palavras do transcript dentro do clipe.
const reference: Word[] = [
  { start: 962.94, end: 963.16, text: "tirar" },
  { start: 963.16, end: 963.3, text: "o" },
  { start: 963.3, end: 963.64, text: "máximo" },
  { start: 963.64, end: 963.9, text: "do" },
  { start: 963.9, end: 964.6, text: "Hydrogen," },
];
const clip = { srcIn: 962.59, srcOut: 964.875, script: "Pra tirar o máximo do Hydrogen, tanto na Busca quanto no app, eu vou te dar três dicas." };
// Envelope vazio: toda palavra conta como com energia de fala (o pior caso para a borda).
const env: Envelope = { hopS: 0.01, db: new Float64Array(0) };

describe("#13413 — \\b mal escapado no JSON do vocabulário", () => {
  it("o pattern lido do JSON traz o backspace, e a fonte da regex o devolve como \\b", () => {
    assert.ok(rules[0].pattern.includes("\u0008"), "pré-condição: o JSON decodifica \\b como U+0008");
    assert.equal(vocabPatternSource(rules[0].pattern), String.raw`\b[Hh]idrog[êe]nio\b`);
    // Padrão bem escapado não muda.
    assert.equal(vocabPatternSource(String.raw`\bSonnet\b`), String.raw`\bSonnet\b`);
  });

  it("a regra reescreve a palavra ouvida", () => {
    assert.deepEqual(applyVocabularyToWords(heard, rules).map((w) => w.text), ["Para", "tirar", "o", "máximo", "do", "Hydrogen."]);
    assert.equal(applyVocabularyToText("Pra tirar o máximo do hidrogênio.", rules), "Pra tirar o máximo do Hydrogen.");
  });

  it("a saída do H12 não se move (edgeExtras)", () => {
    const d = edgeExtras({ edge: "out", clip, heard, reference, env, thresholdDb: -50, rules });
    assert.equal(d.to, undefined, `a borda não pode sair do lugar (extra: ${d.extra ?? "-"})`);
  });

  it("a saída do H12 não se move (trimEdgeExtras, o caminho do build)", () => {
    const raw = { block: "comentario", ...clip } as unknown as RawClip;
    // Toda janela de borda que o refino pede recebe a retranscrição (chaves de `edgeWindowsFor`).
    const heardByWindow = new Map(edgeWindowsFor(raw, 2000).map((w) => [w.key, heard] as [string, Word[]]));
    const r = trimEdgeExtras([raw], heardByWindow, reference, env, { thresholdDb: -50, durationS: 2000, rules });
    assert.deepEqual(r.adjustments, [], "nenhum ajuste de borda: Hydrogen é fala do roteiro");
    assert.equal(r.clips[0].srcOut, clip.srcOut);
  });

  it("o blocks.json com o \\b mal escapado segue válido", () => {
    assert.deepEqual(validateVocabRules(rules, "blocks.json vocabulary"), []);
    const parsed = parseBlocksFile(JSON.parse(`{"edition": "261116", "blocks": {}, "vocabulary": ${BLOCKS_VOCAB_JSON}}`));
    if (!parsed.ok) assert.ok(!parsed.errors.some((e) => e.includes("vocabulary")), parsed.errors.join("; "));
  });
});
