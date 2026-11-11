/**
 * test/video-montagem-12089-respiracao.test.ts — #12089, 2ª rodada: pausas
 * longas nas emendas com o bruto real.
 *
 * Medição da 261105 (a 1ª montagem com o detector de fala, XML V6 contra o
 * final exportado pelo editor): com os limiares fixos (-33 dB no sinal cheio,
 * -46 dB na 1ª diferença), o ruído de sala do bruto quente (piso -41 / -50 dB)
 * passava de -46 dB na 1ª diferença em quase toda pausa, e o detector achou
 * 121 ilhas em 23 min (uma de 69 s): a sequência saiu com 41 pausas de 0,45 s
 * ou mais (30 s), o final do editor com 14 (9 s). O detector agora usa o maior
 * entre o limiar fixo e o relativo ao bruto, tira respiração e ruído sem F0, e
 * não devolve a pausa por causa de palavra esticada pelo Whisper.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildSequencePlan, type ResolvedItem, type SourceInfo, type Word } from "../scripts/lib/diaria/video-montage.ts";
import {
  SPEECH_DETECT,
  SPEECH_DETECT_PLAN,
  extendIslandAttacks,
  protectTranscribedWords,
  speechIslands,
  speechPauseSilences,
  speechThresholds,
  type FrameEnergy,
} from "../scripts/lib/diaria/video-cut-refine.ts";
import { voicedFrames } from "../scripts/lib/diaria/video-voice.ts";
import { parseSpeechDbArg, speechThresholdsPremise, withLostWordFallback } from "../scripts/video-montagem.ts";

const HOP = 0.005;
const SOURCE: SourceInfo = { path: "G:/x/bruto.mp4", fps: 30, durationS: 600, width: 3840, height: 2160, mirrored: true };

/**
 * Envelope sintético de 5 ms de um bruto QUENTE (o da 261105): piso -41 dB no
 * sinal cheio, ruído de sala a `noiseDiffDb` na 1ª diferença (-44 dB: acima do
 * -46 fixo, abaixo do relativo), e `segs` = [início, fim, dB cheio, voz?, dB da 1ª diferença?].
 * Precisa de fala o bastante para o topo (p95) ser o nível da fala: os testes põem ~40% de fala.
 */
function hotEnvelope(durationS: number, segs: Array<[number, number, number, boolean, number?]>, opts: { floorDb?: number; noiseDiffDb?: number; voiced?: boolean } = {}): FrameEnergy {
  const n = Math.round(durationS / HOP);
  const fullDb = new Float64Array(n).fill(opts.floorDb ?? -41);
  const diffDb = new Float64Array(n);
  // Piso da 1ª diferença em -50 dB com o ruído de sala a -44 dB em 1 de cada 2 quadros (o p10 fica no piso).
  for (let i = 0; i < n; i++) diffDb[i] = i % 2 ? (opts.noiseDiffDb ?? -44) : -50;
  const voiced = new Uint8Array(n);
  for (const [a, b, full, v, diff] of segs) {
    for (let i = Math.round(a / HOP); i < Math.round(b / HOP); i++) {
      fullDb[i] = full;
      diffDb[i] = diff ?? full - 12;
      voiced[i] = v ? 1 : 0;
    }
  }
  return opts.voiced === false ? { hopS: HOP, fullDb, diffDb } : { hopS: HOP, fullDb, diffDb, voiced };
}

/** Fala alta e com voz: blocos de 1 s a -8 dB, para o p95 ser a fala. */
const speech = (a: number, b: number): [number, number, number, boolean] => [a, b, -8, true];

const item = (start: number, end: number, text: string, words: Word[] = []): ResolvedItem => ({
  interval: { start, end },
  text,
  words,
  lastWordEnd: words.length ? words[words.length - 1].end : null,
  holdLimit: end,
  how: "explicit",
});

const near = (a: number, b: number, tol = 0.006) => Math.abs(a - b) <= tol;

describe("#12089: limiar relativo ao bruto", () => {
  it("bruto quente (fala a -8 dB, piso -41/-50): o limiar sobe acima do fixo", () => {
    const e = hotEnvelope(10, [speech(1, 3), speech(4, 6), speech(7, 9)]);
    const th = speechThresholds(e);
    assert.equal(th.relative, true);
    assert.ok(near(th.fullDb, -8 - SPEECH_DETECT.fullBelowTopDb, 0.01), `sinal cheio ${th.fullDb}`);
    assert.ok(near(th.diffDb, -50 + SPEECH_DETECT.diffAboveFloorDb, 0.01), `1ª diferença ${th.diffDb}`);
  });

  it("bruto baixo (fala a -25 dB, piso -60/-70): o fixo vence e nada muda", () => {
    const e = hotEnvelope(10, [[1, 3, -25, true], [4, 6, -25, true], [7, 9, -25, true]], { floorDb: -60, noiseDiffDb: -70 });
    for (let i = 0; i < e.diffDb.length; i++) if (e.fullDb[i] === -60) e.diffDb[i] = -70;
    const th = speechThresholds(e);
    assert.deepEqual([th.fullDb, th.diffDb, th.relative], [SPEECH_DETECT.fullDb, SPEECH_DETECT.diffDb, false]);
  });

  it("silêncio digital na maior parte (áudio sintético, sem ruído de sala para medir): fica o fixo", () => {
    const n = 2000;
    const fullDb = new Float64Array(n).fill(-120);
    const diffDb = new Float64Array(n).fill(-120);
    for (let i = 100; i < 300; i++) { fullDb[i] = -8; diffDb[i] = -44; }
    const th = speechThresholds({ hopS: HOP, fullDb, diffDb });
    assert.deepEqual([th.fullDb, th.diffDb, th.relative], [SPEECH_DETECT.fullDb, SPEECH_DETECT.diffDb, false]);
  });

  it("ruído de sala acima de -46 dB na 1ª diferença: com o limiar fixo as pausas somem; com o relativo saem", () => {
    // Três frases separadas por pausas de 1 s de ruído de sala (a 261105 tinha uma ilha de 69 s assim).
    const e = hotEnvelope(10, [speech(1, 3), speech(4, 6), speech(7, 9)], { voiced: false });
    const fixed = speechIslands(e, { fullDb: SPEECH_DETECT.fullDb, diffDb: SPEECH_DETECT.diffDb });
    assert.equal(fixed.length, 1, "o ruído a -44 dB passa no -46 fixo: tudo vira uma ilha só (o bug)");
    const islands = speechIslands(e);
    assert.equal(islands.length, 3);
    assert.ok(near(islands[0].start, 1) && near(islands[1].start, 4) && near(islands[2].start, 7));
    // A cauda acima do fixo (o ruído a -44 dB) avança até `decayMaxS`, nunca a pausa toda.
    for (const s of islands) assert.ok(s.end - Math.ceil(s.start) <= 2 + SPEECH_DETECT.decayMaxS + 1e-9, `fim ${s.end}`);
  });
});

describe("#12089: respiração e ruído sem F0 não são fala", () => {
  it("respiração a -28 dB (acima do limiar) a 0,4 s do ataque: a ilha começa no ataque, a entrada 150 ms antes", () => {
    // A issue: piso -39/-41, respiração a -26/-33 dB, fala a -8 dB; a entrada ficava no começo do ar.
    const e = hotEnvelope(10, [[1.3, 1.6, -28, false], speech(2, 4), speech(5, 6), speech(7, 9)]);
    const islands = extendIslandAttacks(e, speechIslands(e));
    assert.ok(near(islands[0].start, 2), `ilha ${JSON.stringify(islands[0])}`);
    // Sem a voz medida (o detector antes), a respiração vira ilha.
    const blind = speechIslands({ hopS: e.hopS, fullDb: e.fullDb, diffDb: e.diffDb });
    assert.ok(blind.some((s) => s.start < 1.7), "sem a F0 a respiração conta como fala");
    // O item nasce no start do segmento do Whisper (1,0 s): a entrada encolhe até o ataque − 150 ms.
    const sil = speechPauseSilences(islands, 10);
    const plan = buildSequencePlan(
      { target: "youtube", name: "Diaria comentada_Youtube_V1", width: 1920, height: 1080, order: ["comentario"], scales: [60, 85] },
      { comentario: [item(1.0, 4.3, "Fala.", [{ start: 2, end: 4, text: "Fala." }])] },
      sil,
      SOURCE,
      SPEECH_DETECT_PLAN,
    );
    assert.equal(plan.clips.length, 1);
    assert.ok(2.0 - plan.clips[0].srcIn <= SPEECH_DETECT.padBeforeS + 1 / 30, `entrada ${plan.clips[0].srcIn}`);
    assert.ok(plan.clips[0].srcIn >= 1.8, `entrada ${plan.clips[0].srcIn} no ar da respiração`);
  });

  it("respiração colada no ataque: a ilha não recua mais que voicedLeadS antes da voz, nem pelo recuo do #12263", () => {
    const e = hotEnvelope(10, [[1.5, 1.98, -27, false], speech(2, 4), speech(5, 6), speech(7, 9)]);
    const [first] = extendIslandAttacks(e, speechIslands(e));
    assert.ok(first.start >= 2 - SPEECH_DETECT.voicedLeadS - 1e-9, `ilha começa em ${first.start}`);
  });

  it("vogal curta com voz (\"A empresa\", 40 ms a -26 dB, 0,16 s antes da palavra) fica; o mesmo bump sem voz sai", () => {
    const withVowel = hotEnvelope(10, [speech(1, 2), [3.0, 3.04, -26, true], speech(3.2, 5), speech(6, 8)]);
    const a = speechIslands(withVowel);
    assert.ok(a.some((s) => near(s.start, 3.0)), `a vogal abre a ilha: ${JSON.stringify(a)}`);
    const withBreath = hotEnvelope(10, [speech(1, 2), [2.8, 2.84, -26, false], speech(3.2, 5), speech(6, 8)]);
    const b = speechIslands(withBreath);
    assert.ok(b.some((s) => near(s.start, 3.2)), `o bump sem voz a 0,36 s do ataque sai: ${JSON.stringify(b)}`);
    assert.ok(!b.some((s) => s.start < 3.1 && s.end > 2.7), "nenhuma ilha no bump");
  });

  it("consoante surda do ataque (\"s\" de 'segundo', 100 ms sem voz) e sibilante final ficam na ilha", () => {
    // Ataque surdo de 2,9 a 3,0 s (só na 1ª diferença, acima do relativo) e "s" final de 5,0 a 5,12 s abaixo do relativo mas acima do fixo.
    const e = hotEnvelope(10, [speech(1, 2), [2.9, 3.0, -36, false, -30], speech(3, 5), [5.0, 5.12, -37, false, -45.5], speech(7, 9)]);
    const islands = speechIslands(e);
    const mid = islands.find((s) => s.start < 3.5 && s.end > 4)!;
    assert.ok(near(mid.start, 2.9), `ataque surdo dentro da ilha: ${JSON.stringify(mid)}`);
    assert.ok(mid.end >= 5.12 - 1e-9, `sibilante final dentro da ilha: ${JSON.stringify(mid)}`);
  });

  it("ruído de sala alto e sem voz no meio da pausa (cadeira, 0,3 s a -22 dB): a pausa sai inteira", () => {
    const e = hotEnvelope(10, [speech(1, 3), [3.6, 3.9, -22, false], speech(4.5, 6), speech(7, 9)]);
    const islands = speechIslands(e);
    assert.ok(!islands.some((s) => s.start < 3.95 && s.end > 3.55), JSON.stringify(islands));
    const sil = speechPauseSilences(islands, 10);
    assert.ok(sil.some((p) => p.start <= 3.2 && p.end >= 4.3), `pausa entre as frases: ${JSON.stringify(sil)}`);
  });
});

describe("#12089: palavra esticada pelo Whisper não devolve a pausa", () => {
  it("palavra com 60 ms ou mais dentro de uma ilha não é protegida; a dita baixo, inteira na pausa, segue protegida", () => {
    const islands = [{ start: 1, end: 2 }, { start: 3, end: 4 }];
    const pauses = speechPauseSilences(islands, 5);
    // "de" de 1,9 a 3,1 s: o Whisper a esticou por cima da pausa entre as ilhas (o meio cai em 2,5 s, na pausa).
    const stretched: Word[] = [{ start: 1.9, end: 3.1, text: "de" }];
    assert.deepEqual(protectTranscribedWords(pauses, stretched).protectedWords.map((w) => w.text), ["de"], "sem as ilhas, a pausa voltava inteira (a 261105 teria 24 assim)");
    const g = protectTranscribedWords(pauses, stretched, { islands });
    assert.deepEqual(g.protectedWords, []);
    assert.deepEqual(g.silences, pauses);
    // O "e" sussurrado, sem ilha, continua protegido (regressão da review da PR #12142).
    const whisper: Word[] = [{ start: 2.4, end: 2.6, text: "e" }];
    assert.deepEqual(protectTranscribedWords(pauses, whisper, { islands }).protectedWords.map((w) => w.text), ["e"]);
  });

  it("o build aceita a palavra esticada: parte na ilha, resto na pausa = coberta", () => {
    const islands = [{ start: 1, end: 2 }, { start: 3, end: 4 }];
    const words: Word[] = [{ start: 1, end: 1.9, text: "Fala" }, { start: 1.9, end: 3.1, text: "de" }, { start: 3.1, end: 4, text: "novo." }];
    const pauses = protectTranscribedWords(speechPauseSilences(islands, 5), words, { islands }).silences;
    const plan = buildSequencePlan(
      { target: "youtube", name: "Diaria comentada_Youtube_V1", width: 1920, height: 1080, order: ["comentario"], scales: [60, 85] },
      { comentario: [item(0.8, 4.2, "Fala de novo.", words)] },
      pauses,
      SOURCE,
      SPEECH_DETECT_PLAN,
    );
    assert.deepEqual(plan.dropped, []);
    assert.equal(plan.clips.length, 2, "a pausa entre as ilhas sai");
  });
});

describe("#12089: a rede da proteção de palavras", () => {
  it("palavra que mesmo assim ficaria fora dos clipes: a sequência volta à proteção de antes e o build não barra", () => {
    const islands = [{ start: 1, end: 2 }, { start: 3, end: 4 }];
    const words: Word[] = [{ start: 1, end: 1.92, text: "Fala" }, { start: 1.92, end: 2.95, text: "de" }, { start: 3, end: 4, text: "novo." }];
    const raw = speechPauseSilences(islands, 5);
    const spec = { target: "youtube" as const, name: "Diaria comentada_Youtube_V1", width: 1920, height: 1080, order: ["comentario" as const], scales: [60, 85] as [number, number] };
    // O "de" atravessa a emenda entre dois itens (o 1º termina em 2,05 s, antes da pausa de 2,12 s): o trecho 2,05–2,12 não é clipe nem pausa.
    const resolved = { comentario: [item(0.8, 2.05, "Fala", words.slice(0, 1)), item(2.3, 4.2, "de novo.", words.slice(1))] };
    const build = (pauses: typeof raw) => buildSequencePlan(spec, resolved, pauses, SOURCE, SPEECH_DETECT_PLAN);
    const primary = protectTranscribedWords(raw, words, { islands }).silences;
    const fallback = protectTranscribedWords(raw, words).silences;
    assert.ok(build(primary).dropped.some((d) => /fora dos clipes: "de"/.test(d)), "com a proteção nova o 'de' se perde");
    const r = withLostWordFallback(build, primary, fallback);
    assert.equal(r.fellBack, true);
    assert.deepEqual(r.plan.dropped, []);
    assert.match(r.lost.join("\n"), /"de"/);
    // Sem palavra perdida, fica a proteção nova (a pausa sai).
    const ok = withLostWordFallback(() => ({ dropped: [] as string[] }), primary, fallback);
    assert.deepEqual([ok.fellBack, ok.lost], [false, []]);
  });
});

describe("#12089: voz medida no sinal (F0)", () => {
  it("vogal (150 Hz com harmônicos) tem voz; ruído branco do mesmo nível não", () => {
    const sr = 48000;
    const samples = new Int16Array(sr);
    // 0,1–0,4 s: vogal; 0,6–0,9 s: ruído (gerador congruencial, determinístico).
    for (let i = Math.round(0.1 * sr); i < Math.round(0.4 * sr); i++) {
      const t = i / sr;
      samples[i] = Math.round(4000 * Math.sin(2 * Math.PI * 150 * t) + 2000 * Math.sin(2 * Math.PI * 300 * t) + 1000 * Math.sin(2 * Math.PI * 450 * t));
    }
    let seed = 12089;
    for (let i = Math.round(0.6 * sr); i < Math.round(0.9 * sr); i++) {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      samples[i] = Math.round((seed / 2147483648 - 0.5) * 9000);
    }
    const n = Math.round(1 / HOP);
    const v = voicedFrames(samples, sr, HOP, n, () => true);
    const frac = (a: number, b: number) => {
      let c = 0;
      for (let i = Math.round(a / HOP); i < Math.round(b / HOP); i++) c += v[i];
      return c / Math.round((b - a) / HOP);
    };
    assert.ok(frac(0.15, 0.35) > 0.9, `vogal: ${frac(0.15, 0.35)}`);
    assert.ok(frac(0.65, 0.85) < 0.1, `ruído: ${frac(0.65, 0.85)}`);
    // Quadro fora do candidato não é medido.
    assert.equal(voicedFrames(samples, sr, HOP, n, () => false).reduce((a, b) => a + b, 0), 0);
  });
});

describe("#12089: CLI do build", () => {
  it("--speech-full-db/--speech-diff-db: número negativo em dBFS", () => {
    assert.equal(parseSpeechDbArg("--speech-full-db", "-28"), -28);
    assert.throws(() => parseSpeechDbArg("--speech-full-db", ""), /número negativo/);
    assert.throws(() => parseSpeechDbArg("--speech-diff-db", "3"), /número negativo/);
    assert.throws(() => parseSpeechDbArg("--speech-diff-db", "abc"), /número negativo/);
  });

  it("a premissa diz de onde veio cada limiar e se o filtro pela F0 está ligado", () => {
    const relative = speechThresholdsPremise({ fullDb: -31.4, diffDb: -39.8, voice: true });
    assert.match(relative, /-31\.4 dB no sinal cheio \(relativo ao bruto\)/);
    assert.match(relative, /-39\.8 dB na 1ª diferença \(relativo ao bruto\)/);
    assert.match(relative, /--no-speech-voice desliga/);
    const manual = speechThresholdsPremise({ fullDb: -28, diffDb: -46, voice: false }, { fullDb: -28, voice: false });
    assert.match(manual, /-28\.0 dB no sinal cheio \(--speech-\*-db\)/);
    assert.match(manual, /-46\.0 dB na 1ª diferença \(fixo\)/);
    assert.match(manual, /sem o filtro de respiração/);
  });
});
