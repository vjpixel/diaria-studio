/**
 * #13460 — a passada B do refino de bordas (som fora do roteiro) cortou o
 * ".env" do roteiro na 261112 (youtube e guia, bloco `comentario`, saída
 * 744,94 → 744,39 s: `som fora do roteiro na borda: "Envy."`), e o editor
 * recolocou a palavra no final (comparação XML × final, #13196: "env." em
 * 744,40–744,94 s, cauda +540 ms).
 *
 * Duas causas, as duas no casamento da borda com o roteiro:
 *  1. a retranscrição ouviu "Envy." e o transcript "env.": o `tokensMatch` só
 *     aceita 1 letra de diferença a partir de 5 letras, então "envy" não casou
 *     com "env" e virou som a mais;
 *  2. o roteiro escreve ".env", que se fala "ponto env": o "ponto" casado não
 *     existia no roteiro tokenizado, então a proteção "palavra seguinte do
 *     roteiro fica" nem começava.
 *
 * Os dados são os da 261112 (`edge-retranscribe.json`, janela 742.79-745.24;
 * `transcript.json`; clipe do `plan.json` antes da passada B).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { edgeExtras, edgeVariant, spokenScriptTokens, trimEdgeExtras, windowKey, type Envelope } from "../scripts/lib/diaria/video-cut-refine.ts";
import type { RawClip, Word } from "../scripts/lib/diaria/video-montage.ts";

const heard: Word[] = [
  { start: 742.79, end: 743.39, text: "Por" },
  { start: 743.39, end: 743.77, text: "exemplo," },
  { start: 743.97, end: 744.09, text: "o" },
  { start: 744.09, end: 744.39, text: "ponto" },
  { start: 744.39, end: 745.03, text: "Envy." },
];
const reference: Word[] = [
  { start: 742.94, end: 743.4, text: "Por" },
  { start: 743.4, end: 743.76, text: "exemplo," },
  { start: 743.94, end: 744.06, text: "o" },
  { start: 744.06, end: 744.4, text: "ponto" },
  { start: 744.4, end: 744.94, text: "env." },
];
const clip = { srcIn: 743.09, srcOut: 744.94, script: "Por exemplo, o .env." };
// Envelope vazio: toda palavra conta como com energia de fala (o pior caso para a borda).
const env: Envelope = { hopS: 0.01, db: new Float64Array(0) };

describe("#13460 — passada B não tira palavra do roteiro escrita com ponto", () => {
  it("a saída da 261112 não se move (edgeExtras)", () => {
    const d = edgeExtras({ edge: "out", clip, heard, reference, env, thresholdDb: -45 });
    assert.equal(d.to, undefined, `a saída foi movida para ${d.to} (som a mais: ${d.extra})`);
  });

  it("trimEdgeExtras deixa o clipe inteiro, sem ajuste", () => {
    const raw = { block: "comentario", srcIn: 743.09, srcOut: 744.94, script: clip.script } as RawClip;
    const heardMap = new Map<string, Word[]>([[windowKey(742.79, 745.24), heard]]);
    const r = trimEdgeExtras([raw], heardMap, reference, env, { thresholdDb: -45, durationS: 2000 });
    assert.deepEqual(r.adjustments, []);
    assert.equal(r.clips[0].srcOut, 744.94);
  });

  it("só a variante (sem o 'ponto' no roteiro) também fica", () => {
    const d = edgeExtras({
      edge: "out",
      clip: { ...clip, script: "Por exemplo, o env." },
      heard: heard.filter((w) => w.text !== "ponto"),
      reference: reference.filter((w) => w.text !== "ponto"),
      env,
      thresholdDb: -45,
    });
    assert.equal(d.to, undefined);
  });

  it("som realmente fora do roteiro na saída continua saindo", () => {
    const extra: Word[] = [...heard, { start: 745.03, end: 745.4, text: "Então," }];
    const d = edgeExtras({ edge: "out", clip: { ...clip, srcOut: 745.4 }, heard: extra, reference, env, thresholdDb: -45 });
    assert.ok(d.to !== undefined && d.to < 745.4, `esperava corte antes de 745,4 s, veio ${d.to}`);
    assert.equal(d.extra, "Então,");
  });

  it("na entrada, o 'ponto' de uma palavra com ponto antes do 1º casado fica", () => {
    const h: Word[] = [
      { start: 10.0, end: 10.3, text: "ponto" },
      { start: 10.3, end: 10.7, text: "env" },
      { start: 10.8, end: 11.1, text: "guarda" },
      { start: 11.1, end: 11.4, text: "as" },
      { start: 11.4, end: 11.9, text: "chaves" },
    ];
    const ref: Word[] = h.slice(1);
    const d = edgeExtras({ edge: "in", clip: { srcIn: 9.95, srcOut: 11.95, script: "O .env guarda as chaves." }, heard: h, reference: ref, env, thresholdDb: -45 });
    assert.equal(d.to, undefined, `a entrada foi movida para ${d.to} (som a mais: ${d.extra})`);
  });
});

describe("#13460 — edgeVariant", () => {
  it("aceita uma letra a mais no fim a partir de 3 letras", () => {
    assert.equal(edgeVariant("Envy.", "env"), true);
    assert.equal(edgeVariant("env", "envy"), true);
    assert.equal(edgeVariant("env.", "ENV"), true);
  });
  it("recusa palavra curta, diferença no meio e mais de 1 letra", () => {
    assert.equal(edgeVariant("os", "o"), false);
    assert.equal(edgeVariant("ma", "mas"), false);
    assert.equal(edgeVariant("envio", "env"), false);
    assert.equal(edgeVariant("nevy", "env"), false);
    assert.equal(edgeVariant("", ""), false);
  });
});

describe("#13460 — spokenScriptTokens", () => {
  it("põe 'ponto' antes da palavra escrita com ponto", () => {
    assert.deepEqual(spokenScriptTokens("Por exemplo, o .env."), ["por", "exemplo", "o", "ponto", "env"]);
    assert.deepEqual(spokenScriptTokens("o arquivo (.gitignore) fica"), ["o", "arquivo", "ponto", "gitignore", "fica"]);
  });
  it("ponto final, reticências e número decimal não viram 'ponto'", () => {
    assert.deepEqual(spokenScriptTokens("Isso é tudo. ... E 6.1 mil."), ["isso", "e", "tudo", "e", "61", "mil"]);
  });
});
