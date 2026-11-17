/**
 * #13257: na 261116 o `srt --from-final` recusou o roteiro (export reeditado,
 * #12198) e a legenda pelo `--heard-text` subiu com 7 erros de grafia que o
 * modo roteiro corrigia ("Gemini for Hydrogen", "que usa de graça", "ele
 * anuncia menos", "Soné 5.5", "pelas reais", "e -mail") e com um cue final
 * "Música Música E aí" depois do fim da fala. Agora o `--heard-text` aplica a
 * grafia do roteiro nos trechos curtos ancorados e descarta o ruído do fim.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Word } from "../scripts/lib/diaria/video-montage.ts";
import { alignHeardTextToScript } from "../scripts/lib/diaria/video-montage.ts";
import { srtFromExport } from "../scripts/video-montagem.ts";

const say = (text: string, t0: number, dur = 0.3): Word[] =>
  text.split(" ").map((w, i) => ({ start: +(t0 + i * dur).toFixed(3), end: +(t0 + (i + 1) * dur).toFixed(3), text: w }));

/** Só o texto das legendas, unido por espaço (sem número nem tempo de cue). */
const textOf = (srt: string): string =>
  srt
    .split(/\r?\n/)
    .filter((l) => l.trim() && !/^\d+$/.test(l.trim()) && !l.includes("-->"))
    .join(" ");

const youtube = { target: "youtube" as const, width: 1920, height: 1080, name: "Diaria comentada_Youtube_V1", order: [], scales: [100, 110] as [number, number] };

// Roteiro gravado no plan.json, antes da reedição: a 3ª frase foi regravada diferente no export.
const script =
  "O Google lançou o Gemini 4 Hydrogen. " +
  "É de graça para quem usa de graça o app. " +
  "O modelo novo da empresa custa caro e demora para responder tudo que o usuário pergunta no chat. " +
  "A empresa diz que ele alucina menos que o Sonnet 5.5 da Anthropic. " +
  "A disputa pelas IAs mais baratas chegou ao seu e-mail também.";

// O export: a fala com os erros do Whisper da 261116, a 3ª frase regravada e o ruído do fim.
const heard: Word[] = [
  ...say("O Google lançou o Gemini for Hydrogen.", 0),
  ...say("É de graça para que usa de graça o app.", 3),
  ...say("Agora o modelo responde rápido e sai barato para todo mundo.", 7),
  ...say("A empresa diz que ele anuncia menos que o Soné 5.5 da Anthropic.", 12),
  ...say("A disputa pelas reais mais baratas chegou ao seu e -mail também.", 17),
  ...say("Música Música E aí", 22),
];

describe("#13257: --heard-text com a grafia do roteiro (caso 261116)", () => {
  it("regressão: as trocas de grafia do roteiro entram na legenda do --heard-text", () => {
    const { srt, notes, problems } = srtFromExport({ heard, plan: { spec: youtube, script }, rules: [], aliases: [], durationS: 30, text: "ouvido" });
    assert.deepEqual(problems, []);
    const flat = textOf(srt);
    for (const ok of ["Gemini 4 Hydrogen.", "para quem usa", "ele alucina menos", "Sonnet 5.5", "pelas IAs", "seu e-mail"]) assert.ok(flat.includes(ok), `falta "${ok}" em: ${flat}`);
    for (const bad of ["for Hydrogen", "que usa", "anuncia", "Soné", "reais", "e -mail"]) assert.ok(!flat.includes(bad), `sobrou "${bad}" em: ${flat}`);
    assert.ok(notes.some((n) => n.includes('ouvido "Soné", legenda com o roteiro "Sonnet"') && n.includes("#13257")), notes.join("\n"));
  });

  it("o trecho regravado (longo, fora do roteiro) fica como foi ouvido", () => {
    const { srt } = srtFromExport({ heard, plan: { spec: youtube, script }, rules: [], aliases: [], durationS: 30, text: "ouvido" });
    const flat = textOf(srt);
    assert.ok(flat.includes("responde rápido e sai barato para todo mundo."), flat);
    assert.ok(!flat.includes("demora para responder"), "o roteiro velho não volta");
  });

  it("regressão: o cue de ruído depois do fim da fala sai, com aviso", () => {
    const { srt, notes } = srtFromExport({ heard, plan: { spec: youtube, script }, rules: [], aliases: [], durationS: 30, text: "ouvido" });
    assert.ok(!/Música|E aí/.test(srt), srt);
    assert.ok(notes.some((n) => n.startsWith("[aviso]") && n.includes("Música Música E aí")), notes.join("\n"));
  });
});

describe("alignHeardTextToScript", () => {
  it("troca sem âncora dos dois lados não entra (palavra solta casada por acaso)", () => {
    // "de" casa sozinho entre dois trechos diferentes: sem 2 casadas em sequência, nada muda.
    const r = alignHeardTextToScript(say("carro azul de moto rápida", 0), "bicicleta verde de trem lento");
    assert.deepEqual(r.fixes, []);
    assert.equal(r.words.map((w) => w.text).join(" "), "carro azul de moto rápida");
  });

  it("trecho maior que o limite fica como ouvido", () => {
    const r = alignHeardTextToScript(say("o Google lançou um dois três quatro hoje cedo", 0), "o Google lançou cinco seis sete oito hoje cedo");
    assert.deepEqual(r.fixes, []);
    assert.ok(r.words.map((w) => w.text).join(" ").includes("um dois três quatro"));
  });

  it("ruído no meio da fala fica; só o do fim, depois da última casada, sai", () => {
    const r = alignHeardTextToScript(say("E aí, o Google lançou o modelo novo. Música", 0), "E aí, o Google lançou o modelo novo.");
    assert.equal(r.words.map((w) => w.text).join(" "), "E aí, o Google lançou o modelo novo.");
    assert.deepEqual(r.droppedTail.map((w) => w.text), ["Música"]);
  });

  it("fala real depois do roteiro não é ruído", () => {
    const r = alignHeardTextToScript(say("o Google lançou o modelo. Valeu, até amanhã", 0), "o Google lançou o modelo.");
    assert.deepEqual(r.droppedTail, []);
    assert.ok(r.words.map((w) => w.text).join(" ").endsWith("até amanhã"));
  });

  it("o tempo da troca é o do trecho ouvido", () => {
    const r = alignHeardTextToScript(say("o Google lançou o Gemini for Hydrogen hoje", 0), "o Google lançou o Gemini 4 Hydrogen hoje");
    const four = r.words.find((w) => w.text === "4");
    assert.deepEqual(four && [four.start, four.end], [1.5, 1.8]);
  });
});
