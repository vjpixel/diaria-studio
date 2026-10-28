#!/usr/bin/env node
/**
 * scripts/shorts-threads-profile-timer.ts (#11410)
 *
 * Passo do timer do `300` (`Diaria-Shorts-Threads-Profile` e o `-Catchup`,
 * `scripts/lib/scheduled-tasks.ts`) que publica o vertical da edição no
 * Threads PESSOAL do editor. A Threads API não agenda: sem o timer, o destino
 * `threads_profile` do `publish-shorts.ts` fica `pending_schedule` até alguém
 * rodar de novo depois do horário, e passadas 3 h vira `skip_late` (post à
 * mão). Molde: o timer do LinkedIn pessoal (#10982) e o do Instagram (#11265).
 *
 *   1. edição = hoje em BRT (o vertical sai no dia da própria edição);
 *   2. `decideThreadsTimerRun` (puro): destino desligado, timer desligado no
 *      config (`publishing.shorts.threads_profile_via_timer`), dia sem
 *      `02-reviewed.md` ou `threads_profile` já em qualquer arquivo do registro
 *      (inclusive `send_unknown` e as cópias de conflito do OneDrive) → nada a
 *      fazer; antes do horário do vertical (`resolveShortTime`) → espera; até
 *      3 h depois → publica; depois → não publica e alarma (`late`), só se o
 *      dia teve vertical;
 *   3. o vídeo: o vertical genérico no disco (`diaria-comentada-{AAMMDD}-short.mp4`,
 *      o mesmo que o timer do LinkedIn baixa). Fora do disco: com um download em
 *      curso (`.part` recente ou o lock do timer do LinkedIn), espera; senão
 *      acha o "final" vertical no Drive (`fetch-drive-video.ts --orientation
 *      vertical`) e baixa pelo `--from-drive` do publish-shorts (decisão do
 *      editor de 23/10: o editor salva no Drive e o 300 baixa);
 *   4. `publish-shorts.ts AAMMDD --only threads_profile --publish
 *      --threads-timer --now`. A rodada do timer reaproveita o objeto do
 *      vertical já no R2 (`shorts/`, mesmo tamanho) ou sobe de novo, confere o
 *      perfil antes de publicar (`threadsProfilePreflight`: o vídeo da edição
 *      já lá vira registro, nunca um 2º post) e grava no registro próprio
 *      (`06-shorts-published.threads-timer.json`, #11157). `--now` porque o
 *      timer já decidiu dentro da janela (o download não empurra pra `skip_late`);
 *   5. `interpretThreadsTimerOutput` (puro, tipado contra o `ShortsPlanItem`) lê
 *      o JSON e, quando o editor precisa agir, abre um alarme por MOTIVO
 *      (`ThreadsTimerAlarmKey`, fingerprint `{AAMMDD}:{id}`, família `evento`;
 *      `urgente` quando o vídeo não saiu no dia, `acao` quando ele pode estar no
 *      ar e só pede conferência). O mesmo alarme não repete a cada hora
 *      (`_internal/.shorts-threads-timer-alarm.json`, mesmas regras de estado
 *      do timer do Instagram); e-mail devido que não saiu é reenviado.
 *
 * Lock O_EXCL em `_internal/.shorts-threads-timer.lock` (`acquireTimerLock` do
 * timer do LinkedIn): a task diária e a de hora em hora nunca publicam juntas.
 *
 * Só age com `publishing.shorts.threads_profile_via_timer: true` (default
 * false): a task fica registrada e o editor liga o config junto com o arme no
 * 300. Pré-requisitos no 300: `THREADS_PERSONAL_*` e os secrets do R2 no
 * `.env`, e o OAuth do Drive (`data/.credentials.json`).
 *
 * Uso: npx tsx scripts/shorts-threads-profile-timer.ts [--edition AAMMDD] [--dry-run]
 *   --dry-run: decide e imprime os comandos, sem publicar e sem alarme (lê o Drive).
 *
 * Exit: 0 = feito, nada a fazer, esperando ou avisado; 1 = falha (Drive,
 * publish, alarme não aberto, exceção); 2 = uso.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule, parseArgs } from "./lib/cli-args.ts";
import { runCli } from "./lib/cli-exit.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { editionDir as editionDirFor } from "./lib/edition-paths.ts";
import { resolveEditionScheduledAt } from "./lib/edition-scheduled-at.ts";
import { notifyEditor, type NotifyEditorDeps, type NotifySeverity } from "./lib/editor-notify.ts";
import { aammddBrt, MAX_FIRE_LATENESS_MS } from "./lib/linkedin-personal.ts";
import { loadShortScheduleConfig, loadShortsConfig, parseShortsPublishedFile, resolveShortTime, shortVideoFileName } from "./lib/diaria/short-video.ts";
import { readShortsRegistryRaws } from "./lib/diaria/shorts-published-store.ts";
import { TIMER_LOCK_FILE as LINKEDIN_TIMER_LOCK_FILE, acquireTimerLock } from "./shorts-linkedin-profile-timer.ts";
import { DOWNLOAD_PART_FRESH_MS, SHORTS_THREADS_TIMER_LOCK_FILE, verticalDownloadBusy } from "./lib/diaria/vertical-download-guard.ts";
import { alarmDelivery, alreadyAlarmed, emailPending, nextAlarmState, parseAlarmState } from "./shorts-instagram-timer.ts";
// Só tipo: importar o publish-shorts em runtime carregaria o .env no import.
import type { ShortsPlanItem } from "./publish-shorts.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOG_PREFIX = "[shorts-threads-timer]";
const DESTINATION = "threads_profile";
export const THREADS_TIMER_LOCK_FILE = SHORTS_THREADS_TIMER_LOCK_FILE;
/** Alarmes já avisados ao editor nesta edição (não repete o mesmo a cada hora). */
export const THREADS_TIMER_ALARM_STATE_FILE = "_internal/.shorts-threads-timer-alarm.json";
/** Sem vertical 1 h depois do horário, num dia que teve vertical: alarma. */
export const THREADS_MISSING_VIDEO_ALARM_AFTER_MS = 60 * 60_000;
/** `.part` mais novo que isto = outro processo baixando o vertical agora (#11432: mora em `lib/diaria/vertical-download-guard.ts`). */
export { DOWNLOAD_PART_FRESH_MS };

/** Motivo do alarme — chave estável (fingerprint e dedup), nunca texto variável. */
export type ThreadsTimerAlarmKey =
  | "late"
  | "missing-video"
  | "drive-needs-editor"
  | "drive-error"
  | "credentials"
  /** Sem R2 configurado: a Threads API só recebe o vídeo por URL pública. */
  | "public-video"
  | "publish-failed"
  /** Envio ambíguo (`send_unknown`): o vídeo pode estar no ar. */
  | "send-unknown"
  /** O vídeo está no perfil, mas o registro não foi gravado. */
  | "published-unregistered"
  /** Vídeo no perfil no dia da edição sem o marcador dela: o timer não publica. */
  | "preflight-blocked"
  /** A leitura do perfil falhou: o timer não publica enquanto não conseguir conferir. */
  | "preflight-read-failed"
  | "no-output"
  | "crash";

/** O vídeo pode estar (ou está) no ar: `acao`, e o corpo nunca manda publicar. */
const MAYBE_PUBLISHED_KEYS: ReadonlySet<ThreadsTimerAlarmKey> = new Set(["send-unknown", "published-unregistered", "preflight-blocked"]);

/** Motivos em que a próxima execução (até `horário + 3 h`) tenta de novo sozinha. */
const RETRY_KEYS: ReadonlySet<ThreadsTimerAlarmKey> = new Set(["publish-failed", "credentials", "public-video", "no-output", "crash", "drive-error", "preflight-read-failed", "missing-video", "drive-needs-editor"]);

/** Motivos que juntam causas diferentes: a dedup leva também um hash curto da causa (mesmo critério do #11368). */
const MULTI_CAUSE_KEYS: ReadonlySet<ThreadsTimerAlarmKey> = new Set(["publish-failed", "crash", "no-output", "drive-error"]);

export function threadsAlarmSeverity(key: ThreadsTimerAlarmKey): NotifySeverity {
  return MAYBE_PUBLISHED_KEYS.has(key) ? "acao" : "urgente";
}

/** Puro: identidade do alarme na dedup e no fingerprint (motivo, + hash da 1ª linha nos de várias causas). */
export function threadsAlarmId(key: ThreadsTimerAlarmKey, detail: string): string {
  if (!MULTI_CAUSE_KEYS.has(key)) return key;
  const firstLine = detail.split("\n")[0] ?? "";
  const norm = firstLine.toLowerCase().replace(/\d+/g, "0").replace(/\s+/g, " ").trim().slice(0, 200);
  return `${key}#${createHash("sha256").update(norm).digest("hex").slice(0, 8)}`;
}

/**
 * Puro: o alarme já está coberto pelo estado da edição? O mesmo id não repete
 * (salvo com e-mail pendente: aí reenvia), e `late` não sai depois de um
 * motivo que diz "o vídeo pode estar no ar" — o corpo do `late` manda postar à mão.
 */
export function threadsAlarmSuppressed(stateRaw: string | null, key: ThreadsTimerAlarmKey, id: string = key): boolean {
  const state = parseAlarmState(stateRaw);
  const seen = [...state.alarmed, ...state.emailPending].map((k) => k.split("#")[0]);
  if (key === "late" && [...MAYBE_PUBLISHED_KEYS].some((k) => seen.includes(k))) return true;
  if (state.emailPending.includes(id)) return false;
  return state.alarmed.includes(id);
}

export type ThreadsTimerDecision =
  | { kind: "skip"; reason: string }
  | { kind: "wait"; reason: string; at: string; hhmm: string }
  | { kind: "late"; reason: string; at: string; hhmm: string }
  | { kind: "publish"; at: string; hhmm: string };

/** Puro: o que fazer nesta execução, antes de tocar no Drive ou na API. */
export function decideThreadsTimerRun(input: {
  config: unknown;
  reviewedExists: boolean;
  /** Todos os arquivos do registro da edição (`readShortsRegistryRaws`). */
  registryRaws: ReadonlyArray<{ path: string; raw: string }>;
  aammdd: string;
  now: Date;
  /** O dia teve vertical? (no disco, ou outro destino já registrado). Sem isso, passar do horário não alarma. */
  videoSeen: boolean;
}): ThreadsTimerDecision {
  const cfg = loadShortsConfig(input.config);
  if (!cfg.threadsProfile) return { kind: "skip", reason: "publishing.shorts.threads_profile = false" };
  if (!cfg.threadsProfileViaTimer) return { kind: "skip", reason: "publishing.shorts.threads_profile_via_timer = false (o /diaria-publica-video publica)" };
  if (!input.reviewedExists) return { kind: "skip", reason: `sem 02-reviewed.md da edição ${input.aammdd} (dia sem edição)` };
  for (const { path, raw } of input.registryRaws) {
    // Registro ilegível lança: nunca vira "nada publicado" (duplicaria o post).
    const entry = parseShortsPublishedFile(raw, input.aammdd, path).entries.find((e) => e.destination === DESTINATION);
    if (entry) return { kind: "skip", reason: `threads_profile já registrado (${entry.status}${entry.url ? `, ${entry.url}` : ""} em ${basename(path)})` };
  }
  const { hhmm } = resolveShortTime(loadShortScheduleConfig(input.config), input.aammdd);
  const at = resolveEditionScheduledAt(input.aammdd, hhmm);
  const deltaMs = input.now.getTime() - Date.parse(at);
  if (deltaMs < 0) return { kind: "wait", reason: `antes do horário do vertical (${hhmm} BRT)`, at, hhmm };
  if (deltaMs > MAX_FIRE_LATENESS_MS) {
    if (!input.videoSeen) return { kind: "skip", reason: `${hhmm} BRT passou há mais de 3 h e o dia não teve vertical — nada a avisar` };
    return {
      kind: "late",
      at,
      hhmm,
      reason: `${hhmm} BRT passou há ${Math.round(deltaMs / 60_000)} min (teto ${MAX_FIRE_LATENESS_MS / 3_600_000} h) e o vídeo do Threads pessoal não está registrado`,
    };
  }
  return { kind: "publish", at, hhmm };
}

/**
 * Puro: outro processo está baixando o vertical agora? `.part` recente do
 * download (`downloadDriveFileById` grava em `{arquivo}.part`), ou o lock do
 * timer do LinkedIn, que baixa o mesmo arquivo. O timer do LinkedIn faz o
 * mesmo com o lock deste (#11432), e o `O_EXCL` do `.part` em
 * `lib/drive-download.ts` garante que só um baixa mesmo se os dois passarem juntos.
 */
export function verticalDownloadInProgress(input: { partMtimeMs: number | null; linkedinLockMtimeMs: number | null; nowMs: number }): string | null {
  return verticalDownloadBusy({ partMtimeMs: input.partMtimeMs, otherLockMtimeMs: input.linkedinLockMtimeMs, otherLabel: "LinkedIn", otherLockFile: LINKEDIN_TIMER_LOCK_FILE, nowMs: input.nowMs });
}

export type ThreadsVerticalLookup =
  | { kind: "found"; fileId: string; name: string }
  /** O arquivo local apareceu entre a checagem e a consulta (outro processo baixou). */
  | { kind: "exists" }
  | { kind: "none"; reason: string }
  | { kind: "needs-editor"; reason: string }
  | { kind: "error"; reason: string };

/** Puro: lê a saída do `fetch-drive-video.ts --orientation vertical`. */
export function interpretThreadsVerticalLookup(exitCode: number | null, stdout: string): ThreadsVerticalLookup {
  let out: any;
  try {
    out = JSON.parse(stdout);
  } catch {
    return { kind: "error", reason: `fetch-drive-video.ts sem JSON (exit ${exitCode})` };
  }
  const action = out?.action;
  if (action === "print-id" && typeof out.file?.id === "string" && out.file.id) return { kind: "found", fileId: out.file.id, name: String(out.file.name ?? "") };
  if (action === "exists") return { kind: "exists" };
  if (action === "none" || action === "already-published") return { kind: "none", reason: `nenhum vertical "final" no Drive (${out.reason ?? action})` };
  if (action === "needs-editor") {
    return { kind: "needs-editor", reason: `o Drive tem mais de um candidato ou um arquivo ambíguo (${out.selection ?? "?"}) — o editor escolhe (Passo B1 do /diaria-publica-video); o timer não escolhe` };
  }
  return { kind: "error", reason: `fetch-drive-video.ts: ${action ?? "sem action"} (exit ${exitCode})${out?.error ? ` — ${out.error}` : ""}` };
}

/** Puro: argumentos do publish-shorts da rodada do timer. */
export function threadsPublishArgs(aammdd: string, fromDriveId: string | null): string[] {
  const args = ["scripts/publish-shorts.ts", aammdd, "--only", DESTINATION, "--publish", "--threads-timer", "--now"];
  if (fromDriveId) args.push("--from-drive", fromDriveId);
  return args;
}

export type ThreadsTimerOutcome =
  | { kind: "done"; detail: string }
  | { kind: "wait"; detail: string }
  /** `failed`: sai exit 1 (unit `failed`) além do alarme. */
  | { kind: "alarm"; key: ThreadsTimerAlarmKey; detail: string; failed: boolean };

type PlanAction = ShortsPlanItem["action"];

/** Puro: lê a saída do `publish-shorts.ts --only threads_profile --publish --threads-timer`. */
export function interpretThreadsTimerOutput(exitCode: number | null, stdout: string, stderrTail = ""): ThreadsTimerOutcome {
  let out: any;
  try {
    out = JSON.parse(stdout);
  } catch {
    return { kind: "alarm", key: "no-output", failed: true, detail: `publish-shorts.ts sem JSON (exit ${exitCode})${stderrTail ? `. Fim do stderr:\n${stderrTail}` : ""}` };
  }
  const result = Array.isArray(out?.results) ? out.results.find((r: any) => r?.destination === DESTINATION) : undefined;
  if (result) {
    const e = result.entry;
    const where = e ? (e.url ?? e.id) : "";
    if (result.ok && e) {
      if (e.status === "send_unknown") {
        return { kind: "alarm", key: "send-unknown", failed: false, detail: `envio ambíguo no Threads (${e.id}): ${(result.warnings ?? []).join("; ") || "sem detalhe"}` };
      }
      return { kind: "done", detail: `${result.alreadyRegistered ? "já estava no perfil/registro" : "publicado"}: ${e.status} ${where}` };
    }
    if (e) {
      return { kind: "alarm", key: "published-unregistered", failed: true, detail: `o vídeo ESTÁ no perfil (${where}), mas o registro não foi gravado: ${result.error ?? "?"}` };
    }
    if (result.cause === "preflight") {
      const key: ThreadsTimerAlarmKey = result.preflight === "read-failed" ? "preflight-read-failed" : "preflight-blocked";
      return { kind: "alarm", key, failed: true, detail: `conferência do perfil (${result.preflight ?? "?"}): ${result.error ?? "sem mensagem"}` };
    }
    return { kind: "alarm", key: "publish-failed", failed: true, detail: String(result.error ?? "falha sem mensagem") };
  }
  const item = Array.isArray(out?.items) ? out.items.find((i: any) => i?.destination === DESTINATION) : undefined;
  if (!item) return { kind: "alarm", key: "publish-failed", failed: true, detail: `plano sem o destino threads_profile (exit ${exitCode})` };
  const detail = String(item.detail ?? "");
  const action = item.action as PlanAction;
  switch (action) {
    case "skip_done":
      return { kind: "done", detail: "já registrado" };
    case "pending_schedule":
      return { kind: "wait", detail: detail || "antes do horário" };
    case "skip_late":
      return { kind: "alarm", key: "late", failed: false, detail };
    case "skip_missing_credentials":
      return item.cause === "public_video"
        ? { kind: "alarm", key: "public-video", failed: true, detail: `sem URL pública do vertical no 300: ${detail}` }
        : { kind: "alarm", key: "credentials", failed: true, detail: `sem credencial do Threads pessoal no 300: ${detail}` };
    case "skip_invalid":
      return { kind: "alarm", key: "publish-failed", failed: true, detail: `texto/plano inválido: ${detail}` };
    case "skip_delegated":
      return { kind: "alarm", key: "publish-failed", failed: true, detail: `a rodada do timer recebeu skip_delegated (config mudou?): ${detail}` };
    case "publish":
    case "enqueue":
    case "buffer":
    case "guided":
      return { kind: "alarm", key: "publish-failed", failed: true, detail: `plano com ${action} e sem resultado do threads_profile (exit ${exitCode})` };
    default: {
      const unknown: never = action;
      return { kind: "alarm", key: "publish-failed", failed: true, detail: `ação inesperada do plano: ${String(unknown)} (exit ${exitCode})` };
    }
  }
}

/** Puro: `HH:MM` BRT de um instante. */
function hhmmBrt(ms: number): string {
  return new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(ms));
}

/** Puro: corpo do alarme, por motivo, com os comandos já com a edição. */
export function buildThreadsTimerAlarm(input: { aammdd: string; key: ThreadsTimerAlarmKey; reason: string; at?: string | null }): { subject: string; body: string } {
  const { aammdd, key, reason, at } = input;
  const deadline = at ? hhmmBrt(Date.parse(at) + MAX_FIRE_LATENESS_MS) : null;
  const mark = `\`npx tsx scripts/publish-shorts.ts ${aammdd} --mark threads_profile=URL\``;
  const manual = `\`npx tsx scripts/publish-shorts.ts ${aammdd} --only threads_profile --threads-timer --publish --now\``;
  const lines = ["Achado automático da task `Diaria-Shorts-Threads-Profile`", "(`scripts/shorts-threads-profile-timer.ts`, #11410).", "", `Motivo (${key}): ${reason}`, ""];
  let subject: string;
  if (MAYBE_PUBLISHED_KEYS.has(key)) {
    // Nunca sugerir publicar: o vídeo pode estar no perfil.
    lines.push(
      "Confira o perfil do Threads antes de qualquer coisa; NÃO reposte sem conferir.",
      `- Se o vertical da edição está lá: registre com ${mark}.`,
      key === "preflight-blocked"
        ? `- Se o vídeo do dia é outro: publique pela API rodando NO 300 ${manual} só depois de conferir (o timer não publica enquanto o perfil tiver vídeo do dia sem o marcador da edição).`
        : "- Se não está: poste à mão no app e registre com o mesmo comando.",
    );
    subject = `[diar.ia.br] Vertical no Threads pessoal de ${aammdd}: conferir o perfil (${key})`;
  } else {
    if (key === "late") lines.push("Passadas 3 h do horário do vertical o timer NÃO publica mais sozinho.");
    if (key === "missing-video") lines.push(`Salve o vertical "final" em \`${aammdd}/Final/\` no Drive; a próxima execução baixa e publica${deadline ? ` (até ${deadline} BRT)` : ""}.`);
    if (key === "drive-needs-editor") lines.push(`Deixe um só vertical "final" em \`${aammdd}/Final/\` no Drive; a próxima execução publica.`);
    if (key === "public-video") lines.push("A Threads API só recebe o vídeo por URL pública: confira os secrets do R2 (`SHORTS_R2_*`) no `.env` do 300.");
    if (key === "credentials") lines.push("Confira `THREADS_PERSONAL_ACCESS_TOKEN`/`THREADS_PERSONAL_USER_ID` no `.env` do 300 (task `Diaria-Threads-Personal-Token`).");
    if (RETRY_KEYS.has(key)) {
      lines.push(`O timer volta a tentar sozinho de hora em hora${deadline ? ` até ${deadline} BRT` : ""} (3 h depois do horário do vertical); resolvida a causa, não precisa fazer nada.`);
    }
    lines.push(
      "O que fazer:",
      `- Postar o vertical à mão no Threads pessoal e registrar com ${mark}.`,
      `- Ou, conferido que o vídeo não está no perfil, publicar pela API rodando NO 300 ${manual} (de outra máquina vira um segundo escritor).`,
    );
    subject = `[diar.ia.br] Vertical no Threads pessoal de ${aammdd} não saiu pelo timer do 300 (${key})`;
  }
  return { subject, body: lines.join("\n") };
}

/** Abre (ou reaproveita) a issue do alarme, manda o e-mail e grava o estado. */
export async function threadsAlarm(
  dir: string,
  aammdd: string,
  key: ThreadsTimerAlarmKey,
  reason: string,
  at: string | null,
  notifyDeps: NotifyEditorDeps = { cwd: ROOT },
): Promise<boolean> {
  const statePath = join(dir, THREADS_TIMER_ALARM_STATE_FILE);
  const stateRaw = existsSync(statePath) ? readFileSync(statePath, "utf8") : null;
  const id = threadsAlarmId(key, reason);
  if (threadsAlarmSuppressed(stateRaw, key, id)) {
    console.log(`${LOG_PREFIX} ${aammdd}: alarme "${id}" já coberto nesta edição${key === "late" && !alreadyAlarmed(stateRaw, id) ? " (por um motivo que diz que o vídeo pode estar no ar)" : ""} — não repete`);
    return true;
  }
  const { subject, body } = buildThreadsTimerAlarm({ aammdd, key, reason, at });
  const res = await notifyEditor(
    { check: "shorts-threads-timer", fingerprint: `${aammdd}:${id}`, severity: threadsAlarmSeverity(key), family: "evento", subject, body, forceEmail: emailPending(stateRaw, id) },
    notifyDeps,
  );
  const delivery = alarmDelivery(res);
  const next = nextAlarmState(stateRaw, aammdd, id, delivery);
  if (next !== null) {
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileAtomic(statePath, next);
  }
  if (delivery.kind !== "delivered") {
    console.error(`${LOG_PREFIX} ${aammdd}: alarme "${id}" NÃO entregue — ${delivery.error}; tenta de novo na próxima execução`);
    return false;
  }
  console.log(`${LOG_PREFIX} ${aammdd}: alarme "${id}" ${res.issue?.action ?? "registrado"}${res.issue?.url ? ` ${res.issue.url}` : ""}${res.emailSent ? " (e-mail enviado)" : ""}`);
  return true;
}

/** I/O da execução, injetável nos testes. */
export interface ThreadsTimerRunDeps {
  config: unknown;
  now: Date;
  /** `fetch-drive-video.ts --orientation vertical` (só imprime o id). */
  lookupVertical: () => ThreadsVerticalLookup;
  /** Roda `npx tsx <args>` (o publish-shorts). */
  runScript: (args: string[]) => { status: number | null; stdout: string; stderr: string };
  notify: NotifyEditorDeps;
}

function runTsx(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, ["--import", "tsx", ...args], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024 });
  if (r.error) throw r.error;
  if (r.stderr) process.stderr.write(r.stderr);
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function mtimeOf(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

function defaultRunDeps(aammdd: string, dir: string): ThreadsTimerRunDeps {
  return {
    config: JSON.parse(readFileSync(join(ROOT, "platform.config.json"), "utf8")),
    now: new Date(),
    lookupVertical: () => {
      const f = runTsx(["scripts/fetch-drive-video.ts", "--edition", aammdd, "--orientation", "vertical", "--edition-dir", dir]);
      return interpretThreadsVerticalLookup(f.status, f.stdout);
    },
    runScript: runTsx,
    notify: { cwd: ROOT },
  };
}

export async function runThreadsTimer(aammdd: string, dir: string, dryRun: boolean, deps: ThreadsTimerRunDeps = defaultRunDeps(aammdd, dir)): Promise<number> {
  const { config, now } = deps;
  const videoPath = join(dir, shortVideoFileName(aammdd));
  const registryRaws = readShortsRegistryRaws(dir);
  const videoSeen = existsSync(videoPath) || registryRaws.some(({ path, raw }) => parseShortsPublishedFile(raw, aammdd, path).entries.length > 0);
  const decision = decideThreadsTimerRun({ config, reviewedExists: existsSync(join(dir, "02-reviewed.md")), registryRaws, aammdd, now, videoSeen });
  if (decision.kind === "skip" || decision.kind === "wait") {
    console.log(`${LOG_PREFIX} ${aammdd}: ${decision.kind === "skip" ? "nada a fazer" : "esperando"} — ${decision.reason}`);
    return 0;
  }
  if (decision.kind === "late") {
    console.log(`${LOG_PREFIX} ${aammdd}: ${decision.reason}`);
    if (dryRun) return 0;
    return (await threadsAlarm(dir, aammdd, "late", decision.reason, decision.at, deps.notify)) ? 0 : 1;
  }

  const at = decision.at;
  const release = dryRun ? () => {} : acquireTimerLock(join(dir, THREADS_TIMER_LOCK_FILE), now.getTime());
  if (!release) {
    console.log(`${LOG_PREFIX} ${aammdd}: outra execução está no meio (${THREADS_TIMER_LOCK_FILE}) — sai sem publicar`);
    return 0;
  }
  try {
    let fromDrive: string | null = null;
    if (!existsSync(videoPath)) {
      const busy = verticalDownloadInProgress({ partMtimeMs: mtimeOf(`${videoPath}.part`), linkedinLockMtimeMs: mtimeOf(join(dir, LINKEDIN_TIMER_LOCK_FILE)), nowMs: now.getTime() });
      if (busy) {
        console.log(`${LOG_PREFIX} ${aammdd}: ${busy} — tenta de novo na próxima execução`);
        return 0;
      }
      const lookup = deps.lookupVertical();
      if (lookup.kind === "error") {
        console.error(`${LOG_PREFIX} ${aammdd}: ${lookup.reason}`);
        if (!dryRun) await threadsAlarm(dir, aammdd, "drive-error", `Drive: ${lookup.reason}`, at, deps.notify);
        return 1;
      }
      if (lookup.kind === "none" || lookup.kind === "needs-editor") {
        console.log(`${LOG_PREFIX} ${aammdd}: ${lookup.reason} — tenta de novo na próxima execução`);
        if (dryRun) return 0;
        // Ambíguo: o editor precisa escolher, alarma já. Sem vertical: só num dia
        // que teve vertical, e só 1 h depois do horário (pode ainda estar subindo).
        if (lookup.kind === "needs-editor") return (await threadsAlarm(dir, aammdd, "drive-needs-editor", lookup.reason, at, deps.notify)) ? 0 : 1;
        if (videoSeen && now.getTime() - Date.parse(at) >= THREADS_MISSING_VIDEO_ALARM_AFTER_MS) {
          return (await threadsAlarm(dir, aammdd, "missing-video", lookup.reason, at, deps.notify)) ? 0 : 1;
        }
        return 0;
      }
      if (lookup.kind === "found") {
        console.log(`${LOG_PREFIX} ${aammdd}: vertical no Drive: ${lookup.name} (${lookup.fileId})`);
        fromDrive = lookup.fileId;
      }
    }
    const publishArgs = threadsPublishArgs(aammdd, fromDrive);
    if (dryRun) {
      console.log(`${LOG_PREFIX} dry-run: npx tsx ${publishArgs.join(" ")}`);
      return 0;
    }
    const r = deps.runScript(publishArgs);
    if (r.stdout) process.stdout.write(r.stdout.endsWith("\n") ? r.stdout : `${r.stdout}\n`);
    const outcome = interpretThreadsTimerOutput(r.status, r.stdout, r.stderr.trimEnd().split("\n").slice(-15).join("\n"));
    console.log(`${LOG_PREFIX} ${aammdd}: ${outcome.kind}${outcome.kind === "alarm" ? ` (${outcome.key})` : ""} — ${outcome.detail}`);
    if (outcome.kind !== "alarm") return 0;
    const alarmed = await threadsAlarm(dir, aammdd, outcome.key, outcome.detail, at, deps.notify);
    return outcome.failed || !alarmed ? 1 : 0;
  } finally {
    release();
  }
}

async function main(): Promise<number> {
  const { flags, values } = parseArgs(process.argv.slice(2));
  const aammdd = values["edition"] ?? aammddBrt(new Date());
  if (!/^\d{6}$/.test(aammdd)) {
    console.error("uso: shorts-threads-profile-timer.ts [--edition AAMMDD] [--dry-run]");
    return 2;
  }
  const dryRun = flags.has("dry-run");
  const dir = editionDirFor(aammdd);
  try {
    return await runThreadsTimer(aammdd, dir, dryRun);
  } catch (e) {
    // Exceção (registro ilegível, config, spawn): o vídeo do dia fica sem dono — alarme próprio.
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`${LOG_PREFIX} ${aammdd}: erro: ${msg}`);
    if (!dryRun) {
      try {
        await threadsAlarm(dir, aammdd, "crash", `o timer falhou com exceção: ${msg}`, null);
      } catch (e2) {
        console.error(`${LOG_PREFIX} ${aammdd}: nem o alarme saiu: ${e2 instanceof Error ? e2.message : e2}`);
      }
    }
    return 1;
  }
}

if (isMainModule(import.meta.url)) {
  runCli(main, { onError: (e) => console.error("shorts-threads-profile-timer:", e instanceof Error ? e.message : e) });
}
