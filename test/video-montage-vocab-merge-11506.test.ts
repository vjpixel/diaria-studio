/**
 * test/video-montage-vocab-merge-11506.test.ts (#11506) — o vocabulário da
 * montagem junta e separa palavras. Na 261029 o Whisper ouviu "ChatGPT" como
 * "chat EPT"; a regra `[Cc]hat(\s)?EPT` → "ChatGPT" era pulada ("muda o número
 * de palavras"), e o roteiro marcava "fala difere" no item.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyVocabularyToWords, resolveBlocks, type BlocksFile, type VocabRule, type Word } from "../scripts/lib/diaria/video-montage.ts";
import { loadVocab } from "../scripts/video-montagem.ts";

function say(text: string, t0: number, dur = 0.3, gap = 0.05): Word[] {
  let t = t0;
  return text.split(" ").map((w) => {
    const word = { start: Math.round(t * 1000) / 1000, end: Math.round((t + dur) * 1000) / 1000, text: w };
    t += dur + gap;
    return word;
  });
}

const texts = (ws: Word[]) => ws.map((w) => w.text);

describe("vocabulário N→1 e 1→N (#11506)", () => {
  const vocab = loadVocab();

  it("regressão 261029: 'chat EPT' vira 'ChatGPT' (regra do vocabulário global), do início da 1ª ao fim da última", () => {
    const words = say("o chat EPT respondeu", 10);
    const avisos: string[] = [];
    const out = applyVocabularyToWords(words, vocab.rules, undefined, (m) => avisos.push(m));
    assert.deepEqual(texts(out), ["o", "ChatGPT", "respondeu"]);
    assert.equal(out[1].start, words[1].start);
    assert.equal(out[1].end, words[2].end);
    assert.deepEqual(out[2], words[3], "a palavra seguinte não muda");
    assert.deepEqual(avisos, []);
  });

  it("o item do roteiro casa sem 'fala difere'", () => {
    const words = say("bom dia hoje o chat EPT respondeu tudo", 0);
    const file: BlocksFile = { edition: "261029", blocks: { comentario: [{ text: "Hoje o ChatGPT respondeu tudo." }] } };
    const r = resolveBlocks(file, words, { durationS: 30, rules: vocab.rules, aliases: vocab.aliases });
    assert.deepEqual(r.errors, []);
    assert.equal(r.warnings.filter((w) => /difere/.test(w)).length, 0, r.warnings.join("\n"));
    const item = r.blocks.comentario?.[0];
    assert.ok(item && item.heard === undefined);
    assert.deepEqual(texts(item.words), ["hoje", "o", "ChatGPT", "respondeu", "tudo"]);
  });

  it("pontuação colada fica: 'Chat EPT,' → 'ChatGPT,'; 'ChatGPT' já certo não muda", () => {
    assert.deepEqual(texts(applyVocabularyToWords(say("o Chat EPT, e", 0), vocab.rules)), ["o", "ChatGPT,", "e"]);
    const ok = say("o ChatGPT e", 0);
    assert.deepEqual(applyVocabularyToWords(ok, vocab.rules), ok);
  });

  it("1→N divide o tempo da palavra pelo tamanho das novas", () => {
    const rules: VocabRule[] = [{ pattern: "\\bIAgenerativa\\b", replacement: "IA generativa" }];
    const words: Word[] = [
      { start: 1, end: 1.2, text: "a" },
      { start: 1.3, end: 2.6, text: "IAgenerativa" },
      { start: 2.7, end: 3, text: "chegou" },
    ];
    const out = applyVocabularyToWords(words, rules);
    assert.deepEqual(texts(out), ["a", "IA", "generativa", "chegou"]);
    assert.equal(out[1].start, 1.3);
    assert.equal(out[2].end, 2.6);
    assert.equal(out[1].end, out[2].start);
    assert.ok(out[2].end - out[2].start > out[1].end - out[1].start, "a palavra maior fica com mais tempo");
  });

  it("casamento que começa ou termina no espaço junta a palavra vizinha", () => {
    const tail: VocabRule[] = [{ pattern: "chat\\s", replacement: "Chat" }];
    const out = applyVocabularyToWords(say("o chat EPT", 0), tail);
    assert.deepEqual(texts(out), ["o", "ChatEPT"]);
    const head: VocabRule[] = [{ pattern: "\\sEPT", replacement: "GPT" }];
    assert.deepEqual(texts(applyVocabularyToWords(say("o chat EPT", 0), head)), ["o", "chatGPT"]);
  });

  it("regra com o mesmo número de palavras guarda os tempos de cada uma ($1 expandido)", () => {
    const words = say("o Google Fotos", 0);
    const out = applyVocabularyToWords(words, vocab.rules);
    assert.deepEqual(texts(out), ["o", "Google", "Photos"]);
    out.forEach((w, i) => {
      assert.equal(w.start, words[i].start);
      assert.equal(w.end, words[i].end);
    });
  });

  it("regra sem 'g' troca só o 1º casamento; vários casamentos trocam todos", () => {
    const once: VocabRule[] = [{ pattern: "chat EPT", replacement: "ChatGPT", flags: "" }];
    assert.deepEqual(texts(applyVocabularyToWords(say("chat EPT e chat EPT", 0), once)), ["ChatGPT", "e", "chat", "EPT"]);
    assert.deepEqual(texts(applyVocabularyToWords(say("chat EPT e chat EPT", 0), vocab.rules)), ["ChatGPT", "e", "ChatGPT"]);
  });

  it("regra que apagaria palavras é pulada com aviso", () => {
    const avisos: string[] = [];
    const words = say("o chat EPT", 0);
    const out = applyVocabularyToWords(words, [{ pattern: "chat EPT", replacement: "" }], undefined, (m) => avisos.push(m));
    assert.deepEqual(texts(out), ["o", "chat", "EPT"]);
    assert.equal(avisos.length, 1);
    assert.match(avisos[0], /apagaria/);
  });
});
