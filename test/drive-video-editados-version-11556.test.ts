/**
 * #11556: na edição 261029 o editor e a Bruna exportaram todas as versões em
 * `261029/Editados/` (`_Youtube_V1` … `_V5`, `_Instagram_V1` com prefixo
 * "edição 6" e `_Instagram_V2`) e não criaram `Final/`. O fetch respondia
 * `needs-editor` (2+ do mesmo destino) e o contorno foi copiar à mão para
 * `Final/`. Agora: em `Editados/` vale o maior `V{n}` (premissa no JSON), e com
 * `promote` o escolhido é copiado para `Final/` pela Drive API. Sem rede.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PROMOTED_FROM_PROPERTY,
  pickHighestVersion,
  selectDriveVideo,
  videoVersionOf,
  type DriveVideoFile,
} from "../scripts/lib/diaria/drive-video-source.ts";
import {
  promoteToFinal,
  runFetchDriveVideo,
  type DriveFetchInit,
  type FetchDriveVideoDeps,
  type FetchDriveVideoInput,
} from "../scripts/fetch-drive-video.ts";

const NOW = new Date("2026-10-28T23:00:00Z");
const FOLDER = "application/vnd.google-apps.folder";
const EDITION_ID = "ed";

const file = (id: string, name: string, extra: Partial<DriveVideoFile> = {}): DriveVideoFile => ({
  id,
  name,
  mimeType: "video/mp4",
  createdTime: "2026-10-28T20:00:00Z",
  modifiedTime: "2026-10-28T20:00:00Z",
  size: "5",
  ...extra,
});

const YT = (n: number, extra: Partial<DriveVideoFile> = {}) =>
  file(`yt${n}`, `Diaria comentada_Youtube_V${n}.mp4`, { videoMediaMetadata: { width: 1920, height: 1080 }, ...extra });
const IG1 = file("ig1", "edição 6_Instagram_V1.mp4", { videoMediaMetadata: { width: 1080, height: 1920 } });
const IG2 = file("ig2", "Diaria comentada_Instagram_V2.mp4", { videoMediaMetadata: { width: 1080, height: 1920 } });
const STILL = file("still", "Diaria comentada_Youtube_Still.jpg", { mimeType: "image/jpeg" });

/** Drive mockado: subpastas da edição por nome, POST de pasta/cópia registrados. */
function mockDrive(subfolders: Record<string, DriveVideoFile[]>) {
  const posts: { url: string; body: any }[] = [];
  const idOf = (name: string) => `sub-${name.replace(/\W+/g, "_")}`;
  const deps: FetchDriveVideoDeps = {
    async driveFetch(url: string, init?: DriveFetchInit) {
      const u = new URL(url);
      if (init?.method === "POST") {
        const body = JSON.parse(init.body ?? "{}");
        posts.push({ url, body });
        if (u.pathname.endsWith("/copy")) return Response.json({ id: `copy-of-${u.pathname.split("/").at(-2)}` });
        return Response.json({ id: "new-final" });
      }
      if (u.pathname.endsWith("/files")) {
        const q = u.searchParams.get("q") ?? "";
        for (const [name, files] of Object.entries(subfolders)) {
          if (q.includes(`'${idOf(name)}'`)) return Response.json({ files });
        }
        if (q.includes(`'${EDITION_ID}'`)) {
          return Response.json({ files: Object.keys(subfolders).map((name) => ({ id: idOf(name), name, mimeType: FOLDER })) });
        }
        return Response.json({ files: [{ id: EDITION_ID, name: "261029", mimeType: FOLDER }] });
      }
      return Response.json({ id: "root", mimeType: FOLDER });
    },
  };
  return { deps, posts, idOf };
}

async function run(
  subfolders: Record<string, DriveVideoFile[]>,
  opts: Partial<FetchDriveVideoInput> = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "fdv-11556-"));
  const logs: string[] = [];
  try {
    const drive = mockDrive(subfolders);
    const out = await runFetchDriveVideo(
      drive.deps,
      {
        aammdd: "261029",
        orientation: "horizontal",
        folderId: "root",
        editionDir: dir,
        now: NOW,
        windowHours: 36,
        dryRun: true,
        force: false,
        ...opts,
      },
      (l) => logs.push(l),
    );
    return { out, logs, posts: drive.posts, idOf: drive.idOf };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("videoVersionOf: _V5, ' V2', -v12; FINAL e nome sem versão = null", () => {
  assert.equal(videoVersionOf("Diaria comentada_Youtube_V5.mp4"), 5);
  assert.equal(videoVersionOf("edição 6_Instagram_V1.mp4"), 1);
  assert.equal(videoVersionOf("corte v12.mp4"), 12);
  assert.equal(videoVersionOf("Diaria comentada_Youtube_FINAL.mp4"), null);
  assert.equal(videoVersionOf("Diaria comentada_Youtube.mp4"), null);
  assert.equal(videoVersionOf("V1 e V2.mp4"), null, "duas versões no nome não decidem");
});

test("pickHighestVersion: maior n; empate no n desfeito pelo modifiedTime; empate real = null", () => {
  assert.equal(pickHighestVersion([YT(1), YT(5), YT(3)])?.file.id, "yt5");
  const a = YT(2, { id: "a", modifiedTime: "2026-10-28T20:00:00Z" });
  const b = YT(2, { id: "b", modifiedTime: "2026-10-28T21:00:00Z" });
  const tie = pickHighestVersion([a, b]);
  assert.equal(tie?.file.id, "b");
  assert.match(tie?.premise ?? "", /modificada por último/);
  assert.equal(pickHighestVersion([a, YT(2, { id: "c", modifiedTime: a.modifiedTime })]), null, "mesmo n e mesma data");
  assert.equal(pickHighestVersion([YT(1), file("x", "Diaria comentada_Youtube_FINAL.mp4")]), null, "nome sem versão");
});

test("selectDriveVideo: V1..V5 em Editados/ escolhe o V5 com premissa; os mesmos em Final/ seguem ambíguos", () => {
  const versions = [1, 2, 3, 4, 5].map((n) => YT(n));
  const edited = versions.map((f) => ({ ...f, scope: "final-folder" as const, editedFolder: true }));
  const sel = selectDriveVideo(edited, { orientation: "horizontal", now: NOW, editionFolderPresent: true });
  assert.equal(sel.kind, "found");
  if (sel.kind === "found") {
    assert.equal(sel.file.id, "yt5");
    assert.match(sel.premise ?? "", /versão mais alta em Editados\/.*V5/);
  }
  const inFinal = versions.map((f) => ({ ...f, scope: "final-folder" as const }));
  assert.equal(selectDriveVideo(inFinal, { orientation: "horizontal", now: NOW, editionFolderPresent: true }).kind, "ambiguous");
});

test("cenário 261029 (horizontal): só Editados/ com V1..V5 → V5, premissa no JSON, nada escrito sem promote", async () => {
  const { out, logs, posts } = await run({ Editados: [...[1, 2, 3, 4, 5].map((n) => YT(n)), IG1, IG2, STILL] });
  assert.equal(out.exitCode, 0);
  assert.equal(out.output.action, "dry-run");
  if (out.output.action === "dry-run") {
    assert.equal(out.output.file.id, "yt5");
    assert.match(out.output.premise ?? "", /V5/);
    assert.equal(out.output.promoted, undefined);
  }
  assert.ok(logs.some((l) => l.startsWith("[premissa]") && l.includes("V5")));
  assert.equal(posts.length, 0, "sem promote, nenhuma escrita no Drive");
});

test("cenário 261029 (Instagram): 'edição 6_Instagram_V1' e '_Instagram_V2' → V2, não needs-editor", async () => {
  const { out } = await run({ Editados: [...[1, 2, 3, 4, 5].map((n) => YT(n)), IG1, IG2] }, { orientation: "vertical", target: "instagram" });
  assert.equal(out.exitCode, 0);
  assert.equal(out.output.action, "print-id");
  if (out.output.action === "print-id") assert.equal(out.output.file.id, "ig2");
});

test("promote sem Final/: cria Final/ na pasta da edição e copia o escolhido com a marca diaria_promoted_from", async () => {
  const { out, posts } = await run({ Editados: [YT(4), YT(5)] }, { promote: true });
  assert.equal(out.output.action, "dry-run");
  assert.equal(posts.length, 2);
  assert.match(posts[0].url, /\/files\?/);
  assert.deepEqual(posts[0].body, { name: "Final", mimeType: FOLDER, parents: [EDITION_ID] });
  assert.match(posts[1].url, /\/files\/yt5\/copy\?/);
  assert.deepEqual(posts[1].body, { name: "Diaria comentada_Youtube_V5.mp4", parents: ["new-final"], appProperties: { [PROMOTED_FROM_PROPERTY]: "yt5" } });
  if (out.output.action === "dry-run") {
    assert.deepEqual(out.output.promoted, { status: "copied", final_folder_id: "new-final", file_id: "copy-of-yt5", created_folder: true });
  }
});

test("promote com Final/ já contendo a cópia do horizontal: Instagram ainda desce em Editados/ e copia para a Final/ existente", async () => {
  const promotedYt = YT(5, { id: "yt5-copy", appProperties: { [PROMOTED_FROM_PROPERTY]: "yt5" } });
  const { out, posts, idOf } = await run(
    { Final: [promotedYt], Editados: [YT(5), IG1, IG2] },
    { orientation: "vertical", target: "instagram", promote: true },
  );
  assert.equal(out.output.action, "print-id", JSON.stringify(out.output));
  if (out.output.action === "print-id") {
    assert.equal(out.output.file.id, "ig2");
    assert.equal(out.output.promoted?.status, "copied");
  }
  assert.equal(posts.length, 1, "Final/ já existe: só a cópia");
  assert.deepEqual(posts[0].body.parents, [idOf("Final")]);
});

test("promoteToFinal idempotente: nome igual (ou cópia marcada) já em Final/ é 'already', sem escrita", async () => {
  const { deps, posts } = mockDrive({});
  const base = { editionFolderId: EDITION_ID, finalFolderIds: ["fin"], file: IG2, timeoutMs: 1000 };
  const sameName = await promoteToFinal(deps, { ...base, finalFiles: [file("c1", IG2.name)] });
  assert.deepEqual(sameName, { status: "already", final_folder_id: "fin", file_id: "c1" });
  const marked = await promoteToFinal(deps, { ...base, finalFiles: [file("c2", "renomeado.mp4", { appProperties: { [PROMOTED_FROM_PROPERTY]: "ig2" } })] });
  assert.equal(marked.status, "already");
  assert.equal(posts.length, 0);
});

test("promoteToFinal: falha da Drive API vira status error (a escolha segue valendo)", async () => {
  const deps: FetchDriveVideoDeps = { driveFetch: async () => new Response("quota", { status: 403 }) };
  const r = await promoteToFinal(deps, { editionFolderId: EDITION_ID, finalFolderIds: ["fin"], finalFiles: [], file: IG2, timeoutMs: 1000 });
  assert.equal(r.status, "error");
  if (r.status === "error") assert.match(r.error, /403/);
});

test("Final/ com .mp4 do próprio editor (não promovido) segue barrando Editados/ para o Instagram (#11419)", async () => {
  const { out } = await run({ Final: [file("o", "Diaria comentada_Outras redes_V3.mp4", { videoMediaMetadata: { width: 1080, height: 1920 } })], Editados: [IG1, IG2] }, {
    orientation: "vertical",
    target: "instagram",
  });
  assert.equal(out.output.action, "print-id");
  if (out.output.action === "print-id") assert.equal(out.output.file.id, "o");
});
