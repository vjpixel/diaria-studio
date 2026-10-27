import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupPublishedVideo, shortsVideoTerminal } from "../scripts/lib/diaria/published-video-cleanup.ts";
import { DEFAULT_SHORTS_CONFIG } from "../scripts/lib/diaria/short-video.ts";
import { parseShortsCliArgs } from "../scripts/publish-shorts.ts";

const edition = "261027";
const cfg = { ...DEFAULT_SHORTS_CONFIG, facebookPages: [], instagram: true, linkedinProfile: true, threadsProfile: false, x: false };
function fixture(fn: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "cleanup-"));
  mkdirSync(join(dir, "_internal"));
  try { fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}
function ledger(dir: string, file: string, destinations: string[], status = "published") {
  writeFileSync(join(dir, "_internal", file), JSON.stringify({ aammdd: edition, entries: destinations.map(destination => ({ destination, status, id: "id", at: "2026-10-27T00:00:00Z" })) }));
}
const main = "06-shorts-published.json";
const timer = "06-shorts-published.linkedin-timer.json";
const video = `diaria-comentada-${edition}-short.mp4`;
const cleanup = (dir: string, keepVideo = false) => cleanupPublishedVideo({ dir, edition, kind: "vertical", config: cfg, keepVideo, log: () => {} });

test("preserva vertical até o timer terminar; send_unknown não é terminal", () => fixture(dir => {
  writeFileSync(join(dir, video), "video");
  ledger(dir, main, ["youtube_shorts", "instagram", "facebook_profile"]);
  for (const status of [null, "send_unknown", "scheduled"]) {
    if (status) ledger(dir, timer, ["linkedin_profile"], status);
    cleanup(dir);
    assert.equal(existsSync(join(dir, video)), status !== "scheduled");
  }
  assert.equal(shortsVideoTerminal(dir, edition, cfg), true);
}));

test("facebook_profile guiado pendente preserva o vertical; linkedin_page_repost não bloqueia (review #11270, achado 1)", () => fixture(dir => {
  const withRepost = { ...cfg, linkedinPageRepost: true };
  writeFileSync(join(dir, video), "video");
  // Todos os destinos de API + YouTube terminais, mas o perfil do Facebook (etapa
  // guiada que usa o arquivo local) ainda não foi postado: o arquivo fica.
  ledger(dir, main, ["youtube_shorts", "instagram", "linkedin_profile"]);
  assert.equal(shortsVideoTerminal(dir, edition, withRepost), false);
  cleanupPublishedVideo({ dir, edition, kind: "vertical", config: withRepost, log: () => {} });
  assert.ok(existsSync(join(dir, video)));
  // facebook_profile publicado: terminal mesmo com linkedin_page_repost sem registro.
  ledger(dir, main, ["youtube_shorts", "instagram", "linkedin_profile", "facebook_profile"]);
  assert.equal(shortsVideoTerminal(dir, edition, withRepost), true);
  cleanupPublishedVideo({ dir, edition, kind: "vertical", config: withRepost, log: () => {} });
  assert.ok(!existsSync(join(dir, video)));
}));

test("cleanup nunca lança: registro ilegível ou config que lança vira aviso e mantém os arquivos (achado 3)", () => fixture(dir => {
  writeFileSync(join(dir, video), "video");
  const ig = join(dir, `diaria-comentada-${edition}-short-instagram.mp4`);
  writeFileSync(ig, "x");
  const lines: string[] = [];
  const log = (l: string) => lines.push(l);
  writeFileSync(join(dir, "_internal", main), "{ não é json");
  assert.doesNotThrow(() => cleanupPublishedVideo({ dir, edition, kind: "vertical", config: cfg, log }));
  ledger(dir, main, ["youtube_shorts", "instagram", "facebook_profile", "linkedin_profile"]);
  assert.doesNotThrow(() => cleanupPublishedVideo({ dir, edition, kind: "vertical", config: () => { throw new Error("config quebrada"); }, log }));
  assert.doesNotThrow(() => cleanupPublishedVideo({ dir, edition, kind: "vertical", log }));
  writeFileSync(join(dir, "_internal", "05-youtube-published.json"), "{ quebrado");
  assert.doesNotThrow(() => cleanupPublishedVideo({ dir, edition, kind: "horizontal", log }));
  assert.ok(existsSync(join(dir, video))); assert.ok(existsSync(ig));
  assert.equal(lines.length, 4);
  assert.ok(lines.every(l => l.startsWith("[aviso] limpeza do vídeo")), lines.join("\n"));
  assert.ok(lines[1].includes("config quebrada"));
}));

test("keep-video preserva tudo; Instagram queued preserva Chrome até confirmação", () => fixture(dir => {
  const chrome = join(dir, "_internal", `diaria-comentada-${edition}-short-instagram-chrome.mp4`);
  const ig = join(dir, `diaria-comentada-${edition}-short-instagram.mp4`);
  for (const p of [chrome, `${chrome}.json`, ig, join(dir, video)]) writeFileSync(p, "x");
  ledger(dir, main, ["youtube_shorts", "instagram", "linkedin_profile"], "scheduled");
  cleanup(dir, true);
  for (const p of [chrome, `${chrome}.json`, ig, join(dir, video)]) assert.ok(existsSync(p));
  cleanup(dir);
  assert.ok(existsSync(chrome)); assert.ok(!existsSync(ig));
  ledger(dir, main, ["instagram"]);
  cleanup(dir);
  assert.ok(!existsSync(chrome)); assert.ok(!existsSync(`${chrome}.json`));
}));

test("horizontal exige status aceito desta edição e ignora paths do registro e symlinks", () => fixture(dir => {
  const local = join(dir, `diaria-comentada-${edition}.mp4`);
  const other = join(dir, "other.mp4"); writeFileSync(other, "x");
  symlinkSync(other, local);
  const run = () => cleanupPublishedVideo({ dir, edition, kind: "horizontal", log: () => {} });
  for (const uploadStatus of [undefined, "failed", "rejected", "processed"]) {
    writeFileSync(join(dir, "_internal", "05-youtube-published.json"), JSON.stringify({ aammdd: edition, videoId: "id", video_path: other, rereadStatus: { uploadStatus } }));
    run(); assert.ok(existsSync(local)); assert.ok(existsSync(other));
  }
  rmSync(local); writeFileSync(local, "x"); run(); assert.ok(!existsSync(local));
  writeFileSync(local, "x");
  writeFileSync(join(dir, "_internal", "05-youtube-published.json"), JSON.stringify({ aammdd: edition, status: "upload_indeterminado" }));
  run(); assert.ok(existsSync(local));
}));

test("keep-video é booleano antes ou depois da edição", () => {
  for (const args of [["--keep-video", edition, "--publish"], [edition, "--publish", "--keep-video"]]) {
    const result = parseShortsCliArgs(args); assert.ok(result.ok);
    if (result.ok) assert.ok(result.flags.has("keep-video"));
  }
});

test("fetch vertical concluído não consulta o Drive nem solicita novo download", async () => {
  const { runFetchDriveVideo } = await import("../scripts/fetch-drive-video.ts");
  const { loadShortsConfig, listShortDestinations } = await import("../scripts/lib/diaria/short-video.ts");
  const { readFileSync } = await import("node:fs");
  const config = loadShortsConfig(JSON.parse(readFileSync(new URL("../platform.config.json", import.meta.url), "utf8")));
  const dir = mkdtempSync(join(tmpdir(), "fetch-cleaned-"));
  mkdirSync(join(dir, "_internal"));
  try {
    ledger(dir, main, listShortDestinations(config).map(d => d.id));
    const outcome = await runFetchDriveVideo({} as never, { aammdd: edition, editionDir: dir, orientation: "vertical", folderId: "unused", now: new Date(), windowHours: 24, dryRun: false, force: false }, () => {});
    assert.equal(outcome.output.action, "already-published");
    assert.equal(existsSync(join(dir, video)), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
