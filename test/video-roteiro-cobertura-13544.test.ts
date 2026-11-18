/**
 * #13544: na 261118 o CTA dos dois verticais (V1-CTA e V2-CTA) foi gravado no
 * 2º arquivo da pasta e a montagem usou só o 1º, sem aviso nenhum. Aqui: a fala
 * do roteiro sem tomada no blocks.json sai por id, o vídeo solto fora do bruto
 * vira aviso com o `transcribe --source a,b`, e os vídeos que a própria
 * montagem grava na pasta nunca são bruto.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  falasSemTomada,
  falasSemTomadaAviso,
  readRoteiroFalasLista,
  videosForaDoBruto,
  videosForaDoBrutoAviso,
} from "../scripts/lib/diaria/video-roteiro-cobertura.ts";
import { isMontageArtifact, pickRawSource } from "../scripts/lib/diaria/video-montage.ts";

const FALAS = [
  { id: "H1", texto: "O Google soltou uma regra nova para os modelos de IA na Europa.", videos: ["horizontal", "vertical1"] },
  { id: "H2", texto: "E isso muda o que você pode pedir para o Gemini.", videos: ["horizontal"] },
  { id: "V1-CTA", texto: "Você acha que eu acerto a terceira? Comenta aí.", videos: ["vertical1"] },
  { id: "V2-CTA", texto: "A sua empresa tem algum serviço de IA? Me conta nos comentários.", videos: ["vertical2"] },
];

describe("#13544 falasSemTomada", () => {
  it("caso da 261118: as duas falas de CTA sem item saem por id, na ordem do roteiro", () => {
    const items = [
      { text: "O Google soltou uma regra nova para os modelos de IA na Europa.", falaId: "H1" },
      { text: "E isso muda o que você pode pedir para o Gemini." },
    ];
    assert.deepEqual(falasSemTomada(FALAS, items).map((f) => f.id), ["V1-CTA", "V2-CTA"]);
    const msg = falasSemTomadaAviso(falasSemTomada(FALAS, items), ["20261117_183905.mp4"])!;
    assert.match(msg, /2 fala\(s\) do roteiro sem tomada no blocks\.json: V1-CTA \(vertical1\), V2-CTA \(vertical2\)/);
    assert.match(msg, /20261117_183905\.mp4/);
    assert.match(msg, /--source a,b --force/);
  });

  it("todas com tomada: nada a avisar", () => {
    const items = FALAS.map((f) => ({ text: f.texto, fala: f.id }));
    assert.deepEqual(falasSemTomada(FALAS, items), []);
    assert.equal(falasSemTomadaAviso([], []), null);
  });

  it("casamento pelo texto: trecho do corte parcial (3+ palavras), fala dita de outro jeito e o ouvido", () => {
    const sem = falasSemTomada(FALAS, [
      { text: "uma regra nova para os modelos" }, // trecho de H1
      { text: "e isso muda tudo o que você pode pedir pro Gemini" }, // H2 dito de outro jeito
      { text: "Você acha que eu acerto?", heard: "Você acha que eu acerto a terceira? Comenta aí." }, // V1-CTA pelo ouvido
    ]);
    assert.deepEqual(sem.map((f) => f.id), ["V2-CTA"]);
  });

  it("item com id de outra fala não cobre esta pelo texto; item curto não cobre fala nenhuma", () => {
    const sem = falasSemTomada(FALAS, [
      { text: "A sua empresa tem algum serviço de IA? Me conta nos comentários.", falaId: "H2" },
      { text: "Comenta aí." },
    ]);
    assert.deepEqual(sem.map((f) => f.id), ["H1", "V1-CTA", "V2-CTA"]);
  });
});

describe("#13544 readRoteiroFalasLista", () => {
  it("lê id, texto e vídeos; roteiro ausente = []; ilegível = [] com aviso", () => {
    const dir = mkdtempSync(join(tmpdir(), "rot-13544-"));
    assert.deepEqual(readRoteiroFalasLista(dir, () => assert.fail("sem aviso")), []);
    mkdirSync(join(dir, "_internal"));
    writeFileSync(join(dir, "_internal", "roteiro-falas.json"), JSON.stringify({ falas: [...FALAS, { id: "X" }, null] }));
    assert.deepEqual(readRoteiroFalasLista(dir, () => assert.fail("sem aviso")).map((f) => f.id), ["H1", "H2", "V1-CTA", "V2-CTA"]);
    writeFileSync(join(dir, "_internal", "roteiro-falas.json"), "{ quebrado");
    const avisos: string[] = [];
    assert.deepEqual(readRoteiroFalasLista(dir, (m) => avisos.push(m)), []);
    assert.match(avisos[0], /ilegível.*#13544/);
  });
});

describe("#13544 vídeo solto fora do bruto", () => {
  const pasta = [
    { name: "20261117_181712.mp4", size: 9e9 },
    { name: "20261117_183905.mp4", size: 1e9 },
    { name: "261118_cta_card_horizontal-ab12cd34.mp4", size: 2e6 },
    { name: "261118_trecho_H3-0123456789ab.mov", size: 3e6 },
    { name: "261118 - previa vertical.mp4", size: 5e7 },
  ];

  it("os artefatos da montagem (card de CTA, trecho inserido) nunca são bruto", () => {
    assert.equal(isMontageArtifact("261118_cta_card_horizontal-ab12cd34.mp4"), true);
    assert.equal(isMontageArtifact("261118_trecho_H3-0123456789ab.mov"), true);
    assert.equal(isMontageArtifact("20261117_181712.mp4"), false);
    assert.deepEqual(pickRawSource(pasta)!.candidates.map((c) => c.name), ["20261117_181712.mp4", "20261117_183905.mp4"]);
  });

  it("o 2º arquivo fora do source.json vira aviso com o transcribe dos dois", () => {
    const source = { path: "I:/Meu Drive/diaria-studio-video/261118/20261117_181712.mp4" };
    const extras = videosForaDoBruto(pickRawSource(pasta)!.candidates, source);
    assert.deepEqual(extras, ["20261117_183905.mp4"]);
    const msg = videosForaDoBrutoAviso("261118", extras, source)!;
    assert.match(msg, /transcribe 261118 --source "20261117_181712\.mp4,20261117_183905\.mp4" --force/);
  });

  it("bruto já em vários arquivos com os dois: nada a avisar", () => {
    const source = { path: "x/20261117_181712.mp4", files: [{ path: "x/20261117_181712.mp4" }, { path: "x/20261117_183905.mp4" }] };
    assert.deepEqual(videosForaDoBruto(pickRawSource(pasta)!.candidates, source), []);
    assert.equal(videosForaDoBrutoAviso("261118", [], source), null);
  });
});
