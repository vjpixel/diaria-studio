/**
 * test/video-montage-build-11753-11754-11757.test.ts — três achados da análise
 * #11670 sobre o que o editor ainda mexia no Premiere depois do XML:
 *   - #11753: pausas de 0,35–0,8 s dentro do clipe (o build só cortava ≥0,8 s);
 *   - #11754: tomada colapsada pelo Whisper (uma tomada só no transcript onde
 *     houve várias) e a última tomada como padrão;
 *   - #11757: duração-alvo da vertical (≤85 s) com sugestão de frases a cortar.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  COLLAPSED_TAKE,
  SILENCE_DETECT,
  SPEECH_DEFAULTS,
  assembleClips,
  buildSequencePlan,
  collapsedTakeSuspects,
  parseBlocksFile,
  pickCollapsedTake,
  resolveBlocks,
  shortPauseCuts,
  speechParts,
  type ResolvedItem,
  type Segment,
  type SequencePlan,
  type SequenceSpec,
  type Word,
} from "../scripts/lib/diaria/video-montage.ts";
import { VERTICAL_TARGET_S, roteiroMarkdown, verticalTargetCheck, verticalTargetWarning } from "../scripts/lib/diaria/video-montage-docs.ts";
import { collapsedSegmentWarnings, silenceDetectStaleWarning } from "../scripts/video-montagem.ts";

/** Palavras com duração fixa a partir de `t0`, separadas por `gap`. */
function say(text: string, t0: number, dur = 0.3, gap = 0.05): Word[] {
  let t = t0;
  return text.split(" ").map((w) => {
    const word = { start: Math.round(t * 1000) / 1000, end: Math.round((t + dur) * 1000) / 1000, text: w };
    t += dur + gap;
    return word;
  });
}

const SPEC_H: SequenceSpec = { target: "youtube", name: "Diaria comentada_Youtube_V1", width: 1920, height: 1080, order: ["comentario"], scales: [50, 62] };
const SPEC_V: SequenceSpec = { target: "outras-redes", name: "Diaria comentada_Vertical_V1", width: 1080, height: 1920, order: ["titulo", "resumo_curto", "comentario", "fecho"], scales: [115, 130] };
const SOURCE = { fps: 30, durationS: 1000 };

const item = (start: number, end: number, text: string, words: Word[] = []): ResolvedItem => ({
  interval: { start, end },
  text,
  words,
  lastWordEnd: words.length ? words[words.length - 1].end : null,
  holdLimit: end,
  how: "explicit",
});

describe("#11753: pausas curtas dentro do clipe", () => {
  it("defaults decididos pelo editor (minGapS 0,35 / padS 0,07) e a detecção acompanha o corte", () => {
    assert.equal(SPEECH_DEFAULTS.minGapS, 0.35);
    assert.equal(SPEECH_DEFAULTS.padS, 0.07);
    assert.equal(SPEECH_DEFAULTS.minClipS, 0.6);
    assert.ok(SILENCE_DETECT.minDurationS <= SPEECH_DEFAULTS.minGapS, "pausa mais curta que a detecção nunca chegaria ao corte");
  });

  it("regressão: pausa de 0,45 s dentro do clipe sai e sobra ~0,14 s (antes ia inteira para o XML)", () => {
    // 261029, clipe 228,93–252,83 s: pausa de 0,44 s em 238,01 removida pelo editor.
    const parts = speechParts(228.93, 252.83, [{ start: 238.01, end: 238.46 }]);
    assert.deepEqual(parts, [
      { start: 228.93, end: 238.08 },
      { start: 238.39, end: 252.83 },
    ]);
    // Da pausa de 0,45 s ficam 0,07 s de cada lado: ~0,14 s, o que o editor deixa.
    const kept = 0.45 - (parts[1].start - parts[0].end);
    assert.ok(Math.abs(kept - 0.14) < 1e-6, String(kept));
  });

  it("pausa abaixo de 0,35 s continua dentro do clipe", () => {
    assert.deepEqual(speechParts(0, 5, [{ start: 2, end: 2.3 }]), [{ start: 0, end: 5 }]);
  });

  it("palavra solta entre duas pausas curtas não some (o pedaço volta ao vizinho)", () => {
    // fala 0–2, pausa 0,4, palavra 2,4–2,8, pausa 0,4, fala 3,2–5
    const parts = speechParts(0, 5, [
      { start: 2, end: 2.4 },
      { start: 2.8, end: 3.2 },
    ]);
    assert.ok(parts.some((p) => p.start <= 2.4 && p.end >= 2.8), `a palavra 2,4–2,8 ficou fora: ${JSON.stringify(parts)}`);
    assert.equal(parts.length, 2, "só uma das duas pausas é desfeita");
  });

  it("pedaço curto isolado por pausas longas continua descartado (ruído, como antes)", () => {
    const parts = speechParts(0, 5, [
      { start: 1, end: 2 },
      { start: 2.3, end: 4 },
    ]);
    assert.ok(!parts.some((p) => p.start > 1.5 && p.end < 2.5), JSON.stringify(parts));
  });

  it("zoom: corte de pausa curta não troca a escala; pausa longa e troca de item trocam (#11503)", () => {
    // item 1: fala 10–14 com pausa CURTA (0,45) em 11 e LONGA (1,0) em 12,5; item 2 colado depois de pausa curta.
    const silences = [
      { start: 11, end: 11.45 },
      { start: 12.5, end: 13.5 },
      { start: 14, end: 14.4 },
    ];
    const resolved = { comentario: [item(10, 14, "a b c"), item(14.4, 16, "d e")] };
    const plan = buildSequencePlan(SPEC_H, resolved, silences, SOURCE);
    assert.equal(plan.clips.length, 4, JSON.stringify(plan.clips.map((c) => [c.srcIn, c.srcOut])));
    assert.deepEqual(
      plan.clips.map((c) => c.scale),
      [50, 50, 62, 50],
      "pausa curta mantém, pausa longa troca, novo item troca",
    );
    assert.equal(plan.clips[1].keepScale, true);
  });

  it("zoom: o keepScale sobrevive à re-montagem do refino (assembleClips sobre os clipes já montados)", () => {
    const raws = [
      { block: "comentario" as const, srcIn: 0, srcOut: 2 },
      { block: "comentario" as const, srcIn: 2.3, srcOut: 4, keepScale: true as const },
      { block: "comentario" as const, srcIn: 5, srcOut: 6 },
    ];
    const once = assembleClips(SPEC_H, raws, 30);
    const again = assembleClips(SPEC_H, once.clips.map((c) => ({ block: c.block, srcIn: c.srcIn, srcOut: c.srcOut, ...(c.keepScale ? { keepScale: true as const } : {}) })), 30);
    assert.deepEqual(once.clips.map((c) => c.scale), [50, 50, 62]);
    assert.deepEqual(again.clips.map((c) => c.scale), [50, 50, 62]);
  });

  it("shortPauseCuts marca só os cortes de pausa abaixo de 0,8 s", () => {
    const parts = [
      { start: 0, end: 1.07 },
      { start: 1.38, end: 3.07 }, // pausa ~0,45 s
      { start: 4.93, end: 6 }, // pausa ~2 s
    ];
    assert.deepEqual([...shortPauseCuts(parts)], [1]);
  });

  it("silences.json detectado com a pausa mínima antiga (0,45 s) gera aviso; com a nova, não", () => {
    assert.match(silenceDetectStaleWarning(0.45) ?? "", /transcribe/);
    assert.equal(silenceDetectStaleWarning(SILENCE_DETECT.minDurationS), null);
    assert.equal(silenceDetectStaleWarning(undefined), null);
  });
});

describe("#11754: tomada colapsada e a última tomada", () => {
  // 261030, 289–309 s: o transcript registrou UMA tomada, com 4 s entre "dos" e "médicos".
  const collapsed: Word[] = [
    ...say("E o ChatGPT elogiou ela esconder dos", 289.1),
    ...say("médicos o que estava sentindo.", 298.45),
  ];
  const PHRASE = "E o ChatGPT elogiou ela esconder dos médicos o que estava sentindo.";
  // A retranscrição da janela separa as 3 tomadas.
  const takes = [...say(PHRASE, 289.0), ...say(PHRASE, 294.3), ...say(PHRASE, 302.1)];
  const patchSegments: Segment[] = [
    { start: 289.0, end: 293.2, text: PHRASE, words: takes.slice(0, 12) },
    { start: 294.3, end: 298.5, text: PHRASE, words: takes.slice(12, 24) },
    { start: 302.1, end: 306.3, text: PHRASE, words: takes.slice(24) },
  ];

  it("detecta o vão de som sem palavra acima de 1,5 s (decisão do editor)", () => {
    assert.equal(COLLAPSED_TAKE.gapS, 1.5);
    const sus = collapsedTakeSuspects(collapsed);
    assert.equal(sus.length, 1);
    assert.equal(sus[0].kind, "intervalo");
    assert.equal(sus[0].before, "dos");
    assert.equal(sus[0].after, "médicos");
    assert.ok(sus[0].window.start <= 289.1 && sus[0].window.end >= collapsed[collapsed.length - 1].end);
  });

  it("pausa de verdade (dentro de silêncio detectado) não é tomada colapsada (#11505, fala pausada)", () => {
    const gapStart = collapsed[6].end;
    const gapEnd = collapsed[7].start;
    assert.deepEqual(collapsedTakeSuspects(collapsed, [{ start: gapStart, end: gapEnd }]), []);
  });

  it("com as tomadas separadas, a última vale por padrão", () => {
    const pick = pickCollapsedTake(takes, patchSegments, PHRASE);
    assert.ok(pick.ok);
    assert.equal(pick.completeTakes, 3);
    assert.equal(pick.takeNumber, 3);
    assert.ok(pick.interval.start >= takes[23].end, "começa depois da 2ª tomada");
  });

  it("'aprova' explícito da direção vence a última tomada", () => {
    const cue = say("Beleza, é este take.", 299.5);
    const words = [...takes.slice(0, 24), ...cue, ...takes.slice(24)];
    const segs: Segment[] = [patchSegments[0], patchSegments[1], { start: 299.5, end: 300.9, text: "Beleza, é este take.", words: cue }, patchSegments[2]];
    const pick = pickCollapsedTake(words, segs, PHRASE);
    assert.ok(pick.ok);
    assert.equal(pick.takeNumber, 2);
    assert.match(pick.why, /aprovada pela direção/);
  });

  it("tomada recusada pela direção é pulada", () => {
    const cue = say("De novo.", 306.6);
    const segs: Segment[] = [...patchSegments, { start: 306.6, end: 307.3, text: "De novo.", words: cue }];
    const pick = pickCollapsedTake([...takes, ...cue], segs, PHRASE);
    assert.ok(pick.ok);
    assert.equal(pick.takeNumber, 2);
  });

  it("regressão 261030: o intervalo do blocks.json que cobre as 3 tomadas vira só a última, com a retranscrição", () => {
    const file = { edition: "261030", blocks: { comentario: [{ start: 289.0, end: 308.6, text: PHRASE }] } };
    const sem = resolveBlocks(file, collapsed, { durationS: 1000 });
    const it0 = sem.blocks.comentario![0];
    assert.deepEqual(it0.interval, { start: 289.0, end: 308.6 }, "sem retranscrição o trecho segue inteiro");
    assert.ok(it0.collapsed && !it0.collapsed.picked);
    assert.match(sem.warnings.join("\n"), /possível tomada colapsada.*retranscrever/);

    const com = resolveBlocks(file, collapsed, { durationS: 1000, retranscribed: [{ segments: patchSegments }] });
    const it1 = com.blocks.comentario![0];
    assert.ok(it1.collapsed?.picked, JSON.stringify(com.warnings));
    assert.equal(it1.collapsed!.picked!.takeNumber, 3);
    assert.ok(it1.interval.start > 298.5 && it1.interval.start <= 302.1, JSON.stringify(it1.interval));
    assert.ok(it1.words.every((w) => w.start >= 302.1));
    const md = roteiroMarkdown("261030", [buildSequencePlan(SPEC_H, com.blocks, [], SOURCE)], com.blocks, 30);
    assert.match(md, /\*\*tomada colapsada\*\* Comentário \[0\].*3 tomadas; usando a 3ª/);
    const mdSem = roteiroMarkdown("261030", [buildSequencePlan(SPEC_H, sem.blocks, [], SOURCE)], sem.blocks, 30);
    assert.match(mdSem, /\*\*tomada colapsada\?\*\* Comentário \[0\].*retranscribe --from/);
  });

  it("take explícito no blocks.json nunca é trocado pela retranscrição", () => {
    const file = { edition: "261030", blocks: { comentario: [{ text: PHRASE, take: 1 }] } };
    const r = resolveBlocks(file, collapsed, { durationS: 1000, retranscribed: [{ segments: patchSegments }] });
    const it0 = r.blocks.comentario![0];
    assert.ok(it0.collapsed && !it0.collapsed.picked);
    assert.ok(it0.interval.start < 290);
    assert.match(r.warnings.join("\n"), /take explícito/);
  });

  it("a decupagem avisa o segmento colapsado com o comando do retranscribe", () => {
    const lines = collapsedSegmentWarnings("261030", [{ start: 289.1, end: 301.5, text: PHRASE, words: collapsed }], []);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /segmento 1 .*possível tomada colapsada.*retranscribe 261030 --from 288\.\d --to 30\d\.\d/);
  });
});

describe("#11757: duração-alvo da vertical no Gate 2", () => {
  const resolved = {
    titulo: [item(10, 13, "Pais acusam o ChatGPT de matar sua filha.")],
    resumo_curto: [item(20, 40, "Uma jovem escondeu dos médicos o que sentia e o ChatGPT elogiou a decisão.")],
    comentario: [
      item(400, 420, "Esse caso mostra um limite claro dessas ferramentas."),
      item(430, 445, "O ChatGPT elogiou a jovem por esconder dos médicos o que sentia."),
      item(450, 470, "A empresa diz que já mudou as respostas para casos assim."),
      item(485.07, 497.17, "Não utilize IA para nada que vá influenciar diretamente uma decisão importante da sua vida."),
    ],
    fecho: [item(900, 902, "Até amanhã.")],
  };
  const vplan = (seconds: number): SequencePlan => ({ spec: SPEC_V, clips: [], durationFrames: Math.round(seconds * 30), script: "", missingBlocks: [], dropped: [] });

  it("regressão 261030: vertical de 102,3 s passa do alvo de 85 s e a sugestão começa pelo conselho genérico do fim", () => {
    assert.equal(VERTICAL_TARGET_S, 85);
    const c = verticalTargetCheck(vplan(102.3), resolved, 30);
    assert.ok(c);
    assert.ok(Math.abs(c.overS - 17.3) < 0.05);
    assert.equal(c.cuts[0].index, 3);
    assert.match(c.cuts[0].reason, /conselho genérico/);
    assert.ok(c.cuts.some((x) => x.index === 1 && /repete o resumo/.test(x.reason)), JSON.stringify(c.cuts));
    assert.ok(!c.cuts.some((x) => x.index === 0), "a 1ª frase do comentário (gancho) fica");
    assert.ok(c.coveredS >= c.overS);
    assert.match(verticalTargetWarning(SPEC_V.name, c), /17,3 s acima do alvo da vertical \(85 s\); sugestão: cortar comentário \[3\]/);
  });

  it("horizontal, vertical dentro do alvo e alvo da edição maior não avisam", () => {
    assert.equal(verticalTargetCheck({ spec: SPEC_H, durationFrames: 200 * 30 }, resolved, 30), null);
    assert.equal(verticalTargetCheck(vplan(84.5), resolved, 30), null);
    assert.equal(verticalTargetCheck(vplan(102.3), resolved, 30, { targetS: 110 }), null);
  });

  it("o roteiro (Gate 2) mostra o aviso e as frases sugeridas, com o skip da vertical", () => {
    const md = roteiroMarkdown("261030", [vplan(102.3)], resolved, 30);
    assert.match(md, /\*\*\[aviso\] 102,3 s, 17,3 s acima do alvo da vertical \(85 s\)\.\*\*/);
    assert.match(md, /"skip": \["outras-redes"\]/);
    assert.match(md, /- Comentário \[3\] \(12,1 s, fecha com conselho genérico\): "Não utilize IA/);
  });

  it("verticalTargetS no blocks.json é validado", () => {
    const base = { edition: "261030", blocks: { titulo: [{ text: "x" }] } };
    assert.equal(parseBlocksFile({ ...base, verticalTargetS: 90 }).ok, true);
    const bad = parseBlocksFile({ ...base, verticalTargetS: 0 });
    assert.equal(bad.ok, false);
    assert.match(!bad.ok ? bad.errors.join() : "", /verticalTargetS/);
  });
});
