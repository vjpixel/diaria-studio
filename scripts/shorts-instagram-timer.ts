#!/usr/bin/env node
/**
 * scripts/shorts-instagram-timer.ts (#11265, #10940)
 *
 * Passo do timer do `300` (`Diaria-Shorts-Instagram` e o `-Catchup`,
 * `scripts/lib/scheduled-tasks.ts`) que publica o Reels do vertical no
 * Instagram no horário do vertical, sem tarefa manual por edição e sem URL
 * pública: o Instagram não agenda Reels pela API, então alguém precisa rodar
 * o `--publish` depois do horário (decisão do editor 27/10/2026: timer no
 * 300; o túnel #11307 caiu pelo risco de ToS da Cloudflare e o R2 não será
 * habilitado).
 *
 *   1. edição = hoje em BRT (o vertical sai no dia da própria edição);
 *   2. `decideInstagramTimerRun` (puro): Instagram desligado, backend que não
 *      é `timer-300`, dia sem `02-reviewed.md` ou `instagram` já registrado
 *      em qualquer arquivo do registro (inclusive `send_unknown` e as cópias
 *      de conflito do OneDrive) → nada a fazer; antes do horário do vertical
 *      (`resolveShortTime` — com `timer-300` o plano do publish-shorts usa o
 *      MESMO horário pro Instagram, fora da grade, `instagramTimerSlot`) →
 *      espera; até 3 h depois → publica; depois → não publica, e alarma só se
 *      o dia teve vertical (`videoSeen`);
 *   3. o vídeo (`chooseInstagramVideo`): o Drive é SEMPRE consultado pelo
 *      corte `_Instagram_` da pasta `Final/` (#11222, `fetch-drive-video.ts
 *      --target instagram`); o corte vai pra
 *      `diaria-comentada-{AAMMDD}-short-instagram.mp4` e é rebaixado quando
 *      o id ou o `modifiedTime` mudam (`_internal/.shorts-instagram-cut.json`).
 *      Drive ambíguo (`needs-editor`) espera e alarma, nunca cai no genérico;
 *      o vertical genérico só entra quando o Drive diz que NÃO há corte, e só
 *      se já estiver no disco (quem o baixa é o timer do LinkedIn);
 *   4. `publish-shorts.ts AAMMDD --only instagram --publish --instagram-timer
 *      --video P [--from-drive ID]`. A rodada do timer confere a conta antes
 *      de publicar (`instagramTimerGate`) e grava no registro próprio (#11157);
 *   5. `interpretInstagramTimerOutput` (puro, tipado contra o `ShortsPlanItem`)
 *      lê o JSON do publish-shorts e, quando o editor precisa agir, abre um
 *      alarme por MOTIVO (`InstagramTimerAlarmKey`, fingerprint
 *      `{AAMMDD}:{motivo}`, família `evento`; `urgente` quando o Reels não saiu
 *      no dia, então o e-mail sai mesmo com `email_policy: urgent_only`). O
 *      mesmo motivo não repete a cada hora (`_internal/.shorts-instagram-timer-alarm.json`).
 *
 * Lock O_EXCL em `_internal/.shorts-instagram-timer.lock` (o mesmo
 * `acquireTimerLock` do timer do LinkedIn): a task diária e a de hora em hora
 * nunca publicam juntas.
 *
 * Fica de fora (premissa registrada na #11265): X (Buffer) e Threads pessoal
 * recebem o vídeo só por URL pública; sem R2 eles seguem pulados com aviso
 * pelo `/diaria-shorts`, manuais.
 *
 * Uso: npx tsx scripts/shorts-instagram-timer.ts [--edition AAMMDD] [--dry-run]
 *   --dry-run: decide e imprime os comandos, sem publicar e sem alarme (lê o Drive).
 *
 * Exit: 0 = feito, nada a fazer, esperando ou avisado; 1 = falha (Drive,
 * publish, alarme não aberto, exceção); 2 = uso.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule, parseArgs } from "./lib/cli-args.ts";
import { runCli } from "./lib/cli-exit.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { editionDir as editionDirFor } from "./lib/edition-paths.ts";
import { resolveEditionScheduledAt } from "./lib/edition-scheduled-at.ts";
import { notifyEditor, type NotifySeverity } from "./lib/editor-notify.ts";
import { aammddBrt, MAX_FIRE_LATENESS_MS } from "./lib/linkedin-personal.ts";
import {
  loadShortScheduleConfig,
  loadShortsConfig,
  parseShortsPublishedFile,
  resolveShortTime,
  shortInstagramVideoFileName,
  shortVideoFileName,
} from "./lib/diaria/short-video.ts";
import { readShortsRegistryRaws } from "./lib/diaria/shorts-published-store.ts";
import { acquireTimerLock } from "./shorts-linkedin-profile-timer.ts";
// Só tipo: importar o publish-shorts em runtime carregaria o .env no import.
import type { ShortsPlanItem } from "./publish-shorts.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOG_PREFIX = "[shorts-instagram-timer]";
export const INSTAGRAM_TIMER_LOCK_FILE = "_internal/.shorts-instagram-timer.lock";
/** Motivos já avisados ao editor nesta edição (não repete o mesmo a cada hora). */
export const INSTAGRAM_TIMER_ALARM_STATE_FILE = "_internal/.shorts-instagram-timer-alarm.json";
/** Id e `modifiedTime` do corte do Instagram baixado (rebaixa quando mudam). */
export const INSTAGRAM_CUT_SIDECAR_FILE = "_internal/.shorts-instagram-cut.json";
/** Sem vídeo para o Instagram 1 h depois do horário do vertical: alarma cedo, com o motivo real. */
export const MISSING_VIDEO_ALARM_AFTER_MS = 60 * 60_000;

/**
 * Motivo do alarme — chave estável (vira o fingerprint `{AAMMDD}:{motivo}` e a
 * dedup local), nunca texto variável.
 */
export type InstagramTimerAlarmKey =
  | "late"
  | "guided"
  | "missing-video"
  | "drive-needs-editor"
  | "drive-error"
  | "credentials"
  | "publish-failed"
  | "published-unregistered"
  | "check-permalink"
  | "no-output"
  | "crash";

/** O Reels ainda está no ar? Esses avisam com `acao`; o resto é "não saiu hoje" (`urgente`). */
const PUBLISHED_KEYS: ReadonlySet<InstagramTimerAlarmKey> = new Set(["published-unregistered", "check-permalink"]);

export function alarmSeverity(key: InstagramTimerAlarmKey): NotifySeverity {
  return PUBLISHED_KEYS.has(key) ? "acao" : "urgente";
}

export type InstagramTimerDecision =
  | { kind: "skip"; reason: string }
  | { kind: "wait"; reason: string; at: string; hhmm: string }
  | { kind: "late"; reason: string; at: string; hhmm: string }
  | { kind: "publish"; at: string; hhmm: string };

/** Puro: o que fazer nesta execução, antes de tocar no Drive ou na API. */
export function decideInstagramTimerRun(input: {
  config: unknown;
  reviewedExists: boolean;
  /** Todos os arquivos do registro da edição (`readShortsRegistryRaws`). */
  registryRaws: ReadonlyArray<{ path: string; raw: string }>;
  aammdd: string;
  now: Date;
  /**
   * O dia teve vertical? (corte ou genérico no disco, corte já baixado, ou o
   * `/diaria-shorts` já registrou outro destino). Sem isso, passar do horário
   * não alarma: a Etapa 5 pode seguir sem vídeo.
   */
  videoSeen: boolean;
}): InstagramTimerDecision {
  const cfg = loadShortsConfig(input.config);
  if (!cfg.instagram) return { kind: "skip", reason: "publishing.shorts.instagram = false" };
  if (cfg.instagramBackend !== "timer-300") {
    return { kind: "skip", reason: `publishing.shorts.instagram_backend = ${cfg.instagramBackend} (o timer só age com timer-300)` };
  }
  if (!input.reviewedExists) return { kind: "skip", reason: `sem 02-reviewed.md da edição ${input.aammdd} (dia sem edição)` };
  for (const { path, raw } of input.registryRaws) {
    // Registro ilegível lança: nunca vira "nada publicado" (duplicaria o Reels).
    const entry = parseShortsPublishedFile(raw, input.aammdd, path).entries.find((e) => e.destination === "instagram");
    if (entry) return { kind: "skip", reason: `instagram já registrado (${entry.status}${entry.url ? `, ${entry.url}` : ""} em ${basename(path)})` };
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
      reason: `${hhmm} BRT passou há ${Math.round(deltaMs / 60_000)} min (teto ${MAX_FIRE_LATENESS_MS / 3_600_000} h) e o Reels não está registrado`,
    };
  }
  return { kind: "publish", at, hhmm };
}

/** Puro: sem vídeo pro Instagram até `horário + 1 h`, num dia que teve vertical, alarma. */
export function shouldAlarmMissingVideo(now: Date, at: string, videoSeen: boolean): boolean {
  return videoSeen && now.getTime() - Date.parse(at) >= MISSING_VIDEO_ALARM_AFTER_MS;
}

export type InstagramCutLookup =
  | { kind: "found"; fileId: string; name: string; modifiedTime: string | null }
  /** O Drive diz que não há corte do Instagram (ou não tem nada a dizer sobre ele). */
  | { kind: "none"; reason: string }
  /** Ambíguo, sem proporção, pasta duplicada: o editor escolhe. */
  | { kind: "needs-editor"; reason: string }
  | { kind: "error"; reason: string };

/** Puro: lê a saída do `fetch-drive-video.ts --orientation vertical --target instagram`. */
export function interpretInstagramCutLookup(exitCode: number | null, stdout: string): InstagramCutLookup {
  let out: any;
  try {
    out = JSON.parse(stdout);
  } catch {
    return { kind: "error", reason: `fetch-drive-video.ts sem JSON (exit ${exitCode})` };
  }
  const action = out?.action;
  if (action === "print-id" && typeof out.file?.id === "string" && out.file.id) {
    return { kind: "found", fileId: out.file.id, name: String(out.file.name ?? ""), modifiedTime: typeof out.file.modifiedTime === "string" ? out.file.modifiedTime : null };
  }
  if (action === "none") return { kind: "none", reason: `nenhum corte _Instagram_ no Drive (${out.reason ?? "sem motivo"})` };
  // `exists`/`already-published` não vêm com --target instagram (o corte não é
  // o arquivo local que o fetch confere); se vierem, não dizem nada do corte.
  if (action === "exists" || action === "already-published") return { kind: "none", reason: `fetch-drive-video.ts: ${action} (nada sobre o corte do Instagram)` };
  if (action === "needs-editor") {
    return { kind: "needs-editor", reason: `o Drive tem mais de um candidato ou um arquivo ambíguo (${out.selection ?? "?"}) — o editor escolhe (Passo B1 do /diaria-publica-video); o timer não escolhe` };
  }
  return { kind: "error", reason: `fetch-drive-video.ts: ${action ?? "sem action"} (exit ${exitCode})${out?.error ? ` — ${out.error}` : ""}` };
}

export interface InstagramCutSidecar {
  fileId: string;
  modifiedTime: string | null;
}

export type InstagramVideoChoice =
  | { kind: "use-local"; path: string; source: "instagram-cut" | "generic"; note?: string }
  | { kind: "download"; path: string; fileId: string; name: string; modifiedTime: string | null }
  | { kind: "wait"; reason: string; alarm: "missing-video" | "drive-needs-editor" }
  | { kind: "error"; reason: string };

/**
 * Puro: qual arquivo o timer publica. O corte do Instagram vence (é o recorte
 * para o teto de duração dele, #11222) e é rebaixado quando o Drive mostra
 * outro id ou `modifiedTime`. O genérico só quando o Drive diz que não há
 * corte, e só se já estiver no disco. Ambíguo nunca cai no genérico.
 */
export function chooseInstagramVideo(input: {
  instagramCutPath: string;
  instagramCutExists: boolean;
  /** O que foi baixado da última vez (`INSTAGRAM_CUT_SIDECAR_FILE`); null = desconhecido. */
  cutSidecar: InstagramCutSidecar | null;
  genericPath: string;
  genericExists: boolean;
  lookup: InstagramCutLookup;
}): InstagramVideoChoice {
  const { lookup } = input;
  switch (lookup.kind) {
    case "found": {
      const same = input.instagramCutExists && input.cutSidecar?.fileId === lookup.fileId && input.cutSidecar.modifiedTime === lookup.modifiedTime;
      if (same) return { kind: "use-local", path: input.instagramCutPath, source: "instagram-cut" };
      return { kind: "download", path: input.instagramCutPath, fileId: lookup.fileId, name: lookup.name, modifiedTime: lookup.modifiedTime };
    }
    case "needs-editor":
      return { kind: "wait", reason: lookup.reason, alarm: "drive-needs-editor" };
    case "none":
      if (input.instagramCutExists) return { kind: "use-local", path: input.instagramCutPath, source: "instagram-cut", note: `${lookup.reason}; usando o corte já baixado` };
      if (input.genericExists) return { kind: "use-local", path: input.genericPath, source: "generic", note: lookup.reason };
      return { kind: "wait", reason: `${lookup.reason} e sem o vertical genérico no disco`, alarm: "missing-video" };
    case "error":
      // Fail-soft só com o corte já no disco; sem ele, nunca cai no genérico em silêncio.
      if (input.instagramCutExists) return { kind: "use-local", path: input.instagramCutPath, source: "instagram-cut", note: `Drive indisponível (${lookup.reason}); usando o corte já baixado` };
      return { kind: "error", reason: lookup.reason };
  }
}

export type InstagramTimerOutcome =
  | { kind: "done"; detail: string }
  | { kind: "wait"; detail: string }
  /** `failed`: sai exit 1 (unit `failed`) além do alarme. */
  | { kind: "alarm"; key: InstagramTimerAlarmKey; detail: string; failed: boolean };

type PlanAction = ShortsPlanItem["action"];

/** Puro: lê a saída do `publish-shorts.ts --only instagram --publish --instagram-timer`. */
export function interpretInstagramTimerOutput(exitCode: number | null, stdout: string, stderrTail = ""): InstagramTimerOutcome {
  let out: any;
  try {
    out = JSON.parse(stdout);
  } catch {
    return { kind: "alarm", key: "no-output", failed: true, detail: `publish-shorts.ts sem JSON (exit ${exitCode})${stderrTail ? `. Fim do stderr:\n${stderrTail}` : ""}` };
  }
  const result = Array.isArray(out?.results) ? out.results.find((r: any) => r?.destination === "instagram") : undefined;
  if (result) {
    const e = result.entry;
    const where = e ? (e.url ?? e.id) : "";
    if (result.ok && e) {
      if (result.alreadyRegistered && result.matchedBy === "time-window") {
        return { kind: "alarm", key: "check-permalink", failed: false, detail: `Reels sem o marcador da edição achado só pelo horário e registrado (${where}) — confira o permalink` };
      }
      return { kind: "done", detail: `${result.alreadyRegistered ? "já estava na conta/registro" : "publicado"}: ${e.status} ${where}` };
    }
    if (e) {
      return { kind: "alarm", key: "published-unregistered", failed: true, detail: `o Reels ESTÁ NO AR (${where}), mas o registro não foi gravado: ${result.error ?? "?"}. Não reposte; registre com --mark instagram=${e.url ?? "URL"}` };
    }
    return { kind: "alarm", key: "publish-failed", failed: true, detail: String(result.error ?? "falha sem mensagem") };
  }
  const item = Array.isArray(out?.items) ? out.items.find((i: any) => i?.destination === "instagram") : undefined;
  if (!item) return { kind: "alarm", key: "publish-failed", failed: true, detail: `plano sem o destino instagram (exit ${exitCode})` };
  const detail = String(item.detail ?? "");
  const action = item.action as PlanAction;
  switch (action) {
    case "skip_done":
      return { kind: "done", detail: "já registrado" };
    case "pending_schedule":
      return { kind: "wait", detail: detail || "antes do horário" };
    case "guided":
      return { kind: "alarm", key: "guided", failed: false, detail: `acima do teto de duração da API: ${detail || "passo guiado"}` };
    case "skip_late":
      return { kind: "alarm", key: "late", failed: false, detail };
    case "skip_missing_credentials":
      return { kind: "alarm", key: "credentials", failed: true, detail: `sem credencial do Instagram no 300: ${detail}` };
    case "skip_invalid":
      return { kind: "alarm", key: "publish-failed", failed: true, detail: `legenda/plano inválido: ${detail}` };
    case "skip_delegated":
      return { kind: "alarm", key: "publish-failed", failed: true, detail: `a rodada do timer recebeu skip_delegated (backend do Instagram mudou?): ${detail}` };
    case "publish":
    case "enqueue":
    case "buffer":
      return { kind: "alarm", key: "publish-failed", failed: true, detail: `plano com ${action} e sem resultado do instagram (exit ${exitCode})` };
    default: {
      const unknown: never = action;
      return { kind: "alarm", key: "publish-failed", failed: true, detail: `ação inesperada do plano: ${String(unknown)} (exit ${exitCode})` };
    }
  }
}

/** Puro: corpo do alarme, por motivo, com os comandos já com a edição e o arquivo. */
export function buildInstagramTimerAlarm(input: {
  aammdd: string;
  key: InstagramTimerAlarmKey;
  reason: string;
  /** Caminho do corte do Instagram no 300 (pro `--video` do comando manual). */
  cutPath: string;
}): { subject: string; body: string } {
  const { aammdd, key, reason, cutPath } = input;
  const published = PUBLISHED_KEYS.has(key);
  const lines = [
    "Achado automático da task `Diaria-Shorts-Instagram`",
    "(`scripts/shorts-instagram-timer.ts`, #11265).",
    "",
    `Motivo (${key}): ${reason}`,
    "",
  ];
  const confirm = `\`npx tsx scripts/publish-shorts.ts ${aammdd} --confirm-instagram\``;
  const manual = `\`npx tsx scripts/publish-shorts.ts ${aammdd} --only instagram --instagram-timer --publish --now --video ${cutPath}\``;
  if (published) {
    lines.push(
      key === "check-permalink"
        ? "O Reels está registrado. Confira se o permalink é mesmo o desta edição; se não for, corrija o registro com `--mark instagram=URL`."
        : `O Reels está no ar. NÃO reposte: registre com \`npx tsx scripts/publish-shorts.ts ${aammdd} --mark instagram=URL\` (ou ${confirm}).`,
    );
  } else {
    if (key === "late") lines.push("Passadas 3 h do horário do vertical o timer NÃO publica mais sozinho.");
    if (key === "missing-video") lines.push(`Suba o corte \`_Instagram_\` em \`${aammdd}/Final/\` no Drive; até 3 h depois do horário do vertical a próxima execução (de hora em hora) publica.`);
    if (key === "drive-needs-editor") lines.push(`Deixe um só \`_Instagram_\` em \`${aammdd}/Final/\` no Drive (ou uma só pasta \`${aammdd}\`); a próxima execução publica.`);
    lines.push(
      "O que fazer:",
      `- Postar no instagram.com (Passo B3b do \`/diaria-publica-video\`) e registrar com ${confirm}.`,
      `- Ou publicar pela API desta máquina, conferindo antes que o Reels não está na conta: ${manual}`,
    );
  }
  return {
    subject: published ? `[diar.ia.br] Reels do Instagram de ${aammdd}: conferir registro (${key})` : `[diar.ia.br] Reels do Instagram de ${aammdd} não saiu pelo timer do 300 (${key})`,
    body: lines.join("\n"),
  };
}

/** Puro: o motivo já foi avisado nesta edição? */
export function alreadyAlarmed(stateRaw: string | null, key: InstagramTimerAlarmKey): boolean {
  if (!stateRaw) return false;
  try {
    const keys = JSON.parse(stateRaw)?.alarmed;
    return Array.isArray(keys) && keys.includes(key);
  } catch {
    return false; // estado ilegível: avisa de novo (melhor um alarme a mais do que nenhum)
  }
}

/** Puro: lê o sidecar do corte; ilegível = desconhecido (rebaixa). */
export function parseCutSidecar(raw: string | null): InstagramCutSidecar | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw);
    if (typeof o?.fileId !== "string") return null;
    return { fileId: o.fileId, modifiedTime: typeof o.modifiedTime === "string" ? o.modifiedTime : null };
  } catch {
    return null;
  }
}

function runTsx(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, ["--import", "tsx", ...args], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 16 * 1024 * 1024,
  });
  if (r.error) throw r.error;
  if (r.stderr) process.stderr.write(r.stderr);
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function tail(text: string, lines = 15): string {
  return text.trimEnd().split("\n").slice(-lines).join("\n");
}

function mtimeOf(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

async function alarm(dir: string, aammdd: string, key: InstagramTimerAlarmKey, reason: string): Promise<boolean> {
  const statePath = join(dir, INSTAGRAM_TIMER_ALARM_STATE_FILE);
  const stateRaw = existsSync(statePath) ? readFileSync(statePath, "utf8") : null;
  if (alreadyAlarmed(stateRaw, key)) {
    console.log(`${LOG_PREFIX} ${aammdd}: alarme "${key}" já avisado nesta edição — não repete`);
    return true;
  }
  const { subject, body } = buildInstagramTimerAlarm({ aammdd, key, reason, cutPath: join(dir, shortInstagramVideoFileName(aammdd)) });
  const res = await notifyEditor(
    { check: "shorts-instagram-timer", fingerprint: `${aammdd}:${key}`, severity: alarmSeverity(key), family: "evento", subject, body },
    { cwd: ROOT },
  );
  if (res.issue?.action === "failed") {
    console.error(`${LOG_PREFIX} ${aammdd}: alarme "${key}" NÃO aberto (${res.issue.error})`);
    return false;
  }
  let prev: string[] = [];
  try {
    prev = stateRaw ? (JSON.parse(stateRaw)?.alarmed ?? []) : [];
  } catch {
    prev = [];
  }
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileAtomic(statePath, JSON.stringify({ aammdd, alarmed: [...new Set([...prev, key])] }, null, 2) + "\n");
  console.log(`${LOG_PREFIX} ${aammdd}: alarme "${key}" ${res.issue?.action ?? "registrado"}${res.issue?.url ? ` ${res.issue.url}` : ""}${res.emailSent ? " (e-mail enviado)" : ""}`);
  return true;
}

async function run(aammdd: string, dir: string, dryRun: boolean): Promise<number> {
  const config = JSON.parse(readFileSync(join(ROOT, "platform.config.json"), "utf8"));
  const instagramCutPath = join(dir, shortInstagramVideoFileName(aammdd));
  const genericPath = join(dir, shortVideoFileName(aammdd));
  const sidecarPath = join(dir, INSTAGRAM_CUT_SIDECAR_FILE);
  const registryRaws = readShortsRegistryRaws(dir);
  const videoSeen =
    existsSync(instagramCutPath) ||
    existsSync(genericPath) ||
    existsSync(sidecarPath) ||
    registryRaws.some(({ path, raw }) => parseShortsPublishedFile(raw, aammdd, path).entries.length > 0);
  const now = new Date();
  const decision = decideInstagramTimerRun({ config, reviewedExists: existsSync(join(dir, "02-reviewed.md")), registryRaws, aammdd, now, videoSeen });
  if (decision.kind === "skip" || decision.kind === "wait") {
    console.log(`${LOG_PREFIX} ${aammdd}: ${decision.kind === "skip" ? "nada a fazer" : "esperando"} — ${decision.reason}`);
    return 0;
  }
  if (decision.kind === "late") {
    console.log(`${LOG_PREFIX} ${aammdd}: ${decision.reason}`);
    if (dryRun) return 0;
    return (await alarm(dir, aammdd, "late", decision.reason)) ? 0 : 1;
  }

  const release = dryRun ? () => {} : acquireTimerLock(join(dir, INSTAGRAM_TIMER_LOCK_FILE));
  if (!release) {
    console.log(`${LOG_PREFIX} ${aammdd}: outra execução está no meio (${INSTAGRAM_TIMER_LOCK_FILE}) — sai sem publicar`);
    return 0;
  }
  try {
    const fetchArgs = ["scripts/fetch-drive-video.ts", "--edition", aammdd, "--orientation", "vertical", "--target", "instagram", "--edition-dir", dir];
    const f = runTsx(fetchArgs);
    const lookup = interpretInstagramCutLookup(f.status, f.stdout);
    const choice = chooseInstagramVideo({
      instagramCutPath,
      instagramCutExists: existsSync(instagramCutPath),
      cutSidecar: parseCutSidecar(existsSync(sidecarPath) ? readFileSync(sidecarPath, "utf8") : null),
      genericPath,
      genericExists: existsSync(genericPath),
      lookup,
    });
    if (choice.kind === "wait") {
      console.log(`${LOG_PREFIX} ${aammdd}: ${choice.reason} — tenta de novo na próxima execução`);
      if (dryRun) return 0;
      // Ambíguo alarma já (o editor precisa escolher); corte faltando, 1 h depois do horário.
      if (choice.alarm === "drive-needs-editor" || shouldAlarmMissingVideo(now, decision.at, videoSeen)) {
        return (await alarm(dir, aammdd, choice.alarm, choice.reason)) ? 0 : 1;
      }
      return 0;
    }
    if (choice.kind === "error") {
      console.error(`${LOG_PREFIX} ${aammdd}: ${choice.reason}`);
      if (!dryRun) await alarm(dir, aammdd, "drive-error", `Drive: ${choice.reason}`);
      return 1;
    }
    const publishArgs = ["scripts/publish-shorts.ts", aammdd, "--only", "instagram", "--publish", "--instagram-timer", "--video", choice.path];
    if (choice.kind === "download") {
      console.log(`${LOG_PREFIX} ${aammdd}: corte do Instagram no Drive: ${choice.name} (${choice.fileId}, ${choice.modifiedTime ?? "sem data"}) → ${choice.path}`);
      publishArgs.push("--from-drive", choice.fileId);
    } else {
      console.log(`${LOG_PREFIX} ${aammdd}: vídeo = ${choice.source === "instagram-cut" ? "corte do Instagram" : "vertical genérico"} no disco (${choice.path})${choice.note ? ` — ${choice.note}` : ""}`);
    }
    if (dryRun) {
      console.log(`${LOG_PREFIX} dry-run: npx tsx ${publishArgs.join(" ")}`);
      return 0;
    }
    const before = choice.kind === "download" ? mtimeOf(choice.path) : null;
    const r = runTsx(publishArgs);
    if (r.stdout) process.stdout.write(r.stdout.endsWith("\n") ? r.stdout : `${r.stdout}\n`);
    if (choice.kind === "download") {
      const after = mtimeOf(choice.path);
      // Só grava o que baixou de fato (o download falho deixa o arquivo antigo intacto).
      if (after !== null && after !== before) {
        mkdirSync(dirname(sidecarPath), { recursive: true });
        writeFileAtomic(sidecarPath, JSON.stringify({ fileId: choice.fileId, modifiedTime: choice.modifiedTime, name: choice.name }, null, 2) + "\n");
      }
    }
    const outcome = interpretInstagramTimerOutput(r.status, r.stdout, tail(r.stderr));
    console.log(`${LOG_PREFIX} ${aammdd}: ${outcome.kind}${outcome.kind === "alarm" ? ` (${outcome.key})` : ""} — ${outcome.detail}`);
    if (outcome.kind !== "alarm") return 0;
    const alarmed = await alarm(dir, aammdd, outcome.key, outcome.detail);
    return outcome.failed || !alarmed ? 1 : 0;
  } finally {
    release();
  }
}

async function main(): Promise<number> {
  const { flags, values } = parseArgs(process.argv.slice(2));
  const aammdd = values["edition"] ?? aammddBrt(new Date());
  if (!/^\d{6}$/.test(aammdd)) {
    console.error("uso: shorts-instagram-timer.ts [--edition AAMMDD] [--dry-run]");
    return 2;
  }
  const dryRun = flags.has("dry-run");
  const dir = editionDirFor(aammdd);
  try {
    return await run(aammdd, dir, dryRun);
  } catch (e) {
    // Exceção (registro ilegível, config, spawn): o Reels do dia fica sem dono — alarme próprio.
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`${LOG_PREFIX} ${aammdd}: erro: ${msg}`);
    if (!dryRun) {
      try {
        await alarm(dir, aammdd, "crash", `o timer falhou com exceção: ${msg}`);
      } catch (e2) {
        console.error(`${LOG_PREFIX} ${aammdd}: nem o alarme saiu: ${e2 instanceof Error ? e2.message : e2}`);
      }
    }
    return 1;
  }
}

if (isMainModule(import.meta.url)) {
  runCli(main, { onError: (e) => console.error("shorts-instagram-timer:", e instanceof Error ? e.message : e) });
}
