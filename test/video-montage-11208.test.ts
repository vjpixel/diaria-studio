/**
 * test/video-montage-11208.test.ts (#11208) — lógica pura da montagem do vídeo
 * diário (`scripts/lib/diaria/video-montage.ts`), com palavras e silêncios
 * sintéticos. Inclui a regressão dos dois bugs reais da 261027: a tomada falsa
 * duplicada ("Uma atualização de…" duas vezes) e a sílaba da tomada seguinte
 * vazando no corte.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FECHO_HOLD_S,
  TAKE_DEFAULTS,
  alignPunctuationToScript,
  applyVocabularyToWords,
  buildSequencePlan,
  buildXmeml,
  chooseTake,
  cuesToSrt,
  cutPoints,
  decupagemMarkdown,
  defaultSequences,
  findTakes,
  framingFor,
  groupTakes,
  loudnessWarning,
  mapWordsToSequence,
  parseLoudnormJson,
  parseProbe,
  parseSilenceDetect,
  pathUrl,
  pickRawSource,
  previewClipArgs,
  resolveBlocks,
  reviewPreview,
  segmentCues,
  speechParts,
  srtTimestamp,
  wrapCueText,
  type BlocksFile,
  type SequenceSpec,
  type VocabRule,
  type Word,
} from "../scripts/lib/diaria/video-montage.ts";
import { videoTargetOf, hasFinalInName } from "../scripts/lib/diaria/drive-video-source.ts";
import { previewFileName, xmlFileName } from "../scripts/video-montagem.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Palavras com duração fixa a partir de `t0`, separadas por `gap`. */
function say(text: string, t0: number, dur = 0.3, gap = 0.05): Word[] {
  let t = t0;
  return text.split(" ").map((w) => {
    const word = { start: Math.round(t * 1000) / 1000, end: Math.round((t + dur) * 1000) / 1000, text: w };
    t += dur + gap;
    return word;
  });
}

describe("silêncios e fala (#11208)", () => {
  it("parseSilenceDetect lê os pares e fecha o silêncio final na duração", () => {
    const stderr = [
      "[silencedetect @ 0x1] silence_start: 1.5",
      "[silencedetect @ 0x1] silence_end: 2.75 | silence_duration: 1.25",
      "[silencedetect @ 0x1] silence_start: -0.01",
      "[silencedetect @ 0x1] silence_end: 0.4 | silence_duration: 0.41",
      "[silencedetect @ 0x1] silence_start: 9.2",
    ].join("\n");
    assert.deepEqual(parseSilenceDetect(stderr, 10), [
      { start: 1.5, end: 2.75 },
      { start: 0, end: 0.4 },
      { start: 9.2, end: 10 },
    ]);
    assert.equal(parseSilenceDetect(stderr).length, 2, "sem duração, o silêncio aberto é descartado");
  });

  it("speechParts remove silêncio ≥0,8 s com 0,2 s de respiro e descarta clipe <0,6 s", () => {
    const sil = [
      { start: 3, end: 5 }, // 2 s: sai
      { start: 6, end: 6.5 }, // 0,5 s: fica
      { start: 9.2, end: 9.9 }, // 0,7 s: fica
    ];
    assert.deepEqual(speechParts(0, 10, sil), [
      { start: 0, end: 3.2 },
      { start: 4.8, end: 10 },
    ]);
    // trecho de 0,5 s entre dois silêncios longos é descartado
    const sil2 = [
      { start: 1, end: 2 },
      { start: 2.15, end: 4 },
    ];
    assert.deepEqual(speechParts(0, 5, sil2), [
      { start: 0, end: 1.2 },
      { start: 3.8, end: 5 },
    ]);
  });

  it("speechParts nunca sai do intervalo pedido", () => {
    const parts = speechParts(2, 4, [{ start: 0, end: 2.5 }, { start: 3.6, end: 8 }]);
    assert.ok(parts.every((p) => p.start >= 2 && p.end <= 4), JSON.stringify(parts));
  });
});

describe("escolha de tomada (#11208, bugs da 261027)", () => {
  it("regressão: tomada falsa 'Uma atualização de…' não entra; o corte começa depois dela", () => {
    const falsa = say("Uma atualização de", 10);
    const boa = say("Uma atualização de privacidade do Google mudou tudo.", 11.4);
    const words = [...falsa, ...boa, ...say("Olha", 15)];
    const c = chooseTake(words, "Uma atualização de privacidade do Google mudou tudo.");
    assert.ok(c.ok);
    assert.equal(c.take.firstWord, 3, "começa na 2ª 'Uma', não na tomada falsa");
    assert.equal(c.completeTakes, 1);
    const fimFalsa = falsa[falsa.length - 1].end;
    assert.ok(c.interval.start >= fimFalsa + TAKE_DEFAULTS.guardS - 1e-9, `${c.interval.start} pega o fim da tomada falsa (${fimFalsa})`);
    assert.equal(findTakes(words, "Uma atualização de privacidade do Google mudou tudo.").filter((t) => t.complete).length, 1);
  });

  it("regressão: tomada falsa de 1 palavra ('Uma… uma atualização') não arrasta a palavra repetida", () => {
    const words = [...say("Uma", 0), ...say("uma atualização de privacidade do Google.", 0.8)];
    const c = chooseTake(words, "Uma atualização de privacidade do Google.");
    assert.ok(c.ok);
    assert.equal(c.take.firstWord, 1);
    assert.ok(c.interval.start >= words[0].end + TAKE_DEFAULTS.guardS - 1e-9, `${c.interval.start} pega a tomada falsa`);
  });

  it("regressão: a sílaba da tomada seguinte não vaza no fim do corte", () => {
    const t1 = say("O Google pode usar o seu Gmail.", 20);
    const inicioT2 = t1[t1.length - 1].end + 0.12; // regravou logo em seguida
    const t2 = say("O Google pode usar o seu Gmail.", inicioT2);
    const words = [...t1, ...t2];
    const primeira = chooseTake(words, "O Google pode usar o seu Gmail.", { take: 1 });
    assert.ok(primeira.ok);
    assert.ok(primeira.interval.end <= t2[0].start - TAKE_DEFAULTS.guardS + 1e-9, `corte ${primeira.interval.end} invade a tomada 2 (${t2[0].start})`);
    assert.ok(primeira.interval.end >= t1[t1.length - 1].end, "nunca corta a própria tomada");
    // default: a última completa
    const ultima = chooseTake(words, "O Google pode usar o seu Gmail.");
    assert.ok(ultima.ok);
    assert.equal(ultima.takeNumber, 2);
    assert.equal(ultima.take.firstWord, t1.length);
    assert.ok(ultima.interval.start >= t1[t1.length - 1].end + TAKE_DEFAULTS.guardS - 1e-9);
  });

  it("última tomada INCOMPLETA não é escolhida: vale a última completa", () => {
    const a = say("Isso muda a busca do Google.", 0);
    const b = say("Isso muda a busca do Google.", 5);
    const c = say("Isso muda a", 10);
    const words = [...a, ...b, ...c];
    const r = chooseTake(words, "Isso muda a busca do Google.");
    assert.ok(r.ok);
    assert.equal(r.take.firstWord, a.length);
    assert.equal(r.takeNumber, 2);
  });

  it("tolera erro do Whisper (acento, palavra engolida) e falha sem tomada completa", () => {
    const words = say("Uma atualizacao de privacidad do mudou tudo", 0);
    assert.ok(chooseTake(words, "Uma atualização de privacidade do Google mudou tudo").ok);
    const r = chooseTake(say("Nada a ver aqui", 0), "Uma atualização de privacidade");
    assert.equal(r.ok, false);
    const fora = chooseTake(words, "Uma atualização de privacidade do Google mudou tudo", { take: 3 });
    assert.equal(fora.ok, false);
  });
});

describe("decupagem (#11208)", () => {
  it("agrupa tomadas repetidas e sugere a última completa", () => {
    const segs = [
      { start: 0, end: 2, text: "Olá, eu sou o Pixel" },
      { start: 3, end: 4, text: "Uma atualização de" },
      { start: 5, end: 9, text: "Uma atualização de privacidade do Google." },
      { start: 10, end: 12, text: "Isso muda tudo." },
    ];
    const groups = groupTakes(segs);
    assert.deepEqual(groups.map((g) => g.segments), [[0], [1, 2], [3]]);
    assert.equal(groups[1].suggested, 2);
    const md = decupagemMarkdown("261027", segs, groups);
    assert.match(md, /\| 2 \| 00:03\.0–00:04\.0 \| Uma atualização de \| descartar \(tomada repetida\) \|/);
    assert.match(md, /usar \(tomada 2 de 2\)/);
    assert.match(md, /\| Tempo \| Fala \| Sugestão \| Decisão \|/);
  });
});

const SPEC_V: SequenceSpec = { target: "outras-redes", name: "Diaria comentada_Outras redes_V1", width: 1080, height: 1920, order: ["titulo", "comentario", "fecho"], scales: [115, 130] };

function blocksFixture(): { file: BlocksFile; words: Word[] } {
  const words = [
    ...say("Google pode ler seu Gmail?", 1),
    ...say("O comentário de hoje é este.", 5),
    ...say("Até amanhã.", 10),
  ];
  const file: BlocksFile = {
    edition: "261027",
    source: { path: "G:/Meu Drive/Work/Mentoria Fluxo VTSD/YouTube/261027/20261026_191548.mp4", fps: 30, durationS: 20, width: 3840, height: 2160, mirrored: true },
    framing: { faceX: 1850 / 3840, eyeY: 1160 / 2160 },
    blocks: {
      titulo: [{ text: "Google pode ler seu Gmail?" }],
      comentario: [{ text: "O comentário de hoje é este." }],
      fecho: [{ start: 9.9, end: 10.8 }],
    },
  };
  return { file, words };
}

describe("plano das sequências e xmeml (#11208)", () => {
  it("alterna a escala, segura 0,5 s no fecho e lista blocos que faltam", () => {
    const { file, words } = blocksFixture();
    const { blocks, errors } = resolveBlocks(file, words);
    assert.deepEqual(errors, []);
    const plan = buildSequencePlan({ ...SPEC_V, order: [...SPEC_V.order, "cta_out"] }, blocks, [], file.source);
    assert.deepEqual(plan.clips.map((c) => c.scale), [115, 130, 115]);
    const fecho = plan.clips[2];
    assert.equal(fecho.srcOut, 10.8 + FECHO_HOLD_S);
    assert.deepEqual(plan.missingBlocks, ["cta_out"]);
    assert.equal(plan.clips[1].seqStart, plan.clips[0].seqEnd, "clipes encostados na sequência");
    assert.match(plan.script, /^Google pode ler seu Gmail\? O comentário de hoje é este\. Até amanhã\.$/);
    assert.deepEqual(cutPoints(plan, 30), [plan.clips[1].seqStart / 30, plan.clips[2].seqStart / 30]);
  });

  it("fecho curto (<0,6 s de fala) não some: o descarte vem depois do respiro de 0,5 s", () => {
    const { file, words } = blocksFixture();
    file.blocks.fecho = [{ start: 10, end: 10.4 }];
    const { blocks } = resolveBlocks(file, words);
    const plan = buildSequencePlan(SPEC_V, blocks, [], file.source);
    const fecho = plan.clips.filter((c) => c.block === "fecho");
    assert.equal(fecho.length, 1);
    assert.equal(fecho[0].srcOut, 10.9);
    // outro bloco curto continua sendo descartado
    file.blocks.comentario = [{ start: 5, end: 5.4 }];
    assert.equal(buildSequencePlan(SPEC_V, resolveBlocks(file, words).blocks, [], file.source).clips.filter((c) => c.block === "comentario").length, 0);
  });

  it("resolveBlocks junta os erros (intervalo inválido, frase sem tomada, item vazio)", () => {
    const { file, words } = blocksFixture();
    file.blocks.resumo = [{ start: 5, end: 4 }, { text: "frase que não foi dita" }, {}];
    const { errors } = resolveBlocks(file, words);
    assert.equal(errors.length, 3);
    assert.match(errors.join("\n"), /resumo\[0\]: intervalo inválido/);
    assert.match(errors.join("\n"), /resumo\[1\]: nenhuma tomada completa/);
    assert.match(errors.join("\n"), /resumo\[2\]: sem texto nem intervalo/);
  });

  it("xmeml v4: 3 sequências, um <file> definido uma vez, áudio linkado, Center do enquadramento", () => {
    const { file, words } = blocksFixture();
    const { blocks } = resolveBlocks(file, words);
    file.blocks.abertura = file.blocks.titulo;
    const all = resolveBlocks(file, words).blocks;
    const specs = defaultSequences().map((s) => ({ ...s, order: s.order.filter((k) => k in all) }));
    const plans = specs.map((s) => buildSequencePlan(s, all, [], file.source));
    const xml = buildXmeml(plans, file.source, file.framing);
    assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<!DOCTYPE xmeml>\n<xmeml version="4">/);
    assert.equal((xml.match(/<sequence /g) ?? []).length, 3);
    assert.equal((xml.match(/<pathurl>/g) ?? []).length, 1, "o bruto é definido uma vez só");
    assert.match(xml, /<pathurl>file:\/\/localhost\/G:\/Meu%20Drive\/Work\/Mentoria%20Fluxo%20VTSD\/YouTube\/261027\/20261026_191548\.mp4<\/pathurl>/);
    assert.match(xml, /<name>Diaria comentada_Outras redes_V1<\/name>/);
    assert.match(xml, /<linkclipref>a1<\/linkclipref><mediatype>audio<\/mediatype>/);
    assert.match(xml, /<parameterid>center<\/parameterid><name>Center<\/name><value><horiz>[-\d.]+<\/horiz><vert>[-\d.]+<\/vert><\/value>/);
    assert.doesNotMatch(xml, /Flop/, "sem --xml-flop o flip fica para o Premiere");
    assert.match(buildXmeml(plans, file.source, file.framing, { flopFilter: true }), /<effectid>Flop<\/effectid>/);
    assert.doesNotMatch(buildXmeml(plans, { ...file.source, mirrored: false }, file.framing, { flopFilter: true }), /Flop/);
    assert.ok(blocks.titulo.length === 1);
  });

  it("nomes das sequências casam com o destino da pasta Final/ (#11222)", () => {
    const targets = defaultSequences().map((s) => videoTargetOf(`${s.name}.mp4`));
    assert.deepEqual(targets, ["youtube", "instagram", "outras-redes"]);
    for (const s of defaultSequences()) {
      assert.ok(!/por que isso importa/i.test(s.order.join(" ")), "nenhuma versão leva 'Por que isso importa?' (26/10/2026)");
    }
    assert.ok(!defaultSequences()[1].order.includes("abertura"), "verticais não têm apresentação");
    assert.equal(hasFinalInName(previewFileName("261027", "outras-redes")), false, "a prévia nunca vira 'final' para o fetch-drive-video");
    assert.equal(hasFinalInName(xmlFileName("261027")), false);
  });

  it("pathUrl troca barra invertida e codifica espaço e acento", () => {
    assert.equal(pathUrl("G:\\Meu Drive\\vídeo.mp4"), "file://localhost/G:/Meu%20Drive/v%C3%ADdeo.mp4");
  });
});

describe("enquadramento (#11208)", () => {
  const F = { faceX: 1850 / 3840, eyeY: 1160 / 2160 };

  it("vertical 115% num 4K: rosto no centro, olhos a 40% da altura (o crop da prévia da 261027)", () => {
    const r = framingFor({ srcW: 3840, srcH: 2160, seqW: 1080, seqH: 1920, scalePct: 115, framing: F });
    // olhos a 40% pediriam y=492; o recorte encosta embaixo (2160-1670=490), como o render_preview.py da 261027
    assert.deepEqual(r.crop, { x: 1380, y: 490, w: 940, h: 1670 });
    assert.ok(Math.abs(r.crop.x + r.crop.w / 2 - 1850) <= 1);
    const alto = framingFor({ srcW: 3840, srcH: 2160, seqW: 1080, seqH: 1920, scalePct: 130, framing: { faceX: 0.5, eyeY: 0.35 } });
    assert.ok(Math.abs((0.35 * 2160 - alto.crop.y) / alto.crop.h - 0.4) < 0.002, JSON.stringify(alto));
    assert.ok(alto.center.vert > 0, "recorte acima do centro do bruto: o clipe desce");
    // centro do recorte à esquerda do centro do bruto → o clipe vai para a direita
    assert.ok(r.center.horiz > 0);
    assert.equal(r.center.horiz, Math.round((((1920 - (1380 + 470)) * 1.15) / 1080) * 10000) / 10000);
  });

  it("recorte encosta na borda em vez de sair do bruto; 50% no horizontal enche o quadro sem deslocar", () => {
    const borda = framingFor({ srcW: 3840, srcH: 2160, seqW: 1080, seqH: 1920, scalePct: 130, framing: { faceX: 0.02, eyeY: 0.01 } });
    assert.equal(borda.crop.x, 0);
    assert.equal(borda.crop.y, 0);
    const h = framingFor({ srcW: 3840, srcH: 2160, seqW: 1920, seqH: 1080, scalePct: 50, framing: F });
    assert.deepEqual(h.crop, { x: 0, y: 0, w: 3840, h: 2160 });
    assert.deepEqual(h.center, { horiz: 0, vert: 0 });
  });

  it("previewClipArgs: flip, crop, 720x1280, fades de 20/30 ms", () => {
    const args = previewClipArgs({ src: "in.mp4", start: 10, end: 12.5, crop: { x: 1380, y: 492, w: 940, h: 1670 }, mirrored: true, fps: 30, out: "c00.mp4" });
    const vf = args[args.indexOf("-vf") + 1];
    assert.equal(vf, "hflip,crop=940:1670:1380:492,scale=720:1280,setsar=1,fps=30");
    assert.equal(args[args.indexOf("-af") + 1], "afade=t=in:d=0.02,afade=t=out:st=2.470:d=0.03");
    const sem = previewClipArgs({ src: "in.mp4", start: 0, end: 1, crop: { x: 0, y: 0, w: 2, h: 2 }, mirrored: false, fps: 30, out: "o.mp4" });
    assert.ok(!sem[sem.indexOf("-vf") + 1].startsWith("hflip"));
  });
});

describe("legendas (#11208)", () => {
  const vocab = JSON.parse(readFileSync(join(ROOT, "context/video-montagem/vocabulario.json"), "utf8")) as { rules: VocabRule[]; whisper_prompt: string };

  it("o vocabulário vive no arquivo de config, não na lógica", () => {
    assert.ok(vocab.rules.length >= 4);
    assert.match(vocab.whisper_prompt, /diar\.ia\.br/);
    const src = readFileSync(join(ROOT, "scripts/lib/diaria/video-montage.ts"), "utf8");
    assert.doesNotMatch(src, /Google Photos|Modo IA da Busca/, "termos ficam em context/video-montagem/vocabulario.json");
  });

  it("vocabulário pega termo de 2 palavras entre palavras do Whisper", () => {
    const words = say("a diária explica a inteligência personalizada no modo IA da busca do Google Fotos", 0);
    const out = applyVocabularyToWords(words, vocab.rules).map((w) => w.text).join(" ");
    assert.equal(out, "a diar.ia.br explica a Inteligência Personalizada no Modo IA da Busca do Google Photos");
    const soInsta: VocabRule[] = [{ pattern: "fotos", replacement: "Photos", targets: ["instagram"] }];
    assert.equal(applyVocabularyToWords(say("fotos", 0), soInsta, "outras-redes")[0].text, "fotos");
    assert.equal(applyVocabularyToWords(say("fotos", 0), soInsta, "instagram")[0].text, "Photos");
  });

  it("a pontuação segue o roteiro (o Whisper fecha frase onde o roteiro tem vírgula)", () => {
    const words = say("Chama Inteligência Personalizada. Recurso novo do Google.", 0);
    const out = alignPunctuationToScript(words, "Chama Inteligência Personalizada, recurso novo do Google.");
    assert.equal(out.map((w) => w.text).join(" "), "Chama Inteligência Personalizada, recurso novo do Google.");
  });

  it("cues: >50 caracteres, pontuação final, vírgula depois de 30; 2 linhas perto do meio; fim = min(fim+0,3, próxima)", () => {
    const words = say("O Google pode estar usando dados do seu Gmail e das suas fotos para treinar a IA. Calma, tem jeito de desligar isso, e eu mostro como.", 0);
    const cues = segmentCues(words);
    const texts = cues.map((c) => c.map((w) => w.text).join(" "));
    assert.ok(texts.every((t) => t.length <= 50 + 12), JSON.stringify(texts));
    assert.ok(texts.some((t) => t.endsWith("IA.")), "quebra na pontuação final");
    assert.ok(texts.some((t) => t.endsWith("isso,")), "quebra na vírgula depois de 30 caracteres");
    assert.ok(!texts.includes("Calma,"), "vírgula antes de 30 caracteres não quebra");
    const srt = cuesToSrt(cues);
    assert.match(srt, /^1\n00:00:00,000 --> /);
    const blocks = srt.trim().split("\n\n");
    assert.equal(blocks.length, cues.length);
    const end1 = blocks[0].split("\n")[1].split(" --> ")[1];
    assert.equal(end1, srtTimestamp(Math.min(cues[0][cues[0].length - 1].end + 0.3, cues[1][0].start)));
    assert.equal(wrapCueText("O Google pode estar usando dados do seu Gmail"), "O Google pode estar\nusando dados do seu Gmail");
    assert.equal(wrapCueText("curto"), "curto");
    assert.equal(srtTimestamp(3725.5), "01:02:05,500");
  });

  it("mapWordsToSequence só leva palavras com o meio dentro do clipe (sem sílaba de fora)", () => {
    const words = [...say("fora", 0), ...say("dentro do clipe", 2), ...say("depois", 4)];
    const plan = { clips: [{ block: "x", srcIn: 1.9, srcOut: 3.2, frameIn: 57, frameOut: 96, seqStart: 30, seqEnd: 69, scale: 115 }] };
    const out = mapWordsToSequence(words, plan.clips, 30);
    assert.deepEqual(out.map((w) => w.text), ["dentro", "do", "clipe"]);
    assert.ok(out[0].start >= 1 && out[out.length - 1].end <= 69 / 30 + 1e-9);
  });
});

describe("autorrevisão da prévia (#11208)", () => {
  const script = "Uma atualização de privacidade do Google mudou tudo. Até amanhã.";

  it("acha a tomada duplicada, a sílaba vazada no corte e o final seco", () => {
    const words = [
      ...say("Uma atualização de", 0),
      ...say("Uma atualização de privacidade do Google mudou tudo.", 1.2),
      { start: 4.3, end: 4.45, text: "o" },
      ...say("Até amanhã.", 4.6),
    ];
    const durationS = words[words.length - 1].end + 0.1;
    const f = reviewPreview({ words, script, cuts: [4.4], durationS });
    const kinds = f.map((x) => x.kind);
    assert.ok(kinds.includes("tomada-duplicada"), JSON.stringify(f));
    assert.ok(kinds.includes("silaba-vazada"), JSON.stringify(f));
    assert.ok(kinds.includes("final-seco"), JSON.stringify(f));
  });

  it("prévia limpa não acusa nada; fala do roteiro ausente vira fala-faltando", () => {
    const limpa = say(script, 0);
    assert.deepEqual(reviewPreview({ words: limpa, script, cuts: [2], durationS: limpa[limpa.length - 1].end + 0.6 }), []);
    const curta = say("Uma atualização de privacidade do Google mudou tudo.", 0);
    const f = reviewPreview({ words: curta, script, cuts: [], durationS: 10 });
    assert.deepEqual(f.map((x) => x.kind), ["fala-faltando"]);
    assert.match(f[0].detail, /ate amanha/);
  });
});

describe("loudness, bruto, probe (#11208)", () => {
  it("lê o resumo do loudnorm e avisa abaixo de -24 LUFS", () => {
    const stderr = `[Parsed_loudnorm_0 @ 0x1]\n{\n\t"input_i" : "-31.02",\n\t"input_tp" : "-12.40",\n\t"input_lra" : "6.10",\n\t"input_thresh" : "-41.3"\n}\n`;
    const m = parseLoudnormJson(stderr);
    assert.deepEqual(m, { inputI: -31.02, inputTp: -12.4, inputLra: 6.1 });
    assert.match(loudnessWarning(m) ?? "", /-31\.0 LUFS/);
    assert.equal(loudnessWarning({ inputI: -21, inputTp: -1, inputLra: 5 }), null);
    assert.match(loudnessWarning(null) ?? "", /não medido/);
    assert.equal(parseLoudnormJson("nada"), null);
  });

  it("pickRawSource: o maior vídeo solto, nunca um final nem a prévia", () => {
    const r = pickRawSource([
      { name: "20261026_191548.mp4", size: 7_911_864_156 },
      { name: "Diaria comentada V3 final.mp4", size: 9_000_000_000 },
      { name: "261027 - previa outras-redes.mp4", size: 8_000_000_000 },
      { name: "261027 - montagem (importar no Premiere).xml", size: 39_311 },
    ]);
    assert.equal(r?.name, "20261026_191548.mp4");
    assert.equal(pickRawSource([{ name: "x.xml", size: 1 }]), null);
  });

  it("parseProbe: 4K 30 fps; fps fracionário recusa (timebase inteiro no XML)", () => {
    const probe = (rate: string) =>
      JSON.stringify({ streams: [{ codec_type: "audio" }, { codec_type: "video", width: 3840, height: 2160, r_frame_rate: rate }], format: { duration: "658.100000" } });
    assert.deepEqual(parseProbe(probe("30/1"), "G:/x.mp4"), { path: "G:/x.mp4", fps: 30, durationS: 658.1, width: 3840, height: 2160, mirrored: true });
    assert.throws(() => parseProbe(probe("30000/1001"), "x"), /não inteiro/);
  });
});

describe("skill e fluxo do dia (#11208)", () => {
  const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

  it("SKILL.md da /diaria-video-montagem: frontmatter, 2 gates, CLI e passagem para a /diaria-publica-video", () => {
    const skill = read(".claude/skills/diaria-video-montagem/SKILL.md");
    assert.match(skill, /^---\nname: diaria-video-montagem\ndescription: /);
    for (const sub of ["transcribe", "decupagem", "roteiro", "build", "srt", "preview", "review"]) {
      assert.ok(skill.includes(`scripts/video-montagem.ts ${sub}`), `cita o subcomando ${sub}`);
    }
    assert.match(skill, /Gate 1/);
    assert.match(skill, /Gate 2/);
    assert.match(skill, /\/diaria-publica-video/);
    assert.match(skill, /Final\//);
  });

  it("CLAUDE.md e a /diaria-publica-video põem a montagem antes da publicação do vídeo", () => {
    assert.match(read("CLAUDE.md"), /\/diaria-video-montagem[\s\S]{0,300}\/diaria-publica-video[\s\S]{0,300}\/diaria-5-publicacao/);
    assert.match(read(".claude/skills/diaria-publica-video/SKILL.md"), /\/diaria-video-montagem/);
  });
});
