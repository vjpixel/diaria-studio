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
  FRAMING_261027,
  TAKE_DEFAULTS,
  alignPunctuationToScript,
  applyVocabularyToWords,
  buildSequencePlan,
  buildXmeml,
  chooseTake,
  cuesToSrt,
  cutPoints,
  defaultSequences,
  effectiveFraming,
  effectiveSource,
  escapeXml,
  findTakes,
  framingFor,
  groupTakes,
  loudnessWarning,
  mapWordsToSequence,
  parseBlocksFile,
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
  type SourceInfo,
  type VocabAlias,
  type VocabRule,
  type Word,
} from "../scripts/lib/diaria/video-montage.ts";
import { videoTargetOf, hasFinalInName } from "../scripts/lib/diaria/drive-video-source.ts";
import { loadVocab, main as videoMontagemMain, previewFileName, xmlFileName } from "../scripts/video-montagem.ts";
import { XMLParser, XMLValidator } from "fast-xml-parser";

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

describe("tomadas: erros comuns do Whisper (#11208, B)", () => {
  const ok = (words: Word[], phrase: string, extra: Parameters<typeof chooseTake>[2] = {}) => {
    const r = chooseTake(words, phrase, extra);
    assert.ok(r.ok, `${phrase}: ${r.ok ? "" : r.reason}`);
    return r;
  };

  it("'Google Fotos' ouvido casa com 'Google Photos' do roteiro (vocabulário antes do match, ou 1 palavra trocada)", () => {
    const vocab = loadVocab();
    const words = say("Agora o Google Fotos lê tudo.", 0);
    const file: BlocksFile = { edition: "261027", blocks: { titulo: [{ text: "Agora o Google Photos lê tudo." }] } };
    const r = resolveBlocks(file, words, { durationS: 20, rules: vocab.rules });
    assert.deepEqual(r.errors, []);
    ok(words, "Agora o Google Photos lê tudo."); // sem o vocabulário: 1 palavra trocada
  });

  it("'pra' × 'para', 'GPT 5' × 'GPT-5'", () => {
    ok(say("Isso serve pra todo mundo usar.", 0), "Isso serve para todo mundo usar.");
    const g = ok(say("O novo GPT 5 saiu hoje.", 0), "O novo GPT-5 saiu hoje.");
    assert.equal(g.take.lastWord, 5);
  });

  it("última palavra omitida numa frase de 8 continua completa", () => {
    const words = [...say("A Meta lançou um modelo novo para todos", 0), ...say("Olha", 5)];
    const r = ok(words, "A Meta lançou um modelo novo para todos hoje.");
    assert.equal(r.take.lastWord, 7);
  });

  it("gaguejo 'a a versão' acha a tomada a partir do 2º 'a'", () => {
    const words = say("a a versão nova chegou ao Brasil.", 0);
    const r = ok(words, "A versão nova chegou ao Brasil.");
    assert.equal(r.take.firstWord, 1);
  });

  it("'o' repetido no meio não é recomeço; 'usar' engolido ainda casa", () => {
    ok(say("O Google pode usar o seu Gmail.", 0), "O Google pode usar o seu Gmail.");
    const r = ok(say("O Google pode o seu Gmail.", 0), "O Google pode usar o seu Gmail.");
    assert.equal(r.take.firstWord, 0);
    assert.equal(r.take.lastWord, 5);
  });

  it("aliases: 'diária' ouvido casa com 'diar.ia.br' na frase do roteiro", () => {
    const vocab = loadVocab();
    const words = say("Eu sou o Pixel, editor da diária.", 0);
    const file: BlocksFile = { edition: "261027", blocks: { abertura: [{ text: "Eu sou o Pixel, editor da diar.ia.br." }] } };
    assert.deepEqual(resolveBlocks(file, words, { durationS: 20, rules: vocab.rules, aliases: vocab.aliases }).errors, []);
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
    // O Doc da decupagem (por bloco, curado) é testado em test/video-montage-docs-11361.test.ts.
  });
});

const SPEC_V: SequenceSpec = { target: "outras-redes", name: "Diaria comentada_Outras redes_V1", width: 1080, height: 1920, order: ["titulo", "comentario", "fecho"], scales: [115, 130] };

const SOURCE: SourceInfo = { path: "G:/Meu Drive/Work/Mentoria Fluxo VTSD/YouTube/261027/20261026_191548.mp4", fps: 30, durationS: 20, width: 3840, height: 2160, mirrored: true };
const FRAMING = { faceX: 1850 / 3840, eyeY: 1160 / 2160 };

function blocksFixture(): { file: BlocksFile; words: Word[] } {
  const words = [
    ...say("Google pode ler seu Gmail?", 1),
    ...say("O comentário de hoje é este.", 5),
    ...say("Até amanhã.", 10),
  ];
  const file: BlocksFile = {
    edition: "261027",
    framing: FRAMING,
    blocks: {
      titulo: [{ text: "Google pode ler seu Gmail?" }],
      comentario: [{ text: "O comentário de hoje é este." }],
      fecho: [{ start: 9.9, end: 10.8 }],
    },
  };
  return { file, words };
}

const resolveAt = (file: BlocksFile, words: Word[], extra: Partial<Parameters<typeof resolveBlocks>[2]> = {}) =>
  resolveBlocks(file, words, { durationS: SOURCE.durationS, ...extra });

describe("plano das sequências e xmeml (#11208)", () => {
  it("alterna a escala, segura 0,5 s depois da última palavra no fecho e lista blocos que faltam", () => {
    const { file, words } = blocksFixture();
    const { blocks, errors } = resolveAt(file, words);
    assert.deepEqual(errors, []);
    const plan = buildSequencePlan({ ...SPEC_V, order: [...SPEC_V.order, "cta_out"] }, blocks, [], SOURCE);
    assert.deepEqual(plan.clips.map((c) => c.scale), [115, 130, 115]);
    const ultima = words[words.length - 1].end;
    assert.equal(plan.clips[2].srcOut, Math.round((ultima + FECHO_HOLD_S) * 1000) / 1000, "0,5 s depois da ÚLTIMA PALAVRA, não do fim do intervalo");
    assert.deepEqual(plan.missingBlocks, ["cta_out"]);
    assert.deepEqual(plan.dropped, []);
    assert.equal(plan.clips[1].seqStart, plan.clips[0].seqEnd, "clipes encostados na sequência");
    assert.match(plan.script, /^Google pode ler seu Gmail\? O comentário de hoje é este\. Até amanhã\.$/);
    assert.deepEqual(cutPoints(plan, 30), [plan.clips[1].seqStart / 30, plan.clips[2].seqStart / 30]);
  });

  it("regressão A: o respiro do fecho não invade a tomada seguinte ('Até amanhã' forçado na tomada 1)", () => {
    const t1 = say("Até amanhã.", 10); // termina em 10,65
    const t2 = say("Até amanhã.", 11.05);
    const words = [...say("Oi.", 1), ...t1, ...t2];
    const file: BlocksFile = { edition: "261027", framing: FRAMING, blocks: { fecho: [{ text: "Até amanhã.", take: 1 }] } };
    const { blocks, errors } = resolveAt(file, words);
    assert.deepEqual(errors, []);
    const plan = buildSequencePlan({ ...SPEC_V, order: ["fecho"] }, blocks, [], SOURCE);
    const fim = plan.clips[plan.clips.length - 1].srcOut;
    assert.ok(fim <= t2[0].start - TAKE_DEFAULTS.guardS + 1e-9, `fecho sai em ${fim}, dentro da 2ª tomada (${t2[0].start})`);
    assert.ok(fim >= t1[t1.length - 1].end, "nunca corta a última palavra");
    // intervalo explícito que invade a palavra seguinte também é preso
    const exp: BlocksFile = { edition: "261027", framing: FRAMING, blocks: { fecho: [{ start: 9.9, end: 11.1 }] } };
    const p2 = buildSequencePlan({ ...SPEC_V, order: ["fecho"] }, resolveAt(exp, words).blocks, [], SOURCE);
    assert.ok(p2.clips[p2.clips.length - 1].srcOut <= t2[0].start - TAKE_DEFAULTS.guardS + 1e-9);
  });

  it("fecho curto (<0,6 s de fala) não some: o descarte vem depois do respiro de 0,5 s", () => {
    const { file } = blocksFixture();
    const words = [...say("Google pode ler seu Gmail?", 1), ...say("O comentário de hoje é este.", 5), ...say("Tchau.", 10)];
    file.blocks.fecho = [{ start: 10, end: 10.35 }];
    const plan = buildSequencePlan(SPEC_V, resolveAt(file, words).blocks, [], SOURCE);
    const fecho = plan.clips.filter((c) => c.block === "fecho");
    assert.equal(fecho.length, 1);
    assert.ok(fecho[0].srcOut - fecho[0].srcIn >= 0.6);
  });

  it("regressão F: item que some no corte e palavra fora dos clipes vão para dropped", () => {
    const { file, words } = blocksFixture();
    file.blocks.comentario = [{ start: 5, end: 5.4 }];
    const plan = buildSequencePlan(SPEC_V, resolveAt(file, words).blocks, [], SOURCE);
    assert.equal(plan.clips.filter((c) => c.block === "comentario").length, 0);
    assert.match(plan.dropped.join("\n"), /comentario\[0\]: some no corte/);
    // silêncio longo engolindo uma palavra do meio
    const { file: f2, words: w2 } = blocksFixture();
    const meio = w2.find((w) => w.text === "hoje")!;
    const p2 = buildSequencePlan(SPEC_V, resolveAt(f2, w2).blocks, [{ start: meio.start - 0.3, end: meio.end + 0.6 }], SOURCE);
    assert.match(p2.dropped.join("\n"), /palavra\(s\) fora dos clipes: "hoje/);
  });

  it("resolveBlocks junta os erros (intervalo além do bruto, frase sem tomada)", () => {
    const { file, words } = blocksFixture();
    file.blocks.resumo = [{ start: 5, end: 99 }, { text: "frase que não foi dita" }];
    const { errors } = resolveAt(file, words);
    assert.equal(errors.length, 2);
    assert.match(errors.join("\n"), /resumo\[0\]: end 99 além da duração/);
    assert.match(errors.join("\n"), /resumo\[1\]: nenhuma tomada completa/);
  });

  it("regressão I: xmeml bem formado, clipitems batem com o plano, Center alterna com a escala", () => {
    const { file, words } = blocksFixture();
    file.blocks.abertura = file.blocks.titulo;
    const all = resolveAt(file, words).blocks;
    const specs = defaultSequences().map((s) => ({ ...s, order: s.order.filter((k) => k in all) }));
    const plans = specs.map((s) => buildSequencePlan(s, all, [], SOURCE));
    const xml = buildXmeml(plans, SOURCE, FRAMING);
    assert.equal(XMLValidator.validate(xml), true);
    assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<!DOCTYPE xmeml>\n<xmeml version="4">/);
    const doc = new XMLParser({ ignoreAttributes: false, isArray: (n) => ["sequence", "clipitem", "parameter", "link", "filter"].includes(n) }).parse(xml);
    const seqs = doc.xmeml.sequence as Array<Record<string, any>>;
    assert.equal(seqs.length, 2);
    assert.equal(new Set(seqs.map((s) => s["@_id"])).size, 2, "ids de sequência únicos");
    assert.equal((xml.match(/<pathurl>/g) ?? []).length, 1, "o bruto é definido uma vez só");
    assert.match(xml, /<pathurl>file:\/\/localhost\/G:\/Meu%20Drive\/Work\/Mentoria%20Fluxo%20VTSD\/YouTube\/261027\/20261026_191548\.mp4<\/pathurl>/);
    seqs.forEach((s, si) => {
      const plan = plans[si];
      assert.equal(s.name, plan.spec.name);
      const vclips = s.media.video.track.clipitem as Array<Record<string, any>>;
      const aclips = s.media.audio.track.clipitem as Array<Record<string, any>>;
      assert.equal(vclips.length, plan.clips.length);
      assert.equal(aclips.length, plan.clips.length);
      vclips.forEach((v, i) => {
        const c = plan.clips[i];
        assert.deepEqual([v.start, v.end, v.in, v.out], [c.seqStart, c.seqEnd, c.frameIn, c.frameOut]);
        assert.deepEqual([aclips[i].start, aclips[i].in, aclips[i].out], [c.seqStart, c.frameIn, c.frameOut]);
        const params = (v.filter as Array<Record<string, any>>).flatMap((fl) => fl.effect.parameter as Array<Record<string, any>>);
        const scale = params.find((p) => p.parameterid === "scale")?.value;
        const center = params.find((p) => p.parameterid === "center")?.value;
        const fr = framingFor({ srcW: 3840, srcH: 2160, seqW: plan.spec.width, seqH: plan.spec.height, scalePct: c.scale, framing: FRAMING });
        assert.equal(scale, fr.scalePct);
        assert.deepEqual([center.horiz, center.vert], [fr.center.horiz, fr.center.vert]);
      });
      if (plan.spec.height > plan.spec.width && vclips.length >= 2) {
        const centerOf = (i: number) => (vclips[i].filter as Array<Record<string, any>>).flatMap((fl) => fl.effect.parameter).find((p: any) => p.parameterid === "center").value.horiz;
        assert.notEqual(centerOf(0), centerOf(1), "punch-in muda o Center junto com a escala");
      }
    });
    // #11358: o Premiere ignora o Flop do FCP7; o XML nunca leva o flip, mesmo com bruto espelhado.
    assert.equal(SOURCE.mirrored, true);
    assert.doesNotMatch(xml, /Flop/, "o flip fica para o Premiere");
    // nome com & < ' continua XML válido
    const weird = { ...SOURCE, path: "G:/Drive/a&b <c> 'd'.mp4" };
    const x2 = buildXmeml([{ ...plans[0], spec: { ...plans[0].spec, name: "Diaria comentada_Youtube_V1 & <teste>" } }], weird, FRAMING);
    assert.equal(XMLValidator.validate(x2), true);
    assert.equal(escapeXml(`a&b<c>'d"`), "a&amp;b&lt;c&gt;&apos;d&quot;");
  });

  it("nomes das sequências casam com o destino da pasta Final/ (#11222)", () => {
    const targets = defaultSequences().map((s) => videoTargetOf(`${s.name}.mp4`));
    assert.deepEqual(targets, ["youtube", "outras-redes"]);
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

describe("blocks.json e fonte única (#11208, C/L)", () => {
  const ok = { edition: "261027", blocks: { titulo: [{ text: "Oi" }], fecho: [{ start: 1, end: 2 }] } };

  it("aceita o mínimo válido e o molde com as sequências default", () => {
    assert.equal(parseBlocksFile(ok).ok, true);
    assert.equal(parseBlocksFile({ ...ok, mirrored: false, sequences: defaultSequences(), holdBlocks: ["fecho"] }).ok, true);
  });

  it("junta todos os erros de uma vez", () => {
    const r = parseBlocksFile({
      edition: "2610",
      mirrored: "sim",
      framing: { faceX: 2, eyeY: 0.5 },
      blocks: { titulo: { text: "x" }, porque_importa: [], resumo: [{ start: 5, end: 4 }, {}, { text: "a", take: 0 }] },
      holdBlocks: ["fim"],
      sequences: [
        { target: "youtube", name: "Diaria comentada_Instagram_V1", width: 1920, height: 1080, order: ["titulo"], scales: [50] },
        { target: "youtube", name: "Diaria comentada_Youtube_V1", width: 1920, height: 1080, order: ["xx"], scales: [50, -1] },
      ],
      vocabulary: [{ pattern: "(", replacement: "x" }],
    });
    assert.equal(r.ok, false);
    const e = r.ok ? "" : r.errors.join("\n");
    for (const re of [
      /edition precisa ser AAMMDD/,
      /mirrored precisa ser true\/false/,
      /framing precisa/,
      /blocks\.titulo: precisa ser uma lista/,
      /blocks\.porque_importa: bloco desconhecido/,
      /blocks\.resumo\[0\]: intervalo inválido/,
      /blocks\.resumo\[1\]: sem texto nem intervalo/,
      /blocks\.resumo\[2\]: take precisa ser inteiro/,
      /holdBlocks precisa listar blocos conhecidos/,
      /sequences\[0\]: o nome "Diaria comentada_Instagram_V1" não indica o destino youtube/,
      /sequences\[0\]: scales precisa de exatamente 2/,
      /sequences\[1\]: target youtube repetido/,
      /sequences\[1\]: order precisa listar blocos conhecidos/,
      /sequences\[1\]: scales precisa de exatamente 2 números positivos/,
      /vocabulary\[0\]: regex inválida/,
    ]) {
      assert.match(e, re);
    }
  });

  it("source.json é a fonte; blocks.json só sobrepõe mirrored e erra se divergir", () => {
    const measured: SourceInfo = { ...SOURCE };
    assert.equal(effectiveSource(measured, { mirrored: false }).source.mirrored, false);
    assert.equal(effectiveSource(measured, {}).source.mirrored, true);
    assert.equal(effectiveSource(measured, { source: { mirrored: false } }).source.mirrored, false, "legado: mirrored do source vale como override");
    const div = effectiveSource(measured, { source: { path: "G:/outro.mp4", durationS: 30, fps: 25 } });
    assert.equal(div.errors.length, 3);
    assert.match(effectiveSource({ ...measured, fps: 29.97 }).errors.join(), /não inteiro/);
  });

  it("framing: um ponto só para build e prévia, com premissa quando falta", () => {
    assert.deepEqual(effectiveFraming({}), { framing: FRAMING_261027, assumed: true });
    assert.deepEqual(effectiveFraming({ framing: FRAMING }), { framing: FRAMING, assumed: false });
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

  it("regressão G: bruto 1080p mantém a proporção da sequência (a escala sobe em vez de achatar o recorte)", () => {
    const v = framingFor({ srcW: 1920, srcH: 1080, seqW: 1080, seqH: 1920, scalePct: 115, framing: { faceX: 0.5, eyeY: 0.5 } });
    assert.ok(Math.abs(v.crop.w / v.crop.h - 1080 / 1920) < 0.01, JSON.stringify(v));
    assert.equal(v.crop.h, 1080);
    assert.ok(v.scalePct > 115);
    const h = framingFor({ srcW: 1920, srcH: 1080, seqW: 1920, seqH: 1080, scalePct: 50, framing: FRAMING_261027 });
    assert.deepEqual(h.crop, { x: 0, y: 0, w: 1920, h: 1080 });
    assert.equal(h.scalePct, 100);
    assert.equal(framingFor({ srcW: 3840, srcH: 2160, seqW: 1080, seqH: 1920, scalePct: 115, framing: FRAMING_261027 }).scalePct, 115);
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
  const vocab = loadVocab();

  it("o vocabulário vive no arquivo de config, não na lógica", () => {
    assert.ok(vocab.rules.length >= 3);
    assert.ok(vocab.aliases.some((a) => a.written === "diar.ia.br"));
    assert.match(vocab.whisper_prompt ?? "", /diar\.ia\.br/);
    const src = readFileSync(join(ROOT, "scripts/lib/diaria/video-montage.ts"), "utf8");
    assert.doesNotMatch(src, /Google Photos|Modo IA da Busca/, "termos ficam em context/video-montagem/vocabulario.json");
  });

  it("vocabulário pega termo de 2 palavras entre palavras do Whisper", () => {
    const words = say("a diária explica a inteligência personalizada no modo IA da busca do Google Fotos", 0);
    const out = applyVocabularyToWords(words, vocab.rules).map((w) => w.text).join(" ");
    assert.equal(out, "a diária explica a Inteligência Personalizada no Modo IA da Busca do Google Photos", "'diária' não é regra genérica");
    const soInsta: VocabRule[] = [{ pattern: "fotos", replacement: "Photos", targets: ["instagram"] }];
    assert.equal(applyVocabularyToWords(say("fotos", 0), soInsta, "outras-redes")[0].text, "fotos");
    assert.equal(applyVocabularyToWords(say("fotos", 0), soInsta, "instagram")[0].text, "Photos");
  });

  it("regressão E: regra que apagaria palavras é pulada sozinha, com aviso, sem derrubar as outras (#11506: juntar/separar palavras vale)", () => {
    const avisos: string[] = [];
    const rules: VocabRule[] = [{ pattern: "Google Fotos", replacement: "" }, ...vocab.rules];
    const out = applyVocabularyToWords(say("o Google Fotos e a inteligência personalizada", 0), rules, undefined, (m) => avisos.push(m));
    assert.equal(out.map((w) => w.text).join(" "), "o Google Photos e a Inteligência Personalizada");
    assert.equal(avisos.length, 1);
    assert.match(avisos[0], /Google Fotos/);
  });

  it("regressão H: 'diária' só vira diar.ia.br onde o roteiro diz diar.ia.br", () => {
    const aliases: VocabAlias[] = vocab.aliases;
    const words = say("Na diária de hoje, a rotina diária mudou.", 0);
    const out = alignPunctuationToScript(words, "Na diar.ia.br de hoje, a rotina diária mudou.", aliases).map((w) => w.text).join(" ");
    assert.equal(out, "Na diar.ia.br de hoje, a rotina diária mudou.");
    const sem = alignPunctuationToScript(say("a rotina diária mudou", 0), "a rotina diária mudou.", aliases).map((w) => w.text).join(" ");
    assert.equal(sem, "a rotina diária mudou.");
  });

  it("a pontuação segue o roteiro (o Whisper fecha frase onde o roteiro tem vírgula)", () => {
    const words = say("Chama Inteligência Personalizada. Recurso novo do Google.", 0);
    const out = alignPunctuationToScript(words, "Chama Inteligência Personalizada, recurso novo do Google.");
    assert.equal(out.map((w) => w.text).join(" "), "Chama Inteligência Personalizada, recurso novo do Google.");
  });

  it("regressão M: a cue fecha ANTES da palavra que estoura 50 caracteres", () => {
    const words = say("Palavraaaa Palavraaaa Palavraaaa Palavraaaa Palavraaaa Final", 0);
    const cues = segmentCues(words).map((c) => c.map((w) => w.text).join(" "));
    assert.ok(cues.every((t) => t.length <= 50), JSON.stringify(cues));
    assert.deepEqual(cues, ["Palavraaaa Palavraaaa Palavraaaa Palavraaaa", "Palavraaaa Final"]);
  });

  it("cues: >50 caracteres, pontuação final, vírgula depois de 30; 2 linhas perto do meio; fim = min(fim+0,3, próxima)", () => {
    const words = say("O Google pode estar usando dados do seu Gmail e das suas fotos para treinar a IA. Calma, tem jeito de desligar isso, e eu mostro como.", 0);
    const cues = segmentCues(words);
    const texts = cues.map((c) => c.map((w) => w.text).join(" "));
    assert.ok(texts.every((t) => t.length <= 50), JSON.stringify(texts));
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
    const plan = { clips: [{ block: "titulo" as const, srcIn: 1.9, srcOut: 3.2, frameIn: 57, frameOut: 96, seqStart: 30, seqEnd: 69, scale: 115 }] };
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
    assert.equal(r?.pick.name, "20261026_191548.mp4");
    assert.equal(r?.candidates.length, 1);
    const dois = pickRawSource([{ name: "a.mp4", size: 2 }, { name: "b.MOV", size: 3 }]);
    assert.equal(dois?.pick.name, "b.MOV");
    assert.equal(dois?.candidates.length, 2, "mais de um candidato: o CLI avisa listando todos");
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

describe("--xml-flop removida (#11358)", () => {
  it("build recusa a flag (também na forma --xml-flop=valor) antes de ler ou gravar qualquer coisa", async () => {
    assert.equal(await videoMontagemMain(["build", "261027", "--xml-flop"]), 2);
    assert.equal(await videoMontagemMain(["build", "261027", "--xml-flop=true"]), 2);
  });
});
