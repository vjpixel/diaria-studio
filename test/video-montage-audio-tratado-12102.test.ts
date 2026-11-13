/**
 * test/video-montage-audio-tratado-12102.test.ts — a faixa de áudio tratada
 * do `build` (#12102). O editor aplicava o Enhance do Adobe Podcast
 * (Background 0%, Speech 40%) no Premiere, e o XML entregava o áudio cru do
 * bruto (pausas a -40/-46 dB). Decisão de 04/11/2026: usar sempre, aproximando
 * com ffmpeg (`afftdn` + `agate`, limiar do silêncio medido), com os clipitem de
 * áudio do XML e a prévia apontando para a faixa tratada; o vídeo segue o bruto.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AUDIO_CLEAN,
  audioCleanArgs,
  audioCleanFilter,
  audioCleanParams,
  buildXmeml,
  previewClipArgs,
  type PlannedClip,
  type SequencePlan,
  type SequenceSpec,
  type SourceInfo,
} from "../scripts/lib/diaria/video-montage.ts";
import {
  cleanAudioFileName,
  cleanAudioKey,
  cleanAudioXmlPath,
  mergeBuildPlan,
  queueUploadIfMissing,
  renderCleanAudio,
  xmlVersionHashOf,
  type XmlBuildOptions,
} from "../scripts/video-montagem.ts";

const SOURCE: SourceInfo = { path: "G:/Meu Drive/YouTube/261103/bruto.mp4", fps: 30, durationS: 600, width: 3840, height: 2160, mirrored: false };
const FRAMING = { faceX: 0.5, eyeY: 0.5 };
const SPEC: SequenceSpec = { target: "youtube", name: "Diaria comentada_Youtube_V1", width: 1920, height: 1080, order: ["titulo", "comentario"], scales: [60, 85] };
const clip = (block: PlannedClip["block"], seqStart: number, len: number, frameIn: number): PlannedClip => ({
  block, srcIn: frameIn / 30, srcOut: (frameIn + len) / 30, frameIn, frameOut: frameIn + len, seqStart, seqEnd: seqStart + len, scale: 60,
});
const PLAN: SequencePlan = { spec: SPEC, clips: [clip("titulo", 0, 90, 300), clip("comentario", 90, 300, 900)], durationFrames: 390, script: "", missingBlocks: [], dropped: [] };
const TREATED = "G:/Meu Drive/YouTube/261103/261103_audio_tratado.wav";

describe("#12102: comando do ffmpeg da faixa tratada", () => {
  it("bruto quente da 261028 (limiar de silêncio -35 dBFS): piso do afftdn e gate 6 dB abaixo, em -41; gate suave desde o #12262", () => {
    const p = audioCleanParams(-35);
    assert.deepEqual(p, { noiseFloorDb: -41, gateThresholdDb: -41 });
    assert.equal(audioCleanFilter(p), "afftdn=nr=24:nf=-41:tn=1,agate=threshold=0.008913:range=0.316228:ratio=2:attack=50:release=400");
  });

  it("o gate fica abaixo do limiar de silêncio (consoante suave perto dele não é cortada)", () => {
    for (const t of [-45, -35, -30, -25]) assert.ok(audioCleanParams(t).gateThresholdDb <= t - 6, `limiar ${t}`);
  });

  it("piso do afftdn em -80 a -20 e gate em -70 a -20 (limiar fora da faixa é limitado)", () => {
    assert.deepEqual(audioCleanParams(-10), { noiseFloorDb: -20, gateThresholdDb: -20 });
    assert.deepEqual(audioCleanParams(-90), { noiseFloorDb: -80, gateThresholdDb: -70 });
    assert.equal(audioCleanParams(-45).noiseFloorDb, -51);
  });

  it("args: o áudio inteiro do bruto, sem vídeo, WAV PCM 16 bits mono a 48 kHz, formato explícito (grava num .part)", () => {
    const args = audioCleanArgs({ src: "C:/x/bruto.mp4", out: "C:/out/a.wav.part", filter: "F" });
    assert.deepEqual(args, ["-y", "-v", "error", "-i", "C:/x/bruto.mp4", "-map", "0:a:0", "-vn", "-af", "F", "-ac", "1", "-ar", "48000", "-c:a", "pcm_s16le", "-f", "wav", "C:/out/a.wav.part"]);
    assert.ok(!args.includes("-ss"), "sem recorte: a linha do tempo é a do bruto");
    assert.equal(AUDIO_CLEAN.sampleRate, 48000);
  });
});

describe("#12102: os clipitem de áudio do XML apontam para a faixa tratada", () => {
  it("vídeo no bruto (file-1), áudio na faixa tratada (file-audio, definida uma vez), mesmos in/out", () => {
    const xml = buildXmeml([PLAN], SOURCE, FRAMING, { audioPath: TREATED });
    const audio = xml.slice(xml.indexOf("<audio><numOutputChannels>"));
    assert.equal(audio.match(/<file id="file-audio"><name>261103_audio_tratado\.wav<\/name><pathurl>file:\/\/localhost\/G:\/Meu%20Drive\/YouTube\/261103\/261103_audio_tratado\.wav<\/pathurl>/g)?.length, 1);
    assert.equal(audio.match(/<file id="file-audio"\/>/g)?.length, 1);
    assert.doesNotMatch(audio, /file-1/);
    assert.match(audio, /<channelcount>1<\/channelcount>/);
    assert.match(audio, /<clipitem id="a2">.*<in>900<\/in><out>1200<\/out>/s);
    const video = xml.slice(xml.indexOf("<video><format>"), xml.indexOf("<audio><numOutputChannels>"));
    assert.match(video, /<file id="file-1"><name>bruto\.mp4<\/name>/);
    assert.doesNotMatch(video, /file-audio/);
  });

  it("sem faixa tratada (falha no render ou --no-audio-clean): o XML é o de antes, áudio no bruto", () => {
    const xml = buildXmeml([PLAN], SOURCE, FRAMING, {});
    assert.doesNotMatch(xml, /file-audio/);
    assert.equal(xml, buildXmeml([PLAN], SOURCE, FRAMING, { audioPath: null }));
    assert.equal(xml.slice(xml.indexOf("<audio><numOutputChannels>")).match(/<file id="file-1"\/>/g)?.length, 2);
  });

  it("caminho no XML: ao lado do bruto no Neo, com o nome da edição e a chave do tratamento", () => {
    assert.equal(cleanAudioFileName("261103", "ab12cd34"), "261103_audio_tratado-ab12cd34.wav");
    assert.equal(cleanAudioXmlPath("G:\\Meu Drive\\YouTube\\261103\\bruto.mp4", "261103", "ab12cd34"), "G:/Meu Drive/YouTube/261103/261103_audio_tratado-ab12cd34.wav");
    // A chave muda com o filtro (outro tratamento = outro arquivo, nunca o mesmo sobrescrito).
    assert.notEqual(cleanAudioKey(audioCleanFilter(audioCleanParams(-35))), cleanAudioKey(audioCleanFilter(audioCleanParams(-40))));
    assert.match(cleanAudioKey("F"), /^[0-9a-f]{8}$/);
  });

  it("versão do XML: sem faixa tratada o hash é o de antes; com ela, muda", () => {
    const base: XmlBuildOptions = { speechDetect: true, audioRefine: true, audioGain: true, titleMode: "png" };
    assert.equal(xmlVersionHashOf("h", PLAN, base), xmlVersionHashOf("h", PLAN, { ...base, audioClean: null }));
    assert.notEqual(xmlVersionHashOf("h", PLAN, base), xmlVersionHashOf("h", PLAN, { ...base, audioClean: "afftdn" }));
  });
});

describe("#12102: prévia com a faixa tratada", () => {
  it("o áudio do clipe vem da faixa tratada, nos mesmos tempos do vídeo", () => {
    const args = previewClipArgs({ src: "b.mp4", audioSrc: "t.wav", start: 10, end: 12, crop: { x: 0, y: 0, w: 100, h: 100 }, mirrored: false, fps: 30, out: "c.mp4" });
    assert.deepEqual(args.slice(3, 17), ["-ss", "10.000", "-to", "12.000", "-i", "b.mp4", "-ss", "10.000", "-to", "12.000", "-i", "t.wav", "-map", "0:v:0"]);
    assert.ok(args.includes("1:a:0"));
    assert.deepEqual(previewClipArgs({ src: "b.mp4", start: 10, end: 12, crop: { x: 0, y: 0, w: 100, h: 100 }, mirrored: false, fps: 30, out: "c.mp4" }).filter((a) => a === "-i").length, 1);
  });
});

describe("#12102: render fail-soft e reaproveitamento", () => {
  const dirs = () => {
    const root = mkdtempSync(join(tmpdir(), "audio-tratado-12102-"));
    const src = join(root, "bruto.mp4");
    writeFileSync(src, "bruto");
    return { root, src, outDir: join(root, "out"), stateDir: join(root, "state") };
  };

  const key = cleanAudioKey(audioCleanFilter(audioCleanParams(-35)));
  const name = `261103_audio_tratado-${key}.wav`;
  const input = (d: ReturnType<typeof dirs>) => ({ src: d.src, outDir: d.outDir, stateDir: d.stateDir, edition: "261103", mediaPath: SOURCE.path, thresholdDb: -35 });
  const quiet = { info: () => {}, debug: () => {} };
  /** ffmpeg de mentira: grava o arquivo de saída (o `.part`) e registra a chamada. */
  const fakeFfmpeg = (calls: string[][]) => (args: string[]) => { calls.push(args); writeFileSync(args[args.length - 1], "wav"); };

  it("ffmpeg falho: null e aviso (o build segue com o áudio cru), sem .part parcial no out dir", () => {
    const d = dirs();
    try {
      const warns: string[] = [];
      const r = renderCleanAudio(input(d), {
        ...quiet,
        ffmpeg: (args) => { writeFileSync(args[args.length - 1], "metade"); throw new Error("ffmpeg: command not found"); },
        warn: (m) => warns.push(m),
      });
      assert.equal(r, null);
      assert.equal(warns.length, 1);
      assert.match(warns[0], /áudio cru do bruto/);
      assert.match(warns[0], /ffmpeg: command not found/);
      assert.deepEqual(readdirSync(d.outDir), [], "o .part parcial foi apagado");
    } finally { rmSync(d.root, { recursive: true, force: true }); }
  });

  it("rename recusado (WAV aberto no Premiere): tenta de novo e LANÇA pedindo para fechar o projeto, sem cair no áudio cru", () => {
    const d = dirs();
    try {
      let tries = 0;
      assert.throws(
        () => renderCleanAudio(input(d), {
          ...quiet,
          ffmpeg: fakeFfmpeg([]),
          rename: () => { tries++; throw Object.assign(new Error("busy"), { code: "EBUSY" }); },
          warn: () => assert.fail("não é aviso: o build para"),
          retryMs: 1,
        }),
        /EBUSY.*feche o projeto/,
      );
      assert.equal(tries, 3);
      assert.deepEqual(readdirSync(d.outDir), [], "nem .part nem WAV pela metade");
    } finally { rmSync(d.root, { recursive: true, force: true }); }
  });

  it("rename que falha uma vez e passa na 2ª: a faixa vale", () => {
    const d = dirs();
    try {
      let tries = 0;
      const r = renderCleanAudio(input(d), {
        ...quiet,
        ffmpeg: fakeFfmpeg([]),
        rename: (a, b) => { if (++tries === 1) throw Object.assign(new Error("perm"), { code: "EPERM" }); renameSync(a, b); },
        retryMs: 1,
      });
      assert.ok(r);
      assert.ok(existsSync(join(d.outDir, name)));
    } finally { rmSync(d.root, { recursive: true, force: true }); }
  });

  it("meta que não grava: aviso, e a faixa ainda vale no XML", () => {
    const d = dirs();
    try {
      const warns: string[] = [];
      const r = renderCleanAudio(input(d), { ...quiet, ffmpeg: fakeFfmpeg([]), writeMeta: () => { throw new Error("EACCES"); }, warn: (m) => warns.push(m) });
      assert.ok(r);
      assert.equal(r.reused, false);
      assert.match(warns[0], /não será reaproveitada/);
    } finally { rmSync(d.root, { recursive: true, force: true }); }
  });

  it("sucesso + reaproveitamento: mesmo bruto e args = sem ffmpeg; outro limiar = outro arquivo", () => {
    const d = dirs();
    try {
      const calls: string[][] = [];
      const r = renderCleanAudio(input(d), { ...quiet, ffmpeg: fakeFfmpeg(calls), warn: () => assert.fail("sem aviso") });
      assert.ok(r);
      assert.equal(r.reused, false);
      assert.equal(r.xmlPath, `G:/Meu Drive/YouTube/261103/${name}`);
      assert.equal(readFileSync(join(d.outDir, name), "utf8"), "wav");
      assert.equal(calls.length, 1);
      assert.ok(calls[0].includes(audioCleanFilter(audioCleanParams(-35))));
      assert.ok(calls[0][calls[0].length - 1].endsWith(".part"));
      const again = renderCleanAudio(input(d), { ...quiet, ffmpeg: fakeFfmpeg(calls) });
      assert.deepEqual(again, { ...r, reused: true });
      assert.equal(calls.length, 1, "reaproveitou");
      const other = renderCleanAudio({ ...input(d), thresholdDb: -40 }, { ...quiet, ffmpeg: fakeFfmpeg(calls) });
      assert.equal(calls.length, 2);
      assert.notEqual(other?.path, r.path, "outro tratamento, outro arquivo");
    } finally { rmSync(d.root, { recursive: true, force: true }); }
  });

  it("bruto trocado (tamanho/mtime): renderiza de novo, sobrescrevendo com log", () => {
    const d = dirs();
    try {
      const calls: string[][] = [];
      renderCleanAudio(input(d), { ...quiet, ffmpeg: fakeFfmpeg(calls) });
      writeFileSync(d.src, "outro bruto, maior");
      const infos: string[] = [];
      const r = renderCleanAudio(input(d), { debug: () => {}, info: (m) => infos.push(m), ffmpeg: fakeFfmpeg(calls) });
      assert.equal(calls.length, 2);
      assert.equal(r?.reused, false);
      assert.ok(infos.some((m) => /sobrescrita/.test(m)), infos.join("\n"));
    } finally { rmSync(d.root, { recursive: true, force: true }); }
  });

  it("meta ilegível: renderiza de novo (com log de debug), sem quebrar", () => {
    const d = dirs();
    try {
      const calls: string[][] = [];
      renderCleanAudio(input(d), { ...quiet, ffmpeg: fakeFfmpeg(calls) });
      writeFileSync(join(d.stateDir, "audio-tratado.meta.json"), "{ quebrado");
      const debugs: string[] = [];
      const r = renderCleanAudio(input(d), { info: () => {}, debug: (m) => debugs.push(m), ffmpeg: fakeFfmpeg(calls) });
      assert.ok(r);
      assert.equal(calls.length, 2);
      assert.ok(debugs.some((m) => /ilegível/.test(m)));
    } finally { rmSync(d.root, { recursive: true, force: true }); }
  });
});

describe("#12102: upload da faixa reaproveitada no modo API", () => {
  it("entra nos pendentes só se o drive-uploads.json não registra o envio dela", () => {
    const root = mkdtempSync(join(tmpdir(), "uploads-12102-"));
    try {
      const reg = join(root, "drive-uploads.json");
      const wav = join(root, "261103_audio_tratado-ab12cd34.wav");
      assert.equal(queueUploadIfMissing(reg, wav), true);
      assert.deepEqual(JSON.parse(readFileSync(reg, "utf8")).pending, [wav]);
      assert.equal(queueUploadIfMissing(reg, wav), false, "já pendente");
      writeFileSync(reg, JSON.stringify({ files: { "261103_audio_tratado-ab12cd34.wav": { id: "x", link: null, at: "t", from: wav } }, pending: [] }));
      assert.equal(queueUploadIfMissing(reg, wav), false, "já subiu");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("#12101/#12102: o que entrou no XML fica por sequência no plan.json", () => {
  type P = Parameters<typeof mergeBuildPlan>[0]["next"]["plans"][number];
  const plan = (target: string, tag: string, height = 1080, width = 1920): P =>
    ({ spec: { name: `${target}-${tag}`, target, width, height }, clips: [], durationFrames: 0, missingBlocks: [], dropped: [], script: tag } as unknown as P);
  const base = { edition: "261103", source: {} as never, framing: {} as never, framingAssumed: false };
  const oldAudio = { path: "C:/out/old.wav", xmlPath: "G:/old.wav", filter: "old" };
  const newAudio = { path: "C:/out/new.wav", xmlPath: "G:/new.wav", filter: "new" };

  it("--seq: a reconstruída leva a faixa deste build; a mantida, a do build dela", () => {
    const prev = { ...base, hash: "H", plans: [plan("youtube", "v1"), plan("outras-redes", "v1", 1920, 1080)], builtAt: { youtube: 1, "outras-redes": 1 }, xmlAssets: { youtube: { treatedAudio: oldAudio }, "outras-redes": { treatedAudio: oldAudio } } };
    const next = { ...base, hash: "H", plans: [plan("youtube", "v2"), plan("outras-redes", "v2", 1920, 1080)], xmlAssets: { youtube: { treatedAudio: newAudio } } };
    const r = mergeBuildPlan({ next, pickedKeys: new Set(["youtube"]), prev, now: 9 });
    assert.deepEqual(r.plan.xmlAssets, { youtube: { treatedAudio: newAudio }, "outras-redes": { treatedAudio: oldAudio } });
  });

  it("entradas mudaram: a sequência defasada guarda o que entrou no XML dela (#12968)", () => {
    const prev = { ...base, hash: "OLD", plans: [plan("youtube", "v1"), plan("outras-redes", "v1", 1920, 1080)], xmlAssets: { "outras-redes": { treatedAudio: oldAudio } } };
    const next = { ...base, hash: "H", plans: [plan("youtube", "v2"), plan("outras-redes", "v2", 1920, 1080)], xmlAssets: { youtube: { treatedAudio: newAudio } } };
    const r = mergeBuildPlan({ next, pickedKeys: new Set(["youtube"]), prev, now: 9 });
    assert.deepEqual(r.plan.xmlAssets, { youtube: { treatedAudio: newAudio }, "outras-redes": { treatedAudio: oldAudio } });
    assert.deepEqual(r.stale, ["outras-redes"]);
  });
});
