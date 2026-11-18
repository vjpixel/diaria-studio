/**
 * test/video-version-archive-13610.test.ts (#13610)
 *
 * Pasta `arquivo/` de cada edição da pasta de vídeo: a política pura
 * (`video-version-archive.ts`), o executor no disco e num Drive FALSO
 * (`video-version-archive-io.ts`), a numeração do `build` contando o
 * arquivado (`versionPickedSequences`), o gancho fail-soft do
 * `video-montagem.ts` e o bruto/`arquivo/` fora do `transcribe` e do
 * `archive-video-brutos`. Nunca toca o Drive real.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ARCHIVE_DIR_NAME,
  archiveTargetName,
  familyOf,
  isOverwriteArchivedName,
  planEditionArchive,
  vigenteXmlNames,
  xmlFamilyOf,
  xmlReferencedNames,
  maxXmlVersionIn,
  versionOfSequenceId,
  referencedFromXmlTexts,
  stripArchivedSuffix,
  type ArchiveEntry,
} from "../scripts/lib/diaria/video-version-archive.ts";
import { archiveBeforeOverwriteLocal, archiveDriveIds, archiveEditionDrive, archiveEditionLocal, installPreviewFile, isNotOwnerTrashError, moveDriveFile, resolveArchiveFolder, xmlNamesWithArchive } from "../scripts/lib/diaria/video-version-archive-io.ts";
import { FOLDER_MIME, pickDriveBruto, type DriveEntry, type MontageDriveDeps } from "../scripts/lib/diaria/video-montage-drive.ts";
import { BRUTO_SKIP_ARCHIVE_DIR, brutoFilesOf, isBrutoFile, parseRcloneLsjson } from "../scripts/lib/diaria/video-bruto-archive.ts";
import { archiveVersionsAfter, looseFilesIn, makeDriveSession, plannedXmlVersions, uploadAll, versionPickedSequences } from "../scripts/video-montagem.ts";
import { main as archiveMain, runArchiveVersions } from "../scripts/archive-video-versions.ts";

const e = (name: string, modifiedMs: number | null = 1000, extra: Partial<ArchiveEntry> = {}): ArchiveEntry => ({ name, modifiedMs, ...extra });
const xml = (refs: string[]) =>
  `<?xml version="1.0"?><xmeml>${refs.map((r) => `<file><pathurl>file://localhost/Users/Shared/diaria-studio-video/261118/${encodeURIComponent(r)}</pathurl></file>`).join("")}</xmeml>`;

describe("família de cada arquivo (#13610)", () => {
  it("cada variante do XML é uma família própria; o nome antigo _Youtube_ também", () => {
    const k = (n: string) => xmlFamilyOf(n)?.key;
    assert.equal(k("Diaria comentada horizontal_V9.xml"), k("Diaria comentada horizontal_V1.xml"));
    assert.notEqual(k("Diaria comentada horizontal_V5-trechos.xml"), k("Diaria comentada horizontal_V9.xml"));
    assert.notEqual(k("Diaria comentada_Vertical_V10-guia.xml"), k("Diaria comentada_Vertical_V11.xml"));
    assert.notEqual(k("Diaria comentada_Vertical_V2-automacao.xml"), k("Diaria comentada_Vertical_V2.xml"));
    assert.notEqual(k("Diaria comentada_Vertical_V12 leve.xml"), k("Diaria comentada_Vertical_V12.xml"));
    assert.equal(k("Diaria comentada_Vertical_V11 leve.xml"), k("Diaria comentada_Vertical_V12 leve.xml"));
    assert.equal(k("Diaria comentada_Youtube_V3.xml"), k("Diaria comentada_Youtube_V9.xml"));
    assert.notEqual(k("Diaria comentada_Youtube_V3.xml"), k("Diaria comentada horizontal_V3.xml"));
    assert.equal(xmlFamilyOf("Diaria comentada_Vertical_V10-guia.xml")?.version, 10);
    assert.equal(xmlFamilyOf("261029 - montagem (importar no Premiere).xml"), null);
  });

  it("SRT acompanha o XML da sua versão; export e sidecar são subfamílias", () => {
    const srt = familyOf("Diaria comentada_Vertical_V2-guia - legendas.srt");
    assert.equal(srt?.kind, "srt");
    assert.equal(srt?.version, 2);
    assert.equal(srt?.xmlKey, xmlFamilyOf("Diaria comentada_Vertical_V10-guia.xml")?.key);
    const exp = familyOf("Diaria comentada horizontal_V6 - legendas do export.srt");
    assert.notEqual(exp?.key, familyOf("Diaria comentada horizontal_V6 - legendas.srt")?.key);
    assert.notEqual(familyOf("Diaria comentada horizontal_V1 - legendas do export.srt.no-plan.json")?.key, exp?.key);
    assert.equal(familyOf("261027 Vertical (Instagram) - legendas.srt"), null, "SRT sem _V{n} fica fora");
  });

  it("asset: família é o nome sem o hash; tela e trecho por id", () => {
    assert.equal(familyOf("261118_audio_tratado-2brutos.wav")?.key, familyOf("261118_audio_tratado-8c0b970d.wav")?.key);
    assert.equal(familyOf("261118_titulo_vertical-0c4153906c62e230.png")?.key, "asset:261118_titulo_vertical.png");
    assert.equal(familyOf("261118_titulo_vertical-guia-1a9ad2f449d05f1d.png")?.key, "asset:261118_titulo_vertical-guia.png");
    assert.equal(familyOf("261118_cta_card_vertical-d1841f2cb89e58ef.mp4")?.key, "asset:261118_cta_card_vertical.mp4");
    assert.notEqual(familyOf("261118_tela_H10-041f69506d61.png")?.key, familyOf("261118_tela_H10b-6286967028b7.png")?.key);
    assert.equal(familyOf("261118_trecho_H3-79ec6d68675e.mov")?.key, "asset:261118_trecho_H3.mov");
    assert.equal(familyOf("261109_cta_card_horizontal.png"), null, "sem hash: fica");
  });

  it("prévia: família é o nome inteiro, e a regravação arquiva a anterior", () => {
    assert.equal(familyOf("261118 - previa horizontal.mp4")?.kind, "preview");
    assert.notEqual(familyOf("261111 - previa youtube (com card).mp4")?.key, familyOf("261111 - previa youtube.mp4")?.key);
    assert.equal(isOverwriteArchivedName("261118 - previa vertical.mp4"), true);
    assert.equal(isOverwriteArchivedName("Diaria comentada horizontal_V9.xml"), false);
  });

  it("bruto, docs e arquivos sem versão ficam fora", () => {
    for (const n of ["20261117_181712.mp4", "VID_20261104_124252.mp4", "PXL_20261104_124252345.mp4", "WIN_20261020_21_24_22_Pro.mp4", "261118_bruto_unido-8c0b970d.mp4", "roteiro.md", "decupagem.md", "Roteiro final 261118 (3 versões).md", "Notes_261109_154421.pdf", "_origem-brutos.json", "Roteiro final 261103 (3 versões) v4.docx", "Diaria comentada_Youtube_V1.mp4"]) {
      assert.equal(familyOf(n), null, n);
    }
  });
});

describe("plano da pasta (#13610)", () => {
  const root: ArchiveEntry[] = [
    e("20261117_181712.mp4"),
    e("Diaria comentada horizontal_V8.xml", 1),
    e("Diaria comentada horizontal_V9.xml", 2),
    e("Diaria comentada horizontal_V5-trechos.xml", 1),
    e("Diaria comentada_Vertical_V10.xml"),
    e("Diaria comentada_Vertical_V11.xml"),
    e("Diaria comentada_Vertical_V9-guia.xml"),
    e("Diaria comentada_Vertical_V10-guia.xml"),
    e("Diaria comentada_Vertical_V2 - legendas.srt"),
    e("Diaria comentada_Vertical_V11 - legendas.srt"),
    e("Diaria comentada horizontal_V6 - legendas do export.srt"),
    // o mais VELHO é o referenciado: fica mesmo assim; o mais novo sem referência sai
    e("261118_audio_tratado-8c0b970d.wav", 100),
    e("261118_audio_tratado-ffffffff.wav", 900),
    e("261118_titulo_vertical-0c4153906c62e230.png", 100),
    e("261118_titulo_vertical-aaaaaaaaaaaaaaaa.png", 50),
    // família sem nenhuma referência: fica o mais novo
    e("261118_cta_card_horizontal-1111111111111111.mp4", 10),
    e("261118_cta_card_horizontal-2222222222222222.mp4", 20),
    e("261118 - previa horizontal.mp4"),
    e("Roteiro final 261118 (3 versões).md"),
    e("Final", 1, { isFolder: true }),
    e("trechos", 1, { isFolder: true }),
    e("arquivo", 1, { isFolder: true }),
    e("_superadas", 1, { isFolder: true, id: "sup" }),
  ];
  const referenced = new Set(["261118_audio_tratado-8c0b970d.wav", "261118_titulo_vertical-0c4153906c62e230.png", "20261117_181712.mp4"]);

  it("fica a última versão de cada família; variantes não se misturam", () => {
    assert.deepEqual(vigenteXmlNames(root), [
      "Diaria comentada horizontal_V5-trechos.xml",
      "Diaria comentada horizontal_V9.xml",
      "Diaria comentada_Vertical_V10-guia.xml",
      "Diaria comentada_Vertical_V11.xml",
    ]);
    const p = planEditionArchive(root, referenced);
    const moved = p.move.map((m) => m.name).sort();
    assert.deepEqual(moved, [
      "261118_audio_tratado-ffffffff.wav",
      "261118_cta_card_horizontal-1111111111111111.mp4",
      "261118_titulo_vertical-aaaaaaaaaaaaaaaa.png",
      "Diaria comentada horizontal_V6 - legendas do export.srt",
      "Diaria comentada horizontal_V8.xml",
      "Diaria comentada_Vertical_V10.xml",
      "Diaria comentada_Vertical_V2 - legendas.srt",
      "Diaria comentada_Vertical_V9-guia.xml",
    ]);
    const kept = new Set(p.keep.map((k) => k.name));
    for (const n of ["261118_audio_tratado-8c0b970d.wav", "261118_titulo_vertical-0c4153906c62e230.png", "Diaria comentada_Vertical_V11 - legendas.srt", "261118_cta_card_horizontal-2222222222222222.mp4", "261118 - previa horizontal.mp4"]) {
      assert.ok(kept.has(n), n);
    }
  });

  it("asset referenciado por XML vigente nunca está na lista de mover", () => {
    const p = planEditionArchive(root, referenced);
    for (const r of referenced) assert.ok(!p.move.some((m) => m.name === r), r);
  });

  it("referências não lidas: nenhum asset sai (XML e SRT seguem a regra)", () => {
    const p = planEditionArchive(root, null);
    assert.ok(!p.move.some((m) => familyOf(m.name)?.kind === "asset"));
    assert.ok(p.move.some((m) => m.name === "Diaria comentada horizontal_V8.xml"));
  });

  it("bruto, subpastas (inclusive arquivo/) e docs ficam intocados; _superadas/ é absorvida", () => {
    const p = planEditionArchive(root, referenced);
    assert.ok(p.untouched.includes("20261117_181712.mp4"));
    assert.ok(p.untouched.includes("Roteiro final 261118 (3 versões).md"));
    for (const d of ["Final/", "trechos/", "arquivo/"]) assert.ok(p.untouched.includes(d), d);
    assert.deepEqual(p.absorb.map((a) => a.name), ["_superadas"]);
  });

  it("asset sem data em algum membro e sem referência: nada sai", () => {
    const p = planEditionArchive([e("261118_cta_card_vertical-1111111111111111.mp4", null), e("261118_cta_card_vertical-2222222222222222.mp4", 5)], new Set());
    assert.equal(p.move.length, 0);
  });

  it("pathurl: nome do arquivo com percent-encoding decodificado", () => {
    assert.deepEqual(xmlReferencedNames(xml(["261118_audio_tratado-2brutos.wav", "a b.png"])).sort(), ["261118_audio_tratado-2brutos.wav", "a b.png"]);
  });

  it("colisão no arquivo/: nome com (arquivado …), sem sobrescrever", () => {
    const taken = new Set(["x.xml", "x (arquivado 20261118-120000).xml"]);
    assert.equal(archiveTargetName("y.xml", taken, "20261118-120000"), "y.xml");
    assert.equal(archiveTargetName("x.xml", taken, "20261118-120000"), "x (arquivado 20261118-120000 2).xml");
    assert.equal(archiveTargetName("a - legendas.srt.no-plan.json", new Set(["a - legendas.srt.no-plan.json"]), "s"), "a - legendas (arquivado s).srt.no-plan.json");
  });
});

describe("numeração do build conta o arquivo/ (#13610, #13414)", () => {
  it("maxXmlVersionIn e o sequence id do plan.json", () => {
    const key = xmlFamilyOf("Diaria comentada horizontal_V1.xml")!.key;
    assert.equal(maxXmlVersionIn(["Diaria comentada horizontal_V3.xml", "Diaria comentada horizontal_V8.xml", "Diaria comentada horizontal_V9-trechos.xml"], key), 8);
    assert.deepEqual(versionOfSequenceId("seq-youtube-v9-abcdef12"), { version: 9, hash: "abcdef12" });
    assert.equal(versionOfSequenceId("seq-youtube"), null);
  });

  it("build depois de arquivar: a versão nova passa de todas, inclusive as do arquivo/", () => {
    const dir = mkdtempSync(join(tmpdir(), "vva-num-"));
    const state = mkdtempSync(join(tmpdir(), "vva-state-"));
    try {
      writeFileSync(join(dir, "Diaria comentada horizontal_V3.xml"), "<xmeml/>");
      mkdirSync(join(dir, "arquivo"));
      for (const v of [1, 2, 8]) writeFileSync(join(dir, "arquivo", `Diaria comentada horizontal_V${v}.xml`), "<xmeml/>");
      assert.equal(xmlNamesWithArchive(dir).length, 4);
      const plan = { spec: { name: "Diaria comentada horizontal_V1", target: "youtube", width: 1920, height: 1080 }, clips: [], durationFrames: 0 };
      const opts = { speechDetect: true, audioRefine: true, audioGain: true, titleMode: "png" as const };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      versionPickedSequences({ outDir: dir, stateDir: state } as any, [plan as any], "h".repeat(64), opts);
      assert.equal(plan.spec.name, "Diaria comentada horizontal_V9");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(state, { recursive: true, force: true });
    }
  });

  it("o plan.json (outra máquina, XML só no Drive) também conta", () => {
    const dir = mkdtempSync(join(tmpdir(), "vva-num-"));
    const state = mkdtempSync(join(tmpdir(), "vva-state-"));
    try {
      writeFileSync(join(state, "plan.json"), JSON.stringify({ xmlVersions: { youtube: { id: "seq-youtube-v12-00000000", since: 1 } } }));
      assert.deepEqual(plannedXmlVersions({ stateDir: state }), { youtube: { version: 12, hash: "00000000" } });
      const plan = { spec: { name: "Diaria comentada horizontal_V1", target: "youtube", width: 1920, height: 1080 }, clips: [], durationFrames: 0 };
      const opts = { speechDetect: true, audioRefine: true, audioGain: true, titleMode: "png" as const };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      versionPickedSequences({ outDir: dir, stateDir: state } as any, [plan as any], "h".repeat(64), opts);
      assert.equal(plan.spec.name, "Diaria comentada horizontal_V13");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(state, { recursive: true, force: true });
    }
  });
});

describe("executor no disco (o Neo)", () => {
  it("dois builds: só a versão nova (e seus assets) na raiz; a anterior em arquivo/; _superadas/ absorvida", () => {
    const dir = mkdtempSync(join(tmpdir(), "vva-local-"));
    try {
      const t = (n: string, s: number) => utimesSync(join(dir, n), s, s);
      writeFileSync(join(dir, "20261117_181712.mp4"), "bruto");
      writeFileSync(join(dir, "261118_titulo_vertical-aaaaaaaaaaaaaaaa.png"), "png1");
      writeFileSync(join(dir, "Diaria comentada_Vertical_V1.xml"), xml(["261118_titulo_vertical-aaaaaaaaaaaaaaaa.png"]));
      writeFileSync(join(dir, "261118_titulo_vertical-bbbbbbbbbbbbbbbb.png"), "png2");
      writeFileSync(join(dir, "Diaria comentada_Vertical_V2.xml"), xml(["261118_titulo_vertical-bbbbbbbbbbbbbbbb.png"]));
      writeFileSync(join(dir, "roteiro.md"), "r");
      mkdirSync(join(dir, "Final"));
      writeFileSync(join(dir, "Final", "Diaria comentada_Vertical_V1.mp4"), "x");
      mkdirSync(join(dir, "_superadas"));
      writeFileSync(join(dir, "_superadas", "Diaria comentada_Vertical_V0 - legendas.srt"), "s");
      t("261118_titulo_vertical-aaaaaaaaaaaaaaaa.png", 100);
      const dry = archiveEditionLocal(dir, "261118", { apply: false });
      assert.equal(dry.moves.length, 3);
      assert.ok(existsSync(join(dir, "Diaria comentada_Vertical_V1.xml")), "dry-run não move");
      const r = archiveEditionLocal(dir, "261118", { apply: true });
      assert.deepEqual(readdirSync(dir).sort(), ["20261117_181712.mp4", "261118_titulo_vertical-bbbbbbbbbbbbbbbb.png", "Diaria comentada_Vertical_V2.xml", "Final", "arquivo", "roteiro.md"]);
      assert.deepEqual(readdirSync(join(dir, "arquivo")).sort(), ["261118_titulo_vertical-aaaaaaaaaaaaaaaa.png", "Diaria comentada_Vertical_V0 - legendas.srt", "Diaria comentada_Vertical_V1.xml"]);
      assert.deepEqual(r.absorbedFolders, ["_superadas"]);
      assert.ok(existsSync(join(dir, "Final", "Diaria comentada_Vertical_V1.mp4")), "Final/ intocada");
      // idempotente
      assert.equal(archiveEditionLocal(dir, "261118", { apply: true }).moves.length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prévia regravada: a anterior vai para arquivo/ sem sobrescrever a que já está lá", () => {
    const dir = mkdtempSync(join(tmpdir(), "vva-prev-"));
    try {
      const p = join(dir, "261118 - previa horizontal.mp4");
      mkdirSync(join(dir, "arquivo"));
      writeFileSync(join(dir, "arquivo", "261118 - previa horizontal.mp4"), "v0");
      writeFileSync(p, "v1");
      const to = archiveBeforeOverwriteLocal(p, new Date(Date.UTC(2026, 10, 18, 12, 0, 0)));
      assert.ok(to?.endsWith("261118 - previa horizontal (arquivado 20261118-120000).mp4"));
      assert.equal(existsSync(p), false);
      assert.equal(archiveBeforeOverwriteLocal(p), null, "sem anterior: nada");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("gancho do video-montagem: falha ao arquivar vira aviso, nunca lança", async () => {
    const warnings: string[] = [];
    const broken = {
      deps: { driveFetch: async () => new Response("boom", { status: 500 }) },
      edition: "261118",
      cacheDir: "/nao/existe",
      folder: async () => ({ id: "f", name: "261118", mimeType: FOLDER_MIME }),
    };
    const r = await archiveVersionsAfter({ edition: "261118", outDir: "/a", driveDir: "/b", mode: "api" }, broken, [], (m) => warnings.push(m));
    assert.equal(r.length, 0);
    assert.match(warnings.join("\n"), /não foram para arquivo\/ no Drive.*archive-video-versions\.ts --edition 261118 --apply/);
    assert.deepEqual(await archiveVersionsAfter({ edition: "261118", outDir: "/a", driveDir: "/b", mode: "api", noArchive: true }, broken, []), []);
  });
});

type FakeFile = DriveEntry & { parent: string; body?: string };

/**
 * Drive falso: pastas e arquivos em memória. Responde listagem (com `q`),
 * metadado (`fields`), download (`alt=media`), PATCH de move/lixeira, criação
 * de pasta e a sessão de upload resumable (criar ou atualizar por id).
 */
function fakeDrive(
  initial: FakeFile[],
  hooks: {
    failPatch?: (id: string, n: number) => "error" | "applied-error" | null;
    failUpload?: boolean;
    /** #13617: some da listagem (a busca do Drive que atrasa). */
    hideFromList?: (f: FakeFile) => boolean;
    /** #13619: resposta da lixeira (ex.: 403 de dono diferente); null = segue. */
    failTrash?: (id: string) => Response | null;
  } = {},
) {
  const files: FakeFile[] = initial.map((f) => ({ ...f }));
  const patches: Array<{ id: string; add: string; remove: string; name?: string }> = [];
  const uploads: Array<{ kind: "create" | "update"; id: string; name: string }> = [];
  const sessions = new Map<string, { kind: "create" | "update"; id?: string; name?: string; parent?: string }>();
  let created = 0;
  let patchCount = 0;
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
  const meta = (f: FakeFile) => ({ id: f.id, name: f.name, mimeType: f.mimeType, parents: [f.parent], modifiedTime: f.modifiedTime, ...(f.createdTime ? { createdTime: f.createdTime } : {}) });
  const deps: MontageDriveDeps = {
    driveFetch: async (url, init) => {
      const u = new URL(url);
      if (u.pathname.startsWith("/upload/")) {
        const key = `https://u/s/${sessions.size + 1}`;
        const m = /\/files\/([^/?]+)$/.exec(u.pathname);
        if (init?.method === "PATCH" && m) sessions.set(key, { kind: "update", id: decodeURIComponent(m[1]) });
        else {
          const b = JSON.parse(String(init?.body)) as { name: string; parents: string[] };
          sessions.set(key, { kind: "create", name: b.name, parent: b.parents[0] });
        }
        return new Response("", { status: 200, headers: { location: key } });
      }
      const m = /\/files\/([^/?]+)$/.exec(u.pathname);
      if (init?.method === "PATCH" && m) {
        const id = decodeURIComponent(m[1]);
        const body = JSON.parse(String(init.body ?? "{}")) as { name?: string; trashed?: boolean };
        const f = files.find((x) => x.id === id)!;
        if (body.trashed) {
          const failed = hooks.failTrash?.(id) ?? null;
          if (failed) return failed;
          files.splice(files.indexOf(f), 1);
          return json({ id, trashed: true });
        }
        const fail = hooks.failPatch?.(id, ++patchCount) ?? null;
        if (fail === "error") return json({ error: "boom" }, 500);
        patches.push({ id, add: u.searchParams.get("addParents")!, remove: u.searchParams.get("removeParents")!, ...(body.name ? { name: body.name } : {}) });
        f.parent = u.searchParams.get("addParents")!;
        if (body.name) f.name = body.name;
        if (fail === "applied-error") return json({ error: "resposta perdida" }, 500);
        return json(meta(f));
      }
      if (init?.method === "POST") {
        const b = JSON.parse(String(init.body)) as { name: string; parents: string[] };
        const f: FakeFile = { id: `new${++created}`, name: b.name, mimeType: FOLDER_MIME, parent: b.parents[0], modifiedTime: "2026-11-18T00:00:00Z" };
        files.push(f);
        return json(f);
      }
      if (m) {
        const f = files.find((x) => x.id === decodeURIComponent(m[1]));
        if (!f) return json({ error: "not found" }, 404);
        if (u.searchParams.get("alt") === "media") return new Response(f.body ?? "");
        return json(meta(f));
      }
      const q = u.searchParams.get("q") ?? "";
      const parent = /'([^']+)' in parents/.exec(q)![1];
      const name = /name = '([^']+)'/.exec(q)?.[1];
      const foldersOnly = q.includes(`mimeType = '${FOLDER_MIME}'`);
      return json({ files: files.filter((f) => f.parent === parent && (name === undefined || f.name === name) && (!foldersOnly || f.mimeType === FOLDER_MIME) && !hooks.hideFromList?.(f)).map(meta) });
    },
    uploadFetch: async (url) => {
      if (hooks.failUpload) return json({ error: "boom" }, 500);
      const s = sessions.get(url)!;
      if (s.kind === "update") {
        uploads.push({ kind: "update", id: s.id!, name: files.find((f) => f.id === s.id)!.name });
        return json({ id: s.id, name: files.find((f) => f.id === s.id)!.name });
      }
      const f: FakeFile = { id: `up${++created}`, name: s.name!, mimeType: "video/mp4", parent: s.parent!, modifiedTime: "2026-11-18T12:00:00Z" };
      files.push(f);
      uploads.push({ kind: "create", id: f.id, name: f.name });
      return json({ id: f.id, name: f.name });
    },
  };
  return { deps, patches, files, uploads };
}

const edFolder: FakeFile = { id: "ed", name: "261118", mimeType: FOLDER_MIME, parent: "yt" };
const xf = (id: string, name: string, t: string, refs: string[] | string): FakeFile => ({ id, name, mimeType: "application/xml", parent: "ed", modifiedTime: t, body: typeof refs === "string" ? refs : xml(refs) });
const af = (id: string, name: string, t: string): FakeFile => ({ id, name, mimeType: "audio/wav", parent: "ed", modifiedTime: t });
const noSleep = async () => {};

describe("executor no Drive (falso)", () => {
  const mk = (hooks?: Parameters<typeof fakeDrive>[1]) =>
    fakeDrive(
      [
        edFolder,
        { id: "x", name: "notas", mimeType: FOLDER_MIME, parent: "yt" },
        { id: "b", name: "20261117_181712.mp4", mimeType: "video/mp4", parent: "ed", modifiedTime: "2026-11-17T10:00:00Z" },
        xf("v1", "Diaria comentada horizontal_V1.xml", "2026-11-17T10:00:00Z", ["261118_audio_tratado-aaaaaaaa.wav"]),
        xf("v2", "Diaria comentada horizontal_V2.xml", "2026-11-17T11:00:00Z", ["261118_audio_tratado-aaaaaaaa.wav", "20261117_181712.mp4"]),
        af("a1", "261118_audio_tratado-aaaaaaaa.wav", "2026-11-17T09:00:00Z"),
        af("a2", "261118_audio_tratado-bbbbbbbb.wav", "2026-11-17T10:30:00Z"),
        { id: "fin", name: "Final", mimeType: FOLDER_MIME, parent: "ed" },
      ],
      hooks,
    );

  it("dry-run lista e não move; --apply move por addParents/removeParents preservando o id", async () => {
    const d = mk();
    const dry = await archiveEditionDrive(d.deps, edFolder, { apply: false });
    assert.deepEqual(dry.moves.map((m) => m.name).sort(), ["261118_audio_tratado-bbbbbbbb.wav", "Diaria comentada horizontal_V1.xml"]);
    assert.equal(d.patches.length, 0);
    const r = await archiveEditionDrive(d.deps, edFolder, { apply: true, sleep: noSleep });
    assert.equal(r.error, undefined);
    assert.ok(r.moves.every((m) => m.done));
    const arquivo = d.files.find((f) => f.name === "arquivo")!;
    assert.deepEqual(d.patches.map((p) => [p.id, p.add, p.remove]).sort(), [["a2", arquivo.id, "ed"], ["v1", arquivo.id, "ed"]]);
    assert.ok(d.files.some((f) => f.id === "a1" && f.parent === "ed"), "o referenciado fica");
  });

  it("recém-gravado que a busca ainda não mostra entra no plano e nunca sai", async () => {
    const d = mk();
    const fresh = [{ name: "Diaria comentada horizontal_V3.xml", id: "v3", modifiedMs: Date.parse("2026-11-17T13:00:00Z") }];
    d.files.push({ ...xf("v3", "Diaria comentada horizontal_V3.xml", "2026-11-17T13:00:00Z", ["261118_audio_tratado-bbbbbbbb.wav"]), parent: "elsewhere" });
    const r = await archiveEditionDrive(d.deps, edFolder, { apply: false, fresh });
    assert.deepEqual(r.plan.vigenteXmls, ["Diaria comentada horizontal_V3.xml"]);
    assert.deepEqual(r.moves.map((m) => m.name).sort(), ["261118_audio_tratado-aaaaaaaa.wav", "Diaria comentada horizontal_V1.xml", "Diaria comentada horizontal_V2.xml"]);
  });

  it("A: XML fora de família e cópias de nome repetido protegem os assets que referenciam", async () => {
    const d = fakeDrive([
      edFolder,
      xf("v9", "Diaria comentada horizontal_V9.xml", "2026-11-17T12:00:00Z", ["261118_audio_tratado-bbbbbbbb.wav"]),
      xf("v9b", "Diaria comentada horizontal_V9.xml", "2026-11-17T11:00:00Z", ["261118_titulo_vertical-1111111111111111.png"]),
      xf("mont", "261118 - montagem (importar no Premiere).xml", "2026-11-17T12:00:00Z", ["261118_audio_tratado-aaaaaaaa.wav"]),
      af("a1", "261118_audio_tratado-aaaaaaaa.wav", "2026-11-17T09:00:00Z"),
      af("a2", "261118_audio_tratado-bbbbbbbb.wav", "2026-11-17T10:00:00Z"),
      af("t1", "261118_titulo_vertical-1111111111111111.png", "2026-11-17T09:00:00Z"),
      af("t2", "261118_titulo_vertical-2222222222222222.png", "2026-11-17T10:00:00Z"),
    ]);
    const r = await archiveEditionDrive(d.deps, edFolder, { apply: false });
    const moved = r.moves.map((m) => m.name);
    assert.ok(!moved.includes("261118_audio_tratado-aaaaaaaa.wav"), "referenciado pelo XML sem versão");
    assert.ok(!moved.includes("261118_titulo_vertical-1111111111111111.png"), "referenciado pela 2ª cópia do nome repetido");
    assert.ok(moved.includes("261118_titulo_vertical-2222222222222222.png"));
  });

  it("A: XML que fica sem nenhum <pathurl> = nenhum asset sai, com aviso", async () => {
    const d = fakeDrive([
      edFolder,
      xf("v9", "Diaria comentada horizontal_V9.xml", "2026-11-17T12:00:00Z", ["261118_audio_tratado-bbbbbbbb.wav"]),
      xf("odd", "Diaria comentada horizontal_V9 (1).xml", "2026-11-17T12:00:00Z", "<xmeml/>"),
      af("a1", "261118_audio_tratado-aaaaaaaa.wav", "2026-11-17T09:00:00Z"),
      af("a2", "261118_audio_tratado-bbbbbbbb.wav", "2026-11-17T10:00:00Z"),
    ]);
    const r = await archiveEditionDrive(d.deps, edFolder, { apply: false });
    assert.equal(r.moves.length, 0);
    assert.match(r.warnings.join("\n"), /sem <pathurl>|não tem <pathurl>/);
  });

  it("B: XML do plan.json fora da listagem, ou asset mais novo que todo XML = nenhum asset sai", async () => {
    const d = mk();
    const r = await archiveEditionDrive(d.deps, edFolder, { apply: false, expectedXmls: ["Diaria comentada horizontal_V3.xml"] });
    assert.deepEqual(r.moves.map((m) => m.name), ["Diaria comentada horizontal_V1.xml"]);
    const newer = mk();
    newer.files.push(af("a3", "261118_audio_tratado-cccccccc.wav", "2026-11-17T13:00:00Z"));
    const r2 = await archiveEditionDrive(newer.deps, edFolder, { apply: false });
    assert.deepEqual(r2.moves.map((m) => m.name), ["Diaria comentada horizontal_V1.xml"]);
  });

  it("D: duas pastas arquivo/ = usa a mais antiga e avisa; nenhuma = espera e busca de novo antes de criar", async () => {
    const d = fakeDrive([
      edFolder,
      { id: "arqB", name: "arquivo", mimeType: FOLDER_MIME, parent: "ed", modifiedTime: "2026-11-18T10:00:00Z" },
      { id: "arqA", name: "arquivo", mimeType: FOLDER_MIME, parent: "ed", modifiedTime: "2026-11-18T09:00:00Z" },
    ]);
    const warns: string[] = [];
    assert.equal((await resolveArchiveFolder(d.deps, "ed", { create: true, sleep: noSleep, warn: (m) => warns.push(m) }))?.id, "arqA");
    assert.match(warns.join(), /2 pastas arquivo\//);
    const empty = fakeDrive([edFolder]);
    let slept = 0;
    const lateFolder = async () => {
      slept++;
      empty.files.push({ id: "late", name: "arquivo", mimeType: FOLDER_MIME, parent: "ed" });
    };
    assert.equal((await resolveArchiveFolder(empty.deps, "ed", { create: true, sleep: lateFolder }))?.id, "late", "a que apareceu na 2ª busca, sem criar outra");
    assert.equal(slept, 1);
    assert.equal(empty.files.filter((f) => f.name === "arquivo").length, 1);
  });

  it("E: já no arquivo/ = pula sem PATCH; PATCH aplicado com resposta perdida = sucesso; 2xx sem efeito = erro", async () => {
    const d = fakeDrive([edFolder, { id: "arq", name: "arquivo", mimeType: FOLDER_MIME, parent: "ed" }, af("a1", "x.wav", "2026-11-17T09:00:00Z"), af("a2", "y.wav", "2026-11-17T09:00:00Z")], {
      failPatch: (id) => (id === "a2" ? "applied-error" : null),
    });
    d.files.find((f) => f.id === "a1")!.parent = "arq";
    assert.equal(await moveDriveFile(d.deps, "a1", "ed", "arq"), "already");
    assert.equal(d.patches.length, 0);
    assert.equal(await moveDriveFile(d.deps, "a2", "ed", "arq"), "moved");
    const liar = fakeDrive([edFolder, af("a3", "z.wav", "2026-11-17T09:00:00Z")]);
    const lie: MontageDriveDeps = {
      driveFetch: async (url, init) => (init?.method === "PATCH" ? new Response(JSON.stringify({ id: "a3" }), { status: 200 }) : liar.deps.driveFetch(url, init)),
    };
    await assert.rejects(moveDriveFile(lie, "a3", "ed", "arq"), /2xx|#6582/);
  });

  it("G: falha no meio do --apply devolve o parcial (o 1º movido) com o erro", async () => {
    const d = mk({ failPatch: (_id, n) => (n === 2 ? "error" : null) });
    const r = await archiveEditionDrive(d.deps, edFolder, { apply: true, sleep: noSleep });
    assert.match(r.error ?? "", /500|boom/);
    assert.equal(r.moves.filter((m) => m.done).length, 1);
    assert.equal(r.moves.length, 2);
  });

  it("C: prévia no Drive é criada nova e só depois a anterior vai para arquivo/; upload falho deixa a anterior na raiz", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vva-prevd-"));
    try {
      const name = "261118 - previa horizontal.mp4";
      const path = join(dir, name);
      writeFileSync(path, "nova");
      const old: FakeFile = { id: "oldprev", name, mimeType: "video/mp4", parent: "ed", modifiedTime: "2026-11-17T10:00:00Z" };
      const ok = fakeDrive([edFolder, old]);
      const sess = { deps: ok.deps, edition: "261118", cacheDir: dir, folder: async () => edFolder };
      const r = await uploadAll({ stateDir: dir, edition: "261118" }, sess, [path], { archiveOverwritten: true, now: () => new Date(Date.UTC(2026, 10, 18)) });
      assert.equal(r.error, null);
      assert.deepEqual(ok.uploads.map((u) => u.kind), ["create"], "nunca atualiza o id da anterior no lugar");
      const arquivo = ok.files.find((f) => f.name === "arquivo")!;
      assert.equal(ok.files.find((f) => f.id === "oldprev")!.parent, arquivo.id);
      assert.ok(ok.files.some((f) => f.name === name && f.parent === "ed" && f.id !== "oldprev"));

      const bad = fakeDrive([edFolder, { ...old }], { failUpload: true });
      const r2 = await uploadAll({ stateDir: mkdtempSync(join(tmpdir(), "vva-st-")), edition: "261118" }, { ...sess, deps: bad.deps }, [path], { archiveOverwritten: true });
      assert.notEqual(r2.error, null);
      assert.equal(bad.files.find((f) => f.id === "oldprev")!.parent, "ed", "a anterior segue na raiz");
      assert.equal(bad.patches.length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("migração: só pastas de edição, dry-run por padrão; exits 1 (pasta), 3 (avisos com --apply), 4 (infra)", async () => {
    const d = mk();
    const r = await runArchiveVersions(["--folder-id", "yt"], d.deps);
    assert.equal(r.code, 0);
    assert.deepEqual(r.reports.map((x) => x.folder), ["261118"]);
    assert.equal(d.patches.length, 0);
    assert.equal((await runArchiveVersions(["--folder-id", "yt", "--edition", "261199"], d.deps)).code, 1);
    const warned = fakeDrive([edFolder, xf("v9", "Diaria comentada horizontal_V9.xml", "2026-11-17T12:00:00Z", "<xmeml/>")]);
    assert.equal((await runArchiveVersions(["--folder-id", "yt", "--apply"], warned.deps)).code, 3);
    const infra: MontageDriveDeps = { driveFetch: async () => new Response("unauthorized", { status: 401 }) };
    assert.equal(await archiveMain(["--folder-id", "yt"], infra), 4);
    assert.equal(await archiveMain(["--edition"], infra), 2);
  });
});

describe("C/H/F no disco e na numeração", () => {
  it("C: prévia local vai por .part; cópia falha deixa a anterior na raiz", () => {
    const dir = mkdtempSync(join(tmpdir(), "vva-inst-"));
    try {
      const out = join(dir, "261118 - previa vertical.mp4");
      writeFileSync(out, "antiga");
      assert.throws(() => installPreviewFile(join(dir, "nao-existe.mp4"), out, { archive: true }));
      assert.equal(readFileSync(out, "utf8"), "antiga");
      assert.equal(existsSync(join(dir, "arquivo")), false);
      assert.equal(existsSync(`${out}.part`), false);
      const src = join(dir, "render.mp4");
      writeFileSync(src, "nova");
      installPreviewFile(src, out, { archive: true });
      assert.equal(readFileSync(out, "utf8"), "nova");
      assert.deepEqual(readdirSync(join(dir, "arquivo")), ["261118 - previa vertical.mp4"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("H: colisão no arquivo/ do disco não diferencia maiúsculas (NTFS)", () => {
    assert.equal(archiveTargetName("x.xml", new Set(["X.XML"]), "s", { caseInsensitive: true }), "x (arquivado s).xml");
    assert.equal(archiveTargetName("x.xml", new Set(["X.XML"]), "s"), "x.xml");
    const dir = mkdtempSync(join(tmpdir(), "vva-ci-"));
    try {
      mkdirSync(join(dir, "arquivo"));
      writeFileSync(join(dir, "arquivo", "261118 - PREVIA VERTICAL.mp4"), "v0");
      writeFileSync(join(dir, "261118 - previa vertical.mp4"), "v1");
      const to = archiveBeforeOverwriteLocal(join(dir, "261118 - previa vertical.mp4"), new Date(Date.UTC(2026, 10, 18)));
      assert.match(to ?? "", /\(arquivado 20261118-000000\)\.mp4$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("F: o sufixo de colisão sai antes de contar a versão; plan.json ilegível avisa", () => {
    assert.equal(stripArchivedSuffix("Diaria comentada horizontal_V8 (arquivado 20261118-120000).xml"), "Diaria comentada horizontal_V8.xml");
    assert.equal(stripArchivedSuffix("a - legendas (arquivado s).srt.no-plan.json"), "a - legendas.srt.no-plan.json");
    const dir = mkdtempSync(join(tmpdir(), "vva-f-"));
    const state = mkdtempSync(join(tmpdir(), "vva-fs-"));
    try {
      mkdirSync(join(dir, "arquivo"));
      writeFileSync(join(dir, "arquivo", "Diaria comentada horizontal_V8 (arquivado 20261118-120000).xml"), "<xmeml/>");
      const plan = { spec: { name: "Diaria comentada horizontal_V1", target: "youtube", width: 1920, height: 1080 }, clips: [], durationFrames: 0 };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      versionPickedSequences({ outDir: dir, stateDir: state } as any, [plan as any], "h".repeat(64), { speechDetect: true, audioRefine: true, audioGain: true, titleMode: "png" });
      assert.equal(plan.spec.name, "Diaria comentada horizontal_V9");
      writeFileSync(join(state, "plan.json"), "{ruim");
      const warns: string[] = [];
      assert.deepEqual(plannedXmlVersions({ stateDir: state }, (m) => warns.push(m)), {});
      assert.match(warns.join(), /plan\.json ilegível/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(state, { recursive: true, force: true });
    }
  });

  it("A: entidades XML e %XX no pathurl", () => {
    const t = `<xmeml><pathurl>file://localhost/x/O&apos;Neil%20a.png</pathurl><pathurl>file://localhost/x/b&#39;c&amp;d.wav</pathurl><pathurl>file://localhost/x/e&#x27;f.mov</pathurl></xmeml>`;
    assert.deepEqual(xmlReferencedNames(t).sort(), ["O'Neil a.png", "b'c&d.wav", "e'f.mov"]);
    assert.equal(referencedFromXmlTexts([t, "<xmeml/>"]), null, "XML sem pathurl = null");
    assert.equal(referencedFromXmlTexts([t, null]), null, "XML não lido = null");
    assert.equal(referencedFromXmlTexts([t])?.size, 3);
  });

  it("A no disco: XML fora de família (_v9 minúsculo, acento) protege o asset antigo", () => {
    const dir = mkdtempSync(join(tmpdir(), "vva-a-"));
    try {
      writeFileSync(join(dir, "261118_audio_tratado-aaaaaaaa.wav"), "a");
      utimesSync(join(dir, "261118_audio_tratado-aaaaaaaa.wav"), 100, 100);
      writeFileSync(join(dir, "261118_audio_tratado-bbbbbbbb.wav"), "b");
      utimesSync(join(dir, "261118_audio_tratado-bbbbbbbb.wav"), 200, 200);
      writeFileSync(join(dir, "Diaria comentada_Vertical_V2-automação.xml"), xml(["261118_audio_tratado-aaaaaaaa.wav"]));
      writeFileSync(join(dir, "Diaria comentada horizontal_V3.xml"), xml(["261118_audio_tratado-bbbbbbbb.wav"]));
      const r = archiveEditionLocal(dir, "261118", { apply: false });
      assert.deepEqual(r.moves, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("bruto e arquivo/ fora do transcribe e do archive-video-brutos (#13610 restrição 3)", () => {
  it("archive-video-brutos não vê bruto dentro de arquivo/", () => {
    assert.equal(isBrutoFile("20261104_124252.mp4"), true);
    assert.equal(isBrutoFile("arquivo/20261104_124252.mp4"), false);
    assert.equal(isBrutoFile("arquivo"), false);
  });

  it("a listagem recursiva do archive-video-brutos (rclone lsjson -R) não pega bruto em arquivo/", () => {
    const listing = parseRcloneLsjson(
      JSON.stringify([
        { Path: "20261117_181712.mp4", Size: 10, IsDir: false },
        { Path: "arquivo", Size: -1, IsDir: true },
        { Path: "arquivo/20261104_124252.mp4", Size: 10, IsDir: false },
        { Path: "arquivo/Diaria comentada horizontal_V1.xml", Size: 1, IsDir: false },
        { Path: "Brutos/VID_20261104_124252.mp4", Size: 10, IsDir: false },
      ]),
    );
    assert.deepEqual(brutoFilesOf(listing).map((f) => f.path), ["20261117_181712.mp4", "Brutos/VID_20261104_124252.mp4"]);
  });

  it("a lista de onde o transcribe local escolhe o bruto (looseFilesIn) ignora arquivo/", () => {
    const dir = mkdtempSync(join(tmpdir(), "vva-loose-"));
    try {
      writeFileSync(join(dir, "20261117_181712.mp4"), "x");
      mkdirSync(join(dir, "arquivo"));
      writeFileSync(join(dir, "arquivo", "20261104_124252.mp4"), "xxxxxxxxxxxx");
      assert.deepEqual(looseFilesIn(dir).map((f) => f.name), ["20261117_181712.mp4"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a escolha do bruto do transcribe (Drive) ignora a subpasta arquivo/", () => {
    const r = pickDriveBruto([
      { id: "a", name: "arquivo", mimeType: FOLDER_MIME },
      { id: "b", name: "20261117_181712.mp4", mimeType: "video/mp4", size: "100" },
    ]);
    assert.equal(r?.pick.id, "b");
    assert.equal(r?.candidates.length, 1);
  });
});

describe("resíduos do review do PR #13613 (#13617) e lixeira de dono diferente (#13619)", () => {
  const seed = (): FakeFile[] => [
    edFolder,
    af("p0", "x.wav", "2026-11-17T09:00:00Z"),
    af("a2", "261118_audio_tratado-bbbbbbbb.wav", "2026-11-17T10:30:00Z"),
    xf("v1", "Diaria comentada horizontal_V1.xml", "2026-11-17T10:00:00Z", ["261118_audio_tratado-cccccccc.wav"]),
    xf("v2", "Diaria comentada horizontal_V2.xml", "2026-11-17T11:00:00Z", ["261118_audio_tratado-cccccccc.wav"]),
  ];
  // A pasta criada nesta execução (`new*`) nunca aparece na listagem: a busca do Drive atrasada.
  const lagging = { hideFromList: (f: FakeFile) => f.id.startsWith("new") };

  it("1: a arquivo/ criada no upload é reaproveitada pelo arquivamento da mesma execução, mesmo fora da busca", async () => {
    const d = fakeDrive(seed(), lagging);
    const cache = new Map<string, DriveEntry>();
    assert.equal(await archiveDriveIds(d.deps, "ed", "x.wav", ["p0"], { sleep: noSleep, archiveFolders: cache }), 1);
    const r = await archiveEditionDrive(d.deps, edFolder, { apply: true, sleep: noSleep, archiveFolders: cache });
    assert.equal(r.error, undefined);
    assert.ok(r.moves.length > 0);
    assert.equal(d.files.filter((f) => f.name === "arquivo").length, 1, "uma arquivo/ só");
    const arquivo = d.files.find((f) => f.name === "arquivo")!;
    assert.ok(d.patches.every((p) => p.add === arquivo.id));
    // Sem o cache, a mesma sequência cria a 2ª (o defeito que o cache fecha).
    const noCache = fakeDrive(seed(), lagging);
    await archiveDriveIds(noCache.deps, "ed", "x.wav", ["p0"], { sleep: noSleep });
    await archiveEditionDrive(noCache.deps, edFolder, { apply: true, sleep: noSleep });
    assert.equal(noCache.files.filter((f) => f.name === "arquivo").length, 2);
  });

  it("1: a sessão do Drive do video-montagem carrega o cache da arquivo/", () => {
    const s = makeDriveSession("261118", "/tmp", { driveFetch: async () => new Response("{}") }, () => "yt");
    assert.ok(s.archiveFolders instanceof Map);
  });

  it("2: duas arquivo/ = a mais antiga pela CRIAÇÃO, não pela última mudança", async () => {
    const d = fakeDrive([
      edFolder,
      { id: "arqNova", name: "arquivo", mimeType: FOLDER_MIME, parent: "ed", createdTime: "2026-11-18T10:00:00Z", modifiedTime: "2026-11-18T10:00:00Z" },
      { id: "arqVelha", name: "arquivo", mimeType: FOLDER_MIME, parent: "ed", createdTime: "2026-11-18T09:00:00Z", modifiedTime: "2026-11-18T11:00:00Z" },
    ]);
    assert.equal((await resolveArchiveFolder(d.deps, "ed", { create: true, sleep: noSleep }))?.id, "arqVelha");
  });

  it("3: rename final da prévia que falha apaga o .part e relança", () => {
    const dir = mkdtempSync(join(tmpdir(), "vva-part-"));
    try {
      const src = join(dir, "render.mp4");
      writeFileSync(src, "nova");
      // `out` é um diretório não vazio: o rename do `.part` por cima dele falha.
      const out = join(dir, "261118 - previa vertical.mp4");
      mkdirSync(out);
      writeFileSync(join(out, "x"), "x");
      // `arquivo` é um arquivo, não pasta: o arquivamento da anterior falha e vira warn.
      writeFileSync(join(dir, "arquivo"), "não é pasta");
      const warns: string[] = [];
      assert.throws(() => installPreviewFile(src, out, { archive: true, warn: (m) => warns.push(m) }));
      assert.equal(warns.length, 1);
      assert.equal(existsSync(`${out}.part`), false, "nenhum .part órfão");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("4: releitura de parents que falha não mascara o erro do PATCH", async () => {
    const d = fakeDrive([edFolder, { id: "arq", name: "arquivo", mimeType: FOLDER_MIME, parent: "ed" }, af("a1", "x.wav", "2026-11-17T09:00:00Z")], {
      failPatch: () => "error",
    });
    let reads = 0;
    const deps: MontageDriveDeps = {
      driveFetch: async (url, init) => {
        if (!init?.method && /\/files\/a1\?/.test(url) && ++reads > 1) return new Response("releitura caiu", { status: 500 });
        return d.deps.driveFetch(url, init);
      },
    };
    await assert.rejects(moveDriveFile(deps, "a1", "ed", "arq"), /move de a1 para arquivo\/ no Drive falhou \(500\)/);
    // Sem erro do PATCH, o erro da releitura é o que sobe.
    const ok = fakeDrive([edFolder, { id: "arq", name: "arquivo", mimeType: FOLDER_MIME, parent: "ed" }, af("a2", "y.wav", "2026-11-17T09:00:00Z")]);
    let r2 = 0;
    const lie: MontageDriveDeps = {
      driveFetch: async (url, init) => {
        if (init?.method === "PATCH") return new Response(JSON.stringify({ id: "a2" }), { status: 200 });
        if (!init?.method && /\/files\/a2\?/.test(url) && ++r2 > 1) return new Response("releitura caiu", { status: 500 });
        return ok.deps.driveFetch(url, init);
      },
    };
    await assert.rejects(moveDriveFile(lie, "a2", "ed", "arq"), /metadado de a2 no Drive falhou \(500\)/);
  });

  it("6: brutoFilesOf ignora arquivo/Brutos/ (de um _superadas/Brutos/ absorvido); Brutos/ na raiz segue bruto", () => {
    assert.equal(BRUTO_SKIP_ARCHIVE_DIR, ARCHIVE_DIR_NAME);
    const files = [{ path: "arquivo/Brutos/20261117_181712.mp4" }, { path: "Arquivo/brutos/20261117_181712.mp4" }, { path: "Brutos/20261117_181713.mp4" }, { path: "20261117_181714.mp4" }];
    assert.deepEqual(
      brutoFilesOf(files).map((f) => f.path),
      ["Brutos/20261117_181713.mp4", "20261117_181714.mp4"],
    );
  });

  it("#13619: _superadas/ vazia de outra conta (403 insufficientFilePermissions) vira aviso, sem erro, e o exit não é 1", async () => {
    const forbidden = () =>
      new Response(JSON.stringify({ error: { code: 403, errors: [{ reason: "insufficientFilePermissions" }], message: "The user does not have sufficient permissions for this file." } }), { status: 403 });
    const mk = () =>
      fakeDrive(
        [
          edFolder,
          { id: "sup", name: "_superadas", mimeType: FOLDER_MIME, parent: "ed" },
          { id: "old", name: "Diaria comentada horizontal_V1.xml", mimeType: "application/xml", parent: "sup", body: xml(["x.wav"]) },
        ],
        { failTrash: (id) => (id === "sup" ? forbidden() : null) },
      );
    const d = mk();
    const r = await archiveEditionDrive(d.deps, edFolder, { apply: true, sleep: noSleep });
    assert.equal(r.error, undefined, "os moves valeram; a lixeira recusada não é erro");
    assert.ok(r.moves.length > 0 && r.moves.every((m) => m.done));
    assert.deepEqual(r.absorbedFolders, []);
    assert.match(r.warnings.join("\n"), /_superadas\/ \(id sup\) ficou vazia, mas não foi para a lixeira.*#13619/);
    assert.ok(d.files.some((f) => f.id === "sup"), "a pasta vazia segue no Drive");
    const cli = await runArchiveVersions(["--folder-id", "yt", "--apply"], mk().deps);
    assert.equal(cli.code, 3, "exit de avisos, não 1");
    // Outro erro da lixeira continua erro.
    const other = fakeDrive(
      [edFolder, { id: "sup", name: "_superadas", mimeType: FOLDER_MIME, parent: "ed" }, { id: "old", name: "a.xml", mimeType: "application/xml", parent: "sup", body: xml(["x.wav"]) }],
      { failTrash: () => new Response("boom", { status: 500 }) },
    );
    const r2 = await archiveEditionDrive(other.deps, edFolder, { apply: true, sleep: noSleep });
    assert.match(r2.error ?? "", /500/);
  });

  it("#13619: isNotOwnerTrashError reconhece a resposta lida e o erro do retry, e só o 403 de permissão", () => {
    assert.ok(isNotOwnerTrashError(new Error('lixeira da pasta vazia x falhou (403): {"error":{"errors":[{"reason":"insufficientFilePermissions"}]}}')));
    assert.ok(isNotOwnerTrashError(new Error("Drive transient 403: insufficientFilePermissions")));
    assert.equal(isNotOwnerTrashError(new Error("lixeira falhou (403): rateLimitExceeded")), false);
    assert.equal(isNotOwnerTrashError(new Error("falhou (500): insufficientFilePermissions")), false);
  });
});
