/**
 * test/video-montagem-vinheta-som-13240.test.ts — o som a cada "." da vinheta
 * do logo (#13240, decisão do editor de 17/11/2026): o efeito de tecla Enter
 * (`publishing.video.vinheta_som`, 0,18 s) toca uma vez por ponto, em
 * +0,100 s e +0,333 s do início da vinheta (quadros 3 e 10 do MOV, 30 fps).
 *   - config: caminho e instantes, dentro da raiz do Neo;
 *   - XML: uma faixa de áudio própria com 2 clipitems, nos quadros certos, com
 *     o `pathurl` traduzido para o `premiere_root` (#12707);
 *   - ausência do arquivo/config/probe falho: `[aviso]` e XML sem o efeito;
 *   - prévia: o efeito misturado nos mesmos instantes, sem mexer no filtro de
 *     quem não tem o efeito; o abaixamento do bruto (#13246) continua.
 * Tudo sintético: nenhum áudio/vídeo real, só tempos.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildXmeml,
  parseVinhetaSfxProbe,
  previewVinhetaFilter,
  vinhetaConfigFrom,
  vinhetaSfxConfigFrom,
  vinhetaSfxFrames,
  vinhetaSpan,
  type PlannedClip,
  type SequencePlan,
  type SequenceSpec,
  type SourceInfo,
  type VinhetaAsset,
  type VinhetaSfx,
} from "../scripts/lib/diaria/video-montage.ts";
import { DEFAULT_DRIVE_ROOT, loadVinhetaSfx, loadVinhetaSfxForLocalRoot, xmlVersionHashOf, type XmlBuildOptions } from "../scripts/video-montagem.ts";

const ROOT = join(import.meta.dirname, "..");
const config = JSON.parse(readFileSync(join(ROOT, "platform.config.json"), "utf8"));

const SOURCE: SourceInfo = { path: "I:/Meu Drive/diaria-studio-video/261117/bruto.mp4", fps: 30, durationS: 600, width: 3840, height: 2160, mirrored: false };
const FRAMING = { faceX: 0.5, eyeY: 0.5 };
const SPEC_H: SequenceSpec = { target: "youtube", name: "Diaria comentada_Youtube_V1", width: 1920, height: 1080, order: ["titulo", "abertura"], scales: [60, 85] };
const SPEC_V: SequenceSpec = { target: "outras-redes", name: "Diaria comentada_Vertical_V1", width: 1080, height: 1920, order: ["titulo", "abertura"], scales: [115, 130] };
const SFX_NAME = "ES_Computers, Keyboard & Mouse, Keyboard, Laptop, Notebook, Return Or Enter Key Press - Epidemic Sound.mp3";
const SFX: VinhetaSfx = { path: `${DEFAULT_DRIVE_ROOT}/_marca/${SFX_NAME}`, durationS: 0.182146, atS: [0.1, 0.333], audioChannels: 2, audioSampleRate: 48000 };
const VIN: VinhetaAsset = { path: `${DEFAULT_DRIVE_ROOT}/_marca/vinheta-logo-diaria.mov`, durationS: 1.3, width: 1920, height: 1080, hasAudio: false, fps: 30 };

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

describe("#13240: config do som da vinheta", () => {
  it("platform.config.json: o efeito em _marca/, dentro da raiz do Neo, nos quadros 3 e 10 do MOV", () => {
    const cfg = vinhetaSfxConfigFrom(config);
    assert.ok(cfg, "publishing.video.vinheta_som ausente");
    assert.ok(cfg.path.startsWith(`${DEFAULT_DRIVE_ROOT}/_marca/`), `som fora da _marca/ da raiz do Neo: ${cfg.path}`);
    assert.ok(cfg.path.endsWith(SFX_NAME));
    assert.deepEqual(cfg.atS, [0.1, 0.333]);
    // Mesma pasta da vinheta (o build busca os dois na mesma _marca/ do Drive).
    assert.equal(cfg.path.slice(0, cfg.path.lastIndexOf("/")), vinhetaConfigFrom(config)!.path.slice(0, vinhetaConfigFrom(config)!.path.lastIndexOf("/")));
    assert.match(String(config.publishing.video.vinheta_som_note), /#13240/);
    assert.match(String(config.publishing.video.vinheta_som_note), /17\/11/);
  });

  it("caminho vazio, sem at_s ou com at_s inválido = null; instantes válidos em ordem", () => {
    const cfgOf = (v: unknown) => vinhetaSfxConfigFrom({ publishing: { video: { vinheta_som: v } } });
    assert.equal(cfgOf(undefined), null);
    assert.equal(cfgOf({ path: "  ", at_s: [0.1] }), null);
    assert.equal(cfgOf({ path: "x.mp3" }), null);
    assert.equal(cfgOf({ path: "x.mp3", at_s: [] }), null);
    assert.equal(cfgOf({ path: "x.mp3", at_s: ["0.1", -1, Number.NaN] }), null);
    assert.deepEqual(cfgOf({ path: " x.mp3 ", at_s: [0.333, "a", 0.1] }), { path: "x.mp3", atS: [0.1, 0.333] });
  });

  it("probe: sem áudio ou sem duração é erro; canais e taxa quando vêm", () => {
    assert.throws(() => parseVinhetaSfxProbe(JSON.stringify({ streams: [{ codec_type: "video" }], format: { duration: "1" } }), "x.mp3", [0.1]), /sem stream de áudio/);
    assert.throws(() => parseVinhetaSfxProbe(JSON.stringify({ streams: [{ codec_type: "audio" }], format: {} }), "x.mp3", [0.1]), /sem duração/);
    assert.deepEqual(
      parseVinhetaSfxProbe(JSON.stringify({ streams: [{ codec_type: "audio", channels: 2, sample_rate: "48000" }], format: { duration: "0.182146" } }), "x.mp3", [0.1, 0.333]),
      { path: "x.mp3", durationS: 0.182146, atS: [0.1, 0.333], audioChannels: 2, audioSampleRate: 48000 },
    );
  });
});

describe("#13240: onde o efeito toca, em quadros", () => {
  it("vinheta no quadro 100: efeitos nos quadros 103 e 110 (0,100 e 0,333 s arredondados), 5 quadros cada", () => {
    assert.deepEqual(vinhetaSfxFrames({ start: 100, end: 139 }, 30, SFX, 1000), [{ start: 103, end: 108 }, { start: 110, end: 115 }]);
  });

  it("vinheta cortada no fim da sequência: o instante depois do fim fica de fora, o efeito para no fim", () => {
    assert.deepEqual(vinhetaSfxFrames({ start: 100, end: 106 }, 30, SFX, 106), [{ start: 103, end: 106 }]);
  });

  it("efeito mais longo que o intervalo: o 1º para no começo do 2º (faixa sem sobreposição)", () => {
    assert.deepEqual(vinhetaSfxFrames({ start: 0, end: 39 }, 30, { durationS: 1, atS: [0.1, 0.333] }, 1000), [{ start: 3, end: 10 }, { start: 10, end: 40 }]);
  });
});

describe("#13240: o efeito no XML", () => {
  // Título até o quadro 90 (horizontal) / 60 (vertical); sem titleSpeechEndS a vinheta entra no fim do título.
  const H = plan(SPEC_H, [clip("titulo", 0, 90, 300), clip("abertura", 90, 300, 900)]);
  const V = plan(SPEC_V, [clip("titulo", 0, 60, 300), clip("abertura", 60, 300, 900)]);
  const MAC = "/Users/Shared/diaria-studio-video";

  it("horizontal: faixa de áudio própria com 2 clipitems, na vinheta +3 e +10 quadros", () => {
    const span = vinhetaSpan(H, 30, VIN)!;
    const xml = buildXmeml([H], SOURCE, FRAMING, { vinheta: { ...VIN, sfx: SFX } });
    const audio = audioTracks(xml);
    assert.equal(audio.length, 2, "A1 bruto, A2 som da vinheta (o MOV não tem som)");
    const items = [...audio[1].matchAll(/<clipitem id="(vinheta-som-1-\d)"><name>vinheta-som<\/name>[\s\S]*?<start>(\d+)<\/start><end>(\d+)<\/end><in>0<\/in><out>(\d+)<\/out>/g)];
    assert.equal(items.length, 2);
    assert.deepEqual(items.map((m) => [m[1], Number(m[2]), Number(m[3]), Number(m[4])]), [
      ["vinheta-som-1-1", span.start + 3, span.start + 8, 5],
      ["vinheta-som-1-2", span.start + 10, span.start + 15, 5],
    ]);
    assert.equal(xml.match(/<file id="file-vinheta-som"><name>/g)?.length, 1, "o <file> do efeito definido uma vez");
    assert.equal(xml.match(/<file id="file-vinheta-som"\/>/g)?.length, 1, "o 2º clipitem só referencia");
    assert.match(audio[1], /<channelcount>2<\/channelcount>/);
    assert.match(audio[1], /<sourcetrack><mediatype>audio<\/mediatype><trackindex>1<\/trackindex><\/sourcetrack>/);
    assert.doesNotMatch(audio[1], /<link>/, "o efeito não se liga a clipe nenhum");
  });

  it("vertical e MOV com som: o efeito vem depois da faixa do som do MOV, que mantém o link na A2", () => {
    const xml = buildXmeml([V], SOURCE, FRAMING, { vinheta: { ...VIN, hasAudio: true, sfx: SFX } });
    const audio = audioTracks(xml);
    assert.equal(audio.length, 3, "A1 bruto, A2 som do MOV, A3 efeito");
    assert.match(audio[1], /<clipitem id="vinheta-a1">/);
    assert.match(audio[2], /<clipitem id="vinheta-som-1-1">/);
    assert.match(xml, /<linkclipref>vinheta-a1<\/linkclipref><mediatype>audio<\/mediatype><trackindex>2<\/trackindex>/);
  });

  it("pathurl traduzido para o premiere_root, com o nome do arquivo codificado (#12707)", () => {
    const xml = buildXmeml([H], SOURCE, FRAMING, { vinheta: { ...VIN, sfx: SFX }, premierePaths: { from: DEFAULT_DRIVE_ROOT, to: MAC } });
    const m = xml.match(/<file id="file-vinheta-som"><name>([^<]*)<\/name><pathurl>([^<]*)<\/pathurl>/);
    assert.ok(m);
    assert.equal(m[1], SFX_NAME.replace(/&/g, "&amp;"));
    assert.equal(
      m[2],
      `file://localhost/Users/Shared/diaria-studio-video/_marca/${encodeURIComponent(SFX_NAME)}`.replace(/&/g, "&amp;"),
    );
    assert.doesNotMatch(m[2], /I:/);
  });

  it("sem o efeito (arquivo ausente): XML idêntico ao de antes, sem faixa extra", () => {
    const sem = buildXmeml([H], SOURCE, FRAMING, { vinheta: VIN });
    assert.doesNotMatch(sem, /vinheta-som/);
    assert.equal(audioTracks(sem).length, 1);
    // Sem vinheta, nada de efeito mesmo que o asset tivesse um.
    assert.doesNotMatch(buildXmeml([H], SOURCE, FRAMING, {}), /vinheta-som/);
  });

  it("duas sequências no mesmo XML: um clipitem por instante em cada, o <file> definido uma vez", () => {
    const xml = buildXmeml([H, V], SOURCE, FRAMING, { vinheta: { ...VIN, sfx: SFX } });
    assert.equal(xml.match(/<clipitem id="vinheta-som-1-\d">/g)?.length, 2);
    assert.equal(xml.match(/<clipitem id="vinheta-som-2-\d">/g)?.length, 2);
    assert.equal(xml.match(/<file id="file-vinheta-som"><name>/g)?.length, 1);
  });

  it("o abaixamento do bruto sob a vinheta (#13246) continua com o efeito", () => {
    const comTitulo: SequencePlan = { ...H, titleSpeechEndS: 12.5 };
    const xml = buildXmeml([comTitulo], SOURCE, FRAMING, { vinheta: { ...VIN, sfx: SFX } });
    assert.match(audioTracks(xml)[0], /<clipitem id="a1-2">/, "o clipe de áudio do título segue partido sob a vinheta");
  });

  it("versão do XML: o efeito muda o hash (novo _V{n})", () => {
    const base: XmlBuildOptions = { speechDetect: true, audioRefine: true, audioGain: true, titleMode: "png" };
    assert.notEqual(xmlVersionHashOf("h", H, { ...base, vinheta: { ...VIN, sfx: SFX } }), xmlVersionHashOf("h", H, { ...base, vinheta: VIN }));
  });
});

describe("#13240: arquivo ausente vira aviso, nunca falha", () => {
  const cfgSom = { publishing: { video: { vinheta_som: { path: SFX.path, at_s: [0.1, 0.333] } } } };
  const probeOk = () => JSON.stringify({ streams: [{ codec_type: "audio", channels: 2, sample_rate: "48000" }], format: { duration: "0.182146" } });

  it("arquivo ausente nesta máquina: null + [aviso], sem medir", () => {
    const warns: string[] = [];
    const s = loadVinhetaSfx({ readConfig: () => cfgSom, exists: () => false, probe: () => { throw new Error("não deveria medir"); }, warn: (m) => warns.push(m) });
    assert.equal(s, null);
    assert.equal(warns.length, 1);
    assert.match(warns[0], /som da vinheta não encontrado.*#13240/);
  });

  it("config sem vinheta_som: null + [aviso]", () => {
    const warns: string[] = [];
    assert.equal(loadVinhetaSfx({ readConfig: () => ({}), warn: (m) => warns.push(m) }), null);
    assert.match(warns[0], /sem publishing\.video\.vinheta_som/);
  });

  it("probe falho: null + [aviso]", () => {
    const warns: string[] = [];
    assert.equal(loadVinhetaSfx({ readConfig: () => cfgSom, exists: () => true, probe: () => { throw new Error("ffprobe quebrou"); }, warn: (m) => warns.push(m) }), null);
    assert.match(warns[0], /som da vinheta ilegível.*ffprobe quebrou/);
  });

  it("presente: o caminho do config no path (o do XML), medido no probePath", () => {
    const probed: string[] = [];
    const s = loadVinhetaSfx({ readConfig: () => cfgSom, exists: (p) => p === "C:/cache/x.mp3", probePath: "C:/cache/x.mp3", probe: (p) => { probed.push(p); return probeOk(); }, warn: () => assert.fail("sem aviso") });
    assert.deepEqual(s, { ...SFX });
    assert.deepEqual(probed, ["C:/cache/x.mp3"]);
  });

  it("modo local com raiz explícita: procura em {raiz}/_marca/ antes do caminho do config (#13308)", async () => {
    const root = "/mnt/hd-sata/diaria-video-cache/local-root";
    const s = await loadVinhetaSfxForLocalRoot(root, null, { readConfig: () => cfgSom, exists: (p) => p === `${root}/_marca/${SFX_NAME}`, probe: probeOk, warn: () => assert.fail("sem aviso") });
    assert.equal(s?.path, `${root}/_marca/${SFX_NAME}`);
    assert.deepEqual(s?.atS, [0.1, 0.333]);
    const warns: string[] = [];
    assert.equal(await loadVinhetaSfxForLocalRoot(root, null, { readConfig: () => cfgSom, exists: () => false, warn: (m) => warns.push(m) }), null);
    assert.match(warns[0], /som da vinheta não encontrado em .*_marca.*#13240/);
  });
});

describe("#13240: o efeito na prévia", () => {
  it("2 instantes: a entrada 2 dividida em 2 cópias, cada uma atrasada, misturadas com o bruto abaixado", () => {
    const f = previewVinhetaFilter({ startS: 3, scale: 1, hasAudio: false, loudnorm: "L", duck: { startS: 3, endS: 4.3, db: -20 }, sfx: { atS: [3.1, 3.333] } });
    assert.match(f, /\[0:a\]volume=-20dB:enable='between\(t,3\.000,4\.300\)'\[bru\]/);
    assert.match(f, /\[2:a\]asplit=2\[sfx0\]\[sfx1\]/);
    assert.match(f, /\[sfx0\]adelay=delays=3100:all=1,aresample=48000\[sx0\]/);
    assert.match(f, /\[sfx1\]adelay=delays=3333:all=1,aresample=48000\[sx1\]/);
    assert.match(f, /\[bru\]\[sx0\]\[sx1\]amix=inputs=3:duration=first:normalize=0,L\[aout\]$/);
  });

  it("com o som do MOV: 4 entradas na mistura; 1 instante só: sem asplit", () => {
    const f = previewVinhetaFilter({ startS: 1, scale: 1, hasAudio: true, loudnorm: "L", sfx: { atS: [1.1, 1.333] } });
    assert.match(f, /\[0:a\]\[va\]\[sx0\]\[sx1\]amix=inputs=4/);
    const um = previewVinhetaFilter({ startS: 1, scale: 1, hasAudio: false, loudnorm: "L", sfx: { atS: [1.1] } });
    assert.doesNotMatch(um, /asplit/);
    assert.match(um, /\[2:a\]adelay=delays=1100:all=1,aresample=48000\[sx0\];\[0:a\]\[sx0\]amix=inputs=2/);
  });

  it("sem o efeito (ou sem instante): o filtro de antes, byte a byte", () => {
    for (const hasAudio of [true, false]) {
      const base = { startS: 2, scale: 0.5, hasAudio, loudnorm: "L", duck: { startS: 2, endS: 3.3, db: -20 } };
      assert.equal(previewVinhetaFilter({ ...base, sfx: null }), previewVinhetaFilter(base));
      assert.equal(previewVinhetaFilter({ ...base, sfx: { atS: [] } }), previewVinhetaFilter(base));
    }
  });

  it("a prévia usa os mesmos quadros do XML (vinheta em 1 s, 30 fps: 1,1 s e 1,333 s)", () => {
    const at = vinhetaSfxFrames({ start: 30, end: 69 }, 30, SFX, 90).map((x) => x.start / 30);
    assert.deepEqual(at.map((t) => Math.round(t * 1000)), [1100, 1333]);
  });
});
