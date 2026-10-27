#!/usr/bin/env node
/**
 * scripts/stage5-youtube.ts (#10659)
 *
 * §5b-youtube do Stage 5 num comando só: consentimento → `fetch-drive-video.ts
 * --orientation horizontal` → `publish-youtube.ts --upload` → registro do
 * passo em `_internal/05-youtube-step.json` + `run-log`.
 *
 * Por que existe: na 1ª Etapa 5 com o passo no playbook (261026) ele não rodou
 * (nem fetch, nem upload, nem o `log-event` pedido) e nada acusou — eram dois
 * comandos e um log em prosa, com consent `youtube: auto`. Aqui é um comando,
 * e o registro que ele grava SEMPRE (inclusive "consent desligado" e "sem
 * vídeo no Drive") é o que a invariante `youtube-step-ran` do Stage 5 confere.
 *
 * Uso: npx tsx scripts/stage5-youtube.ts AAMMDD --edition-dir DIR
 *
 * Nunca para a Etapa 5: exit 0 em todo desfecho (o motivo vai no JSON do
 * stdout e no registro); exit 2 só para uso inválido.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { isMainModule, parseArgs } from "./lib/cli-args.ts";
import { runCli } from "./lib/cli-exit.ts";
import { editionDir as editionDirFor } from "./lib/edition-paths.ts";
import { youtubeUploadEnabled, type PublishConsent } from "./lib/publish-consent.ts";
import { logEvent } from "./lib/run-log.ts";
import { D1_VIDEO_URL_FILE } from "./lib/diaria/d1-video-link.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const YOUTUBE_STEP_FILE = "_internal/05-youtube-step.json";
const CONSENT_FILE = "_internal/05-publish-consent.json";

export type YouTubeStepOutcome =
  | "consent-off"
  | "already-published"
  | "no-video"
  | "needs-editor"
  | "fetch-error"
  | "uploaded"
  | "upload-error";

export interface YouTubeStepRecord {
  aammdd: string;
  at: string;
  outcome: YouTubeStepOutcome;
  /** `action` do fetch (ausente quando o consent desligou o passo). */
  fetch_action?: string;
  fetch_exit?: number | null;
  upload_exit?: number | null;
  /** `url`/`state` do JSON do `--upload` (estado RELIDO, #573). */
  video_url?: string | null;
  state?: string | null;
  /** `_internal/05-video-url.txt` existe depois do passo (link no D1). */
  d1_link: boolean;
  detail?: string;
}

/** Puro: consentimento a partir do arquivo (ausente/ilegível → auto, como a chave ausente). */
export function consentAllowsYouTube(raw: string | null): { enabled: boolean; note?: string } {
  if (raw === null) return { enabled: true, note: "05-publish-consent.json ausente — tratado como auto" };
  try {
    return { enabled: youtubeUploadEnabled(JSON.parse(raw) as PublishConsent) };
  } catch (e) {
    return { enabled: true, note: `05-publish-consent.json ilegível (${(e as Error).message}) — tratado como auto` };
  }
}

/**
 * #11222: o editor sobe o horizontal pelo YouTube Studio e cola o link, que
 * vira `_internal/05-video-url.txt` (`link-video-d1.ts --save`) sem
 * `05-youtube-published.json`. Com o link já gravado, o vídeo existe no canal:
 * o passo não busca no Drive nem sobe de novo (desde o #11222 o fetch acha o
 * `_Youtube_` da pasta `Final/`, e subiria um 2º vídeo). Devolve a URL gravada,
 * ou null sem o arquivo.
 */
export function pastedVideoUrl(dir: string): string | null {
  const p = join(dir, D1_VIDEO_URL_FILE);
  if (!existsSync(p)) return null;
  const url = readFileSync(p, "utf8").trim();
  return url || null;
}

/** Puro: desfecho do fetch → próximo passo. */
export function classifyFetch(exitCode: number | null, stdout: string): { action: string; upload: boolean; outcome?: YouTubeStepOutcome; detail?: string } {
  let out: any = null;
  try {
    out = JSON.parse(stdout);
  } catch {
    return { action: "sem-json", upload: false, outcome: "fetch-error", detail: `fetch-drive-video.ts sem JSON (exit ${exitCode})` };
  }
  const action = String(out?.action ?? "sem-action");
  if (action === "downloaded" || action === "exists") return { action, upload: true };
  if (action === "already-published") return { action, upload: false, outcome: "already-published" };
  if (action === "none") return { action, upload: false, outcome: "no-video", detail: String(out.reason ?? "") };
  if (action === "needs-editor") return { action, upload: false, outcome: "needs-editor", detail: String(out.selection ?? "") };
  return { action, upload: false, outcome: "fetch-error", detail: String(out?.error ?? `exit ${exitCode}`) };
}

/** Puro: lê `url`/`state` do JSON do `publish-youtube.ts --upload` (pode vir vazio em falha). */
export function parseUploadStdout(stdout: string): { url: string | null; state: string | null } {
  try {
    const j = JSON.parse(stdout);
    return { url: typeof j?.url === "string" ? j.url : null, state: typeof j?.state === "string" ? j.state : null };
  } catch {
    return { url: null, state: null };
  }
}

function runTsx(args: string[]): { status: number | null; stdout: string } {
  const r = spawnSync(process.execPath, ["--import", "tsx", ...args], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    maxBuffer: 16 * 1024 * 1024,
  });
  if (r.error) return { status: null, stdout: "" };
  return { status: r.status, stdout: r.stdout ?? "" };
}

async function main(): Promise<number> {
  const { values, positional } = parseArgs(process.argv.slice(2));
  const aammdd = values["edition"] ?? positional[0];
  if (!aammdd || !/^\d{6}$/.test(aammdd)) {
    console.error("uso: stage5-youtube.ts AAMMDD --edition-dir DIR");
    return 2;
  }
  const dir = resolve(values["edition-dir"] ?? editionDirFor(aammdd));
  const consentPath = join(dir, CONSENT_FILE);
  const consent = consentAllowsYouTube(existsSync(consentPath) ? readFileSync(consentPath, "utf8") : null);
  if (consent.note) console.error(`[premissa] ${consent.note}`);

  const base = { aammdd, at: new Date().toISOString() };
  let record: Omit<YouTubeStepRecord, "d1_link">;
  const pasted = pastedVideoUrl(dir);
  if (!consent.enabled) {
    record = { ...base, outcome: "consent-off", detail: "consent.youtube manual/skipped" };
  } else if (pasted) {
    record = {
      ...base,
      outcome: "already-published",
      video_url: pasted,
      detail: `link já gravado em ${D1_VIDEO_URL_FILE} (vídeo no canal, subido pelo Studio ou pelo --upload, #11222) — nada buscado nem enviado`,
    };
  } else {
    const fetch = runTsx(["scripts/fetch-drive-video.ts", "--edition", aammdd, "--orientation", "horizontal", "--edition-dir", dir]);
    const f = classifyFetch(fetch.status, fetch.stdout);
    if (!f.upload) {
      record = { ...base, outcome: f.outcome!, fetch_action: f.action, fetch_exit: fetch.status, ...(f.detail ? { detail: f.detail } : {}) };
    } else {
      const up = runTsx(["scripts/publish-youtube.ts", aammdd, "--upload", "--edition-dir", dir]);
      const parsed = parseUploadStdout(up.stdout);
      record = {
        ...base,
        outcome: up.status === 0 ? "uploaded" : "upload-error",
        fetch_action: f.action,
        fetch_exit: fetch.status,
        upload_exit: up.status,
        video_url: parsed.url,
        state: parsed.state,
      };
    }
  }
  const full: YouTubeStepRecord = { ...record, d1_link: existsSync(join(dir, D1_VIDEO_URL_FILE)) };
  try {
    mkdirSync(join(dir, "_internal"), { recursive: true });
    writeFileAtomic(join(dir, YOUTUBE_STEP_FILE), JSON.stringify(full, null, 2) + "\n");
  } catch (e) {
    console.error(`[aviso] ${YOUTUBE_STEP_FILE} não gravado: ${(e as Error).message}`);
  }
  logEvent(
    {
      edition: aammdd,
      stage: 5,
      agent: "orchestrator",
      level: full.outcome === "fetch-error" || full.outcome === "upload-error" ? "warn" : "info",
      message: `youtube: ${full.outcome}, fetch ${full.fetch_action ?? "-"}, upload exit ${full.upload_exit ?? "-"}, video-url ${full.d1_link ? "gravado" : "ausente"}`,
      details: full,
    },
    ROOT,
  );
  console.log(JSON.stringify(full, null, 2));
  return 0;
}

if (isMainModule(import.meta.url)) {
  runCli(main, { onError: (e) => console.error("stage5-youtube:", e instanceof Error ? e.message : e) });
}
