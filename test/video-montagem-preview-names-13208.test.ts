import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DRIVE_UPLOADS_FILE, previewFileName, reviewFinalSequence, uploadAll, type DriveSession } from "../scripts/video-montagem.ts";

it("#13208: nomes por formato, cortes preservados e review-final reconhece as prévias", () => {
  for (const [key, format] of [["youtube", "horizontal"], ["outras-redes", "vertical"], ["instagram", "vertical"], ["soberana", "soberana"]]) {
    assert.equal(previewFileName("261116", key), `261116 - previa ${format}.mp4`);
  }
  assert.deepEqual(reviewFinalSequence(previewFileName("261116", "youtube"), undefined), { target: "youtube", key: "youtube" });
  assert.deepEqual(reviewFinalSequence(previewFileName("261116", "outras-redes"), undefined), { target: "outras-redes", key: "outras-redes" });
  assert.deepEqual(reviewFinalSequence(previewFileName("261116", "soberana"), "soberana", [{ target: "instagram", corte: "soberana" }]), { target: "instagram", key: "soberana" });
});

it("#13208: upload preserva o antigo, atualiza o novo por id e avisa uma vez por edição", async () => {
  const dir = mkdtempSync(join(tmpdir(), "preview-13208-"));
  const name = previewFileName("261116", "youtube");
  const path = join(dir, name);
  const calls: string[] = [];
  const logs: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { logs.push(args.join(" ")); };
  const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { "content-type": "application/json" } });
  const d: DriveSession = {
    edition: "261116", cacheDir: dir,
    folder: async () => ({ id: "folder", name: "261116", mimeType: "application/vnd.google-apps.folder" }),
    deps: {
      driveFetch: async (_url, init) => {
        calls.push(init?.method ?? "GET");
        if (init?.method === "PATCH") return new Response("", { headers: { location: "https://upload.example/session" } });
        return json({ files: [{ id: "new-id", name, mimeType: "video/mp4" }] });
      },
      uploadFetch: async () => json({ id: "new-id", name }),
    },
  };
  try {
    writeFileSync(path, "preview");
    writeFileSync(join(dir, DRIVE_UPLOADS_FILE), JSON.stringify({ files: { "261116 - previa youtube.mp4": { id: "old-id" } }, pending: [] }));
    for (let i = 0; i < 2; i++) assert.equal((await uploadAll({ stateDir: dir, edition: "261116" }, d, [path])).error, null);
    const reg = JSON.parse(readFileSync(join(dir, DRIVE_UPLOADS_FILE), "utf8"));
    assert.equal(reg.files["261116 - previa youtube.mp4"].id, "old-id");
    assert.equal(reg.files[name].id, "new-id");
    assert.equal(reg.previewNamesNoticeShown, true);
    assert.equal(logs.filter((s) => s.includes("[aviso] #13208")).length, 1);
    assert.deepEqual(calls, ["GET", "PATCH", "GET", "PATCH"]);
  } finally {
    console.error = original;
    rmSync(dir, { recursive: true, force: true });
  }
});
