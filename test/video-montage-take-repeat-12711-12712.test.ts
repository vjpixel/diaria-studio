/**
 * #12711: tomada repetida que o Whisper colapsou passava pelo verify-xml e
 * pelo review (o casamento com o roteiro não vê a repetição). Os dois casos
 * reais, com os tempos do bruto e dos silêncios medidos:
 *   - 261111, horizontal V6: "Quem fica, ou quem entra, é quem sabe fazer a IA
 *     funcionar melhor," em 1096.98–1105.88 cobria duas tomadas; a transcrição
 *     da sequência esticou "fazer" de 156.46 a 160.98 s e o transcript.json do
 *     bruto esticou "funcionar" de 1100.50 a 1105.64 s. Correção: 1101.6.
 *   - 261110, horizontal V8: o item "Treinar" (206–207.2) era o fim de
 *     "…treinamento, de…" ("Muito de…" na retranscrição de 205.75–206.5); a
 *     retranscrição da janela do roteiro esticou "treinar" de 206.10 a 216.86.
 *
 * #12712: corte sem `hook` (nem resumo_curto nesta vertical) só aparecia no
 * `video-extra-verticals.ts`; a montagem passa a avisar com o mesmo erro.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { defaultSequences, type Interval, type SequencePlan, type SequenceSpec, type Word } from "../scripts/lib/diaria/video-montage.ts";
import {
  repeatedPhraseSuspects,
  speechRateSuspects,
  stretchedWordFindings,
  takeRepeatItems,
  takeRepeatLine,
  takeRepeatWarnings,
  windowHeardSuspects,
  type TakeRepeatItem,
} from "../scripts/lib/diaria/video-montage-repeat.ts";
import { checkText } from "../scripts/lib/diaria/video-final-review.ts";
import { corteHookLine, extraVerticalHook, firstCorteSpeech, missingHookProblem, planExtraVerticals } from "../scripts/lib/diaria/extra-verticals.ts";
import { loadShortScheduleConfig } from "../scripts/lib/diaria/short-video.ts";
import { takeRepeatSection, windowRepeatSuspects } from "../scripts/video-montagem.ts";

const W = (text: string, start: number, end: number): Word => ({ text, start, end });

// 261111: silêncios do bruto em volta do item (silences.json).
const SIL_261111: Interval[] = [
  { start: 1098.93, end: 1099.33 },
  { start: 1100.624, end: 1101.15 },
  { start: 1101.21, end: 1101.86 },
  { start: 1106.065, end: 1106.64 },
];
// 261110: silêncios do bruto em volta de 206 s (silences.json).
const SIL_261110: Interval[] = [
  { start: 203.726, end: 204.1 },
  { start: 206.439, end: 207.03 },
  { start: 207.13, end: 208.06 },
  { start: 209.76, end: 210.14 },
  { start: 219.07, end: 220.206 },
];

const QUEM = "Quem fica, ou quem entra, é quem sabe fazer a IA funcionar melhor,";

describe("#12711: palavra esticada no áudio montado (verify-xml, review, review-final)", () => {
  // Transcrição da sequência do horizontal da 261111 (seq-youtube.transcript.json): "fazer" de 156.46 a 160.98.
  const seqWords = [
    W("Quem", 153.0, 153.24), W("fica,", 153.24, 153.7), W("ou", 153.86, 154.1), W("quem", 154.1, 154.3), W("entra,", 154.3, 154.7),
    W("é", 155.2, 155.4), W("quem", 155.4, 155.6), W("sabe", 155.6, 155.9), W("fazer", 156.46, 160.98), W("a", 160.98, 161.1),
    W("IA", 161.1, 161.3), W("funcionar", 161.3, 161.9), W("melhor.", 161.9, 162.2),
  ];
  it("caso 261111: \"fazer\" esticada por 4,5 s sobre fala vira tomada-colapsada", () => {
    const f = stretchedWordFindings(seqWords, [{ start: 158.2, end: 158.5 }]);
    assert.equal(f.length, 1, JSON.stringify(f));
    assert.equal(f[0].kind, "tomada-colapsada");
    assert.equal(f[0].at, 156.46);
    assert.match(f[0].detail, /"fazer" esticada por 4,2 s de som/);
  });
  it("palavra longa sobre silêncio (pausa de verdade) não acusa", () => {
    assert.deepEqual(stretchedWordFindings(seqWords, [{ start: 156.6, end: 160.9 }]), []);
  });
  it("fala sem palavra esticada não acusa", () => {
    const ok = [W("Quem", 0, 0.3), W("fica", 0.3, 0.7), W("ou", 0.8, 1.0), W("quem", 1.0, 1.2), W("entra", 1.2, 1.6)];
    assert.deepEqual(stretchedWordFindings(ok, []), []);
  });
  it("review-final: checkText com os silêncios do export acusa e dá a correção", () => {
    const [yt] = defaultSequences();
    const plan: SequencePlan = {
      spec: yt,
      clips: [{ block: "comentario", srcIn: 1096.98, srcOut: 1105.88, frameIn: 32909, frameOut: 33176, seqStart: 4590, seqEnd: 4857, scale: 50 }],
      durationFrames: 4857,
      script: QUEM,
      missingBlocks: [],
      dropped: [],
    };
    const f = checkText({ words: seqWords, plan, fps: 30, durationS: 170, silences: [] });
    const hit = f.find((x) => x.kind === "tomada-colapsada");
    assert.ok(hit, JSON.stringify(f));
    assert.match(hit.fix, /tomada completa/);
    assert.equal(checkText({ words: seqWords, plan, fps: 30, durationS: 170 }).some((x) => x.kind === "tomada-colapsada"), false, "sem silêncios, o checkText segue como antes");
  });
});

describe("#12711: fala demais para o texto do item (build/roteiro)", () => {
  // Itens de calibração no ritmo da 261111 (~12 letras/s), sem silêncio dentro.
  const calib: TakeRepeatItem[] = [
    { id: "comentario[0]", text: "A IA já está no mercado de trabalho.", start: 10, end: 12.4 },
    { id: "comentario[1]", text: "E isso cria um mercado insustentável.", start: 20, end: 22.6 },
    { id: "comentario[2]", text: "o que requer experiência.", start: 30, end: 31.8 },
    { id: "comentario[3]", text: "Empresas cortam vagas de entrada.", start: 40, end: 42.4 },
    { id: "comentario[4]", text: "Quem vai ocupar o lugar delas?", start: 50, end: 52.0 },
  ];
  it("caso 261111: o intervalo velho (duas tomadas) acusa; o corrigido (1101.6) não", () => {
    const old: TakeRepeatItem = { id: "comentario[20]", text: QUEM, start: 1096.98, end: 1105.88 };
    const fixed: TakeRepeatItem = { ...old, start: 1101.6 };
    const s = speechRateSuspects([...calib, old], SIL_261111);
    assert.deepEqual(s.map((x) => [x.id, x.kind]), [["comentario[20]", "fala-longa"]]);
    assert.match(s[0].detail, /pode cobrir mais de uma tomada/);
    assert.deepEqual(speechRateSuspects([...calib, fixed], SIL_261111), []);
  });
  it("sem itens para calibrar o ritmo, não acusa", () => {
    assert.deepEqual(speechRateSuspects([{ id: "x", text: QUEM, start: 1096.98, end: 1105.88 }], SIL_261111), []);
  });
  it("frase repetida no intervalo e uma vez no texto acusa; repetida também no texto, não", () => {
    const words = [
      W("Quem", 0, 0.2), W("fica", 0.2, 0.5), W("ou", 0.5, 0.6), W("quem", 0.6, 0.8), W("entra", 0.8, 1.1),
      W("Quem", 2, 2.2), W("fica", 2.2, 2.5), W("ou", 2.5, 2.6), W("quem", 2.6, 2.8), W("entra", 2.8, 3.1), W("é", 3.2, 3.3), W("quem", 3.3, 3.5), W("sabe", 3.5, 3.8),
    ];
    const s = repeatedPhraseSuspects([{ id: "comentario[20]", text: "Quem fica ou quem entra é quem sabe", start: 0, end: 4, words }]);
    assert.equal(s.length, 1);
    assert.equal(s[0].kind, "frase-repetida");
    assert.match(s[0].detail, /"Quem fica ou" aparece 2 vezes no intervalo e 1 no texto/);
    assert.deepEqual(repeatedPhraseSuspects([{ id: "y", text: "Quem fica ou quem entra. Quem fica ou quem entra é quem sabe", start: 0, end: 4, words }]), []);
  });
  it("takeRepeatItems pula o item já acusado como tomada colapsada (#11754) e takeRepeatWarnings dá a linha com o retranscribe --sub", () => {
    const mk = (start: number, end: number, text: string, collapsed?: boolean) => ({ interval: { start, end }, text, words: [], ...(collapsed ? { collapsed: { suspects: [] } } : {}) });
    const items = takeRepeatItems({ comentario: [mk(10, 12.4, calib[0].text), mk(1096.98, 1105.88, QUEM, true)] });
    assert.deepEqual(items.map((x) => x.id), ["comentario[0]"]);
    const lines = takeRepeatWarnings([...calib, { id: "comentario[20]", text: QUEM, start: 1096.98, end: 1105.88 }], SIL_261111);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^comentario\[20\]: .*\(retranscribe --sub --from 1096\.0 --to 1106\.9\) \(#12711\)$/);
  });
});

describe("#12711: retranscrição da janela do item no roteiro", () => {
  const treinar: TakeRepeatItem = { id: "comentario[6]", text: "Treinar", start: 206, end: 207.2 };
  it("caso 261110: a janela ouviu \"Muito de…\", sem \"treinar\": fala divergente", () => {
    const s = windowHeardSuspects(treinar, [W("Muito", 205.75, 205.91), W("de...", 205.91, 206.37)], SIL_261110);
    assert.deepEqual(s.map((x) => x.kind), ["fala-divergente"]);
    assert.match(s[0].detail, /ouviu "Muito de\.\.\.", sem 1 de 1 palavra/);
  });
  it("caso 261110: \"treinar\" esticada até 216,86 s sobre fala na janela: palavra esticada", () => {
    const heard = [W("treinamento,", 205.14, 205.82), W("de", 206.02, 206.1), W("treinar", 206.1, 216.86), W("um", 216.86, 217.02)];
    const s = windowHeardSuspects(treinar, heard, SIL_261110);
    assert.deepEqual(s.map((x) => x.kind), ["palavra-esticada"]);
    assert.match(s[0].detail, /"treinar" esticada/);
  });
  it("a janela que ouviu o texto, sem palavra esticada, não acusa; janela vazia também não", () => {
    assert.deepEqual(windowHeardSuspects(treinar, [W("Treinar", 206.05, 206.5)], SIL_261110), []);
    assert.deepEqual(windowHeardSuspects(treinar, [], SIL_261110), []);
  });
  it("windowRepeatSuspects casa cada item com a janela dele e a seção do roteiro lista as suspeitas", () => {
    const items = [
      { id: "comentario[5]", text: "de treinamento", start: 204.9, end: 205.9 },
      { id: "comentario[6]", text: "Treinar", start: 206, end: 207.2 },
    ];
    const s = windowRepeatSuspects(items, [[W("de", 204.9, 205.14), W("treinamento", 205.14, 205.82)], [W("Muito", 205.75, 205.91), W("de", 205.91, 206.37)]], SIL_261110, (a, b) => a === b);
    assert.deepEqual(s.map((x) => x.id), ["comentario[6]"]);
    const md = takeRepeatSection(s);
    assert.match(md, /## Tomada repetida\? \(#12711\)/);
    assert.ok(md.includes(takeRepeatLine(s[0]).slice(0, 20)));
    assert.equal(takeRepeatSection([]), "");
  });
});

describe("#12712: corte sem gancho avisa na montagem com o erro da publicação", () => {
  const [, OUT] = defaultSequences();
  const NVIDIA: SequenceSpec = { ...OUT, target: "instagram", name: "Diaria comentada_Vertical_V1-nvidia", corte: "nvidia", screenTitle: "A Nvidia", order: ["titulo", "comentario", "fecho"] };
  const file = {
    blocks: {
      comentario: [
        { start: 1, end: 2, text: "Fala só do horizontal.", skip: ["nvidia"] },
        { start: 3, end: 4, text: "Treinar um modelo de IA é exatamente isso.", targets: ["nvidia"] },
      ],
    },
  } as unknown as Parameters<typeof corteHookLine>[0];
  it("caso 261110: corte nvidia sem hook nem resumo_curto vira [aviso] com o mesmo texto do video-extra-verticals e a 1ª fala do corte", () => {
    const line = corteHookLine(file, NVIDIA);
    assert.ok(line);
    assert.equal(line.level, "aviso");
    assert.ok(line.text.startsWith(missingHookProblem("nvidia")), line.text);
    assert.match(line.text, /"hook": "Treinar um modelo de IA é exatamente isso\."/);
    assert.equal(firstCorteSpeech(file, NVIDIA), "Treinar um modelo de IA é exatamente isso.");
    // A publicação recusa com o mesmo texto: a regra é uma só (nada duplicado).
    const sched = loadShortScheduleConfig({ publishing: { shorts: { schedule: { rotation_times: ["06:30", "08:00", "12:00"], rotation_start: "2026-10-26", rotation_end: "2026-11-13", default_time: "12:00" } } } });
    const plan = planExtraVerticals({ edition: "261110", file: { ...file, sequences: [NVIDIA] } as never, sched, driveIds: { nvidia: "abc" } });
    assert.ok(plan[0].problems.includes(missingHookProblem("nvidia")), JSON.stringify(plan[0].problems));
  });
  it("com hook, [premissa] com o gancho; sequência sem corte, nada", () => {
    const withHook = { ...NVIDIA, hook: "A Nvidia vale mais que países." };
    const line = corteHookLine(file, withHook);
    assert.equal(line?.level, "premissa");
    assert.match(line!.text, /"A Nvidia vale mais que países\."/);
    assert.deepEqual(extraVerticalHook(file, withHook), { text: "A Nvidia vale mais que países.", how: "hook" });
    assert.equal(corteHookLine(file, OUT), null);
  });
});
