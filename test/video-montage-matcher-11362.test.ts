/**
 * test/video-montage-matcher-11362.test.ts — regressões da 1ª execução real
 * da /diaria-video-montagem (edição 261028):
 *   - #11362: frase curta casou com a tomada de OUTRA frase ("com esforço
 *     médio de raciocínio," → "com baixo esforço de raciocínio,"), sem aviso;
 *   - #11360: número partido pelo Whisper ("GPT 6 .1", "53 ,6 %") saía com
 *     espaço na legenda e não casava com "GPT-6.1" do roteiro;
 *   - #11351: silencedetect fixo em -45 dB num bruto quente (-9,9 LUFS), sem
 *     aviso de loudness alto, e "palavra fora dos clipes" quando o Whisper
 *     estica a palavra por cima da pausa.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  SILENCE_DETECT,
  alignPunctuationToScript,
  buildSequencePlan,
  chooseTake,
  cuesToSrt,
  findTakes,
  joinWordTexts,
  loudnessWarning,
  mergeSplitNumberTokens,
  resolveBlocks,
  reviewPreview,
  roteiroMarkdown,
  segmentCues,
  silenceNoiseDb,
  wordCoveredBySilence,
  type BlocksFile,
  type SequenceSpec,
  type Word,
} from "../scripts/lib/diaria/video-montage.ts";
import { parseSilenceDbArg, planHashOf } from "../scripts/video-montagem.ts";

function say(text: string, t0: number, dur = 0.3, gap = 0.05): Word[] {
  let t = t0;
  return text.split(" ").map((w) => {
    const word = { start: Math.round(t * 1000) / 1000, end: Math.round((t + dur) * 1000) / 1000, text: w };
    t += dur + gap;
    return word;
  });
}

const SPEC: SequenceSpec = { target: "outras-redes", name: "Diaria comentada_Outras redes_V1", width: 1080, height: 1920, order: ["resumo"], scales: [115, 130] };

describe("#11362: frase curta não casa com a tomada de outra frase", () => {
  // 10:03 a frase certa; 13:21, numa frase posterior, a de sentido trocado.
  const certa = say("o modelo roda com esforço médio de raciocínio, e responde rápido.", 603);
  const outra = say("Agora com baixo esforço de raciocínio, ele erra mais.", 801);
  const words = [...certa, ...outra];

  it("regressão 261028: 'com esforço médio de raciocínio,' fica na tomada de 10:03, não na de 13:21", () => {
    const r = chooseTake(words, "com esforço médio de raciocínio,");
    assert.ok(r.ok, r.ok ? "" : r.reason);
    assert.ok(r.interval.start < 700, `tomada escolhida em ${r.interval.start}, a frase de sentido trocado`);
    assert.equal(r.text, "com esforço médio de raciocínio,");
    assert.equal(r.completeTakes, 1);
  });

  it("sem a frase certa no bruto, a de sentido trocado não vira tomada completa (palavra a mais + engolida)", () => {
    const r = chooseTake(outra, "com esforço médio de raciocínio,");
    assert.equal(r.ok, false);
  });

  it("frase curta não aceita troca de sentido ('baixo' no lugar de 'médio'), mas aceita a parecida ('Fotos' × 'Photos')", () => {
    assert.equal(chooseTake(say("com esforço baixo de raciocínio,", 0), "com esforço médio de raciocínio,").ok, false);
    assert.ok(chooseTake(say("Agora o Google Fotos lê tudo.", 0), "Agora o Google Photos lê tudo.").ok);
    // uma tolerância só: palavra engolida sozinha ainda vale
    assert.ok(chooseTake(say("com esforço de raciocínio,", 0), "com esforço médio de raciocínio,").ok);
  });

  it("frase curta nunca troca número ('subiu 20%' não é tomada de 'subiu 10%'), só casa exato", () => {
    assert.equal(chooseTake(say("O uso subiu 20 % no Brasil.", 0), "O uso subiu 10% no Brasil.").ok, false);
    assert.equal(chooseTake(say("Saiu a versão 4 hoje.", 0), "Saiu a versão 5 hoje.").ok, false);
    assert.ok(chooseTake(say("O uso subiu 10 % no Brasil.", 0), "O uso subiu 10% no Brasil.").ok, "o número certo, partido, ainda casa");
  });

  it("frase longa (8+ palavras) mantém as tolerâncias de antes", () => {
    const r = chooseTake(say("Uma atualizacao de privacidad do mudou tudo", 0), "Uma atualização de privacidade do Google mudou tudo");
    assert.ok(r.ok);
  });

  it("o roteiro mostra a fala ouvida quando ela difere do texto pedido (e o resolveBlocks avisa)", () => {
    const ws = say("O Google pode o seu Gmail.", 0);
    const file: BlocksFile = { edition: "261028", blocks: { resumo: [{ text: "O Google pode usar o seu Gmail." }, { start: 0, end: 3, text: "O Google pode ler o seu Gmail." }] } };
    const res = resolveBlocks(file, ws, { durationS: 10 });
    assert.deepEqual(res.errors, []);
    assert.equal(res.blocks.resumo?.[0].heard, "O Google pode o seu Gmail.");
    assert.equal(res.blocks.resumo?.[1].heard, "O Google pode o seu Gmail.");
    assert.match(res.warnings.join("\n"), /resumo\[0\]: a fala ouvida difere/);
    const plan = buildSequencePlan(SPEC, res.blocks, [], { fps: 30, durationS: 10 });
    const md = roteiroMarkdown("261028", [plan], res.blocks, 30);
    assert.match(md, /\*\*fala difere\*\* resumo\[0\], ouvido: "O Google pode o seu Gmail\." \(pedido: "O Google pode usar o seu Gmail\."\)/);
  });

  it("fala igual ao pedido (acento, 'pra', GPT 5 × GPT-5) não marca diferença", () => {
    const ws = say("Isso serve pra todo mundo usar o GPT 5.", 0);
    const file: BlocksFile = { edition: "261028", blocks: { resumo: [{ text: "Isso serve para todo mundo usar o GPT-5." }] } };
    const res = resolveBlocks(file, ws, { durationS: 10 });
    assert.deepEqual(res.errors, []);
    assert.equal(res.blocks.resumo?.[0].heard, undefined);
    assert.deepEqual(res.warnings, []);
  });
});

describe("#11360: número partido pelo Whisper", () => {
  it("joinWordTexts cola '.1', ',6' e '%' ao número anterior", () => {
    assert.equal(joinWordTexts(["GPT", "6", ".1", "Terra"]), "GPT 6.1 Terra");
    assert.equal(joinWordTexts(["subiu", "53", ",6", "%"]), "subiu 53,6%");
    assert.equal(joinWordTexts(["fim", ".", "Olá"]), "fim . Olá", "ponto solto sem dígito não cola");
    assert.equal(joinWordTexts(["isso", ",5"]), "isso ,5", "só cola depois de número");
  });

  it("regressão 261028: a legenda sai 'GPT 6.1 Terra' mesmo sem casar com o roteiro (intervalo explícito)", () => {
    const ws = say("O GPT 6 .1 Terra chegou.", 0);
    const srt = cuesToSrt(segmentCues(ws));
    assert.match(srt, /O GPT 6\.1 Terra chegou\./);
    assert.doesNotMatch(srt, /6 \.1/);
  });

  it("casa 'GPT-6.1' e '53,6%' do roteiro com os tokens partidos (legenda com a grafia do roteiro)", () => {
    const ws = say("O GPT 6 .1 Terra acertou 53 ,6 % das questões.", 0);
    const out = alignPunctuationToScript(ws, "O GPT-6.1 Terra acertou 53,6% das questões.");
    assert.deepEqual(out.map((w) => w.text), ["O", "GPT-6.1", "Terra", "acertou", "53,6%", "das", "questões."]);
    assert.equal(out[1].start, ws[1].start);
    assert.equal(out[1].end, ws[3].end, "a palavra juntada vai do início da 1ª ao fim da última");
    const srt = cuesToSrt(segmentCues(out));
    assert.match(srt, /O GPT-6\.1 Terra acertou\s53,6% das questões\./);
  });

  it("mergeSplitNumberTokens só junta quando o token do roteiro tem dígito", () => {
    const ws = say("vai a o mercado", 0);
    assert.equal(mergeSplitNumberTokens(ws, ["vai", "ao", "mercado"]).length, 4);
  });

  it("a tomada casa 'GPT-6.1' com 'GPT 6 .1' (3 tokens) e a autorrevisão não acusa o número", () => {
    const ws = say("O novo GPT 6 .1 saiu hoje.", 0);
    const r = chooseTake(ws, "O novo GPT-6.1 saiu hoje.");
    assert.ok(r.ok, r.ok ? "" : r.reason);
    assert.equal(r.take.lastWord, ws.length - 1);
    assert.equal(r.text, "O novo GPT 6.1 saiu hoje.");
    assert.equal(findTakes(ws, "O novo GPT-6.1 saiu hoje.").filter((t) => t.complete).length, 1);
    const findings = reviewPreview({ words: ws, script: "O novo GPT-6.1 saiu hoje.", cuts: [], durationS: ws[ws.length - 1].end + 1 });
    assert.deepEqual(findings, []);
  });
});

describe("#11351: silêncio relativo ao loudness e bruto quente", () => {
  it("regressão 261028: bruto a -9,9 LUFS detecta a -35 dB, não a -45", () => {
    const quente = { inputI: -9.9, inputTp: 0, inputLra: 4 };
    assert.deepEqual(silenceNoiseDb(quente), { noiseDb: -35, how: "relative" });
  });

  it("bruto baixo (261027, -31 LUFS) e normal (-21) ficam no piso de -45; sem medida, -45; nunca acima de -25", () => {
    assert.equal(silenceNoiseDb({ inputI: -31, inputTp: -6, inputLra: 5 }).noiseDb, SILENCE_DETECT.noiseDb);
    assert.equal(silenceNoiseDb({ inputI: -21, inputTp: -3, inputLra: 5 }).noiseDb, -45);
    assert.deepEqual(silenceNoiseDb(null), { noiseDb: -45, how: "default" });
    assert.equal(silenceNoiseDb({ inputI: 2, inputTp: 3, inputLra: 1 }).noiseDb, -25);
  });

  it("o hash do plan.json muda quando o silences.json é redetectado (srt/preview/review recusam o plano velho)", () => {
    const blocks = '{"edition":"261028","blocks":{}}';
    const source = '{"path":"x.mp4","fps":30}';
    const antes = planHashOf(blocks, source, JSON.stringify([{ start: 1, end: 2 }]));
    const depois = planHashOf(blocks, source, JSON.stringify([{ start: 1, end: 2 }, { start: 5, end: 6.2 }]));
    assert.notEqual(antes, depois);
    assert.equal(antes, planHashOf(blocks, source, JSON.stringify([{ start: 1, end: 2 }])), "determinístico");
    assert.notEqual(planHashOf(blocks, source, null), planHashOf(blocks, source, ""), "ausente ≠ vazio");
  });

  it("--silence-db sobrepõe e é validado", () => {
    assert.deepEqual(silenceNoiseDb({ inputI: -9.9, inputTp: 0, inputLra: 4 }, -30), { noiseDb: -30, how: "override" });
    assert.equal(parseSilenceDbArg(undefined), undefined);
    assert.equal(parseSilenceDbArg("-35"), -35);
    assert.throws(() => parseSilenceDbArg("35"), /negativo/);
    assert.throws(() => parseSilenceDbArg(""), /negativo/);
    assert.throws(() => parseSilenceDbArg("abc"), /negativo/);
  });

  it("aviso também para bruto quente (> -14 LUFS) e true peak ≥ 0 dBTP", () => {
    assert.match(loudnessWarning({ inputI: -9.9, inputTp: 0, inputLra: 4 }) ?? "", /bruto quente: -9\.9 LUFS, acima de -14 LUFS; true peak 0\.0 dBTP/);
    assert.match(loudnessWarning({ inputI: -18, inputTp: 0.4, inputLra: 4 }) ?? "", /clipping/);
    assert.match(loudnessWarning({ inputI: -12, inputTp: -2, inputLra: 4 }) ?? "", /acima de -14 LUFS/);
    assert.equal(loudnessWarning({ inputI: -18, inputTp: -1, inputLra: 4 }), null);
  });

  it("regressão 261028: palavra esticada por cima da pausa ('medida', '10') não é 'palavra fora dos clipes'", () => {
    // Whisper: "medida" ~1035,2–1036,2; silêncio 1035,5–1036,8 (o corte passa no
    // meio dela). 1036,3 põe o meio da palavra (1035,75) depois do fim do clipe (1035,7).
    const ws: Word[] = [
      ...say("uma", 1034.6),
      { start: 1035.2, end: 1036.3, text: "medida" },
      ...say("nova chegou.", 1036.9),
    ];
    const sil = [{ start: 1035.5, end: 1036.8 }];
    const file: BlocksFile = { edition: "261028", blocks: { resumo: [{ start: 1034.5, end: 1037.7 }] } };
    const res = resolveBlocks(file, ws, { durationS: 1200 });
    const plan = buildSequencePlan(SPEC, res.blocks, sil, { fps: 30, durationS: 1200 });
    assert.ok(plan.clips.some((c) => c.srcOut < 1035.75), "o meio da palavra fica fora dos clipes");
    assert.deepEqual(plan.dropped, []);
    // "10": 1126,4–1128,2 com silêncio 1126,5–1127,6
    const parts = [{ start: 1126, end: 1126.7 }, { start: 1127.4, end: 1129 }];
    assert.equal(wordCoveredBySilence({ start: 1126.4, end: 1128.2 }, parts, [{ start: 1126.5, end: 1127.6 }]), true);
  });

  it("palavra inteira dentro do silêncio, ou com o trecho de fora fora de silêncio, continua perdida", () => {
    const parts = [{ start: 0, end: 1 }, { start: 3, end: 4 }];
    assert.equal(wordCoveredBySilence({ start: 1.5, end: 2 }, parts, [{ start: 1, end: 3 }]), false, "nada dentro dos clipes");
    assert.equal(wordCoveredBySilence({ start: 0.8, end: 2 }, parts, [{ start: 1.5, end: 3 }]), false, "1,0–1,5 fora dos clipes sem silêncio");
    assert.equal(wordCoveredBySilence({ start: 0.8, end: 2 }, parts, [{ start: 0.9, end: 3 }]), true);
  });
});
