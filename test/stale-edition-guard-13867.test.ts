/**
 * #13867 — no fluxo `/diaria-publica`, a Parte A grava `05-video-url.txt` e
 * `05-youtube-published.json` na edição logo antes do assert da Etapa 5. Sem
 * o sentinel 4, esse mtime recente disparava `prev_gate_in_transit` mesmo com
 * o gate nunca aprovado, e o playbook mandava "aguardar o sync" em vez de
 * repassar a ação do stderr do guard.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isPublicaVideoFile, PUBLICA_VIDEO_DIRS, PUBLICA_VIDEO_FILES } from "../scripts/lib/stale-edition-guard.ts";
import { findNewestFile } from "../scripts/lib/sentinel-absence-hint.ts";
import { runStaleEditionGuard } from "../scripts/stale-edition-guard.ts";
import { D1_VIDEO_URL_FILE } from "../scripts/lib/diaria/d1-video-link.ts";
import { YOUTUBE_PUBLISHED_FILE } from "../scripts/lib/diaria/youtube-upload.ts";
import { YOUTUBE_PENDING_APPROVAL_FILE } from "../scripts/lib/diaria/youtube-pending-approval.ts";
import { PUBLICA_PHASES_FILE } from "../scripts/lib/diaria/publica-phases.ts";
import { YOUTUBE_THUMB_FILE, youtubeVideoFileName } from "../scripts/lib/diaria/youtube-video.ts";
import { youtubeCaptionFileName } from "../scripts/lib/diaria/youtube-captions.ts";
import { SHORT_COVER_FILE, SHORT_COVER_SOURCE_FILE } from "../scripts/lib/diaria/short-cover.ts";
import { THUMB_FRAMES_DIR } from "../scripts/lib/diaria/youtube-thumb-frames.ts";
import { THUMB_PORTRAITS_DIR } from "../scripts/lib/diaria/youtube-thumb-portrait.ts";
import { THUMB_CAPA_BG_DIR } from "../scripts/lib/diaria/youtube-thumb-capa-bg.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const NOW = Date.parse("2026-11-23T10:00:00Z");
const HOURS_AGO = (NOW - 5 * 3_600_000) / 1000;
const MIN_AGO = (NOW - 2 * 60_000) / 1000;

/** Edição com Etapas 1-3 feitas há horas, sem sentinel 4. */
function staleEdition(): string {
  const dir = mkdtempSync(join(tmpdir(), "stale-13867-"));
  mkdirSync(join(dir, "_internal"), { recursive: true });
  for (const f of ["02-reviewed.md", "03-social.md", "_internal/.step-3-done.json"]) {
    writeFileSync(join(dir, f), "x");
    utimesSync(join(dir, f), HOURS_AGO, HOURS_AGO);
  }
  return dir;
}
function touchRecent(dir: string, rel: string): void {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), "x");
  utimesSync(join(dir, rel), MIN_AGO, MIN_AGO);
}
const guard = (dir: string) =>
  runStaleEditionGuard(["check", "--edition-dir", dir, "--step", "4", "--caller-stage", "5"], { host: "300", now: NOW });

describe("#13867 arquivos de vídeo do /diaria-publica não contam como atividade recente", () => {
  it("Parte A recém-gravada (05-video-url.txt + 05-youtube-published.json), gate nunca aprovado → exit 0", () => {
    const dir = staleEdition();
    touchRecent(dir, "_internal/05-video-url.txt");
    touchRecent(dir, "_internal/05-youtube-published.json");
    touchRecent(dir, "diaria-comentada-261123.mp4");
    assert.equal(guard(dir), 0);
  });
  it("arquivo editorial recente (sync do gate em trânsito) segue disparando exit 4", () => {
    const dir = staleEdition();
    touchRecent(dir, "_internal/05-video-url.txt");
    touchRecent(dir, "02-reviewed.md");
    assert.equal(guard(dir), 4);
  });
  it("findNewestFile com exclude ignora os de vídeo; sem exclude, não", () => {
    const dir = staleEdition();
    touchRecent(dir, "_internal/05-youtube-published.json");
    assert.equal(findNewestFile(dir)?.relPath, "_internal/05-youtube-published.json");
    assert.notEqual(findNewestFile(dir, 4, isPublicaVideoFile)?.relPath, "_internal/05-youtube-published.json");
  });
  it("lista bate com as constantes de origem (não deriva em silêncio)", () => {
    for (const f of [
      D1_VIDEO_URL_FILE, YOUTUBE_PUBLISHED_FILE, YOUTUBE_PENDING_APPROVAL_FILE, PUBLICA_PHASES_FILE,
      YOUTUBE_THUMB_FILE, SHORT_COVER_FILE, SHORT_COVER_SOURCE_FILE,
    ]) {
      assert.ok(PUBLICA_VIDEO_FILES.includes(f), f);
    }
    for (const d of [THUMB_FRAMES_DIR, THUMB_PORTRAITS_DIR, THUMB_CAPA_BG_DIR]) {
      assert.ok(PUBLICA_VIDEO_DIRS.includes(`${d}/`), d);
      assert.ok(isPublicaVideoFile(`${d}/frame-01.jpg`));
    }
    assert.ok(isPublicaVideoFile(youtubeVideoFileName("261123")));
    assert.ok(isPublicaVideoFile(youtubeCaptionFileName("261123")));
    assert.ok(isPublicaVideoFile("diaria-comentada-261123-short.mp4"));
    assert.ok(isPublicaVideoFile("_internal/video-publish-plan.horizontal.json"));
    assert.ok(isPublicaVideoFile("_internal\\05-video-url.txt"));
  });
  it("arquivos editoriais nunca são excluídos", () => {
    for (const f of ["02-reviewed.md", "03-social.md", "_internal/.step-4-done.json", "04-d1-2x1.jpg", "_internal/05-edition-url.txt"]) {
      assert.equal(isPublicaVideoFile(f), false, f);
    }
  });
  it("playbook do Stage 5: exit 4 só com prev_gate_in_transit repassa a ação do stderr", () => {
    const stage5 = readFileSync(join(ROOT, ".claude/agents/orchestrator-stage-5.md"), "utf8");
    assert.match(stage5, /TODOS os `signals` do JSON do stdout de `kind` `prev_gate_in_transit`/);
    assert.match(stage5, /a mensagem do stderr do guard, repassada como está/);
    assert.match(stage5, /Demais exit 4 \(outra máquina à frente/);
  });
});
