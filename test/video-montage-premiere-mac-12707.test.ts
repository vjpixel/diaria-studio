/**
 * test/video-montage-premiere-mac-12707.test.ts
 *
 * #12707 — o XML é gerado no Neo (Drive em `G:`) e importado no Premiere de um
 * Mac. Todo `<pathurl>` saía com a raiz do Windows, e o PNG do título na V2
 * (#12091) e o MP4 do card de CTA (#12571) chegavam offline. O build agora
 * troca a raiz do Neo pela do Mac (`--premiere-root` / `publishing.video.
 * premiere_root`) em TODO `<file>` do XML, com o mesmo tradutor: bruto, áudio
 * tratado, título, vinheta e card. Sem a raiz configurada, o XML é o de antes.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ctaCardFrames, CTA_CARD_DEFAULT_SHARE, type CtaCardAsset } from "../scripts/lib/diaria/video-cta-card.ts";
import {
  buildXmeml,
  premierePath,
  premiereRootFrom,
  unmappedPremierePaths,
  type PlannedClip,
  type PremierePathMap,
  type SequencePlan,
  type SequenceSpec,
  type SourceInfo,
  type VinhetaAsset,
} from "../scripts/lib/diaria/video-montage.ts";
import { DEFAULT_DRIVE_ROOT, premierePathsLine, xmlVersionHashOf, type XmlBuildOptions } from "../scripts/video-montagem.ts";

const NEO = "G:/Meu Drive/Work/Mentoria Fluxo VTSD/YouTube";
const MAC = "/Users/pixel/Library/CloudStorage/GoogleDrive-conta@gmail.com/Meu Drive/Work/Mentoria Fluxo VTSD/YouTube";
const MAP: PremierePathMap = { from: NEO, to: MAC };

const SOURCE: SourceInfo = { path: `${NEO}/261111/bruto.mov`, fps: 30, durationS: 600, width: 3840, height: 2160, mirrored: false };
const FRAMING = { faceX: 0.5, eyeY: 0.5 };
const SPEC_V: SequenceSpec = { target: "outras-redes", name: "Diaria comentada_Vertical_V8", width: 1080, height: 1920, order: ["titulo", "abertura"], scales: [115, 130] };
const VIN: VinhetaAsset = { path: `${NEO}/_marca/vinheta-logo-diaria.mov`, durationS: 1.2, width: 1920, height: 1080, hasAudio: true };
const CARD: CtaCardAsset = {
  path: "/cache/out/261111_cta_card_vertical-20cb692b63c11a25.mp4",
  xmlPath: `${NEO}/261111/261111_cta_card_vertical-20cb692b63c11a25.mp4`,
  width: 1080,
  height: 1920,
  fps: 30,
  frames: ctaCardFrames(30),
  share: CTA_CARD_DEFAULT_SHARE,
};
const TITLE_PNG = `${NEO}/261111/261111_titulo_vertical-b522b4fd3b258a9b.png`;
const AUDIO = `${NEO}/261111/261111_audio_tratado-abc.wav`;

function clip(block: PlannedClip["block"], seqStart: number, len: number, frameIn: number): PlannedClip {
  return { block, srcIn: frameIn / 30, srcOut: (frameIn + len) / 30, frameIn, frameOut: frameIn + len, seqStart, seqEnd: seqStart + len, scale: 115 };
}
const PLAN: SequencePlan = {
  spec: SPEC_V,
  clips: [clip("titulo", 0, 60, 300), clip("abertura", 60, 300, 900)],
  durationFrames: 360,
  script: "",
  missingBlocks: [],
  dropped: [],
};

function build(map?: PremierePathMap | null): string {
  return buildXmeml([PLAN], SOURCE, FRAMING, {
    screenTitle: { text: "Título", mode: "png", pngPath: TITLE_PNG },
    vinheta: VIN,
    audioPath: AUDIO,
    ctaCard: { "outras-redes": CARD },
    premierePaths: map,
  });
}

/** `<name>` → `<pathurl>` de cada `<file>` definido no XML. */
function pathUrls(xml: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of xml.matchAll(/<file id="[^"]+"><name>([^<]+)<\/name><pathurl>([^<]+)<\/pathurl>/g)) out.set(m[1], m[2]);
  return out;
}

const MAC_URL = "file://localhost/Users/pixel/Library/CloudStorage/GoogleDrive-conta%40gmail.com/Meu%20Drive/Work/Mentoria%20Fluxo%20VTSD/YouTube";

describe("#12707: pathurl do XML com a raiz do Premiere do Mac", () => {
  it("com o mapa, os 5 arquivos (bruto, áudio, título, vinheta, card) apontam para o Mac, nenhum para G:", () => {
    const urls = pathUrls(build(MAP));
    assert.deepEqual(Object.fromEntries(urls), {
      "bruto.mov": `${MAC_URL}/261111/bruto.mov`,
      "261111_audio_tratado-abc.wav": `${MAC_URL}/261111/261111_audio_tratado-abc.wav`,
      "261111_titulo_vertical-b522b4fd3b258a9b.png": `${MAC_URL}/261111/261111_titulo_vertical-b522b4fd3b258a9b.png`,
      "vinheta-logo-diaria.mov": `${MAC_URL}/_marca/vinheta-logo-diaria.mov`,
      "261111_cta_card_vertical-20cb692b63c11a25.mp4": `${MAC_URL}/261111/261111_cta_card_vertical-20cb692b63c11a25.mp4`,
    });
    assert.doesNotMatch(build(MAP), /G:/);
  });

  it("título e card usam o mesmo tradutor do bruto: mesma pasta no Mac que o bruto", () => {
    const urls = pathUrls(build(MAP));
    const dir = (u: string) => u.slice(0, u.lastIndexOf("/"));
    const bruto = dir(urls.get("bruto.mov")!);
    assert.equal(dir(urls.get("261111_titulo_vertical-b522b4fd3b258a9b.png")!), bruto);
    assert.equal(dir(urls.get("261111_cta_card_vertical-20cb692b63c11a25.mp4")!), bruto);
  });

  it("sem mapa, o XML é o de antes (raiz do Neo, o formato que o Premiere do Windows importou)", () => {
    const urls = pathUrls(build(null));
    assert.equal(urls.get("261111_titulo_vertical-b522b4fd3b258a9b.png"), "file://localhost/G:/Meu%20Drive/Work/Mentoria%20Fluxo%20VTSD/YouTube/261111/261111_titulo_vertical-b522b4fd3b258a9b.png");
    assert.equal(urls.get("261111_cta_card_vertical-20cb692b63c11a25.mp4"), "file://localhost/G:/Meu%20Drive/Work/Mentoria%20Fluxo%20VTSD/YouTube/261111/261111_cta_card_vertical-20cb692b63c11a25.mp4");
    assert.equal(build(undefined), build(null));
  });
});

describe("#12707: premierePath", () => {
  it("troca só a raiz, sem caixa na letra do drive e com barra invertida", () => {
    assert.equal(premierePath("g:\\Meu Drive\\Work\\Mentoria Fluxo VTSD\\YouTube\\261111\\x.png", MAP), `${MAC}/261111/x.png`);
    assert.equal(premierePath(NEO, MAP), MAC);
    assert.equal(premierePath(`${NEO}/a.mov`, { from: `${NEO}/`, to: `${MAC}/` }), `${MAC}/a.mov`);
  });

  it("fora da raiz (ou prefixo que não fecha num segmento) fica igual e é listado", () => {
    assert.equal(premierePath(`${NEO}-outra/a.mov`, MAP), `${NEO}-outra/a.mov`);
    assert.equal(premierePath("D:/outro/a.mov", MAP), "D:/outro/a.mov");
    assert.deepEqual(unmappedPremierePaths([`${NEO}/a.mov`, "D:/outro/a.mov", "D:/outro/a.mov"], MAP), ["D:/outro/a.mov"]);
    assert.deepEqual(unmappedPremierePaths(["D:/outro/a.mov"], undefined), []);
  });

  it("a raiz padrão do Neo é a que o mapa troca (a vinheta do config mora nela)", () => {
    assert.equal(DEFAULT_DRIVE_ROOT, NEO);
  });
});

describe("#12707: premiereRootFrom (flag > config; off; absoluto)", () => {
  const cfg = (v: unknown) => ({ publishing: { video: { premiere_root: v } } });
  it("flag vence o config; off desliga; config sozinho vale; ausente = sem tradução", () => {
    assert.deepEqual(premiereRootFrom(`${MAC}/`, cfg("/Users/outro/YouTube")), { root: MAC, how: "flag" });
    assert.deepEqual(premiereRootFrom("off", cfg(MAC)), { root: null, how: "off" });
    assert.deepEqual(premiereRootFrom(undefined, cfg(MAC)), { root: MAC, how: "config" });
    assert.deepEqual(premiereRootFrom(undefined, cfg("  ")), { root: null, how: "none" });
    assert.deepEqual(premiereRootFrom(undefined, null), { root: null, how: "none" });
  });
  it("caminho relativo é erro explícito (nunca um pathurl quebrado em silêncio)", () => {
    assert.throws(() => premiereRootFrom("Users/pixel/YouTube", null), /absoluto/);
    assert.throws(() => premiereRootFrom(undefined, cfg("~/Google Drive/YouTube")), /absoluto/);
  });
});

describe("#12707: versão do XML e relato", () => {
  const base: XmlBuildOptions = { speechDetect: true, audioRefine: true, audioGain: true, titleMode: "png" };
  it("o mapa muda a versão (outro XML, outro _V{n}); sem mapa o hash é o de antes", () => {
    assert.notEqual(xmlVersionHashOf("h", PLAN, { ...base, premierePaths: MAP }), xmlVersionHashOf("h", PLAN, base));
    assert.equal(xmlVersionHashOf("h", PLAN, { ...base, premierePaths: null }), xmlVersionHashOf("h", PLAN, base));
  });
  it("o build diz qual raiz foi e lista o que ficou de fora", () => {
    assert.match(premierePathsLine(undefined, []), /raiz do Neo.*premiere_root/);
    assert.match(premierePathsLine(MAP, []), new RegExp(`raiz ${MAC.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.doesNotMatch(premierePathsLine(MAP, []), /\[aviso\]/);
    assert.match(premierePathsLine(MAP, ["D:/outro/a.mov"]), /\[aviso\].*D:\/outro\/a\.mov/);
  });
});
