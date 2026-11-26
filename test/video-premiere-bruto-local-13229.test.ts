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
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ctaCardFrames, CTA_CARD_DEFAULT_SHARE, type CtaCardAsset } from "../scripts/lib/diaria/video-cta-card.ts";
import {
  buildXmeml,
  duplicateBrutoNames,
  escapeXml,
  pathUrl,
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
import { parsePremiereBrutoRoot } from "../scripts/lib/diaria/premiere-bruto-root.ts";
import { writeLocalBrutoXml } from "../scripts/video-montagem.ts";
import {
  brutoFilePaths,
  fileUrlToPath,
  isBrutoCandidate,
  isInsidePath,
  isStable,
  main,
  mergeTargets,
  newestEditionOf,
  parseArgs,
  planCleanup,
  progressLine,
  readOrigins,
  recordOrigin,
  rootsFromConfig,
  runCleanup,
  stabilityStep,
  todayAAMMDD,
  validOrigins,
  xmlTargets,
  type StabilityEntry,
  type StatResult,
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
    const t = xmlTargets(local, xml, `${LOCAL}/${ED}`, `${MAC}/${ED}`).targets;
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

describe("#13229: pathurl ida e volta (build e script do Mac)", () => {
  it("& ' # % e acento sobrevivem a escapeXml + pathUrl + localBrutoXml + brutoFilePaths", () => {
    const name = "A&B 'x' #1 100% ção.mp4";
    const xml = `<file id="file-1"><name>${escapeXml(name)}</name><pathurl>${escapeXml(pathUrl(`${NEO}/${ED}/${name}`))}</pathurl>\n</file>`;
    assert.equal(brutoFilePaths(xml).get("file-1"), `${NEO}/${ED}/${name}`);
    const local = localBrutoXml(xml, `${LOCAL}/${ED}`);
    assert.deepEqual(local.rewritten, [name]);
    assert.equal(brutoFilePaths(local.xml).get("file-1"), `${LOCAL}/${ED}/${name}`);
    assert.deepEqual(xmlTargets(local.xml, xml, `${LOCAL}/${ED}`, `${MAC}/${ED}`).targets, [{ name, dest: `${LOCAL}/${ED}/${name}`, src: `${NEO}/${ED}/${name}` }]);
  });
});

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "bruto-13229-")).replace(/\\/g, "/");
}

describe("#13229: writeLocalBrutoXml (build)", () => {
  const ctxOk = { premiereBrutoDir: `${LOCAL}/${ED}`, premierePaths: MAP, edition: ED };
  function setup(xml = normalXml()): { xmlPath: string; localPath: string } {
    const d = tmp();
    const xmlPath = join(d, "Diaria comentada_Vertical_V2.xml");
    writeFileSync(xmlPath, xml);
    return { xmlPath, localPath: join(d, "Diaria comentada_Vertical_V2-local.xml") };
  }
  it("grava o -local.xml; o srt regravando o XML regrava o local junto", () => {
    const { xmlPath, localPath } = setup();
    assert.equal(writeLocalBrutoXml(ctxOk, xmlPath), localPath);
    assert.match(readFileSync(localPath, "utf8"), /diaria-video-local\/261125\/20261125_101010\.mp4/);
    writeFileSync(xmlPath, `${normalXml()}<!-- legenda #13332 -->`);
    assert.equal(writeLocalBrutoXml(ctxOk, xmlPath), localPath);
    assert.match(readFileSync(localPath, "utf8"), /legenda #13332/);
  });
  for (const [label, ctx, xml] of [
    ["sem a chave no config", { premiereBrutoDir: undefined, premierePaths: MAP, edition: ED }, undefined],
    ["sem premiere_root", { premiereBrutoDir: `${LOCAL}/${ED}`, premierePaths: undefined, edition: ED }, undefined],
    ["XML leve (sem bruto)", ctxOk, `<file id="trecho-0-0"><name>t.mp4</name><pathurl>file://localhost/x/t.mp4</pathurl></file>`],
    [
      "nome de bruto repetido",
      ctxOk,
      `<file id="file-1"><name>x.mp4</name><pathurl>file://localhost/a/x.mp4</pathurl></file><file id="file-2"><name>x.mp4</name><pathurl>file://localhost/b/x.mp4</pathurl></file>`,
    ],
  ] as const) {
    it(`${label}: não grava e apaga o -local.xml velho`, () => {
      const { xmlPath, localPath } = setup(xml);
      writeFileSync(localPath, "velho");
      assert.equal(writeLocalBrutoXml(ctx, xmlPath), null);
      assert.equal(existsSync(localPath), false);
    });
  }
  it("falha de leitura: não grava e apaga o velho", () => {
    const { xmlPath, localPath } = setup();
    writeFileSync(localPath, "velho");
    const missing = xmlPath.replace(/V2\.xml$/, "V9.xml");
    const staleOf9 = missing.replace(/\.xml$/, "-local.xml");
    writeFileSync(staleOf9, "velho");
    assert.equal(writeLocalBrutoXml(ctxOk, missing), null);
    assert.equal(existsSync(staleOf9), false);
    assert.equal(readFileSync(localPath, "utf8"), "velho", "o -local.xml de outra versão não é tocado");
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
  it("estável só depois de N varreduras iguais, ou com mtime antigo; tamanho 0 nunca; chave é o caminho completo", () => {
    const A = `${MAC}/${ED}/a.mp4`;
    let s = stabilityStep(new Map(), [{ path: A, size: 10, mtimeMs: 1000 }]);
    const opts = { stablePolls: 3, stableAgeMs: 120_000 };
    assert.equal(isStable(s.get(A)!, 2000, opts), false);
    s = stabilityStep(s, [{ path: A, size: 20, mtimeMs: 2000 }]);
    assert.equal(s.get(A)!.polls, 1, "cresceu: volta a 1");
    s = stabilityStep(s, [{ path: A, size: 20, mtimeMs: 2000 }]);
    s = stabilityStep(s, [{ path: A, size: 20, mtimeMs: 2000 }, { path: `${MAC}/261116-17/a.mp4`, size: 20, mtimeMs: 2000 }]);
    assert.equal(isStable(s.get(A)!, 3000, opts), true);
    assert.equal(s.get(`${MAC}/261116-17/a.mp4`)!.polls, 1, "mesmo nome em outra pasta não herda as voltas");
    const old: StabilityEntry = { path: "/b.mp4", size: 5, mtimeMs: 0, polls: 1 };
    assert.equal(isStable(old, 200_000, opts), true, "já estava no Drive antes");
    assert.equal(isStable({ ...old, size: 0, polls: 9 }, 200_000, opts), false);
  });
  const file = (size: number): StatResult => ({ kind: "file", size, mtimeMs: 0 });
  it("limpeza: apaga só edição passada com original de mesmo nome e tamanho; .part sem original fica; EIO fica", () => {
    const drive: Record<string, StatResult> = {
      [`${MAC}/261120/a.mp4`]: file(100),
      [`${MAC}/261120/b.mp4`]: file(999),
      [`${MAC}/261120/eio.mp4`]: { kind: "error", code: "EIO" },
      [`${MAC}/261116-17/c.mp4`]: file(50),
      [`${MAC}/261121/p.mp4`]: file(70),
    };
    const actions = planCleanup({
      today: "261125",
      current: "261125",
      localRoot: LOCAL,
      driveRoot: MAC,
      driveStat: (p) => drive[p] ?? { kind: "absent" },
      folders: [
        { folder: "261120", files: [{ name: "a.mp4", size: 100 }, { name: "b.mp4", size: 100 }, { name: "z.mp4", size: 1 }, { name: "eio.mp4", size: 1 }, { name: ".DS_Store", size: 6 }] },
        { folder: "261116-17", files: [{ name: "c.mp4", size: 50 }] },
        { folder: "261121", files: [{ name: "p.mp4.part", size: 30 }, { name: "q.mp4.part", size: 30 }, { name: ".origem.json", size: 2 }] },
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
      "261120/eio.mp4": "keep",
      "261120/.DS_Store": "delete",
      "261116-17/c.mp4": "delete",
      "261121/p.mp4.part": "delete",
      "261121/q.mp4.part": "keep",
    });
    assert.match(actions.find((a) => a.name === "eio.mp4")!.reason, /erro EIO/);
  });
  it("current diferente de hoje: reprocessar uma edição velha mantém a pasta dela", () => {
    const actions = planCleanup({ today: "261125", current: "261120", localRoot: LOCAL, driveRoot: MAC, driveStat: () => file(1), folders: [{ folder: "261120", files: [{ name: "a.mp4", size: 1 }] }, { folder: "261119", files: [{ name: "b.mp4", size: 1 }] }] });
    assert.deepEqual(actions.map((a) => `${a.folder}/${a.name}`), ["261119/b.mp4"]);
  });
  it("limpeza confere o original pela .origem.json (bruto de outra pasta do Drive)", () => {
    const actions = planCleanup({
      today: "261125",
      current: "261125",
      localRoot: LOCAL,
      driveRoot: MAC,
      driveStat: (p) => (p === `${MAC}/261116-17/c.mp4` ? file(50) : { kind: "absent" }),
      folders: [{ folder: "261117", files: [{ name: "c.mp4", size: 50 }], origins: { "c.mp4": `${MAC}/261116-17/c.mp4` } }],
    });
    assert.equal(actions[0].action, "delete");
  });
  it(".origem.json: só texto dentro do Drive (sem caixa); fora ou não texto volta ao caminho padrão", () => {
    assert.deepEqual(validOrigins({ a: `${MAC}/x/a.mp4`, b: `/users/shared/DIARIA-studio-video/y/b.mp4`, c: "/tmp/c.mp4", d: 3, e: "rel/e.mp4" }, MAC), {
      origins: { a: `${MAC}/x/a.mp4`, b: "/users/shared/DIARIA-studio-video/y/b.mp4" },
      rejected: ["c", "d", "e"],
    });
    assert.deepEqual(validOrigins([1], MAC).origins, {});
    assert.ok(isInsidePath("/Users/Shared/Diaria-Studio-Video/x", MAC));
    assert.ok(!isInsidePath("/Users/Shared/diaria-studio-video-local", MAC));
  });
  it("edição mais nova do nome (com virada de mês e de ano), hoje local, file URL, alvos únicos", () => {
    assert.equal(newestEditionOf("261116-17"), "261117");
    assert.equal(newestEditionOf("261130-01"), "261201");
    assert.equal(newestEditionOf("261231-02"), "270102");
    assert.equal(newestEditionOf("_marca"), null);
    assert.equal(newestEditionOf("261340"), null);
    assert.equal(todayAAMMDD(new Date(2026, 10, 5, 23, 59)), "261105");
    assert.equal(fileUrlToPath("file://localhost/Users/a/b%20c.mp4"), "/Users/a/b c.mp4");
    assert.equal(fileUrlToPath("file://localhost/I:/Meu%20Drive/x.mp4"), "I:/Meu Drive/x.mp4");
    assert.equal(fileUrlToPath("http://x"), null);
    const t = { name: "a", dest: "/l/a", src: "/d/a" };
    assert.deepEqual(mergeTargets([[t], [t]]), [t]);
    assert.match(progressLine("a.mp4", 512 * 1024 ** 2, 1024 ** 3, 10_000), /a\.mp4: 512 MB de 1,00 GB \(50%\), 51,2 MB\/s, falta 10 s/);
  });
  it("XML local com <file> fora da pasta local: descartado e listado", () => {
    const local = `<file id="file-1"><name>a.mp4</name><pathurl>file://localhost/outra/raiz/261125/a.mp4</pathurl></file>`;
    const r = xmlTargets(local, null, `${LOCAL}/${ED}`, `${MAC}/${ED}`);
    assert.deepEqual(r.targets, []);
    assert.deepEqual(r.discarded, ["file-1: /outra/raiz/261125/a.mp4"]);
  });
  it("um validador só para premiere_bruto_root (build e script aceitam e recusam o mesmo)", () => {
    for (const v of ["/Users/x/local/", "C:\\local", "rel", "", 3, undefined]) {
      const r = parsePremiereBrutoRoot(v);
      const cfg = { publishing: { video: { premiere_root: MAC, premiere_bruto_root: v } } };
      if ("error" in r) {
        assert.throws(() => premiereBrutoRootFrom(cfg));
        assert.equal(rootsFromConfig(cfg).localRoot, null);
        assert.equal(rootsFromConfig(cfg).errors.length, 1);
      } else {
        assert.equal(premiereBrutoRootFrom(cfg), r.ok);
        assert.equal(rootsFromConfig(cfg).localRoot, r.ok);
      }
    }
    assert.equal(premiereBrutoRootFrom({ publishing: { video: { premiere_bruto_root: "C:\\local\\" } } }), "C:/local");
  });
  it("args: --no-clean com --clean-only é erro; números validados", () => {
    const a = parseArgs([ED, "--dry-run", "--idle-min", "5"]);
    assert.ok(!("error" in a) && a.edition === ED && a.dryRun && a.idleMin === 5);
    assert.ok("error" in parseArgs([]));
    assert.ok("error" in parseArgs([ED, "--interval", "0"]));
    assert.ok("error" in parseArgs([ED, "--no-clean", "--clean-only"]));
    assert.ok("error" in parseArgs([ED, "--local-root"]));
  });
});

describe("#13229: .origem.json e limpeza no disco", () => {
  it("corrompida: avisa, guarda o arquivo ao lado e regrava (atômico)", () => {
    const d = tmp();
    writeFileSync(join(d, ".origem.json"), "{nao json");
    assert.deepEqual(readOrigins(d, MAC), { origins: {}, corrupt: true });
    recordOrigin(d, MAC, "a.mp4", `${MAC}/${ED}/a.mp4`);
    assert.deepEqual(JSON.parse(readFileSync(join(d, ".origem.json"), "utf8")), { "a.mp4": `${MAC}/${ED}/a.mp4` });
    assert.ok(readdirSync(d).some((n) => n.startsWith(".origem.json.corrompido-")));
    assert.ok(!readdirSync(d).some((n) => n.endsWith(".tmp")));
  });
  it("runCleanup: --dry-run não apaga nada; sem ele a pasta só some quando fica vazia", () => {
    const root = tmp();
    const drive = `${root}/drive`;
    const local = `${root}/local`;
    for (const p of [`${drive}/261120`, `${local}/261120`, `${local}/261119`, `${drive}/261119`]) mkdirSync(p, { recursive: true });
    writeFileSync(`${drive}/261120/a.mp4`, "abc");
    writeFileSync(`${local}/261120/a.mp4`, "abc");
    writeFileSync(`${drive}/261119/b.mp4`, "abc");
    writeFileSync(`${local}/261119/b.mp4`, "ab");
    writeFileSync(`${local}/261119/c.mp4`, "abc");
    const dry = runCleanup({ localRoot: local, driveRoot: drive, today: "261125", current: "261125", dryRun: true });
    assert.deepEqual(dry.deleted, []);
    assert.deepEqual(dry.wouldDelete, ["261120/a.mp4"]);
    assert.ok(existsSync(`${local}/261120/a.mp4`));
    const real = runCleanup({ localRoot: local, driveRoot: drive, today: "261125", current: "261125", dryRun: false });
    assert.deepEqual(real.deleted, ["261120/a.mp4"]);
    assert.deepEqual(real.removedFolders, ["261120"]);
    assert.ok(!existsSync(`${local}/261120`));
    assert.ok(existsSync(`${local}/261119/b.mp4`) && existsSync(`${local}/261119/c.mp4`), "tamanho diferente e original ausente ficam, e a pasta junto");
    assert.ok(existsSync(`${drive}/261120/a.mp4`), "o Drive nunca é tocado");
  });
});

describe("#13229: main (saídas 0/2/3)", () => {
  const silent = async (argv: string[]): Promise<number> => {
    const [log, err] = [console.log, console.error];
    console.log = () => {};
    console.error = () => {};
    try {
      return await main(argv, { now: () => new Date(2026, 10, 25, 12) });
    } finally {
      console.log = log;
      console.error = err;
    }
  };
  function roots(): { drive: string; local: string; cfg: string; base: string[] } {
    const r = tmp();
    const drive = `${r}/drive`;
    const local = `${r}/local`;
    mkdirSync(`${drive}/${ED}`, { recursive: true });
    const cfg = `${r}/nao-existe.json`;
    return { drive, local, cfg, base: [ED, "--config", cfg, "--drive-root", drive, "--local-root", local, "--once", "--stable-polls", "1", "--no-clean"] };
  }
  it("2: uso inválido, pasta local ausente, pasta local dentro do Drive", async () => {
    const { drive, cfg, base } = roots();
    assert.equal(await silent([ED, "--no-clean", "--clean-only"]), 2);
    assert.equal(await silent([ED, "--config", cfg, "--drive-root", drive, "--once"]), 2);
    assert.equal(await silent([...base, "--local-root", `${drive.toUpperCase()}/sub`]), 2);
  });
  it("0: sem XML local, o vídeo estável é copiado e conferido; .origem.json registra a origem", async () => {
    const { drive, local, base } = roots();
    writeFileSync(`${drive}/${ED}/20261125_101010.mp4`, "bruto");
    assert.equal(await silent(base), 0);
    assert.equal(readFileSync(`${local}/${ED}/20261125_101010.mp4`, "utf8"), "bruto");
    assert.equal(JSON.parse(readFileSync(`${local}/${ED}/.origem.json`, "utf8"))["20261125_101010.mp4"], `${drive}/${ED}/20261125_101010.mp4`);
  });
  it("0 com XML local (origem de outra pasta); 3 com vídeo do XML ausente; 3 com XML ilegível; 2 com XML de outra raiz", async () => {
    const { drive, local, base } = roots();
    mkdirSync(`${drive}/261116-17`);
    writeFileSync(`${drive}/261116-17/x.mp4`, "outro");
    const normal = `<file id="file-1"><name>x.mp4</name><pathurl>${pathUrl(`${drive}/261116-17/x.mp4`)}</pathurl></file>`;
    writeFileSync(`${drive}/${ED}/S_V1.xml`, normal);
    writeFileSync(`${drive}/${ED}/S_V1-local.xml`, localBrutoXml(normal, `${local}/${ED}`).xml);
    assert.equal(await silent(base), 0);
    assert.equal(readFileSync(`${local}/${ED}/x.mp4`, "utf8"), "outro");

    const b = roots();
    const n2 = `<file id="file-1"><name>y.mp4</name><pathurl>${pathUrl(`${b.drive}/${ED}/y.mp4`)}</pathurl></file>`;
    writeFileSync(`${b.drive}/${ED}/S_V1.xml`, n2);
    writeFileSync(`${b.drive}/${ED}/S_V1-local.xml`, localBrutoXml(n2, `${b.local}/${ED}`).xml);
    assert.equal(await silent(b.base), 3, "y.mp4 ainda não subiu");

    const c = roots();
    mkdirSync(`${c.drive}/${ED}/S_V1-local.xml`);
    assert.equal(await silent(c.base), 3, "XML local ilegível nunca sai 0");

    const e = roots();
    writeFileSync(`${e.drive}/${ED}/S_V1-local.xml`, localBrutoXml(n2, `/outra/raiz/${ED}`).xml);
    assert.equal(await silent(e.base), 2, "XML de outra raiz: nenhum vídeo sob a pasta local");
  });
});
