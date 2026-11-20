/**
 * test/video-montagem-vinheta-som-13240.test.ts — o som a cada "." da vinheta
 * do logo (#13240, decisão do editor de 17/11/2026): o efeito de tecla Enter
 * (`publishing.video.vinheta_som`, 0,18 s) toca uma vez por ponto, em
 * +0,100 s e +0,333 s do início da vinheta (quadros 3 e 10 do MOV, 30 fps).
 *   - config: caminho e instantes, dentro da raiz do Neo; item inválido avisa;
 *   - XML: uma faixa de áudio própria com 2 clipitems, nos quadros certos, com
 *     o `pathurl` traduzido para o `premiere_root` (#12707);
 *   - ausência do arquivo/config/probe falho: `[aviso]`, motivo registrado e
 *     XML sem o efeito; sem a vinheta, aviso de que o som também ficou fora;
 *   - prévia: o efeito misturado nos mesmos instantes, sem mexer no filtro de
 *     quem não tem o efeito; o abaixamento do bruto (#13240, PR #13246) continua.
 * Tudo sintético: nenhum áudio/vídeo real, só tempos.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildXmeml,
  parseVinhetaSfxProbe,
  previewVinhetaFilter,
  vinhetaConfigFrom,
  vinhetaSfxConfigCheck,
  premiereUnsafeNameChars,
  vinhetaSfxConfigFrom,
  vinhetaSfxFrames,
  vinhetaSfxLenFrames,
  vinhetaSpan,
  vinhetaUsesMovAudio,
  type PlannedClip,
  type SequencePlan,
  type SequenceSpec,
  type SourceInfo,
  type VinhetaAsset,
  type VinhetaSfx,
} from "../scripts/lib/diaria/video-montage.ts";
import { parseXmlAudio } from "../scripts/lib/diaria/video-xml-verify.ts";
import {
  DEFAULT_DRIVE_ROOT,
  SFX_PREVIEW_CONSEQUENCE,
  loadVinhetaSfx,
  loadVinhetaSfxForDrive,
  loadVinhetaSfxForLocalRoot,
  makeDriveSession,
  runWithSfxFallback,
  vinhetaSfxAbsentFor,
  vinhetaSfxPlacedAviso,
  vinhetaSfxPremissa,
  vinhetaSfxSemVinhetaAviso,
  xmlVersionHashOf,
  type XmlBuildOptions,
} from "../scripts/video-montagem.ts";

const ROOT = join(import.meta.dirname, "..");
const config = JSON.parse(readFileSync(join(ROOT, "platform.config.json"), "utf8"));

const SOURCE: SourceInfo = { path: "I:/Meu Drive/diaria-studio-video/261117/bruto.mp4", fps: 30, durationS: 600, width: 3840, height: 2160, mirrored: false };
const FRAMING = { faceX: 0.5, eyeY: 0.5 };
const SPEC_H: SequenceSpec = { target: "youtube", name: "Diaria comentada_Youtube_V1", width: 1920, height: 1080, order: ["titulo", "abertura"], scales: [60, 85] };
const SPEC_V: SequenceSpec = { target: "outras-redes", name: "Diaria comentada_Vertical_V1", width: 1080, height: 1920, order: ["titulo", "abertura"], scales: [115, 130] };
const SFX_NAME = "vinheta-som.mp3";
const SFX: VinhetaSfx = { path: `${DEFAULT_DRIVE_ROOT}/_marca/${SFX_NAME}`, durationS: 0.182146, atS: [0.1, 0.333], audioChannels: 2, audioSampleRate: 48000 };
const VIN: VinhetaAsset = { path: `${DEFAULT_DRIVE_ROOT}/_marca/vinheta-logo-diaria.mov`, durationS: 1.3, width: 1920, height: 1080, hasAudio: false, fps: 30 };
const PROBE_OK = () => JSON.stringify({ streams: [{ codec_type: "audio", channels: 2, sample_rate: "48000" }], format: { duration: "0.182146" } });
const CFG_SOM = { publishing: { video: { vinheta_som: { path: SFX.path, at_s: [0.1, 0.333] } } } };

function clip(block: PlannedClip["block"], seqStart: number, len: number, frameIn: number): PlannedClip {
  return { block, srcIn: frameIn / 30, srcOut: (frameIn + len) / 30, frameIn, frameOut: frameIn + len, seqStart, seqEnd: seqStart + len, scale: 115 };
}
function plan(spec: SequenceSpec, clips: PlannedClip[]): SequencePlan {
  return { spec, clips, durationFrames: clips[clips.length - 1].seqEnd, script: "", missingBlocks: [], dropped: [] };
}
function audioTracks(xml: string): string[] {
  const seq = xml.slice(xml.indexOf("<sequence "), xml.indexOf("</sequence>"));
  return seq.slice(seq.indexOf("<audio><numOutputChannels>")).split("<track>").slice(1);
}
/** Sessão do Drive simulada com uma `_marca/` contendo `files` (download conta em `counter`). */
function fakeDrive(dir: string, files: Array<{ id: string; name: string }>, counter: { n: number }) {
  return makeDriveSession("261117", dir, {
    driveFetch: async (url) => {
      const u = new URL(url);
      if (u.searchParams.get("alt") === "media") { counter.n++; return new Response("mp3", { headers: { "Content-Type": "audio/mpeg" } }); }
      const q = u.searchParams.get("q") ?? "";
      if (q.includes("'root' in parents")) return Response.json({ files: [{ id: "brand", name: "_marca", mimeType: "application/vnd.google-apps.folder" }] });
      assert.match(q, /'brand' in parents/);
      return Response.json({ files: files.map((f) => ({ ...f, size: "3", modifiedTime: "2026-11-17T00:00:00Z" })) });
    },
    uploadFetch: async () => { throw new Error("não sobe"); },
  }, () => "root");
}

describe("#13240: config do som da vinheta", () => {
  it("platform.config.json: o efeito em _marca/, dentro da raiz do Neo, nos quadros 3 e 10 do MOV", () => {
    const cfg = vinhetaSfxConfigFrom(config);
    assert.ok(cfg, "publishing.video.vinheta_som ausente");
    assert.ok(cfg.path.startsWith(`${DEFAULT_DRIVE_ROOT}/_marca/`), `som fora da _marca/ da raiz do Neo: ${cfg.path}`);
    assert.ok(cfg.path.endsWith(SFX_NAME));
    assert.deepEqual(cfg.atS, [0.1, 0.333]);
    // Mesma pasta da vinheta (o build busca os dois na mesma _marca/ do Drive).
    const dirOf = (p: string) => p.slice(0, p.lastIndexOf("/"));
    assert.equal(dirOf(cfg.path), dirOf(vinhetaConfigFrom(config)!.path));
    assert.match(String(config.publishing.video.vinheta_som_note), /#13240/);
    assert.match(String(config.publishing.video.vinheta_som_note), /17\/11/);
    assert.deepEqual(vinhetaSfxConfigCheck(config).problems, [], "o config do repo não descarta nada");
    // A nota da vinheta descreve o respiro atual (1,7 s, VINHETA_BREATH_S), não o de antes do #13204.
    assert.match(String(config.publishing.video.vinheta_logo_note), /respiro de 1,7 s/);
  });

  it("caminho vazio, sem at_s ou com at_s inválido = null; instantes válidos ordenados", () => {
    const cfgOf = (v: unknown) => vinhetaSfxConfigFrom({ publishing: { video: { vinheta_som: v } } });
    assert.equal(cfgOf(undefined), null);
    assert.equal(cfgOf({ path: "  ", at_s: [0.1] }), null);
    assert.equal(cfgOf({ path: "x.mp3" }), null);
    assert.equal(cfgOf({ path: "x.mp3", at_s: [] }), null);
    assert.equal(cfgOf({ path: "x.mp3", at_s: ["0.1", -1, Number.NaN] }), null);
    assert.deepEqual(cfgOf({ path: " x.mp3 ", at_s: [0.333, "a", 0.1] }), { path: "x.mp3", atS: [0.1, 0.333] });
  });

  it("um problema por item descartado; chave presente e toda inválida diz isso, não 'sem config'", () => {
    const check = (v: unknown) => vinhetaSfxConfigCheck({ publishing: { video: { vinheta_som: v } } });
    const parcial = check({ path: "x.mp3", at_s: [0.333, "a", -1, 0.1] });
    assert.deepEqual(parcial.cfg, { path: "x.mp3", atS: [0.1, 0.333] });
    assert.equal(parcial.problems.length, 2);
    assert.match(parcial.problems[0], /at_s\[1\] = "a" descartado/);
    assert.match(parcial.problems[1], /at_s\[2\] = -1 descartado/);
    const toda = check({ path: "x.mp3", at_s: ["0.1", null] });
    assert.equal(toda.present, true);
    assert.equal(toda.cfg, null);
    assert.match(toda.problems.at(-1)!, /at_s sem nenhum instante válido \(2 item\(ns\), todos descartados\)/);
    assert.deepEqual(vinhetaSfxConfigCheck({}), { present: false, cfg: null, problems: [] });
  });

  it("#13522: nome com & ou vírgula (o mp3 da Epidemic) = sem som e aviso, nunca XML que não importa", () => {
    const epidemic = "I:/Meu Drive/diaria-studio-video/_marca/ES_Computers, Keyboard & Mouse, Keyboard, Laptop, Notebook, Return Or Enter Key Press - Epidemic Sound.mp3";
    assert.deepEqual(premiereUnsafeNameChars(epidemic), [",", "&"]);
    const check = vinhetaSfxConfigCheck({ publishing: { video: { vinheta_som: { path: epidemic, at_s: [0.1, 0.333] } } } });
    assert.equal(check.cfg, null);
    assert.match(check.problems.join("\n"), /",", "&" no nome do arquivo: o Premiere não importa o XML/);
    // Só o NOME conta: vírgula numa pasta do caminho não descarta.
    assert.deepEqual(premiereUnsafeNameChars("I:/a,b/vinheta-som.mp3"), []);
    assert.deepEqual(premiereUnsafeNameChars("C:\\a&b\\vinheta-som.mp3"), []);
    assert.deepEqual(vinhetaSfxConfigFrom({ publishing: { video: { vinheta_som: { path: "I:/x/vinheta-som.mp3", at_s: [0.1] } } } }), { path: "I:/x/vinheta-som.mp3", atS: [0.1] });
  });

  it("probe: sem áudio ou sem duração é erro; canais e taxa quando vêm", () => {
    assert.throws(() => parseVinhetaSfxProbe(JSON.stringify({ streams: [{ codec_type: "video" }], format: { duration: "1" } }), "x.mp3", [0.1]), /sem stream de áudio/);
    assert.throws(() => parseVinhetaSfxProbe(JSON.stringify({ streams: [{ codec_type: "audio" }], format: {} }), "x.mp3", [0.1]), /sem duração/);
    assert.deepEqual(parseVinhetaSfxProbe(PROBE_OK(), "x.mp3", [0.1, 0.333]), { path: "x.mp3", durationS: 0.182146, atS: [0.1, 0.333], audioChannels: 2, audioSampleRate: 48000 });
  });
});

describe("#13240: onde o efeito toca, em quadros", () => {
  it("#13522: duração arredondada para BAIXO: 0,182 s a 30 fps = 5 quadros (nunca mais mídia do que o arquivo tem); exato não desce", () => {
    assert.equal(vinhetaSfxLenFrames(0.182146, 30), 5);
    assert.equal(vinhetaSfxLenFrames(0.2, 30), 6);
    assert.equal(vinhetaSfxLenFrames(0.001, 30), 1);
  });

  it("vinheta no quadro 100: efeitos nos quadros 103 e 110 (0,100 e 0,333 s arredondados), 5 quadros cada", () => {
    assert.deepEqual(vinhetaSfxFrames({ start: 100, end: 139 }, 30, SFX, 1000), [{ start: 103, end: 108 }, { start: 110, end: 115 }]);
  });

  it("vinheta cortada no fim da sequência: o instante depois do fim fica de fora, o efeito para no fim", () => {
    assert.deepEqual(vinhetaSfxFrames({ start: 100, end: 106 }, 30, SFX, 106), [{ start: 103, end: 106 }]);
  });

  it("efeito mais longo que o intervalo: o 1º para no começo do 2º (faixa sem sobreposição)", () => {
    assert.deepEqual(vinhetaSfxFrames({ start: 0, end: 39 }, 30, { durationS: 1, atS: [0.1, 0.333] }, 1000), [{ start: 3, end: 10 }, { start: 10, end: 40 }]);
  });

  it("2 instantes que arredondam para o mesmo quadro viram 1 clipitem (e o aviso conta 1 de 2)", () => {
    const at = vinhetaSfxFrames({ start: 0, end: 39 }, 30, { durationS: 0.182146, atS: [0.1, 0.11] }, 1000);
    assert.deepEqual(at, [{ start: 3, end: 8 }]);
    assert.equal(vinhetaSfxPlacedAviso(at.length, 2), "[aviso] 1 de 2 instantes do som da vinheta fora da sequência ou no mesmo quadro (#13240)");
    assert.equal(vinhetaSfxPlacedAviso(2, 2), null);
  });
});

describe("#13240: o efeito no XML", () => {
  // Título até o quadro 90 (horizontal) / 60 (vertical); sem titleSpeechEndS a vinheta entra no fim do título.
  const H = plan(SPEC_H, [clip("titulo", 0, 90, 300), clip("abertura", 90, 300, 900)]);
  const V = plan(SPEC_V, [clip("titulo", 0, 60, 300), clip("abertura", 60, 300, 900)]);
  const MAC = "/Users/Shared/diaria-studio-video";

  it("horizontal: faixa de áudio própria com 2 clipitems, na vinheta +3 e +10 quadros, 5 quadros cada", () => {
    const span = vinhetaSpan(H, 30, VIN)!;
    const xml = buildXmeml([H], SOURCE, FRAMING, { vinheta: { ...VIN, sfx: SFX } });
    const audio = audioTracks(xml);
    assert.equal(audio.length, 2, "A1 bruto, A2 som da vinheta (o MOV não tem som)");
    const items = [...audio[1].matchAll(/<clipitem id="(vinheta-som-1-\d)"><name>vinheta-som<\/name><enabled>TRUE<\/enabled><duration>(\d+)<\/duration>[\s\S]*?<start>(\d+)<\/start><end>(\d+)<\/end><in>0<\/in><out>(\d+)<\/out>/g)];
    assert.deepEqual(items.map((m) => [m[1], Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])]), [
      ["vinheta-som-1-1", 5, span.start + 3, span.start + 8, 5],
      ["vinheta-som-1-2", 5, span.start + 10, span.start + 15, 5],
    ]);
    assert.equal(xml.match(/<file id="file-vinheta-som"><name>/g)?.length, 1, "o <file> do efeito definido uma vez");
    assert.equal(xml.match(/<file id="file-vinheta-som"\/>/g)?.length, 1, "o 2º clipitem só referencia");
    assert.match(xml, /<file id="file-vinheta-som"><name>[^<]*<\/name><pathurl>[^<]*<\/pathurl>\n<rate><timebase>30<\/timebase><ntsc>FALSE<\/ntsc><\/rate><duration>5<\/duration>/);
    assert.match(audio[1], /<channelcount>2<\/channelcount>/);
    assert.match(audio[1], /<sourcetrack><mediatype>audio<\/mediatype><trackindex>1<\/trackindex><\/sourcetrack>/);
    assert.doesNotMatch(audio[1], /<link>/, "o efeito não se liga a clipe nenhum");
  });

  it("#13522: MOV com som E efeito: o som do MOV (clique no quadro 0) fica fora; só os 2 cliques do efeito", () => {
    const xml = buildXmeml([V], SOURCE, FRAMING, { vinheta: { ...VIN, hasAudio: true, sfx: SFX } });
    const audio = audioTracks(xml);
    assert.equal(audio.length, 2, "A1 bruto, A2 efeito (sem a faixa do som do MOV)");
    assert.doesNotMatch(xml, /<clipitem id="vinheta-a1">/);
    assert.doesNotMatch(xml, /<linkclipref>vinheta-a1</);
    assert.equal(audio[1].match(/<clipitem id="vinheta-som-1-\d">/g)?.length, 2, "um clique por \".\" do logo");
    assert.equal(vinhetaUsesMovAudio({ hasAudio: true, sfx: SFX }), false);
  });

  it("#13522: MOV com som SEM efeito: o som do MOV segue na A2 com o link, como antes", () => {
    const xml = buildXmeml([V], SOURCE, FRAMING, { vinheta: { ...VIN, hasAudio: true } });
    const audio = audioTracks(xml);
    assert.equal(audio.length, 2, "A1 bruto, A2 som do MOV");
    assert.match(audio[1], /<clipitem id="vinheta-a1">/);
    assert.match(xml, /<linkclipref>vinheta-a1<\/linkclipref><mediatype>audio<\/mediatype><trackindex>2<\/trackindex>/);
    assert.equal(vinhetaUsesMovAudio({ hasAudio: true }), true);
  });

  it("#13522: nenhum clipitem do efeito pede mais quadros do que o arquivo tem (o Premiere não importava nada)", () => {
    const xml = buildXmeml([H, V], SOURCE, FRAMING, { vinheta: { ...VIN, sfx: SFX } });
    const fileLen = Number(xml.match(/<file id="file-vinheta-som"><name>[\s\S]*?<duration>(\d+)<\/duration>/)![1]);
    assert.ok(fileLen <= SFX.durationS * 30, `<file> declara ${fileLen} quadros, o arquivo tem ${SFX.durationS * 30}`);
    const real = SFX.durationS * 30;
    const clips = [...xml.matchAll(/<clipitem id="vinheta-som-[^"]+"><name>vinheta-som<\/name><enabled>TRUE<\/enabled><duration>(\d+)<\/duration>[\s\S]*?<in>(\d+)<\/in><out>(\d+)<\/out>/g)];
    assert.equal(clips.length, 4, "2 cliques por sequência (horizontal e vertical)");
    for (const m of clips) {
      assert.ok(Number(m[1]) <= real, `clipitem <duration> ${m[1]} > ${real} quadros reais`);
      assert.ok(Number(m[3]) - Number(m[2]) <= real, `out-in ${Number(m[3]) - Number(m[2])} > ${real} quadros reais`);
    }
  });

  it("pathurl traduzido para o premiere_root, com o nome do arquivo codificado (#12707)", () => {
    const xml = buildXmeml([H], SOURCE, FRAMING, { vinheta: { ...VIN, sfx: SFX }, premierePaths: { from: DEFAULT_DRIVE_ROOT, to: MAC } });
    const m = xml.match(/<file id="file-vinheta-som"><name>([^<]*)<\/name><pathurl>([^<]*)<\/pathurl>/);
    assert.ok(m);
    assert.equal(m[1], SFX_NAME.replace(/&/g, "&amp;"));
    assert.equal(m[2], `file://localhost/Users/Shared/diaria-studio-video/_marca/${encodeURIComponent(SFX_NAME)}`.replace(/&/g, "&amp;"));
    assert.doesNotMatch(m[2], /I:/);
  });

  it("sem o efeito (arquivo ausente): XML idêntico ao de antes, sem faixa extra", () => {
    const sem = buildXmeml([H], SOURCE, FRAMING, { vinheta: VIN });
    assert.doesNotMatch(sem, /vinheta-som/);
    assert.equal(audioTracks(sem).length, 1);
    // Sem vinheta, nada de efeito mesmo que o asset tivesse um.
    assert.doesNotMatch(buildXmeml([H], SOURCE, FRAMING, {}), /vinheta-som/);
  });

  it("verify-xml: parseXmlAudio lê os mesmos clipes de áudio com e sem o efeito (os do efeito não contam)", () => {
    const comTitulo: SequencePlan = { ...H, titleSpeechEndS: 12.5 };
    const sem = parseXmlAudio(buildXmeml([comTitulo], SOURCE, FRAMING, { vinheta: VIN }));
    const com = parseXmlAudio(buildXmeml([comTitulo], SOURCE, FRAMING, { vinheta: { ...VIN, sfx: SFX } }));
    assert.equal(com.clips.length, sem.clips.length);
    assert.deepEqual(com.clips, sem.clips);
  });

  it("duas sequências no mesmo XML: um clipitem por instante em cada, o <file> definido uma vez", () => {
    const xml = buildXmeml([H, V], SOURCE, FRAMING, { vinheta: { ...VIN, sfx: SFX } });
    assert.equal(xml.match(/<clipitem id="vinheta-som-1-\d">/g)?.length, 2);
    assert.equal(xml.match(/<clipitem id="vinheta-som-2-\d">/g)?.length, 2);
    assert.equal(xml.match(/<file id="file-vinheta-som"><name>/g)?.length, 1);
  });

  it("o abaixamento do bruto sob a vinheta (#13240, PR #13246) continua com o efeito", () => {
    const comTitulo: SequencePlan = { ...H, titleSpeechEndS: 12.5 };
    const xml = buildXmeml([comTitulo], SOURCE, FRAMING, { vinheta: { ...VIN, sfx: SFX } });
    assert.match(audioTracks(xml)[0], /<clipitem id="a1-2">/, "o clipe de áudio do título segue partido sob a vinheta");
  });

  it("versão do XML: o efeito muda o hash (novo _V{n})", () => {
    const base: XmlBuildOptions = { speechDetect: true, audioRefine: true, audioGain: true, titleMode: "png" };
    assert.notEqual(xmlVersionHashOf("h", H, { ...base, vinheta: { ...VIN, sfx: SFX } }), xmlVersionHashOf("h", H, { ...base, vinheta: VIN }));
  });
});

describe("#13240: arquivo ausente vira aviso, nunca falha, e o motivo fica registrado", () => {
  it("arquivo ausente nesta máquina: null + [aviso] com a consequência do build + motivo", () => {
    const warns: string[] = [];
    const absent: string[] = [];
    const s = loadVinhetaSfx({ readConfig: () => CFG_SOM, exists: () => false, probe: () => { throw new Error("não deveria medir"); }, warn: (m) => warns.push(m), onAbsent: (r) => absent.push(r) });
    assert.equal(s, null);
    assert.deepEqual(warns, [`som da vinheta não encontrado em ${SFX.path}: XML sem o som a cada ponto da vinheta, inserir à mão no Premiere (#13240)`]);
    assert.deepEqual(absent, [`som da vinheta não encontrado em ${SFX.path}`]);
  });

  it("na prévia, a consequência é 'prévia sem o som (o XML tem)', nunca 'inserir à mão no Premiere'", () => {
    const warns: string[] = [];
    loadVinhetaSfx({ readConfig: () => CFG_SOM, exists: () => false, warn: (m) => warns.push(m), consequence: SFX_PREVIEW_CONSEQUENCE });
    assert.match(warns[0], /: prévia sem o som \(o XML tem\) \(#13240\)$/);
    assert.doesNotMatch(warns[0], /Premiere/);
  });

  it("config sem vinheta_som: null + [aviso] 'sem config', sem motivo registrado (nada foi configurado)", () => {
    const warns: string[] = [];
    const absent: string[] = [];
    assert.equal(loadVinhetaSfx({ readConfig: () => ({}), warn: (m) => warns.push(m), onAbsent: (r) => absent.push(r) }), null);
    assert.match(warns[0], /sem publishing\.video\.vinheta_som/);
    assert.deepEqual(absent, []);
  });

  it("vinheta_som com todo at_s inválido: avisa cada item e diz que nenhum instante é válido, não 'sem config'", () => {
    const warns: string[] = [];
    const absent: string[] = [];
    const cfg = { publishing: { video: { vinheta_som: { path: SFX.path, at_s: ["0.1", -2] } } } };
    assert.equal(loadVinhetaSfx({ readConfig: () => cfg, warn: (m) => warns.push(m), onAbsent: (r) => absent.push(r) }), null);
    assert.ok(warns.some((w) => /at_s\[0\] = "0\.1" descartado/.test(w)));
    assert.ok(warns.some((w) => /at_s\[1\] = -2 descartado/.test(w)));
    assert.ok(warns.some((w) => /at_s sem nenhum instante válido/.test(w)));
    assert.ok(warns.every((w) => !/sem publishing\.video\.vinheta_som \(path/.test(w)));
    assert.match(absent[0], /configurado, mas sem path ou sem instante válido/);
  });

  it("item inválido com outros válidos: um [aviso] por item, e o som entra com os válidos", () => {
    const warns: string[] = [];
    const cfg = { publishing: { video: { vinheta_som: { path: SFX.path, at_s: [0.1, "x", 0.333] } } } };
    const s = loadVinhetaSfx({ readConfig: () => cfg, exists: () => true, probe: PROBE_OK, warn: (m) => warns.push(m) });
    assert.deepEqual(s?.atS, [0.1, 0.333]);
    assert.equal(warns.length, 1);
    assert.match(warns[0], /at_s\[1\] = "x" descartado/);
  });

  it("probe falho: null + [aviso]", () => {
    const warns: string[] = [];
    assert.equal(loadVinhetaSfx({ readConfig: () => CFG_SOM, exists: () => true, probe: () => { throw new Error("ffprobe quebrou"); }, warn: (m) => warns.push(m) }), null);
    assert.match(warns[0], /som da vinheta ilegível.*ffprobe quebrou/);
  });

  it("presente: o caminho do config no path (o do XML), medido no probePath", () => {
    const probed: string[] = [];
    const s = loadVinhetaSfx({ readConfig: () => CFG_SOM, exists: (p) => p === "C:/cache/x.mp3", probePath: "C:/cache/x.mp3", probe: (p) => { probed.push(p); return PROBE_OK(); }, warn: () => assert.fail("sem aviso") });
    assert.deepEqual(s, { ...SFX });
    assert.deepEqual(probed, ["C:/cache/x.mp3"]);
  });

  it("sem a vinheta: o aviso diz que o som também ficou fora, com os instantes", () => {
    assert.equal(
      vinhetaSfxSemVinhetaAviso([0.1, 0.333]),
      "[aviso] sem a vinheta, o som de tecla (+0,100 s e +0,333 s do início dela) também ficou fora: inserir os dois à mão no Premiere (#13240)",
    );
  });

  it("plan.json: o motivo do build inteiro vence o da sequência; sem motivo, nada é gravado", () => {
    assert.deepEqual(vinhetaSfxAbsentFor("sem a vinheta do logo", { h: "outro" }, "h"), { vinhetaSfx: { ausente: "sem a vinheta do logo" } });
    assert.deepEqual(vinhetaSfxAbsentFor(null, { h: "nenhum instante do som cabe na sequência" }, "h"), { vinhetaSfx: { ausente: "nenhum instante do som cabe na sequência" } });
    assert.deepEqual(vinhetaSfxAbsentFor(null, {}, "h"), {});
  });
});

describe("#13240: modo local com raiz explícita (loadVinhetaSfxForLocalRoot, #13308)", () => {
  const root = "/mnt/hd-sata/diaria-video-cache/local-root";

  it("procura em {raiz}/_marca/ antes do caminho do config", async () => {
    const s = await loadVinhetaSfxForLocalRoot(root, null, { readConfig: () => CFG_SOM, exists: (p) => p === `${root}/_marca/${SFX_NAME}`, probe: PROBE_OK, warn: () => assert.fail("sem aviso") });
    assert.equal(s?.path, `${root}/_marca/${SFX_NAME}`);
    assert.deepEqual(s?.atS, [0.1, 0.333]);
  });

  it("ausente na raiz e presente no caminho do config: copia para {raiz}/_marca/ e o XML aponta para a raiz (#13739)", async () => {
    const copies: Array<[string, string]> = [];
    const s = await loadVinhetaSfxForLocalRoot(root, null, { readConfig: () => CFG_SOM, exists: (p) => p === SFX.path, probe: PROBE_OK, warn: () => assert.fail("sem aviso"), mkdir: () => {}, copy: (a, b) => { copies.push([a, b]); } });
    assert.equal(s?.path, `${root}/_marca/${SFX_NAME}`);
    assert.deepEqual(copies, [[SFX.path, `${root}/_marca/${SFX_NAME}`]]);
  });

  it("cópia para a raiz falha: usa o do config com [aviso] explícito do caminho fora da raiz (#13739)", async () => {
    const warns: string[] = [];
    const s = await loadVinhetaSfxForLocalRoot(root, null, { readConfig: () => CFG_SOM, exists: (p) => p === SFX.path, probe: PROBE_OK, warn: (m) => warns.push(m), mkdir: () => {}, copy: () => { throw new Error("EACCES"); } });
    assert.equal(s?.path, SFX.path);
    assert.equal(warns.length, 1);
    assert.match(warns[0], /fora da raiz/);
    assert.match(warns[0], /EACCES/);
    assert.match(warns[0], /#13739/);
  });

  it("ausente nos dois e sem sessão do Drive: null + [aviso] + motivo", async () => {
    const warns: string[] = [];
    const absent: string[] = [];
    assert.equal(await loadVinhetaSfxForLocalRoot(root, null, { readConfig: () => CFG_SOM, exists: () => false, warn: (m) => warns.push(m), onAbsent: (r) => absent.push(r) }), null);
    assert.match(warns[0], /som da vinheta não encontrado em .*_marca.*#13240/);
    assert.match(absent[0], /copie o arquivo para/);
  });

  it("ausente nos dois, com o Drive: baixa da _marca/ para {raiz}/_marca/ e mede lá; falha do Drive = [aviso] + null", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vinheta-som-raiz-"));
    const counter = { n: 0 };
    try {
      const drive = fakeDrive(dir, [{ id: "som", name: SFX_NAME }], counter);
      const probed: string[] = [];
      const local = join(dir, "_marca", SFX_NAME).replace(/\\/g, "/");
      const s = await loadVinhetaSfxForLocalRoot(dir, drive, { readConfig: () => CFG_SOM, exists: () => false, probe: (p) => { probed.push(p.replace(/\\/g, "/")); return PROBE_OK(); }, warn: () => assert.fail("sem aviso") });
      assert.equal(counter.n, 1);
      assert.equal(s?.path, local, "o path é o da raiz explícita");
      assert.deepEqual(probed, [local]);
      const warns: string[] = [];
      const semArquivo = fakeDrive(dir, [], counter);
      assert.equal(await loadVinhetaSfxForLocalRoot(dir, semArquivo, { readConfig: () => CFG_SOM, exists: () => false, warn: (m) => warns.push(m) }), null);
      assert.match(warns[0], /som da vinheta no Drive: arquivo .* ausente ou duplicado em _marca\/; copie o arquivo para .*#13240/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("#13240: o efeito no modo API do Drive (loadVinhetaSfxForDrive)", () => {
  it("baixa da _marca/ para o cache, mede lá, grava o caminho do Neo no XML e reaproveita o cache", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vinheta-som-"));
    const counter = { n: 0 };
    const drive = fakeDrive(dir, [{ id: "som", name: SFX_NAME }], counter);
    try {
      const cached = join(dir, "_marca", SFX_NAME);
      const deps = {
        readConfig: () => CFG_SOM,
        exists: () => false,
        probe: (p: string) => {
          assert.equal(p, cached);
          return PROBE_OK();
        },
        warn: (m: string) => { throw new Error(m); },
      };
      const s = await loadVinhetaSfxForDrive(drive, deps);
      assert.equal(s?.path, SFX.path, "o XML grava o caminho do Neo, não o do cache");
      assert.equal(s?.localPath, cached);
      assert.deepEqual(s?.atS, [0.1, 0.333]);
      assert.equal(s?.durationS, 0.182146);
      await loadVinhetaSfxForDrive(drive, deps);
      assert.equal(counter.n, 1, "a 2ª chamada usa o cache");
      // _marca/ ausente no Drive: [aviso] e null, nunca exceção.
      const warns: string[] = [];
      drive.deps.driveFetch = async () => Response.json({ files: [] });
      assert.equal(await loadVinhetaSfxForDrive(drive, { ...deps, warn: (m) => warns.push(m) }), null);
      assert.match(warns[0], /som da vinheta no Drive: 0 pastas _marca.*#13240/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("sem sessão do Drive: cai no modo local (loadVinhetaSfx)", async () => {
    const warns: string[] = [];
    assert.equal(await loadVinhetaSfxForDrive(null, { readConfig: () => ({}), warn: (m) => warns.push(m) }), null);
    assert.match(warns[0], /sem publishing\.video\.vinheta_som/);
  });
});

describe("#13240: a [premissa] do build sobre o som", () => {
  it("diz que o som de tecla é intencional (decisão de 17/11) e pede conferir se toca nos pontos colocados, nunca se sumiu", () => {
    const p = vinhetaSfxPremissa([{ name: "Youtube", n: 2 }, { name: "Vertical", n: 2 }]);
    assert.equal(p, "[premissa] o som de tecla em cada ponto da vinheta é intencional (decisão do editor de 17/11/2026, #13240): conferir no 1º import se ele toca nos 2 pontos");
    assert.doesNotMatch(p!, /sumiu/);
  });

  it("conta os instantes colocados, não os configurados; contagens diferentes saem por sequência", () => {
    assert.match(vinhetaSfxPremissa([{ name: "Youtube", n: 1 }])!, /toca nos 1 ponto$/);
    assert.match(vinhetaSfxPremissa([{ name: "Youtube", n: 2 }, { name: "Vertical", n: 1 }, { name: "Corte", n: 0 }])!, /nos pontos colocados \(2 em Youtube, 1 em Vertical\)$/);
  });

  it("nenhum instante colocado em sequência nenhuma: sem premissa", () => {
    assert.equal(vinhetaSfxPremissa([]), null);
    assert.equal(vinhetaSfxPremissa([{ name: "Youtube", n: 0 }]), null);
  });
});

describe("#13240: o efeito na prévia", () => {
  it("2 instantes: a entrada 2 dividida em 2 cópias, cada uma atrasada, misturadas com o bruto abaixado", () => {
    const f = previewVinhetaFilter({ startS: 3, scale: 1, hasAudio: false, loudnorm: "L", duck: { startS: 3, endS: 4.3, db: -20 }, sfx: { atSeqS: [3.1, 3.333] } });
    assert.match(f, /\[0:a\]volume=-20dB:enable='between\(t,3\.000,4\.300\)'\[bru\]/);
    assert.match(f, /\[2:a\]asplit=2\[sfx0\]\[sfx1\]/);
    assert.match(f, /\[sfx0\]adelay=delays=3100:all=1,aresample=48000\[sx0\]/);
    assert.match(f, /\[sfx1\]adelay=delays=3333:all=1,aresample=48000\[sx1\]/);
    assert.match(f, /\[bru\]\[sx0\]\[sx1\]amix=inputs=3:duration=first:normalize=0,L\[aout\]$/);
  });

  it("com o som do MOV: 4 entradas na mistura; 1 instante só: sem asplit", () => {
    const f = previewVinhetaFilter({ startS: 1, scale: 1, hasAudio: true, loudnorm: "L", sfx: { atSeqS: [1.1, 1.333] } });
    assert.match(f, /\[0:a\]\[va\]\[sx0\]\[sx1\]amix=inputs=4/);
    const um = previewVinhetaFilter({ startS: 1, scale: 1, hasAudio: false, loudnorm: "L", sfx: { atSeqS: [1.1] } });
    assert.doesNotMatch(um, /asplit/);
    assert.match(um, /\[2:a\]adelay=delays=1100:all=1,aresample=48000\[sx0\];\[0:a\]\[sx0\]amix=inputs=2/);
  });

  it("sem o efeito (ou sem instante): o filtro de antes, byte a byte", () => {
    for (const hasAudio of [true, false]) {
      const base = { startS: 2, scale: 0.5, hasAudio, loudnorm: "L", duck: { startS: 2, endS: 3.3, db: -20 } };
      assert.equal(previewVinhetaFilter({ ...base, sfx: null }), previewVinhetaFilter(base));
      assert.equal(previewVinhetaFilter({ ...base, sfx: { atSeqS: [] } }), previewVinhetaFilter(base));
    }
  });

  it("a prévia usa os mesmos quadros do XML (vinheta em 1 s, 30 fps: 1,1 s e 1,333 s)", () => {
    const at = vinhetaSfxFrames({ start: 30, end: 69 }, 30, SFX, 90).map((x) => x.start / 30);
    assert.deepEqual(at.map((t) => Math.round(t * 1000)), [1100, 1333]);
  });

  it("falha só com o som: refaz sem ele e culpa o som", () => {
    const calls: boolean[] = [];
    const warns: string[] = [];
    runWithSfxFallback((withSfx) => { calls.push(withSfx); if (withSfx) throw new Error("amix quebrou\nresto"); }, true, (m) => warns.push(m));
    assert.deepEqual(calls, [true, false]);
    assert.deepEqual(warns, ["[aviso] misturar o som da vinheta na prévia falhou (amix quebrou): prévia sem o som (o XML tem) (#13240)"]);
  });

  it("falha também sem o som: o erro da 2ª sobe e o som NÃO leva a culpa", () => {
    const warns: string[] = [];
    assert.throws(
      () => runWithSfxFallback((withSfx) => { throw new Error(withSfx ? "com som" : "overlay quebrou"); }, true, (m) => warns.push(m)),
      /overlay quebrou/,
    );
    assert.deepEqual(warns, []);
  });

  it("sem som: uma tentativa só, o erro sobe direto", () => {
    const calls: boolean[] = [];
    assert.throws(() => runWithSfxFallback((withSfx) => { calls.push(withSfx); throw new Error("x"); }, false, () => assert.fail("sem aviso")), /x/);
    assert.deepEqual(calls, [false]);
  });
});
