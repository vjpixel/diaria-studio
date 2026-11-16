/**
 * test/video-montagem-vinheta-silencio-13239.test.ts — #13239, o que a PR
 * #13246 deixou de fora:
 *  - item 3: o silêncio que completa a pausa da vinheta é escolhido por
 *    energia (o mesmo limite do "corta som" da checagem de entrada, #12263) e
 *    pelo rosto parado nos itens vizinhos (`face`), não só pela distância; o
 *    trecho escolhido sai como `[premissa]` (`SequencePlan.premises`);
 *  - item 5: a estimativa de duração do roteiro (`duracaoPorVideo`) e da
 *    decupagem (`suggestedDurations`) soma a pausa da vinheta.
 * Tudo sintético: energia por quadro montada à mão, sem áudio real.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  VINHETA_BREATH_S,
  buildSequencePlan,
  pickVinhetaFiller,
  vinhetaBreathFor,
  type FillerEnergy,
  type ResolvedItem,
  type Segment,
  type SequenceSpec,
  type Word,
} from "../scripts/lib/diaria/video-montage.ts";
import { buildDecupagemDoc, decupagemMarkdown, suggestedDurations, type DecupagemPlan } from "../scripts/lib/diaria/video-montage-docs.ts";
import { duracaoPorVideo, renderDuracoes, roteiroDuracaoConfigFrom, ROTEIRO_DURACAO_DEFAULT } from "../scripts/lib/diaria/roteiro-videos.ts";
import type { RoteiroFalas } from "../scripts/lib/diaria/roteiro-gravacao.ts";

const FPS = 30;
const SPEC_V: SequenceSpec = { target: "outras-redes", name: "Diaria comentada_Vertical_V12", width: 1080, height: 1920, order: ["titulo", "abertura"], scales: [115, 130] };
const HOP = 0.01;

/** Energia de 0 a `durS` no piso (-70 dB), com trechos de som (`loud`: [início, fim, dB]). */
function energy(durS: number, loud: Array<[number, number, number]>, quietDb = -40): FillerEnergy {
  const n = Math.ceil(durS / HOP);
  const fullDb = new Float64Array(n).fill(-70);
  for (const [a, b, db] of loud) for (let k = Math.floor(a / HOP); k < Math.min(n, Math.ceil(b / HOP)); k++) fullDb[k] = db;
  return { hopS: HOP, fullDb, quietDb };
}

const w = (text: string, start: number, end: number): Word => ({ text, start, end });
const item = (start: number, end: number, text: string, words: Word[], holdLimit: number, framing?: { faceX: number; eyeY: number }): ResolvedItem => ({
  interval: { start, end },
  text,
  words,
  lastWordEnd: words.length ? words[words.length - 1].end : null,
  holdLimit,
  how: "explicit",
  ...(framing ? { framing } : {}),
});

describe("#13239 item 3: o silêncio da pausa da vinheta por energia e rosto", () => {
  // Fala do bloco até 34,44 s; itens ocupando 27–34,6 e 174–178 (como a 261116 do V12).
  const busy = [{ start: 27.2, end: 34.6 }, { start: 174, end: 178 }, { start: 60, end: 70 }];
  const base = { need: 1.4, from: 34.44, file: { start: 0, end: 300 }, busy, pad: 0.05 };
  const silences = [{ start: 0, end: 5 }, { start: 42.25, end: 44.1 }, { start: 90, end: 93 }];

  it("261116: som nos 40 ms antes do corte (-52 dB): a pausa sai desse ponto, para dentro do mesmo silêncio", () => {
    // -52 dB nos 40 ms antes do corte, acima do limite de -55 dB: o "corta som" do build.
    const e = energy(300, [[42.27, 42.3, -52]], -55);
    const p = pickVinhetaFiller({ ...base, silences, energy: e });
    assert.ok(p);
    assert.ok(p.srcIn - 0.04 >= 42.3 && p.srcOut <= 44.05 + 1e-9, `pausa em ${p.srcIn}–${p.srcOut}`);
    assert.ok(p.why.some((x) => /sem som/.test(x)), p.why.join("; "));
    // Sem energia (detector desligado), a escolha de antes: o mais perto depois da fala.
    const old = pickVinhetaFiller({ ...base, silences });
    assert.equal(old?.srcIn, 42.3);
    assert.ok(old?.why.some((x) => /sem medida de energia/.test(x)));
  });

  it("o silêncio mais perto com som de ponta a ponta (respiração, movimento) perde para um quieto mais longe", () => {
    const e = energy(300, [[42.2, 44.2, -50]], -55);
    const p = pickVinhetaFiller({ ...base, silences, energy: e });
    assert.ok(p);
    assert.ok(p.srcIn >= 90, `ficou em ${p.srcIn}`);
    assert.ok(p.why.includes("depois da fala do bloco"));
  });

  it("som só no começo do silêncio: a pausa vai para o ponto quieto dentro dele, sem trocar de silêncio", () => {
    const e = energy(300, [[90, 90.6, -45]]);
    const p = pickVinhetaFiller({ ...base, silences: [{ start: 90, end: 93 }], energy: e });
    assert.ok(p);
    assert.ok(p.srcIn > 90.6 + 0.04, `pausa em ${p.srcIn}, ainda no som`);
    assert.ok(p.srcOut <= 93 - 0.05 + 1e-9);
    assert.equal(Math.round((p.srcOut - p.srcIn) * 1000) / 1000, 1.4);
  });

  it("todo silêncio com som: fica o mais quieto disponível, e a premissa diz que tem som", () => {
    const e = energy(300, [[42, 44.2, -30], [90, 93, -38]]);
    const p = pickVinhetaFiller({ ...base, silences: silences.slice(1), energy: e });
    assert.ok(p);
    assert.ok(p.srcIn >= 90);
    assert.ok(p.why.some((x) => /com som \(pico -38 dB/.test(x)), p.why.join("; "));
  });

  it("pré-roll segue por último, mesmo quieto e com o resto com som", () => {
    const e = energy(300, [[42, 44.2, -30], [90, 93, -30]]);
    const p = pickVinhetaFiller({ ...base, silences, energy: e });
    assert.ok(p && p.srcIn >= 42, `pré-roll escolhido: ${p?.srcIn}`);
  });

  it("rosto: o silêncio entre itens com o rosto em outra posição perde para um com o rosto parado", () => {
    const here = { faceX: 0.48, eyeY: 0.54 };
    const moved = { faceX: 0.6, eyeY: 0.5 };
    const framings = [
      { interval: { start: 27.2, end: 34.6 }, framing: here },
      { interval: { start: 45, end: 50 }, framing: moved }, // depois do silêncio de 42,25 s: o editor mudou de lugar
      { interval: { start: 60, end: 70 }, framing: here },
      { interval: { start: 95, end: 100 }, framing: here },
    ];
    const p = pickVinhetaFiller({ ...base, busy: [...busy, { start: 45, end: 50 }, { start: 95, end: 100 }], silences: silences.slice(1), framings, itemFraming: here });
    assert.ok(p);
    assert.ok(p.srcIn >= 90, `ficou no silêncio com o rosto em outra posição: ${p.srcIn}`);
    assert.ok(p.why.includes("rosto parado nos vizinhos"), p.why.join("; "));
    // Sem framing medido, o rosto não pesa: volta o mais perto.
    assert.equal(pickVinhetaFiller({ ...base, silences: silences.slice(1) })?.srcIn, 42.3);
  });

  it("buildSequencePlan: com a energia do detector, o trecho escolhido sai como [premissa] com os critérios", () => {
    const resolved = {
      titulo: [item(20, 23, "a vinheta", [w("a", 20, 21.5), w("vinheta", 21.6, 22.9)], 23.2)],
      abertura: [item(23.2, 30, "olá eu sou", [w("olá", 23.2, 24), w("sou", 24.1, 30)], 30)],
    };
    const sil = [{ start: 22.95, end: 23.2 }, { start: 40, end: 42 }, { start: 80, end: 83 }];
    // O silêncio de 40–42 s tem som de ponta a ponta; o de 80–83 s é quieto.
    const e = energy(600, [[39.9, 42.1, -30]]);
    const p = buildSequencePlan(SPEC_V, resolved, sil, { fps: FPS, durationS: 600 }, { breathAfter: vinhetaBreathFor(SPEC_V), fillerEnergy: e });
    const filler = p.clips.find((c) => c.filler);
    assert.ok(filler);
    assert.ok(filler.srcIn >= 80, `pausa em ${filler.srcIn}`);
    assert.equal(p.warnings, undefined);
    assert.equal(p.premises?.length, 1);
    assert.match(p.premises![0], /pausa completada com 1\.40 s de silêncio do bruto em 80\.05–81\.45 s.*depois da fala do bloco, fora dos itens, sem som \(pico -70 dB, limite -40 dB\).*conferir esse trecho no Premiere/);
  });
});

describe("#13239 item 5: a estimativa de duração conta a pausa da vinheta", () => {
  const FIXTURE = join(import.meta.dirname, "fixtures", "roteiro-video", "roteiro-falas-261116.json");
  const roteiro = (): RoteiroFalas => JSON.parse(readFileSync(FIXTURE, "utf8"));

  it("roteiro: cada vídeo soma a pausa à fala (os verticais da 261116 saíram 1,4 s mais longos que a conta)", () => {
    const sem = new Map(duracaoPorVideo(roteiro(), { ...ROTEIRO_DURACAO_DEFAULT, pausaVinhetaS: 0 }).map((d) => [d.video, d]));
    const com = duracaoPorVideo(roteiro());
    assert.equal(com.length, 3);
    for (const d of com) {
      assert.equal(d.pausaS, VINHETA_BREATH_S);
      const s = sem.get(d.video)!;
      assert.ok(d.segundos - s.segundos >= 1 && d.segundos - s.segundos <= 2, `${d.video}: ${s.segundos} → ${d.segundos}`);
    }
    assert.match(renderDuracoes(roteiro()), /inclui ~1,7 s da pausa da vinheta/);
  });

  it("a pausa empurra para fora do alvo a vertical que só a fala deixava no limite", () => {
    const r = roteiro();
    const v1 = duracaoPorVideo(r, { ...ROTEIRO_DURACAO_DEFAULT, pausaVinhetaS: 0 }).find((d) => d.video === "vertical1")!;
    const alvo = { ...ROTEIRO_DURACAO_DEFAULT.alvoS, vertical1: v1.segundos };
    assert.equal(duracaoPorVideo(r, { ...ROTEIRO_DURACAO_DEFAULT, alvoS: alvo, pausaVinhetaS: 0 }).find((d) => d.video === "vertical1")!.foraDoAlvo, false);
    assert.equal(duracaoPorVideo(r, { ...ROTEIRO_DURACAO_DEFAULT, alvoS: alvo }).find((d) => d.video === "vertical1")!.foraDoAlvo, true);
  });

  it("config: pausa_vinheta_s sobrepõe, 0 tira da conta, inválido cai no default com aviso", () => {
    const avisos: string[] = [];
    assert.equal(roteiroDuracaoConfigFrom({ publishing: { video: { roteiro: { pausa_vinheta_s: 0 } } } }).pausaVinhetaS, 0);
    assert.equal(roteiroDuracaoConfigFrom({ publishing: { video: { roteiro: { pausa_vinheta_s: 2 } } } }).pausaVinhetaS, 2);
    assert.equal(roteiroDuracaoConfigFrom({ publishing: { video: { roteiro: { pausa_vinheta_s: "x" } } } }, (m) => void avisos.push(m)).pausaVinhetaS, VINHETA_BREATH_S);
    assert.ok(avisos.some((a) => /pausa_vinheta_s inválido/.test(a)));
  });

  it("decupagem: a montagem sugerida soma a pausa quando o título tem fala \"usar\"; sem título, não", () => {
    const seg = (text: string, start: number, end: number): Segment => ({ start, end, text, words: [{ start, end, text }] } as Segment);
    const segs = [seg("Google lança modo IA.", 0, 4), seg("Comentário sobre o modo IA.", 5, 65), seg("Até amanhã!", 66, 69)];
    const plan: DecupagemPlan = {
      edition: "261116",
      blocks: [
        { key: "titulo", rows: [{ segments: [1], suggestion: "usar" }] },
        { key: "comentario", rows: [{ segments: [2], suggestion: "usar" }] },
        { key: "fecho", rows: [{ segments: [3], suggestion: "usar" }] },
      ],
    };
    const d = suggestedDurations(buildDecupagemDoc(plan, segs));
    for (const x of d) {
      assert.equal(x.pausaS, VINHETA_BREATH_S, x.spec.name);
      assert.equal(Math.round(x.totalS * 10) / 10, Math.round((4 + 60 + 3 + VINHETA_BREATH_S) * 10) / 10, x.spec.name);
    }
    assert.match(decupagemMarkdown("261116", buildDecupagemDoc(plan, segs)), /mais a pausa de 1,7 s da vinheta depois do título/);
    const semTitulo: DecupagemPlan = { ...plan, blocks: [{ key: "titulo", rows: [{ segments: [1], suggestion: "cortar" }] }, ...plan.blocks.slice(1)] };
    for (const x of suggestedDurations(buildDecupagemDoc(semTitulo, segs))) assert.equal(x.pausaS, 0, x.spec.name);
  });
});
