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
 * Uso: npx tsx scripts/stage5-youtube.ts AAMMDD --edition-dir DIR [--upload-from-final] [--ignore-pending-approval]
 *
 * #11297: desde o #11222 o horizontal pronto mora em `{AAMMDD}/Final/` e o
 * editor o sobe pelo YouTube Studio. Sem o link colado, o fetch acharia o
 * `_Youtube_` de `Final/` e este passo subiria um 2º vídeo. Por isso o vídeo
 * escolhido em `Final/` só sobe com `--upload-from-final` (sinal explícito);
 * sem ele, o passo consulta o fetch em `--dry-run` (nada baixado) e registra
 * `awaiting-link`. Edições sem `Final/` seguem com o upload automático.
 *
 * #12122: com `_internal/05-youtube-pending-approval.json` (gravado pelo
 * `publish-youtube.ts --dry-run` do `/diaria-publica-video`, à espera do "pode
 * publicar"), o passo não busca nem sobe nada e registra `awaiting-approval`:
 * na 261104 o Stage 5 em paralelo subiu o horizontal antes da confirmação, com
 * a capa intermediária. `--ignore-pending-approval` sobrepõe (vídeo pela skill
 * abandonado, decisão do editor).
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
import { readD1VideoUrl } from "./lib/diaria/d1-video-link-file.ts";
import { publishConfirmArgs } from "./lib/diaria/publish-confirm.ts";
import { describePendingApproval, readPendingApproval } from "./lib/diaria/youtube-pending-approval.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const YOUTUBE_STEP_FILE = "_internal/05-youtube-step.json";
const CONSENT_FILE = "_internal/05-publish-consent.json";

export type YouTubeStepOutcome =
  | "consent-off"
  | "already-published"
  | "no-video"
  | "needs-editor"
  | "awaiting-link"
  | "awaiting-approval"
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
  /**
   * #12120: passo do podcast do `--upload` (`podcast` do JSON). `null` = o
   * upload não trouxe o campo (não tentado ou não gravado); ausente = sem upload.
   */
  podcast_ok?: boolean | null;
  podcast_error?: string | null;
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
 * `_Youtube_` da pasta `Final/`, e subiria um 2º vídeo).
 *
 * #11297: o conteúdo passa por `parseD1VideoUrlFile` (via `readD1VideoUrl`, o
 * mesmo parse dos publishers do D1), não só `trim()`. Arquivo presente com
 * conteúdo que não é link do YouTube devolve `invalid`: alguém colou algo ali,
 * então o passo também não sobe (seria arriscar o 2º vídeo) e leva ao editor.
 */
export type PastedVideoUrl = { url: string } | { invalid: string } | null;

export function pastedVideoUrl(dir: string): PastedVideoUrl {
  const read = readD1VideoUrl(dir);
  if (read.url) return { url: read.url };
  if (read.warning) return { invalid: read.warning };
  return null;
}

/** Próximo passo depois do fetch em `--dry-run` (#11297). */
export type FetchPlan =
  | { kind: "upload-existing"; action: string }
  | { kind: "download"; action: string }
  | { kind: "stop"; action: string; outcome: YouTubeStepOutcome; detail?: string };

/**
 * Puro (#11297): decide a partir do JSON do `fetch-drive-video.ts --dry-run`.
 * `dry-run` com o arquivo em `Final/` vira `awaiting-link` sem
 * `allowFinalUpload` (o editor sobe pelo Studio e cola o link); com o sinal,
 * ou fora de `Final/` (edição sem a pasta), segue para o download. `exists`
 * (arquivo local de um fetch explícito anterior) sobe como antes. O resto
 * reaproveita `classifyFetch`.
 */
export function planFromDryRun(exitCode: number | null, stdout: string, allowFinalUpload: boolean, aammdd = "{AAMMDD}"): FetchPlan {
  let out: any = null;
  try {
    out = JSON.parse(stdout);
  } catch {
    out = null;
  }
  if (out?.action === "dry-run") {
    if (out?.file?.scope === "final-folder" && !allowFinalUpload) {
      return {
        kind: "stop",
        action: "dry-run",
        outcome: "awaiting-link",
        detail:
          `${String(out?.file?.name ?? "vídeo")} está em Final/ e o horizontal sobe pelo YouTube Studio (#11222): nada baixado nem enviado. ` +
          `Colar o link com \`link-video-d1.ts ${aammdd} --save\` (ou /diaria-publica-video --video-url); ` +
          `para subir pela API, rodar o passo com --upload-from-final (#11297)`,
      };
    }
    return { kind: "download", action: "dry-run" };
  }
  const f = classifyFetch(exitCode, stdout);
  if (f.upload) return { kind: "upload-existing", action: f.action };
  return { kind: "stop", action: f.action, outcome: f.outcome!, ...(f.detail ? { detail: f.detail } : {}) };
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

/** Puro: lê `url`/`state`/`podcast` do JSON do `publish-youtube.ts --upload` (pode vir vazio em falha). */
export function parseUploadStdout(stdout: string): { url: string | null; state: string | null; podcastOk: boolean | null; podcastError: string | null } {
  try {
    const j = JSON.parse(stdout);
    const pod = j?.podcast && typeof j.podcast === "object" ? j.podcast : null;
    return {
      url: typeof j?.url === "string" ? j.url : null,
      state: typeof j?.state === "string" ? j.state : null,
      podcastOk: pod && typeof pod.ok === "boolean" ? pod.ok : null,
      podcastError: pod && typeof pod.error === "string" ? pod.error : null,
    };
  } catch {
    return { url: null, state: null, podcastOk: null, podcastError: null };
  }
}

/**
 * Puro (#12120): o passo do podcast é fail-soft dentro do `--upload` e só
 * aparece como `[aviso]` no stderr. Aqui ele vira nível `warn` no run-log do
 * passo, para ser conferido sem ler o log do upload.
 */
export function youtubeStepLevel(rec: Pick<YouTubeStepRecord, "outcome" | "podcast_ok">): "info" | "warn" {
  // #12287: o hold do "pode publicar" é `warn`, não desfecho normal — um
  // marcador esquecido faz o D1 sair sem o vídeo.
  if (rec.outcome === "fetch-error" || rec.outcome === "upload-error" || rec.outcome === "awaiting-approval") return "warn";
  if (rec.outcome === "uploaded" && rec.podcast_ok === false) return "warn";
  return "info";
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
  const { values, positional, flags } = parseArgs(process.argv.slice(2));
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
  const allowFinalUpload = flags.has("upload-from-final");
  const pending = readPendingApproval(dir, aammdd);
  if (pending.kind !== "none" && flags.has("ignore-pending-approval")) {
    console.error(`[premissa] --ignore-pending-approval: ${describePendingApproval(pending, aammdd)} — seguindo por decisão do editor`);
  }
  const fetchArgs = ["scripts/fetch-drive-video.ts", "--edition", aammdd, "--orientation", "horizontal", "--edition-dir", dir];
  const upload = (fetchAction: string, fetchExit: number | null): Omit<YouTubeStepRecord, "d1_link"> => {
    // #11741: o upload exige confirmação explícita; aqui ela é o consent da Etapa 5
    // (gate acima), decidido pelo editor no gate 4 — o passo não pergunta de novo.
    const up = runTsx(["scripts/publish-youtube.ts", aammdd, "--upload", "--edition-dir", dir, ...publishConfirmArgs(aammdd)]);
    const parsed = parseUploadStdout(up.stdout);
    return {
      ...base,
      outcome: up.status === 0 ? "uploaded" : "upload-error",
      fetch_action: fetchAction,
      fetch_exit: fetchExit,
      upload_exit: up.status,
      video_url: parsed.url,
      state: parsed.state,
      podcast_ok: parsed.podcastOk,
      ...(parsed.podcastError ? { podcast_error: parsed.podcastError } : {}),
    };
  };
  const fetchAndUpload = (): Omit<YouTubeStepRecord, "d1_link"> => {
    // #11551: o fetch só baixa com --download (o default é o plano, sem gravar nada).
    const fetch = runTsx([...fetchArgs, "--download"]);
    const f = classifyFetch(fetch.status, fetch.stdout);
    if (f.upload) return upload(f.action, fetch.status);
    return { ...base, outcome: f.outcome!, fetch_action: f.action, fetch_exit: fetch.status, ...(f.detail ? { detail: f.detail } : {}) };
  };
  if (!consent.enabled) {
    record = { ...base, outcome: "consent-off", detail: "consent.youtube manual/skipped" };
  } else if (pasted && "url" in pasted) {
    record = {
      ...base,
      outcome: "already-published",
      video_url: pasted.url,
      detail: `link já gravado em ${D1_VIDEO_URL_FILE} (vídeo no canal, subido pelo Studio ou pelo --upload, #11222) — nada buscado nem enviado`,
    };
  } else if (pasted) {
    record = {
      ...base,
      outcome: "needs-editor",
      detail: `${pasted.invalid} — o arquivo existe, então nada foi buscado nem enviado (#11297); corrigir com link-video-d1.ts ${aammdd} --save`,
    };
  } else if (pending.kind !== "none" && !flags.has("ignore-pending-approval")) {
    // #12122: a skill de vídeo está com o plano à espera do "pode publicar".
    record = { ...base, outcome: "awaiting-approval", detail: describePendingApproval(pending, aammdd, new Date()) };
    // #12287: banner no stderr com o comando de liberar, além do run-log.
    console.error(`[aviso] YouTube segurado: ${record.detail}`);
  } else if (allowFinalUpload) {
    // Sinal explícito do editor: baixa e sobe, inclusive de Final/.
    record = fetchAndUpload();
  } else {
    // #11297: consulta sem baixar; o `_Youtube_` de Final/ não sobe sem o sinal.
    const dry = runTsx([...fetchArgs, "--dry-run"]);
    const plan = planFromDryRun(dry.status, dry.stdout, false, aammdd);
    if (plan.kind === "stop") {
      record = { ...base, outcome: plan.outcome, fetch_action: plan.action, fetch_exit: dry.status, ...(plan.detail ? { detail: plan.detail } : {}) };
    } else if (plan.kind === "upload-existing") {
      record = upload(plan.action, dry.status);
    } else {
      record = fetchAndUpload();
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
      level: youtubeStepLevel(full),
      message:
        `youtube: ${full.outcome}, fetch ${full.fetch_action ?? "-"}, upload exit ${full.upload_exit ?? "-"}, video-url ${full.d1_link ? "gravado" : "ausente"}` +
        (full.podcast_ok === undefined ? "" : `, podcast ${full.podcast_ok === null ? "sem resultado" : full.podcast_ok ? "ok" : "FALHOU"}`),
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
