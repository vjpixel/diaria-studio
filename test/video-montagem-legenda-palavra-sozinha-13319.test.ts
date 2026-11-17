/**
 * test/video-montagem-legenda-palavra-sozinha-13319.test.ts — legenda nunca
 * deixa uma palavra sozinha quando dá para evitar (#13319, pedido do editor na
 * 261117: "falso.", "diabetes.", "cura?" saíam numa cue só).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cuesToSrt, rebalanceLoneWords, segmentCues, wrapCueText } from "../scripts/lib/diaria/video-montage.ts";

const words = (text: string, t0 = 0) => text.split(" ").map((w, i) => ({ start: t0 + i * 0.3, end: t0 + i * 0.3 + 0.25, text: w }));
const texts = (cues: { text: string }[][]) => cues.map((c) => c.map((w) => w.text).join(" "));

describe("#13319: cue com uma palavra só", () => {
  it("261117: a última palavra da frase que passa dos 50 caracteres leva a anterior junto", () => {
    const cues = segmentCues(words("Tem gente largando o remédio por causa de vídeo falso. Tem até o Drauzio Varella vendendo remédio para diabetes."));
    for (const c of cues) assert.ok(c.length >= 2, `cue de uma palavra: ${c.map((w) => w.text).join(" ")}`);
    assert.ok(texts(cues).includes("vídeo falso."), texts(cues).join(" | "));
    assert.ok(texts(cues).includes("para diabetes."), texts(cues).join(" | "));
  });

  it("frase de uma palavra só fica sozinha (\"Não.\")", () => {
    const cues = segmentCues(words("E denunciar funciona? Não. Ao denunciar no Instagram, por exemplo, nada muda."));
    assert.ok(texts(cues).includes("Não."));
  });

  it("cue de uma palavra que abre frase puxa a 1ª da seguinte; a doadora nunca fica com menos de 2", () => {
    const w = words("Fim. Abre frase que continua bem longa aqui.");
    const out = rebalanceLoneWords([[w[0]], [w[1]], w.slice(2)]);
    assert.deepEqual(texts(out), ["Fim.", "Abre frase", "que continua bem longa aqui."]);
    const curta = words("Uma duas três");
    assert.deepEqual(texts(rebalanceLoneWords([curta.slice(0, 2), [curta[2]]])), ["Uma duas", "três"]);
  });

  it("fim de frase com aspas ou reticências conta como fim (não rouba palavra da frase anterior)", () => {
    const w = words("Ele disse: chega.\" Não.");
    assert.deepEqual(texts(rebalanceLoneWords([w.slice(0, 3), [w[3]]])), ["Ele disse: chega.\"", "Não."]);
    const r = words("E então… Fim.");
    assert.deepEqual(texts(rebalanceLoneWords([r.slice(0, 2), [r[2]]])), ["E então…", "Fim."]);
  });

  it("token colado no anterior (\"%\", \",5\") nunca é separado dele", () => {
    const w = [...words("subiu para 50"), { start: 1, end: 1.1, text: "%" }];
    const lone = { start: 2, end: 2.2, text: "hoje." };
    const out = rebalanceLoneWords([w, [lone]]);
    assert.deepEqual(texts(out), ["subiu para 50 %", "hoje."]);
  });

  it("os tempos seguem as palavras movidas", () => {
    const srt = cuesToSrt(segmentCues(words("Tem gente largando o remédio por causa de vídeo falso.")));
    assert.match(srt, /\nvídeo falso\.\n/);
    assert.doesNotMatch(srt, /\nfalso\.\n/);
  });
});

describe("#13319: linha com uma palavra só", () => {
  it("quebra no espaço mais perto do meio que deixa 2 palavras de cada lado", () => {
    const out = wrapCueText("Desinformação generalizada é perigosa demais");
    for (const line of out.split("\n")) assert.ok(line.split(" ").length >= 2, out);
  });

  it("se evitar a palavra sozinha deixar uma linha longa demais, quebra no meio como antes", () => {
    const out = wrapCueText("a b desinformaçãogeneralizada perigosamente");
    for (const line of out.split("\n")) assert.ok(line.length <= 32, out);
  });

  it("com 2 ou 3 palavras não há como evitar: quebra no meio como antes", () => {
    assert.equal(wrapCueText("Desinformaçãogeneralizadíssima perigosa").split("\n").length, 2);
  });
});
