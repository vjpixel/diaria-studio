/**
 * #13389: na 261117 a pasta `{AAMMDD}/Editados/` (sem `Final/`) tinha
 * `261117_Diaria comentada_Vertical_V1.mp4` exportado em 1920x1080 (medido
 * com ffprobe no arquivo real), o horizontal e o corte
 * `26117_Diaria comentada_Vertical-guia_V1.mp4` (1080x1920). O fetch
 * respondeu `none` ("nenhum do destino outras-redes nem sem sufixo"), que
 * parecia "o vídeo ainda não subiu": o vertical tinha o sufixo certo e a
 * proporção errada. Agora: `needs-editor`/`orientation-mismatch` (exit 3), com
 * a lista do que foi recusado e por quê. Sem rede (Drive mockado).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { explainFinalFolderRejections, selectDriveVideo, type DriveVideoFile } from "../scripts/lib/diaria/drive-video-source.ts";
import { runFetchDriveVideo, type FetchDriveVideoDeps, type FetchDriveVideoInput } from "../scripts/fetch-drive-video.ts";
import { buildInstagramTimerAlarm, chooseInstagramVideo, interpretInstagramCutLookup } from "../scripts/shorts-instagram-timer.ts";
import { buildLinkedinTimerAlarm, interpretDriveLookup } from "../scripts/shorts-linkedin-profile-timer.ts";
import { buildThreadsTimerAlarm, interpretThreadsVerticalLookup } from "../scripts/shorts-threads-profile-timer.ts";

const NOW = new Date("2026-11-17T00:57:00Z");
const FOLDER = "application/vnd.google-apps.folder";
const EDITION_ID = "ed";
const EDITADOS_ID = "editados";

const REAL_V = "261117_Diaria comentada_Vertical_V1.mp4";
const REAL_H = "261117_Diaria comentada_horizontal_V1.mp4";
const REAL_GUIA = "26117_Diaria comentada_Vertical-guia_V1.mp4";
const CORTES = [{ corte: "guia", screenTitle: "Médico falso de IA: como não cair" }];

const H = { width: 1920, height: 1080 };
const V = { width: 1080, height: 1920 };

const file = (id: string, name: string, dims?: { width: number; height: number }): DriveVideoFile => ({
  id,
  name,
  mimeType: "video/mp4",
  createdTime: "2026-11-17T00:32:00Z",
  modifiedTime: "2026-11-17T00:33:00Z",
  size: "112048659",
  ...(dims ? { videoMediaMetadata: dims } : {}),
});
const edited = (f: DriveVideoFile): DriveVideoFile => ({ ...f, scope: "final-folder", editedFolder: true, folderName: "Editados" });

test("selectDriveVideo: _Vertical_V1 em 1920x1080 é orientation-mismatch, não none", () => {
  const sel = selectDriveVideo([edited(file("v", REAL_V, H)), edited(file("h", REAL_H, H)), edited(file("g", REAL_GUIA, V))], {
    orientation: "vertical",
    now: NOW,
    editionFolderPresent: true,
    cortes: CORTES,
  });
  assert.equal(sel.kind, "orientation-mismatch", JSON.stringify(sel));
  if (sel.kind !== "orientation-mismatch") return;
  assert.deepEqual(sel.files.map((f) => f.id), ["v"]);
  assert.match(sel.reason, /261117_Diaria comentada_Vertical_V1\.mp4/);
  assert.match(sel.reason, /1920x1080/);
  const why = Object.fromEntries(sel.rejected.map((r) => [r.file.id, r.reason]));
  assert.match(why.v, /proporção no Drive é 1920x1080 \(horizontal\)/);
  assert.match(why.h, /destino youtube no nome \(horizontal\)/);
  assert.match(why.g, /corte guia/);
});

test("com a vertical em 1080x1920 o mesmo conjunto acha a vertical (o 261117_ e o corte guia não atrapalham)", () => {
  const sel = selectDriveVideo([edited(file("v", REAL_V, V)), edited(file("h", REAL_H, H)), edited(file("g", REAL_GUIA, V))], {
    orientation: "vertical",
    now: NOW,
    editionFolderPresent: true,
    cortes: CORTES,
  });
  assert.equal(sel.kind, "found", JSON.stringify(sel));
  if (sel.kind === "found") assert.equal(sel.file.id, "v");
});

test("none lista os recusados e o motivo de cada um", () => {
  const sel = selectDriveVideo([edited(file("h", REAL_H, H)), edited(file("g", REAL_GUIA, V)), edited(file("r", "rascunho vertical.mp4", V))], {
    orientation: "vertical",
    now: NOW,
    editionFolderPresent: true,
    cortes: CORTES,
  });
  assert.equal(sel.kind, "none", JSON.stringify(sel));
  if (sel.kind !== "none") return;
  assert.equal(sel.rejected?.length, 3);
  assert.match(sel.reason, /recusados: .*261117_Diaria comentada_horizontal_V1\.mp4: destino youtube/);
  assert.match(sel.reason, /26117_Diaria comentada_Vertical-guia_V1\.mp4: corte guia/);
  assert.match(sel.reason, /rascunho vertical\.mp4: sem sufixo de destino em Editados\//);
});

test("explainFinalFolderRejections: horizontal com sufixo e proporção vertical", () => {
  const [r] = explainFinalFolderRejections([edited(file("h", REAL_H, V))], "horizontal");
  assert.match(r.reason, /destino youtube no nome, mas a proporção no Drive é 1080x1920 \(vertical\)/);
});

function mockDrive(editados: DriveVideoFile[]): FetchDriveVideoDeps {
  return {
    async driveFetch(url) {
      const u = new URL(url);
      if (u.pathname.endsWith("/files")) {
        const q = u.searchParams.get("q") ?? "";
        if (q.includes(`'${EDITADOS_ID}'`)) return Response.json({ files: editados });
        if (q.includes(`'${EDITION_ID}'`)) return Response.json({ files: [{ id: EDITADOS_ID, name: "Editados", mimeType: FOLDER }] });
        return Response.json({ files: [{ id: EDITION_ID, name: "261117", mimeType: FOLDER }] });
      }
      return Response.json({ id: decodeURIComponent(u.pathname.split("/").pop() ?? ""), mimeType: FOLDER });
    },
  };
}

test("caso real 261117 (fetch, dry-run): needs-editor orientation-mismatch com exit 3 e os recusados", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fdv-13389-"));
  try {
    const input: FetchDriveVideoInput = {
      aammdd: "261117",
      orientation: "vertical",
      folderId: "root",
      editionDir: dir,
      now: NOW,
      windowHours: 36,
      dryRun: true,
      force: false,
      cortes: CORTES,
    };
    const lines: string[] = [];
    const out = await runFetchDriveVideo(
      mockDrive([file("v", REAL_V, H), file("h", REAL_H, H), file("g", REAL_GUIA, V)]),
      input,
      (l) => lines.push(l),
    );
    assert.equal(out.exitCode, 3);
    assert.equal(out.output.action, "needs-editor", JSON.stringify(out.output));
    if (out.output.action !== "needs-editor" || out.output.selection !== "orientation-mismatch") {
      assert.fail(`selection inesperada: ${JSON.stringify(out.output)}`);
    }
    assert.deepEqual(out.output.files.map((f) => f.id), ["v"]);
    assert.equal(out.output.rejected.length, 3);
    assert.ok(out.output.rejected.every((r) => r.reason.length > 0));
    assert.ok(lines.some((l) => /\[aviso\].*1920x1080/.test(l)), lines.join("\n"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("timers: orientation-mismatch vira needs-editor com o motivo real, não 'mais de um candidato'", () => {
  const stdout = JSON.stringify({ action: "needs-editor", selection: "orientation-mismatch", reason: `${REAL_V} ... 1920x1080`, edition_folder_id: EDITION_ID });
  const ig = interpretInstagramCutLookup(3, stdout);
  assert.equal(ig.kind, "needs-editor");
  if (ig.kind === "needs-editor") {
    assert.equal(ig.immediate, true);
    assert.match(ig.reason, /proporção errada.*1920x1080/);
  }
  const li = interpretDriveLookup(3, stdout);
  assert.equal(li.kind, "wait");
  if (li.kind === "wait") {
    assert.match(li.reason, /proporção errada.*1920x1080/);
    assert.equal(li.selection, "orientation-mismatch");
  }
  const th = interpretThreadsVerticalLookup(3, stdout);
  assert.equal(th.kind, "needs-editor");
  if (th.kind === "needs-editor") assert.match(th.reason, /proporção errada.*1920x1080/);

  const alarm = buildLinkedinTimerAlarm({
    aammdd: "261117",
    key: "drive-needs-editor",
    reason: "x",
    at: "2026-11-17T12:00:00Z",
    selection: "orientation-mismatch",
  });
  assert.match(alarm.body, /Reexporte o vertical na proporção vertical/);
  assert.doesNotMatch(alarm.body, /Deixe um só vertical/);
});

const FINAL_ID = "final";

/** `{AAMMDD}/` com `Final/` e `Editados/` (review #13399): a errada em Final/, a certa em Editados/. */
function mockDriveFinalAndEdited(finals: DriveVideoFile[], editados: DriveVideoFile[]): FetchDriveVideoDeps {
  return {
    async driveFetch(url) {
      const u = new URL(url);
      if (u.pathname.endsWith("/files")) {
        const q = u.searchParams.get("q") ?? "";
        if (q.includes(`'${FINAL_ID}'`)) return Response.json({ files: finals });
        if (q.includes(`'${EDITADOS_ID}'`)) return Response.json({ files: editados });
        if (q.includes(`'${EDITION_ID}'`)) {
          return Response.json({
            files: [
              { id: FINAL_ID, name: "Final", mimeType: FOLDER },
              { id: EDITADOS_ID, name: "Editados", mimeType: FOLDER },
            ],
          });
        }
        return Response.json({ files: [{ id: EDITION_ID, name: "261117", mimeType: FOLDER }] });
      }
      return Response.json({ id: decodeURIComponent(u.pathname.split("/").pop() ?? ""), mimeType: FOLDER });
    },
  };
}

for (const c of [
  { orientation: "vertical" as const, wrong: file("v1", "Diaria comentada_Vertical_V1.mp4", H), right: file("v2", "Diaria comentada_Vertical_V2.mp4", V) },
  { orientation: "horizontal" as const, wrong: file("h1", "Diaria comentada horizontal_V1.mp4", V), right: file("h2", "Diaria comentada horizontal_V2.mp4", H) },
]) {
  test(`${c.orientation}: errada em Final/ e certa em Editados/ → a de Editados/, exit 0 (review #13399)`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "fdv-13389-fe-"));
    try {
      const input: FetchDriveVideoInput = {
        aammdd: "261117",
        orientation: c.orientation,
        folderId: "root",
        editionDir: dir,
        now: NOW,
        windowHours: 36,
        dryRun: true,
        force: false,
        cortes: [],
      };
      const out = await runFetchDriveVideo(mockDriveFinalAndEdited([c.wrong], [c.right]), input, () => {});
      assert.equal(out.exitCode, 0, JSON.stringify(out.output));
      const o = out.output;
      assert.ok(o.action === "print-id" || o.action === "dry-run", JSON.stringify(o));
      if (o.action === "print-id" || o.action === "dry-run") assert.equal(o.file.id, c.right.id);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("alarmes de Instagram e Threads: orientation-mismatch pede reexportar, não 'deixe um só'", () => {
  const stdout = JSON.stringify({ action: "needs-editor", selection: "orientation-mismatch", reason: `${REAL_V} ... 1920x1080` });
  const choice = chooseInstagramVideo({
    instagramCutPath: "/x/ig.mp4",
    instagramCutExists: false,
    cutSidecar: null,
    genericPath: "/x/g.mp4",
    genericExists: false,
    lookup: interpretInstagramCutLookup(3, stdout),
  });
  assert.equal(choice.kind === "wait" ? choice.selection : null, "orientation-mismatch");

  const ig = buildInstagramTimerAlarm({ aammdd: "261117", key: "drive-needs-editor", reason: "x", videoArg: null, selection: "orientation-mismatch" });
  assert.match(ig.body, /Reexporte o vertical na proporção vertical/);
  assert.doesNotMatch(ig.body, /Deixe um só/);
  assert.match(buildInstagramTimerAlarm({ aammdd: "261117", key: "drive-needs-editor", reason: "x", videoArg: null }).body, /Deixe um só/);

  const th = interpretThreadsVerticalLookup(3, stdout);
  assert.equal(th.kind === "needs-editor" ? th.selection : null, "orientation-mismatch");
  const thAlarm = buildThreadsTimerAlarm({ aammdd: "261117", key: "drive-needs-editor", reason: "x", selection: "orientation-mismatch" });
  assert.match(thAlarm.body, /Reexporte o vertical na proporção vertical/);
  assert.doesNotMatch(thAlarm.body, /Deixe um só/);
  assert.match(buildThreadsTimerAlarm({ aammdd: "261117", key: "drive-needs-editor", reason: "x" }).body, /Deixe um só/);
});
