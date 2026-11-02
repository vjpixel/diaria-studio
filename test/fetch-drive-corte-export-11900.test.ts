/**
 * #11900 (resíduo da PR #11906): o 300 não achava no Drive o export da
 * vertical extra (`…_V{n}-{corte}.mp4` em `{AAMMDD}/Final/`). O
 * `videoTargetOf` devolve `null` para nome de corte (de propósito: o corte não
 * é a vertical da edição), então o `fetch-drive-video.ts` nunca o escolhia e a
 * única saída era `--video-dir` local ou `--from-drive {id}` à mão.
 * Agora `--corte SLUG` acha o export de cada corte e devolve o `--drive-ids`
 * pronto para o `video-extra-verticals.ts`. Sem rede (Drive mockado).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { selectCorteExport, selectDriveVideo, PROMOTED_FROM_PROPERTY, type DriveVideoFile } from "../scripts/lib/diaria/drive-video-source.ts";
import {
  parseCorteList,
  parseFetchCorteArgs,
  runFetchCorteExports,
  type DriveFetchInit,
  type FetchDriveVideoDeps,
} from "../scripts/fetch-drive-video.ts";

const FOLDER = "application/vnd.google-apps.folder";
const VERT = { videoMediaMetadata: { width: 1080, height: 1920 } };
const HORIZ = { videoMediaMetadata: { width: 1920, height: 1080 } };

const f = (id: string, name: string, extra: Partial<DriveVideoFile> = {}): DriveVideoFile => ({
  id,
  name,
  mimeType: "video/mp4",
  modifiedTime: "2026-11-03T20:00:00Z",
  scope: "final-folder",
  ...VERT,
  ...extra,
});

const MAIN = f("main", "Diaria comentada_Vertical_V1.mp4");
const YT = f("yt", "Diaria comentada_Youtube_V1.mp4", HORIZ);
const SOB = f("sob", "Diaria comentada_Vertical_V1-soberana.mp4");

test("cenário da issue: a vertical da edição nunca escolhe o corte, e o corte é achado pelo slug", () => {
  const files = [YT, MAIN, SOB];
  const edition = selectDriveVideo(files, { orientation: "vertical", now: new Date(), editionFolderPresent: true });
  assert.equal(edition.kind, "found");
  assert.equal(edition.kind === "found" && edition.file.id, "main");
  const corte = selectCorteExport(files, "soberana");
  assert.equal(corte.kind, "found");
  assert.equal(corte.kind === "found" && corte.file.id, "sob");
});

test("slug é exato: soberana não casa com soberana-2 nem com outro corte", () => {
  const files = [f("s2", "Diaria comentada_Vertical_V1-soberana-2.mp4"), f("x", "Diaria comentada_Vertical_V1-noticia.mp4")];
  assert.equal(selectCorteExport(files, "soberana").kind, "none");
  const two = selectCorteExport(files, "soberana-2");
  assert.equal(two.kind === "found" && two.file.id, "s2");
});

test("2 exports do mesmo corte em Final/ ficam para o editor", () => {
  const sel = selectCorteExport([SOB, f("sob2", "Diaria comentada_Vertical_V2-soberana.mp4")], "soberana");
  assert.equal(sel.kind, "ambiguous");
  assert.equal(sel.kind === "ambiguous" && sel.candidates.length, 2);
});

test("sem export em Final/, vale a versão mais alta de Editados/ com premissa", () => {
  const sel = selectCorteExport(
    [MAIN, f("e1", "Diaria comentada_Vertical_V1-soberana.mp4", { editedFolder: true }), f("e3", "Diaria comentada_Vertical_V3-soberana.mp4", { editedFolder: true })],
    "soberana",
  );
  assert.equal(sel.kind, "found");
  assert.equal(sel.kind === "found" && sel.file.id, "e3");
  assert.match(sel.kind === "found" ? sel.premise ?? "" : "", /V3/);
});

test("Final/ com export do editor vence Editados/", () => {
  const sel = selectCorteExport([SOB, f("e9", "Diaria comentada_Vertical_V9-soberana.mp4", { editedFolder: true })], "soberana");
  assert.equal(sel.kind === "found" && sel.file.id, "sob");
});

test("cópia promovida não congela a versão: V4 em Editados/ vence a cópia do V2 (#11577)", () => {
  const v2 = f("e2", "Diaria comentada_Vertical_V2-soberana.mp4", { editedFolder: true });
  const copy = { ...v2, id: "e2-copy", editedFolder: undefined, appProperties: { [PROMOTED_FROM_PROPERTY]: "e2" } };
  const v4 = f("e4", "Diaria comentada_Vertical_V4-soberana.mp4", { editedFolder: true });
  const sel = selectCorteExport([copy, v2, v4], "soberana");
  assert.equal(sel.kind === "found" && sel.file.id, "e4");
});

test("proporção horizontal exclui; desconhecida passa; fora de Final/ não conta", () => {
  assert.equal(selectCorteExport([f("h", "X_V1-soberana.mp4", HORIZ)], "soberana").kind, "none");
  const unknown = selectCorteExport([f("u", "X_V1-soberana.mp4", { videoMediaMetadata: undefined })], "soberana");
  assert.equal(unknown.kind, "found");
  assert.equal(selectCorteExport([f("r", "X_V1-soberana.mp4", { scope: "edition-folder" })], "soberana").kind, "none");
  assert.equal(selectCorteExport([f("m", "X_V1-soberana.mov", { mimeType: "video/quicktime" })], "soberana").kind, "none");
});

function mockDrive(edition: string, sub: Record<string, DriveVideoFile[]>, opts: { editionFolders?: number } = {}): FetchDriveVideoDeps {
  const idOf = (name: string) => `sub-${name.replace(/\W+/g, "_")}`;
  return {
    async driveFetch(url: string, _init?: DriveFetchInit) {
      const u = new URL(url);
      if (!u.pathname.endsWith("/files")) return Response.json({ id: "root", mimeType: FOLDER });
      const q = u.searchParams.get("q") ?? "";
      for (const [name, files] of Object.entries(sub)) {
        if (q.includes(`'${idOf(name)}'`)) return Response.json({ files: files.map(({ scope: _s, editedFolder: _e, ...rest }) => rest) });
      }
      if (q.includes("'ed")) return Response.json({ files: Object.keys(sub).map((name) => ({ id: idOf(name), name, mimeType: FOLDER })) });
      const n = opts.editionFolders ?? 1;
      return Response.json({ files: Array.from({ length: n }, (_, i) => ({ id: `ed${i}`, name: edition, mimeType: FOLDER })) });
    },
  };
}

test("runFetchCorteExports: acha cada corte e monta o --drive-ids do video-extra-verticals", async () => {
  const logs: string[] = [];
  const deps = mockDrive("261103", {
    Final: [YT, MAIN, SOB],
    Editados: [f("n2", "Diaria comentada_Vertical_V2-noticia.mp4")],
  });
  const { exitCode, output } = await runFetchCorteExports(deps, { aammdd: "261103", folderId: "root", cortes: ["soberana", "noticia", "falta"] }, (l) => logs.push(l));
  assert.equal(exitCode, 0);
  assert.equal(output.action, "cortes");
  if (output.action !== "cortes") return;
  assert.deepEqual(output.cortes.map((c) => [c.corte, c.selection, c.file?.id ?? null]), [
    ["soberana", "found", "sob"],
    ["noticia", "found", "n2"],
    ["falta", "none", null],
  ]);
  assert.equal(output.drive_ids, "soberana=sob,noticia=n2");
  assert.equal(output.next_command, "npx tsx scripts/video-extra-verticals.ts 261103 --drive-ids soberana=sob,noticia=n2");
  assert.ok(logs.some((l) => l.includes("[premissa] noticia")), logs.join("\n"));
});

test("runFetchCorteExports: ambíguo sai 3; subpasta duplicada sai 3; sem subpasta sai 0 com none", async () => {
  const amb = await runFetchCorteExports(
    mockDrive("261103", { Final: [SOB, f("sob2", "Diaria comentada_Vertical_V2-soberana.mp4")] }),
    { aammdd: "261103", folderId: "root", cortes: ["soberana"] },
    () => {},
  );
  assert.equal(amb.exitCode, 3);
  assert.equal(amb.output.action === "cortes" && amb.output.next_command, null);
  const dup = await runFetchCorteExports(mockDrive("261103", {}, { editionFolders: 2 }), { aammdd: "261103", folderId: "root", cortes: ["soberana"] }, () => {});
  assert.equal(dup.exitCode, 3);
  assert.equal(dup.output.action, "needs-editor");
  const none = await runFetchCorteExports(mockDrive("261103", {}, { editionFolders: 0 }), { aammdd: "261103", folderId: "root", cortes: ["soberana"] }, () => {});
  assert.equal(none.exitCode, 0);
  assert.equal(none.output.action === "cortes" && none.output.cortes[0].selection, "none");
});

test("runFetchCorteExports: pasta inacessível sai 1", async () => {
  const deps: FetchDriveVideoDeps = { driveFetch: async () => new Response("nope", { status: 404 }) };
  const out = await runFetchCorteExports(deps, { aammdd: "261103", folderId: "root", cortes: ["soberana"] }, () => {});
  assert.equal(out.exitCode, 1);
  assert.equal(out.output.action === "error" && out.output.phase, "folder");
});

test("parse do modo corte", () => {
  const cfg = { folderId: "cfg", windowHours: null };
  assert.equal(parseFetchCorteArgs(["--edition", "261103", "--orientation", "vertical"], cfg), null);
  assert.deepEqual(parseFetchCorteArgs(["--edition", "261103", "--corte", "soberana,noticia"], cfg), {
    ok: true,
    aammdd: "261103",
    folderId: "cfg",
    cortes: ["soberana", "noticia"],
  });
  assert.equal(parseFetchCorteArgs(["--edition", "261103", "--corte"], cfg)?.ok, false);
  assert.equal(parseFetchCorteArgs(["--edition", "261103", "--corte", "soberana", "--download"], cfg)?.ok, false);
  assert.equal(parseFetchCorteArgs(["--edition", "261103", "--corte", "soberana", "--orientation", "vertical"], cfg)?.ok, false);
  assert.equal(parseFetchCorteArgs(["--corte", "soberana"], cfg)?.ok, false);
  assert.equal(parseFetchCorteArgs(["--edition", "261103", "--corte", "soberana"], { folderId: null, windowHours: null })?.ok, false);
  assert.equal(parseCorteList("Soberana").ok, false);
  assert.equal(parseCorteList("a,a").ok, false);
});
