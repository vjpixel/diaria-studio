import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { runFetchDriveVideo, type FetchDriveVideoDeps } from "../scripts/fetch-drive-video.ts";
import { driveCoverCandidates, type DriveVideoFile } from "../scripts/lib/diaria/drive-video-source.ts";
import { planShortsPublish, publishInstagramReel, enqueueInstagramReel, uploadCoverOrFallback, type GraphDeps } from "../scripts/publish-shorts.ts";

const folder = (id: string, name: string) => ({ id, name, mimeType: "application/vnd.google-apps.folder" });
const still = (id: string, name = "Diaria comentada_Youtube_V1.00_00_03_08.Still001.png"): DriveVideoFile =>
  ({ id, name, mimeType: "image/png", scope: "final-folder", modifiedTime: "2026-10-29T01:33:00Z" });

test("Still e extensão obrigatórios; sequência Instagram antiga serve todos os verticais; raiz excluída", () => {
  const vertical = still("v", "261027 Vertical (Instagram).00_00_03_08.Still001.jpg");
  const files = [still("h"), vertical, still("wrong", "Youtube_capa.jpg"), still("video", "Youtube_Still.mp4"), { ...vertical, id: "root", scope: "root" as const }];
  assert.deepEqual(driveCoverCandidates(files, "horizontal").map((f) => f.id), ["h"]);
  assert.deepEqual(driveCoverCandidates(files, "vertical").map((f) => f.id), ["v"]);
});

for (const mode of ["download", "dry-run", "ambiguous", "ambiguous-sem-video", "ambiguous-sem-video-sem-capa", "bad-image", "drive-down", "local-preserved", "forced", "empty"] as const) {
  test(`fetch capa ${mode}: escopo da edição, vídeo local e precedência Drive`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "cover-11542-"));
    try {
      if (!mode.startsWith("ambiguous-sem-video")) writeFileSync(join(dir, "diaria-comentada-261029.mp4"), "video local");
      const dest = join(dir, "04-youtube-thumb.jpg");
      if (mode !== "download" && mode !== "dry-run" && mode !== "ambiguous-sem-video-sem-capa") writeFileSync(dest, mode === "empty" ? "" : "capa gerada");
      const lines: string[] = [];
      const bytes = mode === "bad-image" ? Buffer.from("not image") : await sharp({ create: { width: 16, height: 9, channels: 3, background: "red" } }).png().toBuffer();
      const mediaCalls: string[] = [];
      const deps: FetchDriveVideoDeps = { driveFetch: async (url) => {
        if (mode === "drive-down") throw new Error("ENOTFOUND www.googleapis.com");
        const u = new URL(url);
        if (u.searchParams.has("alt")) { mediaCalls.push(url); return new Response(new Uint8Array(bytes), { headers: { "content-type": "image/png" } }); }
        if (u.pathname.endsWith("/root")) return Response.json(folder("root", "YouTube"));
        const q = u.searchParams.get("q") ?? "";
        if (q.startsWith("'root'")) return Response.json({ files: [folder("edition", "261029"), folder("other", "261028")] });
        if (q.startsWith("'edition'")) return Response.json({ files: [folder("final", "Final"), folder("edited", "Editados")] });
        if (q.startsWith("'final'")) return Response.json({ files: [still("one")] });
        if (q.startsWith("'edited'")) return Response.json({ files: mode.startsWith("ambiguous") ? [still("two")] : [] });
        throw new Error(`unexpected folder: ${url}`);
      } };
      const result = await runFetchDriveVideo(deps, { aammdd: "261029", orientation: "horizontal", folderId: "root", editionDir: dir, now: new Date(), windowHours: 36, force: mode === "forced" || mode === "bad-image", dryRun: mode === "dry-run" }, (line) => lines.push(line));
      if (mode === "ambiguous" || mode === "drive-down") {
        // Review #11545: com o vídeo já em disco, capa ambígua ou Drive fora do ar não barram o `exists`.
        assert.equal(result.exitCode, 0);
        assert.equal(result.output.action, "exists");
        assert.equal(mediaCalls.length, 0);
        assert.equal(readFileSync(dest, "utf8"), "capa gerada");
      } else if (mode === "ambiguous-sem-video") {
        // #11650: capa local presente e sem --force, o Still do Drive nunca seria
        // usado; a ambiguidade dele não pode virar needs-editor.
        assert.equal(result.exitCode, 0);
        assert.equal(result.output.action, "none");
        assert.equal(result.output.cover?.source, "local");
        assert.equal(mediaCalls.length, 0);
        assert.equal(readFileSync(dest, "utf8"), "capa gerada");
      } else if (mode === "ambiguous-sem-video-sem-capa") {
        // Sem capa local o Still do Drive seria usado: a ambiguidade segue com o editor.
        assert.equal(result.exitCode, 3);
        assert.equal(result.output.action, "needs-editor");
        if (result.output.action === "needs-editor" && result.output.selection === "ambiguous-cover") {
          assert.deepEqual(result.output.candidates.map((f) => [f.id, f.modifiedTime]), [["one", "2026-10-29T01:33:00Z"], ["two", "2026-10-29T01:33:00Z"]]);
        } else assert.fail("expected ambiguous-cover");
        assert.equal(mediaCalls.length, 0);
      } else if (mode === "local-preserved") {
        assert.equal(result.exitCode, 0);
        assert.equal(result.output.cover?.source, "local");
        assert.equal(result.output.cover?.file, undefined);
        assert.equal(mediaCalls.length, 0);
        assert.equal(readFileSync(dest, "utf8"), "capa gerada");
        assert.ok(!lines.some((line) => line.includes("[premissa] capa local substituída")));
      } else if (mode === "bad-image") {
        // Review #11545: capa é opcional — falha nela cai na capa local, o vídeo segue.
        assert.equal(result.exitCode, 0);
        assert.equal(result.output.cover?.source, "local");
        assert.equal(readFileSync(dest, "utf8"), "capa gerada");
        assert.equal(readdirSync(dir).length, 2, "não deixa temporários");
      } else {
        assert.equal(result.exitCode, 0);
        assert.equal(result.output.action, mode === "forced" ? "none" : "exists");
        assert.equal(result.output.cover?.source, "drive");
        assert.equal(mediaCalls.length, mode === "dry-run" ? 0 : 1);
        if (mode !== "dry-run") assert.equal((await sharp(dest).metadata()).format, "jpeg");
        assert.equal(lines.includes("[premissa] capa local substituída pelo Still do Drive"), mode === "forced");
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

test("Instagram direto envia cover_url ao criar container, preservando collab", async () => {
  let body: Record<string, string> = {};
  const seq = [{ id: "c" }, { success: true }, { status_code: "FINISHED" }, { id: "m" }, { permalink: "p" }];
  const deps: GraphDeps = { fetch: async (_u, init) => {
    if (init?.body instanceof URLSearchParams && init.body.get("media_type") === "REELS") body = Object.fromEntries(init.body);
    return Response.json(seq.shift());
  }, sleep: async () => {}, now: () => new Date(), log: () => {} };
  await publishInstagramReel(deps, "ig", "token", "v25.0", Buffer.from("video"), "caption", ["vjpixel"], "https://cdn.example/cover.jpg");
  assert.equal(body.cover_url, "https://cdn.example/cover.jpg");
  assert.equal(body.collaborators, '["vjpixel"]');
});

test("fila preserva capa pública no payload de enqueue", async () => {
  let payload: any;
  await enqueueInstagramReel({ uploadVideo: async () => "https://cdn.example/v.mp4", uploadCover: async () => "https://cdn.example/c.jpg", enqueue: async (p) => { payload = p; return { key: "k", scheduled_at: "2026-10-30T12:00:00Z" }; }, now: () => new Date("2026-10-29") }, { caption: "x", scheduledAt: "2026-10-30T12:00:00Z", igAccount: "diaria", idempotencyKey: "k" }, []);
  assert.equal(payload.cover_url, "https://cdn.example/c.jpg");
});


test("plano identifica capa, destinos suportados e fallback sem credenciais R2", () => {
  const input = {
    aammdd: "261029", reviewedMd: "DESTAQUE 1 | IA\n\n[Título](https://example.com)\n\nTexto do destaque.\n\nPor que isso importa: teste.\n\n---\n\nDESTAQUE 2 | IA\n\n[Outro](https://example.org)\n\nTexto.",
    now: new Date("2026-10-29T01:00:00Z"), config: { publishing: { shorts: { instagram: true, facebook_pages: [] } } },
    pages: [], instagramReady: true, published: { aammdd: "261029", entries: [] },
    video: { path: "v.mp4", exists: true, sizeBytes: 1 }, coverPath: "04-youtube-short-capa.jpg",
  };
  const ready = planShortsPublish({ ...input, coverUploadReady: true });
  assert.equal(ready.cover.path, input.coverPath);
  assert.equal(ready.cover.destinations.instagram, "cover_url");
  // #11547: sem a API do YouTube o Short é guiado — a capa vai pelo Studio.
  assert.match(ready.cover.destinations.youtube_shorts, /^guided/);
  assert.match(planShortsPublish(input).cover.destinations.instagram, /R2 credentials missing/);
});

test("review #11545: falha no upload da capa vira aviso e o Reel segue sem cover_url", async () => {
  const lines: string[] = [];
  // #11679: a falha volta como valor (o registro grava cover.ok=false), nunca como cover_url.
  assert.deepEqual(await uploadCoverOrFallback(() => Promise.reject(new Error("R2 503")), (l) => lines.push(l)), { error: "capa não enviada ao R2: R2 503" });
  assert.match(lines.join("\n"), /R2 503.*frame automático/);
  assert.equal(await uploadCoverOrFallback(async () => "https://r2/x.jpg", () => {}), "https://r2/x.jpg");
});
