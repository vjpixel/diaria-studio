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
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  archiveTargetName,
  familyOf,
  isOverwriteArchivedName,
  planEditionArchive,
  vigenteXmlNames,
  xmlFamilyOf,
  xmlReferencedNames,
  maxXmlVersionIn,
  versionOfSequenceId,
  type ArchiveEntry,
} from "../scripts/lib/diaria/video-version-archive.ts";
import { archiveBeforeOverwriteLocal, archiveEditionDrive, archiveEditionLocal, xmlNamesWithArchive } from "../scripts/lib/diaria/video-version-archive-io.ts";
import { FOLDER_MIME, pickDriveBruto, type DriveEntry, type MontageDriveDeps } from "../scripts/lib/diaria/video-montage-drive.ts";
import { isBrutoFile } from "../scripts/lib/diaria/video-bruto-archive.ts";
import { archiveVersionsAfter, plannedXmlVersions, versionPickedSequences } from "../scripts/video-montagem.ts";
import { runArchiveVersions } from "../scripts/archive-video-versions.ts";

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

/** Drive falso: pastas e arquivos em memória; responde listagem, download e PATCH de move. */
function fakeDrive(tree: Record<string, Array<DriveEntry & { parent: string; body?: string }>>) {
  const files = Object.values(tree).flat();
  const patches: Array<{ id: string; add: string; remove: string; name?: string }> = [];
  let created = 0;
  const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { "content-type": "application/json" } });
  const deps: MontageDriveDeps = {
    driveFetch: async (url, init) => {
      const u = new URL(url);
      const m = /\/files\/([^/?]+)$/.exec(u.pathname);
      if (init?.method === "PATCH" && m) {
        const id = decodeURIComponent(m[1]);
        const body = JSON.parse(String(init.body ?? "{}")) as { name?: string; trashed?: boolean };
        const f = files.find((x) => x.id === id)!;
        if (body.trashed) {
          files.splice(files.indexOf(f), 1);
          return json({ id });
        }
        patches.push({ id, add: u.searchParams.get("addParents")!, remove: u.searchParams.get("removeParents")!, ...(body.name ? { name: body.name } : {}) });
        f.parent = u.searchParams.get("addParents")!;
        if (body.name) f.name = body.name;
        return json({ id });
      }
      if (init?.method === "POST") {
        const b = JSON.parse(String(init.body)) as { name: string; parents: string[] };
        const f = { id: `new${++created}`, name: b.name, mimeType: FOLDER_MIME, parent: b.parents[0] };
        files.push(f);
        return json(f);
      }
      if (m && u.searchParams.get("alt") === "media") return new Response(files.find((x) => x.id === decodeURIComponent(m[1]))?.body ?? "");
      const q = u.searchParams.get("q") ?? "";
      const parent = /'([^']+)' in parents/.exec(q)![1];
      const name = /name = '([^']+)'/.exec(q)?.[1];
      const foldersOnly = q.includes(`mimeType = '${FOLDER_MIME}'`);
      return json({ files: files.filter((f) => f.parent === parent && (name === undefined || f.name === name) && (!foldersOnly || f.mimeType === FOLDER_MIME)) });
    },
  };
  return { deps, patches, files };
}

describe("executor no Drive (falso)", () => {
  const mk = () =>
    fakeDrive({
      root: [{ id: "ed", name: "261118", mimeType: FOLDER_MIME, parent: "yt" }, { id: "x", name: "notas", mimeType: FOLDER_MIME, parent: "yt" }],
      ed: [
        { id: "b", name: "20261117_181712.mp4", mimeType: "video/mp4", parent: "ed", modifiedTime: "2026-11-17T10:00:00Z" },
        { id: "v1", name: "Diaria comentada horizontal_V1.xml", mimeType: "application/xml", parent: "ed", modifiedTime: "2026-11-17T10:00:00Z", body: xml(["261118_audio_tratado-aaaaaaaa.wav"]) },
        { id: "v2", name: "Diaria comentada horizontal_V2.xml", mimeType: "application/xml", parent: "ed", modifiedTime: "2026-11-17T11:00:00Z", body: xml(["261118_audio_tratado-aaaaaaaa.wav", "20261117_181712.mp4"]) },
        { id: "a1", name: "261118_audio_tratado-aaaaaaaa.wav", mimeType: "audio/wav", parent: "ed", modifiedTime: "2026-11-17T09:00:00Z" },
        { id: "a2", name: "261118_audio_tratado-bbbbbbbb.wav", mimeType: "audio/wav", parent: "ed", modifiedTime: "2026-11-17T12:00:00Z" },
        { id: "fin", name: "Final", mimeType: FOLDER_MIME, parent: "ed" },
      ],
    });

  it("dry-run lista e não move; --apply move por addParents/removeParents preservando o id", async () => {
    const d = mk();
    const dry = await archiveEditionDrive(d.deps, { id: "ed", name: "261118" }, { apply: false });
    assert.deepEqual(dry.moves.map((m) => m.name).sort(), ["261118_audio_tratado-bbbbbbbb.wav", "Diaria comentada horizontal_V1.xml"]);
    assert.equal(d.patches.length, 0);
    const r = await archiveEditionDrive(d.deps, { id: "ed", name: "261118" }, { apply: true });
    assert.equal(r.moves.length, 2);
    const arquivo = d.files.find((f) => f.name === "arquivo")!;
    assert.deepEqual(d.patches.map((p) => [p.id, p.add, p.remove]).sort(), [["a2", arquivo.id, "ed"], ["v1", arquivo.id, "ed"]]);
    assert.ok(d.files.some((f) => f.id === "a1" && f.parent === "ed"), "o referenciado fica");
  });

  it("recém-gravado que a busca ainda não mostra entra no plano e nunca sai", async () => {
    const d = mk();
    const fresh = [{ name: "Diaria comentada horizontal_V3.xml", id: "v3", modifiedMs: Date.now() }];
    d.files.push({ id: "v3", name: "Diaria comentada horizontal_V3.xml", mimeType: "application/xml", parent: "elsewhere", body: xml(["261118_audio_tratado-bbbbbbbb.wav"]) });
    const r = await archiveEditionDrive(d.deps, { id: "ed", name: "261118" }, { apply: false, fresh });
    assert.deepEqual(r.plan.vigenteXmls, ["Diaria comentada horizontal_V3.xml"]);
    assert.deepEqual(r.moves.map((m) => m.name).sort(), ["261118_audio_tratado-aaaaaaaa.wav", "Diaria comentada horizontal_V1.xml", "Diaria comentada horizontal_V2.xml"]);
  });

  it("migração: só pastas de edição, dry-run por padrão", async () => {
    const d = mk();
    const r = await runArchiveVersions(["--folder-id", "yt"], d.deps);
    assert.equal(r.code, 0);
    assert.deepEqual(r.reports.map((x) => x.folder), ["261118"]);
    assert.equal(d.patches.length, 0);
    const miss = await runArchiveVersions(["--folder-id", "yt", "--edition", "261199"], d.deps);
    assert.equal(miss.code, 1);
  });
});

describe("bruto e arquivo/ fora do transcribe e do archive-video-brutos (#13610 restrição 3)", () => {
  it("archive-video-brutos não vê bruto dentro de arquivo/", () => {
    assert.equal(isBrutoFile("20261104_124252.mp4"), true);
    assert.equal(isBrutoFile("arquivo/20261104_124252.mp4"), false);
    assert.equal(isBrutoFile("arquivo"), false);
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
