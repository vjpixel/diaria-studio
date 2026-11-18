/**
 * #13369 (R2 da #13199) — medição do Silero VAD como 2º voto nas pontas dos
 * clipes, contra o corte que o editor aprovou no Premiere (registro do
 * `video-xml-vs-final`). Só medição: nada aqui entra no `build`. Fixture:
 * probabilidades sintéticas por janela de 32 ms (as do `vad_probs.py`) e um
 * registro no formato de `data/video-xml-vs-final/{AAMMDD}.json`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  aggregateVadVote,
  edgeVote,
  editorEdge,
  longestSpeechRunS,
  measureVadVote,
  speechFraction,
  VAD_VOTE,
  type VadProbs,
} from "../scripts/lib/diaria/video-vad-vote.ts";
import type { ClipComparison, EditionRecord } from "../scripts/lib/diaria/video-xml-vs-final.ts";
import { main, splitList } from "../scripts/video-medicoes.ts";

const HOP = 0.032;
/** 20 s de áudio; `speech` = intervalos (s) com fala (prob 0,9), o resto 0,05. */
function vad(speech: Array<[number, number]>, durationS = 20): VadProbs {
  const n = Math.ceil(durationS / HOP);
  const probs = Array.from({ length: n }, (_, i) => {
    const t0 = i * HOP;
    const t1 = t0 + HOP;
    return speech.some(([a, b]) => t0 < b && t1 > a) ? 0.9 : 0.05;
  });
  return { hopS: HOP, probs };
}

const clip = (index: number, srcIn: number, srcOut: number, headMs: number | null, tailMs: number | null, extra: Partial<ClipComparison> = {}): ClipComparison => ({
  index,
  srcIn,
  srcOut,
  status: headMs === null ? "removed" : "kept",
  headMs,
  tailMs,
  internalPauses: [],
  finalStart: headMs === null ? null : srcIn,
  touched: true,
  ...extra,
});

const record = (clips: ClipComparison[]): Pick<EditionRecord, "edition" | "sequences"> => ({
  edition: "261105",
  sequences: [
    {
      key: "outras-redes",
      target: "outras-redes",
      finalFile: "x.mp4",
      xmlVersion: null,
      xmlDurationS: null,
      finalDurationS: null,
      coverage: 0.95,
      summary: {},
      loudness: null,
      framing: null,
      captions: null,
      detail: { clips, added: [], takeSwaps: [], orderInversions: 0, wordsRecovered: [], wordsRemoved: 0, finalUnpairedS: 0 },
    },
  ],
});

describe("#13369 o voto do Silero numa ponta", () => {
  it("fala logo antes da entrada = estender (a sílaba que o corte tirou)", () => {
    const v = vad([[1.8, 3]]);
    assert.equal(edgeVote(v, 2.0, "entrada"), "estender");
  });
  it("nada falado nos 300 ms depois da entrada = aparar (respiração que sobrou)", () => {
    const v = vad([[2.6, 4]]);
    assert.equal(edgeVote(v, 2.0, "entrada"), "aparar");
  });
  it("fala começando dentro da folga do detector = manter", () => {
    const v = vad([[2.15, 4]]);
    assert.equal(edgeVote(v, 2.0, "entrada"), "manter");
  });
  it("saída: fala depois = estender; sem fala nos 270 ms antes = aparar", () => {
    assert.equal(edgeVote(vad([[1, 5.1]]), 5.0, "saida"), "estender");
    assert.equal(edgeVote(vad([[1, 4.6]]), 5.0, "saida"), "aparar");
    assert.equal(edgeVote(vad([[1, 4.9]]), 5.0, "saida"), "manter");
  });
  it("uma janela isolada acima do limiar fora do clipe é estalo, não fala", () => {
    const v = vad([[2.5, 4]]);
    v.probs[Math.floor(1.9 / HOP)] = 0.95;
    assert.notEqual(edgeVote(v, 2.0, "entrada"), "estender");
    assert.ok(longestSpeechRunS(v, 1.7, 2.0) < VAD_VOTE.minSpeechS);
  });
  it("speechFraction e intervalo vazio", () => {
    const v = vad([[0, 1]]);
    assert.equal(speechFraction(v, 0, 0.96), 1);
    assert.equal(speechFraction(v, 3, 3), 0);
  });
});

describe("#13369 editorEdge", () => {
  it("abaixo da tolerância é manteve; o sinal diz a direção", () => {
    assert.equal(editorEdge(0), "manteve");
    assert.equal(editorEdge(VAD_VOTE.editorTolMs), "manteve");
    assert.equal(editorEdge(170), "estendeu");
    assert.equal(editorEdge(-213), "aparou");
  });
});

describe("#13369 measureVadVote contra o registro do xml-vs-final", () => {
  const v = vad([[1.8, 4.6], [8.3, 9.7], [12.2, 13.5], [13.8, 15]]);
  const rep = measureVadVote({
    record: record([
      // entrada cortou a sílaba (editor estendeu), saída com respiração (editor aparou)
      clip(0, 2.0, 5.0, 170, -300),
      // removido pelo editor: fora
      clip(1, 6.0, 7.0, null, null, { status: "removed" }),
      // entrada com respiração que o editor manteve (alarme falso), saída juntada ao vizinho: fora
      clip(2, 7.7, 9.8, 0, 0, { joinedTail: true }),
      // pausa interna removida pelo editor (13,5–13,8 s sem fala)
      clip(3, 12.1, 15.1, 0, 0, { internalPauses: [{ start: 13.52, end: 13.78, ms: 260 }] }),
      // além do fim do áudio: fora, uma linha por sequência
      clip(4, 30, 31, 0, 0),
    ]),
    vad: v,
  });

  it("pontas: votos e editor por ponta, juntadas e removidas fora", () => {
    const by = (c: number, side: string) => rep.edges.find((e) => e.clip === c && e.side === side);
    assert.deepEqual(
      [by(0, "entrada")?.vote, by(0, "entrada")?.editor, by(0, "entrada")?.agree],
      ["estender", "estendeu", true],
    );
    assert.deepEqual([by(0, "saida")?.vote, by(0, "saida")?.editor, by(0, "saida")?.agree], ["aparar", "aparou", true]);
    assert.deepEqual([by(2, "entrada")?.vote, by(2, "entrada")?.editor], ["aparar", "manteve"]);
    assert.equal(by(2, "saida"), undefined, "ponta juntada ao vizinho fica de fora");
    assert.equal(rep.edges.filter((e) => e.clip === 1).length, 0, "clipe removido fica de fora");
  });

  it("resumo: acertos, alarme falso, pausa que o Silero também cortaria", () => {
    assert.equal(rep.summary.hits, 2);
    assert.equal(rep.summary.falseAlarms, 1);
    assert.equal(rep.summary.pausesRemoved, 1);
    assert.equal(rep.summary.pausesVadCuts, 1);
    assert.equal(rep.summary.confusion.estender.estendeu, 1);
    assert.equal(rep.skipped.length, 1);
    assert.match(rep.skipped[0].reason, /1 clipe\(s\) além do fim do áudio do VAD/);
  });

  it("agregado: precisão e cobertura sobre as edições", () => {
    const a = aggregateVadVote([rep, { ...rep, edition: "261106" }]);
    assert.deepEqual(a.editions, ["261105", "261106"]);
    assert.equal(a.summary.edges, rep.summary.edges * 2);
    assert.equal(a.precision, Math.round((4 / (rep.summary.voteChanges * 2)) * 1000) / 1000);
    assert.equal(a.recall, Math.round((4 / (rep.summary.editorTouched * 2)) * 1000) / 1000);
    assert.equal(aggregateVadVote([]).precision, null);
  });

  it("registro sem detalhe (importado da #11670) vai para skipped; hopS inválido é erro", () => {
    const r = record([]);
    delete (r.sequences[0] as { detail?: unknown }).detail;
    assert.deepEqual(measureVadVote({ record: r, vad: v }).skipped, [{ seq: "outras-redes", reason: "registro sem detalhe por clipe" }]);
    assert.throws(() => measureVadVote({ record: r, vad: { hopS: 0, probs: [] } }), /hopS/);
  });
});

describe("#13369 CLI video-medicoes", () => {
  it("splitList ignora vazios; sem subcomando válido sai 2", () => {
    assert.deepEqual(splitList(" a.json, ,b.json"), ["a.json", "b.json"]);
    assert.deepEqual(splitList(undefined), []);
    assert.equal(main([]), 2);
    assert.equal(main(["vad", "2611"]), 2);
  });
  it("vad sem --audio é erro (1), nunca medição em silêncio", () => {
    assert.equal(main(["vad", "261105"]), 1);
  });
});
