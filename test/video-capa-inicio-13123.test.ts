/**
 * test/video-capa-inicio-13123.test.ts
 *
 * #13123 (em teste, opt-in): a capa nos primeiros quadros dos verticais, para
 * as redes sem controle de capa (TikTok, Facebook, LinkedIn, Threads, X)
 * escolherem esse frame. Opção (a) da issue: o painel + gancho da capa do
 * Short sobre a fala de abertura, sem mexer no áudio. Só nas verticais; sem
 * `capaInicio` no blocks.json o build sai como antes.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import {
  CAPA_INICIO,
  capaInicioFileName,
  capaInicioFrames,
  capaInicioMsOf,
  capaInicioTrack,
  capaInicioXmlIssues,
  parseCapaInicioClip,
  previewCapaInicioArgs,
  resolveCapaInicioText,
  validateCapaInicio,
  type CapaInicioAsset,
} from "../scripts/lib/diaria/video-capa-inicio.ts";
import { buildXmeml, parseBlocksFile, type PlannedClip, type SequencePlan, type SequenceSpec, type SourceInfo } from "../scripts/lib/diaria/video-montage.ts";
import { parseXmlAudio, xmlPlanIssues } from "../scripts/lib/diaria/video-xml-verify.ts";
import { composeShortCoverOverlay } from "../scripts/lib/diaria/youtube-thumb.ts";
import { capaFramesOf, capaInicioXmlPath, renderCapaInicio, xmlVersionHashOf, type XmlBuildOptions } from "../scripts/video-montagem.ts";

const SOURCE: SourceInfo = { path: "G:/Meu Drive/YouTube/261116/bruto.mp4", fps: 30, durationS: 600, width: 3840, height: 2160, mirrored: false };
const FRAMING = { faceX: 0.5, eyeY: 0.5 };
const SPEC_H: SequenceSpec = { target: "youtube", name: "Diaria comentada_Youtube_V1", width: 1920, height: 1080, order: ["gancho", "comentario", "fecho"], scales: [60, 85] };
const SPEC_V: SequenceSpec = { target: "outras-redes", name: "Diaria comentada_Vertical_V1", width: 1080, height: 1920, order: ["gancho", "comentario", "fecho"], scales: [115, 130] };

function clip(block: PlannedClip["block"], seqStart: number, len: number, frameIn: number): PlannedClip {
  return { block, srcIn: frameIn / 30, srcOut: (frameIn + len) / 30, frameIn, frameOut: frameIn + len, seqStart, seqEnd: seqStart + len, scale: 115 };
}
function plan(spec: SequenceSpec, clips: PlannedClip[]): SequencePlan {
  return { spec, clips, durationFrames: clips.length ? clips[clips.length - 1].seqEnd : 0, script: "", missingBlocks: [], dropped: [] };
}
const asset = (over: Partial<CapaInicioAsset> = {}): CapaInicioAsset => ({
  path: "/cache/out/261116_capa_inicio-abc.png",
  xmlPath: "G:/Meu Drive/YouTube/261116/261116_capa_inicio-abc.png",
  width: 1080,
  height: 1920,
  frames: capaInicioFrames(30, CAPA_INICIO.defaultMs),
  ms: CAPA_INICIO.defaultMs,
  text: "Inventa menos?",
  ...over,
});
const pv = plan(SPEC_V, [clip("gancho", 0, 90, 300), clip("comentario", 90, 60, 900)]);
const ph = plan(SPEC_H, [clip("gancho", 0, 90, 300), clip("comentario", 90, 60, 900)]);

describe("capaInicio: opt-in e duração (#13123)", () => {
  it("default 300 ms (fim da faixa 0,2-0,3 s da issue); true liga, número é ms, ausente/false desliga", () => {
    assert.equal(CAPA_INICIO.defaultMs, 300);
    assert.equal(capaInicioMsOf(true), 300);
    assert.equal(capaInicioMsOf(500), 500);
    assert.equal(capaInicioMsOf(false), null);
    assert.equal(capaInicioMsOf(undefined), null);
  });

  it("quadros: arredonda ao quadro, pelo menos 1, nunca passa da sequência", () => {
    assert.equal(capaInicioFrames(30, 300), 9);
    assert.equal(capaInicioFrames(30, 10), 1);
    assert.equal(capaInicioFrames(30, 1000, 12), 12);
    assert.equal(capaFramesOf(undefined, 100), null);
    assert.equal(capaFramesOf({ frames: 9 }, 5), 5);
  });

  it("valida: booleano, ou inteiro de ms entre 100 e 1000", () => {
    assert.deepEqual(validateCapaInicio(undefined), []);
    assert.deepEqual(validateCapaInicio(true), []);
    assert.deepEqual(validateCapaInicio(250), []);
    for (const bad of [50, 1500, 2.5, "sim", null]) assert.equal(validateCapaInicio(bad).length, 1, String(bad));
  });

  it("blocks.json: capaInicio e capa (arquivo e sequência) entram no parse; tipos errados são erro", () => {
    const base = { edition: "261116", blocks: { gancho: [{ text: "x" }] } };
    assert.equal(parseBlocksFile({ ...base, capaInicio: true, capa: "Inventa menos?", sequences: [{ ...SPEC_V, capa: "Outra capa aqui" }] }).ok, true);
    const bad = parseBlocksFile({ ...base, capaInicio: 5000, capa: 3, sequences: [{ ...SPEC_V, capa: 1 }] });
    assert.equal(bad.ok, false);
    if (!bad.ok) {
      assert.ok(bad.errors.some((e) => /capaInicio/.test(e)), bad.errors.join("; "));
      assert.equal(bad.errors.filter((e) => /capa precisa ser texto/.test(e)).length, 2, bad.errors.join("; "));
    }
  });
});

describe("texto da capa: sequência > blocks.json > roteiro (#13123)", () => {
  const roteiro = { vertical1: "Capa do vertical um", vertical2: "Capa do guia" };
  it("a vertical da edição: capa da sequência, depois a do arquivo, depois o vertical 1 do roteiro", () => {
    assert.deepEqual(resolveCapaInicioText({ spec: { capa: " Da  sequência " }, fileCapa: "Do arquivo", roteiro, corteVertical2: "guia" }), { text: "Da sequência", how: "sequencia" });
    assert.deepEqual(resolveCapaInicioText({ spec: {}, fileCapa: "Do arquivo", roteiro, corteVertical2: "guia" }), { text: "Do arquivo", how: "blocks" });
    assert.deepEqual(resolveCapaInicioText({ spec: {}, roteiro, corteVertical2: "guia" }), { text: "Capa do vertical um", how: "roteiro-vertical1" });
    assert.deepEqual(resolveCapaInicioText({ spec: {}, roteiro: null, corteVertical2: "guia" }), { text: null });
  });

  it("o corte guia usa o vertical 2 do roteiro, nunca a capa do arquivo; outro corte sem capa própria fica sem", () => {
    assert.deepEqual(resolveCapaInicioText({ spec: { corte: "guia" }, fileCapa: "Do arquivo", roteiro, corteVertical2: "guia" }), { text: "Capa do guia", how: "roteiro-vertical2" });
    assert.deepEqual(resolveCapaInicioText({ spec: { corte: "soberana" }, fileCapa: "Do arquivo", roteiro, corteVertical2: "guia" }), { text: null });
    assert.deepEqual(resolveCapaInicioText({ spec: { corte: "soberana", capa: "IA soberana?" }, roteiro, corteVertical2: "guia" }), { text: "IA soberana?", how: "sequencia" });
  });
});

describe("XML com a capa no começo (#13123)", () => {
  it("vertical: faixa de vídeo no topo, do quadro 0 ao 9, com o PNG; o áudio e a contagem de clipes não mudam", () => {
    const xml = buildXmeml([pv], SOURCE, FRAMING, { capaInicio: { "outras-redes": asset() } });
    assert.deepEqual(parseCapaInicioClip(xml), { start: 0, end: 9 });
    assert.match(xml, /<name>capa-inicio<\/name>/);
    assert.match(xml, /261116_capa_inicio-abc\.png/);
    // A faixa da capa é a última de vídeo (por cima do bruto, do título e da vinheta).
    const capaAt = xml.indexOf('<clipitem id="capa-inicio-1">');
    assert.ok(capaAt > xml.lastIndexOf('<clipitem id="v'), "capa acima dos clipes do bruto");
    assert.ok(capaAt < xml.indexOf("<audio><numOutputChannels>"), "capa na parte de vídeo da sequência");
    assert.deepEqual(xmlPlanIssues(parseXmlAudio(xml), { clips: 2, durationFrames: pv.durationFrames }), []);
    assert.deepEqual(capaInicioXmlIssues(xml, 9), []);
  });

  it("sem capaInicio (o build de sempre) o XML não tem a faixa; o horizontal nunca leva a capa", () => {
    const plain = buildXmeml([pv], SOURCE, FRAMING, {});
    assert.equal(parseCapaInicioClip(plain), null);
    assert.deepEqual(capaInicioXmlIssues(plain, null), []);
    const h = buildXmeml([ph], SOURCE, FRAMING, { capaInicio: { youtube: asset({ width: 1920, height: 1080 }) } });
    assert.equal(parseCapaInicioClip(h), null);
  });

  it("verify-xml: capa ausente, fora do quadro 0, duração diferente ou sobrando no XML são problema", () => {
    const xml = buildXmeml([pv], SOURCE, FRAMING, { capaInicio: { "outras-redes": asset() } });
    assert.match(capaInicioXmlIssues(xml, null).join(), /plano não tem/);
    assert.match(capaInicioXmlIssues(xml, 15).join(), /9 quadros no XML, 15 no plano/);
    assert.match(capaInicioXmlIssues(buildXmeml([pv], SOURCE, FRAMING, {}), 9).join(), /ausente/);
    const shifted = xml.replace(/(<clipitem id="capa-inicio-1">[\s\S]*?)<start>0<\/start><end>9<\/end>/, "$1<start>3</start><end>12</end>");
    assert.match(capaInicioXmlIssues(shifted, 9).join(), /quadro 3/);
  });

  it("a capa curta numa sequência mais curta que ela é cortada na duração da sequência", () => {
    const short = plan(SPEC_V, [clip("gancho", 0, 5, 300)]);
    const xml = buildXmeml([short], SOURCE, FRAMING, { capaInicio: { "outras-redes": asset() } });
    assert.deepEqual(parseCapaInicioClip(xml), { start: 0, end: 5 });
  });

  it("clipitem cru: referência curta quando o <file> já foi definido; zero quadros = nada", () => {
    const rate = "<rate><timebase>30</timebase><ntsc>FALSE</ntsc></rate>";
    const full = capaInicioTrack({ asset: asset(), rate, total: 18000, id: "capa-inicio-1", fileId: "file-capa-inicio", fileDefined: false, pathurl: "file:///x.png" });
    assert.match(full, /<pathurl>file:\/\/\/x\.png<\/pathurl>/);
    const ref = capaInicioTrack({ asset: asset(), rate, total: 18000, id: "capa-inicio-2", fileId: "file-capa-inicio", fileDefined: true, pathurl: "file:///x.png" });
    assert.match(ref, /<file id="file-capa-inicio"\/>/);
    assert.equal(capaInicioTrack({ asset: asset({ frames: 0 }), rate, total: 18000, id: "c", fileId: "f", fileDefined: false, pathurl: "p" }), "");
  });

  it("a capa entra no hash da versão do XML (capa nova = _V{n} novo); sem capa o hash fica o de antes", () => {
    const opts: XmlBuildOptions = { speechDetect: true, audioRefine: true, audioGain: true, titleMode: "png" };
    const base = xmlVersionHashOf("h", pv, opts);
    assert.equal(xmlVersionHashOf("h", pv, { ...opts, capaInicio: {} }), base);
    const a = xmlVersionHashOf("h", pv, { ...opts, capaInicio: { "outras-redes": asset() } });
    assert.notEqual(a, base);
    assert.equal(xmlVersionHashOf("h", pv, { ...opts, capaInicio: { "outras-redes": asset({ path: "/outro/lugar.png" }) } }), a, "o caminho local da prévia não muda o XML");
    assert.notEqual(xmlVersionHashOf("h", pv, { ...opts, capaInicio: { "outras-redes": asset({ frames: 15 }) } }), a);
  });
});

describe("prévia e PNG da capa (#13123)", () => {
  it("ffmpeg da prévia: PNG escalado à prévia, overlay só nos primeiros quadros, áudio copiado", () => {
    const args = previewCapaInicioArgs({ input: "joined.mp4", png: "/o/capa.png", out: "joined-capa.mp4", frames: 9, width: 720, height: 1280 });
    const fc = args[args.indexOf("-filter_complex") + 1];
    assert.match(fc, /scale=720:1280/);
    assert.match(fc, /enable='lt\(n,9\)'/);
    assert.equal(args[args.indexOf("-c:a") + 1], "copy");
    assert.equal(args.at(-1), "joined-capa.mp4");
  });

  it("nome do PNG por edição, corte e hash; caminho no XML na pasta do bruto", () => {
    assert.equal(capaInicioFileName("261116", undefined, "abc"), "261116_capa_inicio-abc.png");
    assert.equal(capaInicioFileName("261116", "guia", "abc"), "261116_capa_inicio-guia-abc.png");
    assert.equal(capaInicioXmlPath("G:\\Meu Drive\\YouTube\\261116\\bruto.mp4", "x.png"), "G:/Meu Drive/YouTube/261116/x.png");
  });

  it("o PNG é transparente no alto (o rosto aparece) e tem o painel escuro na base", async () => {
    const { png } = await composeShortCoverOverlay({ hook: "Inventa menos?", width: 540, height: 960 });
    const img = sharp(png);
    const meta = await img.metadata();
    assert.equal(meta.width, 540);
    assert.equal(meta.height, 960);
    assert.equal(meta.hasAlpha, true);
    const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
    const alphaAt = (x: number, y: number) => data[(y * info.width + x) * info.channels + 3];
    assert.equal(alphaAt(270, 100), 0, "alto transparente");
    assert.ok(alphaAt(10, 940) > 200, "painel na base");
  });

  it("gancho fora de 2 a 5 palavras é recusado (mesma regra da capa do Short)", async () => {
    await assert.rejects(composeShortCoverOverlay({ hook: "Uma duas três quatro cinco seis sete" }), /palavra/);
  });

  it("renderCapaInicio grava o PNG no out dir com o hash no nome e devolve o asset do XML", async () => {
    const dir = mkdtempSync(join(tmpdir(), "capa-inicio-13123-"));
    try {
      const fake = async () => ({ png: Buffer.from("png-falso"), warnings: ["aviso x"] });
      const { asset: a, warnings } = await renderCapaInicio({ outDir: dir, mediaPath: "G:/Meu Drive/YouTube/261116/bruto.mp4", edition: "261116", corte: "guia", text: "Capa do guia", width: 1080, height: 1920, fps: 30, ms: 300, compose: fake });
      assert.deepEqual(warnings, ["aviso x"]);
      assert.equal(a.frames, 9);
      assert.match(a.xmlPath, /^G:\/Meu Drive\/YouTube\/261116\/261116_capa_inicio-guia-[0-9a-f]{16}\.png$/);
      assert.deepEqual(readdirSync(dir), [a.path.split(/[\\/]/).pop()]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
