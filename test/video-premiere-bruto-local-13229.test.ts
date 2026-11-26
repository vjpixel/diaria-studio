/**
 * test/video-premiere-bruto-local-13229.test.ts
 *
 * #13229 (decisão do editor de 25/11/2026): cópia local do bruto no Mac, fora
 * do Drive, + XML "local". O build ganha `publishing.video.premiere_bruto_root`
 * e grava `…-local.xml` ao lado do XML, com SÓ os vídeos do bruto apontando
 * para `{raiz}/{AAMMDD}/`; áudio tratado, PNGs, card e vinheta seguem no
 * `premiere_root`. O `scripts/video/prepara-bruto-mac.ts` copia o bruto do
 * Drive e limpa as cópias de edições passadas só com o original conferido.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ctaCardFrames, CTA_CARD_DEFAULT_SHARE, type CtaCardAsset } from "../scripts/lib/diaria/video-cta-card.ts";
import {
  buildXmeml,
  duplicateBrutoNames,
  localBrutoXml,
  localXmlFileName,
  premiereBrutoRootFrom,
  type PlannedClip,
  type PremierePathMap,
  type SequencePlan,
  type SourceInfo,
  type VinhetaAsset,
} from "../scripts/lib/diaria/video-montage.ts";
import { xmlFamilyOf } from "../scripts/lib/diaria/video-version-archive.ts";
import {
  brutoFilePaths,
  fileUrlToPath,
  isBrutoCandidate,
  isStable,
  mergeTargets,
  newestEditionOf,
  parseArgs,
  planCleanup,
  progressLine,
  rootsFromConfig,
  stabilityStep,
  todayAAMMDD,
  xmlTargets,
  type StabilityEntry,
} from "../scripts/video/prepara-bruto-mac.ts";

const NEO = "I:/Meu Drive/diaria-studio-video";
const MAC = "/Users/Shared/diaria-studio-video";
const LOCAL = "/Users/bruna/diaria-video-local";
const MAP: PremierePathMap = { from: NEO, to: MAC };
const ED = "261125";

const SOURCE: SourceInfo = {
  path: `${NEO}/${ED}/20261125_101010.mp4`,
  fps: 30,
  durationS: 600,
  width: 3840,
  height: 2160,
  mirrored: false,
  files: [
    { id: "a", path: `${NEO}/${ED}/20261125_101010.mp4`, offsetFrames: 0, frames: 9000, width: 3840, height: 2160, mirrored: false },
    { id: "b", path: `${NEO}/${ED}/20261125_102020 (1).mp4`, offsetFrames: 9000, frames: 9000, width: 3840, height: 2160, mirrored: false },
  ],
};
const VIN: VinhetaAsset = { path: `${NEO}/_marca/vinheta-logo-diaria.mov`, durationS: 1.2, width: 1920, height: 1080, hasAudio: true };
const CARD: CtaCardAsset = {
  path: "/cache/out/card.mp4",
  xmlPath: `${NEO}/${ED}/${ED}_cta_card_vertical-20cb692b63c11a25.mp4`,
  width: 1080,
  height: 1920,
  fps: 30,
  frames: ctaCardFrames(30),
  share: CTA_CARD_DEFAULT_SHARE,
};
function clip(block: PlannedClip["block"], seqStart: number, len: number, frameIn: number, file = 0): PlannedClip {
  return { block, file, srcIn: frameIn / 30, srcOut: (frameIn + len) / 30, frameIn, frameOut: frameIn + len, seqStart, seqEnd: seqStart + len, scale: 115 };
}
const PLAN: SequencePlan = {
  spec: { target: "outras-redes", name: "Diaria comentada_Vertical_V2", width: 1080, height: 1920, order: ["titulo", "abertura"], scales: [115, 130] },
  clips: [clip("titulo", 0, 60, 300), clip("abertura", 60, 300, 9300, 1)],
  durationFrames: 360,
  script: "",
  missingBlocks: [],
  dropped: [],
};

function normalXml(): string {
  return buildXmeml([PLAN], SOURCE, { faceX: 0.5, eyeY: 0.5 }, {
    mediaPaths: SOURCE.files!.map((f) => f.path),
    screenTitle: { text: "Título", mode: "png", pngPath: `${NEO}/${ED}/${ED}_titulo_vertical-b522b4fd3b258a9b.png` },
    vinheta: VIN,
    audioPath: `${NEO}/${ED}/${ED}_audio_tratado-abc.wav`,
    ctaCard: { "outras-redes": CARD },
    premierePaths: MAP,
  });
}

function pathUrls(xml: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of xml.matchAll(/<file id="([^"]+)"><name>[^<]+<\/name><pathurl>([^<]+)<\/pathurl>/g)) out.set(m[1], m[2]);
  return out;
}

describe("#13229: premiereBrutoRootFrom", () => {
  it("ausente ou vazia = null (o build de sempre); absoluta = sem barra final", () => {
    assert.equal(premiereBrutoRootFrom({}), null);
    assert.equal(premiereBrutoRootFrom({ publishing: { video: { premiere_bruto_root: "  " } } }), null);
    assert.equal(premiereBrutoRootFrom({ publishing: { video: { premiere_bruto_root: `${LOCAL}/` } } }), LOCAL);
  });
  it("relativa ou não texto é erro explícito", () => {
    assert.throws(() => premiereBrutoRootFrom({ publishing: { video: { premiere_bruto_root: "diaria-video-local" } } }), /absoluto/);
    assert.throws(() => premiereBrutoRootFrom({ publishing: { video: { premiere_bruto_root: 3 } } }), /texto/);
  });
});

describe("#13229: localBrutoXml (reescrita de paths)", () => {
  it("só os file-N do bruto vão para {raiz}/{AAMMDD}/; áudio, PNG, card e vinheta ficam no premiere_root", () => {
    const xml = normalXml();
    const before = pathUrls(xml);
    const { xml: local, rewritten } = localBrutoXml(xml, `${LOCAL}/${ED}`);
    const after = pathUrls(local);
    assert.deepEqual(rewritten, ["20261125_101010.mp4", "20261125_102020 (1).mp4"]);
    assert.equal(after.get("file-1"), `file://localhost${LOCAL}/${ED}/20261125_101010.mp4`);
    assert.equal(after.get("file-2"), `file://localhost${LOCAL}/${ED}/20261125_102020%20(1).mp4`);
    for (const [id, url] of before) {
      if (/^file-\d+$/.test(id)) continue;
      assert.equal(after.get(id), url, `${id} não muda`);
      assert.match(url, /^file:\/\/localhost\/Users\/Shared\/diaria-studio-video\//);
    }
    assert.ok([...before.keys()].filter((k) => !/^file-\d+$/.test(k)).length >= 4);
    // O resto do XML é idêntico: só os pathurl do bruto mudam.
    assert.equal(local.replace(/<pathurl>[^<]*<\/pathurl>/g, ""), xml.replace(/<pathurl>[^<]*<\/pathurl>/g, ""));
  });
  it("XML sem bruto (leve, #13219) não reescreve nada", () => {
    const xml = `<file id="trecho-0-0"><name>t.mp4</name><pathurl>file://localhost/x/t.mp4</pathurl></file>`;
    assert.deepEqual(localBrutoXml(xml, LOCAL), { xml, rewritten: [] });
  });
  it("o script do Mac lê de volta o destino e a origem de cada vídeo", () => {
    const xml = normalXml();
    const local = localBrutoXml(xml, `${LOCAL}/${ED}`).xml;
    const t = xmlTargets(local, xml, `${LOCAL}/${ED}`, `${MAC}/${ED}`);
    assert.deepEqual(t, [
      { name: "20261125_101010.mp4", dest: `${LOCAL}/${ED}/20261125_101010.mp4`, src: `${MAC}/${ED}/20261125_101010.mp4` },
      { name: "20261125_102020 (1).mp4", dest: `${LOCAL}/${ED}/20261125_102020 (1).mp4`, src: `${MAC}/${ED}/20261125_102020 (1).mp4` },
    ]);
  });
  it("nome do XML local é a variante -local da mesma família de versão", () => {
    assert.equal(localXmlFileName("Diaria comentada_Vertical_V2.xml"), "Diaria comentada_Vertical_V2-local.xml");
    assert.equal(xmlFamilyOf("Diaria comentada_Vertical_V2-local.xml")?.version, 2);
  });
  it("nomes repetidos do bruto são detectados", () => {
    assert.deepEqual(duplicateBrutoNames(["a/x.mp4", "b/x.mp4", "a/y.mp4"]), ["x.mp4"]);
  });
});

describe("#13229: prepara-bruto-mac (decisões puras)", () => {
  it("candidato a bruto: vídeo solto; prévia, derivado com hash, .part e oculto não", () => {
    assert.ok(isBrutoCandidate("20261125_101010.mp4"));
    assert.ok(isBrutoCandidate("WIN_20261020_21_24_22_Pro.mp4"));
    assert.ok(!isBrutoCandidate("261125 - prévia vertical.mp4"));
    assert.ok(!isBrutoCandidate("261125_cta_card_vertical-20cb692b63c11a25.mp4"));
    assert.ok(!isBrutoCandidate("x.mp4.part"));
    assert.ok(!isBrutoCandidate(".x.mp4"));
    assert.ok(!isBrutoCandidate("261125_audio_tratado-abc.wav"));
  });
  it("estável só depois de N varreduras iguais, ou com mtime antigo; tamanho 0 nunca", () => {
    let s = stabilityStep(new Map(), [{ name: "a.mp4", size: 10, mtimeMs: 1000 }]);
    const opts = { stablePolls: 3, stableAgeMs: 120_000 };
    assert.equal(isStable(s.get("a.mp4")!, 2000, opts), false);
    s = stabilityStep(s, [{ name: "a.mp4", size: 20, mtimeMs: 2000 }]);
    assert.equal(s.get("a.mp4")!.polls, 1, "cresceu: volta a 1");
    s = stabilityStep(s, [{ name: "a.mp4", size: 20, mtimeMs: 2000 }]);
    s = stabilityStep(s, [{ name: "a.mp4", size: 20, mtimeMs: 2000 }]);
    assert.equal(isStable(s.get("a.mp4")!, 3000, opts), true);
    const old: StabilityEntry = { name: "b.mp4", size: 5, mtimeMs: 0, polls: 1 };
    assert.equal(isStable(old, 200_000, opts), true, "já estava no Drive antes");
    assert.equal(isStable({ ...old, size: 0, polls: 9 }, 200_000, opts), false);
  });
  it("limpeza: apaga só edição passada com original no Drive de mesmo nome e tamanho", () => {
    const drive: Record<string, number> = {
      [`${MAC}/261120/a.mp4`]: 100,
      [`${MAC}/261120/b.mp4`]: 999,
      [`${MAC}/261116-17/c.mp4`]: 50,
      [`${MAC}/261121/p.mp4`]: 70,
    };
    const actions = planCleanup({
      today: "261125",
      current: "261125",
      localRoot: LOCAL,
      driveRoot: MAC,
      driveSize: (p) => drive[p] ?? null,
      folders: [
        { folder: "261120", files: [{ name: "a.mp4", size: 100 }, { name: "b.mp4", size: 100 }, { name: "z.mp4", size: 1 }, { name: ".DS_Store", size: 6 }] },
        { folder: "261116-17", files: [{ name: "c.mp4", size: 50 }] },
        { folder: "261121", files: [{ name: "p.mp4.part", size: 30 }, { name: ".origem.json", size: 2 }] },
        { folder: "261125", files: [{ name: "hoje.mp4", size: 1 }] },
        { folder: "261126", files: [{ name: "amanha.mp4", size: 1 }] },
        { folder: "pessoal", files: [{ name: "x.mp4", size: 1 }] },
      ],
    });
    const by = Object.fromEntries(actions.map((a) => [`${a.folder}/${a.name}`, a.action]));
    assert.deepEqual(by, {
      "261120/a.mp4": "delete",
      "261120/b.mp4": "keep",
      "261120/z.mp4": "keep",
      "261120/.DS_Store": "delete",
      "261116-17/c.mp4": "delete",
      "261121/p.mp4.part": "delete",
    });
  });
  it("limpeza confere o original pela .origem.json (bruto de outra pasta do Drive)", () => {
    const actions = planCleanup({
      today: "261125",
      current: "261125",
      localRoot: LOCAL,
      driveRoot: MAC,
      driveSize: (p) => (p === `${MAC}/261116-17/c.mp4` ? 50 : null),
      folders: [{ folder: "261117", files: [{ name: "c.mp4", size: 50 }], origins: { "c.mp4": `${MAC}/261116-17/c.mp4` } }],
    });
    assert.equal(actions[0].action, "delete");
  });
  it("edição mais nova do nome, hoje local, file URL, alvos únicos, config, args", () => {
    assert.equal(newestEditionOf("261116-17"), "261117");
    assert.equal(newestEditionOf("_marca"), null);
    assert.equal(todayAAMMDD(new Date(2026, 10, 5, 23, 59)), "261105");
    assert.equal(fileUrlToPath("file://localhost/Users/a/b%20c.mp4"), "/Users/a/b c.mp4");
    assert.equal(fileUrlToPath("file://localhost/I:/Meu%20Drive/x.mp4"), "I:/Meu Drive/x.mp4");
    assert.equal(fileUrlToPath("http://x"), null);
    assert.equal(brutoFilePaths(`<file id="file-1"><name>a</name><pathurl>file://localhost/A%26B/a.mp4</pathurl>`).get("file-1"), "/A&B/a.mp4");
    const t = { name: "a", dest: "/l/a", src: "/d/a" };
    assert.deepEqual(mergeTargets([[t], [t]]), [t]);
    assert.deepEqual(rootsFromConfig({ publishing: { video: { premiere_root: MAC, premiere_bruto_root: `${LOCAL}/` } } }), { driveRoot: MAC, localRoot: LOCAL });
    assert.deepEqual(rootsFromConfig({ publishing: { video: { premiere_root: "I:/x" } } }), { driveRoot: null, localRoot: null });
    const a = parseArgs([ED, "--dry-run", "--idle-min", "5"]);
    assert.ok(!("error" in a) && a.edition === ED && a.dryRun && a.idleMin === 5);
    assert.ok("error" in parseArgs([]));
    assert.ok("error" in parseArgs([ED, "--interval", "0"]));
    assert.match(progressLine("a.mp4", 512 * 1024 ** 2, 1024 ** 3, 10_000), /a\.mp4: 512 MB de 1,00 GB \(50%\), 51,2 MB\/s, falta 10 s/);
  });
});
