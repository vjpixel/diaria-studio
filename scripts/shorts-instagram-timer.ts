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
 *      (`resolveShortTime`) → espera; mais de 3 h depois (`MAX_FIRE_LATENESS_MS`,
 *      o mesmo teto do LinkedIn) → não publica e avisa o editor; senão publica;
 *   3. o vídeo: o corte do Instagram (`_Instagram_` em `Final/`, #11222) em
 *      `diaria-comentada-{AAMMDD}-short-instagram.mp4` — baixado do Drive
 *      quando ainda não está no disco (`fetch-drive-video.ts --target
 *      instagram` + `--from-drive`). Sem esse corte no Drive, usa o vertical
 *      genérico só se ele já estiver no disco (quem o baixa é o timer do
 *      LinkedIn; baixar aqui para o mesmo caminho seria corrida entre os dois);
 *   4. `publish-shorts.ts AAMMDD --only instagram --publish --instagram-timer
 *      --video P`. A rodada do timer confere a conta (`/media`) antes de
 *      publicar e grava no registro próprio (#11157), e o plano dela decide
 *      API ou passo guiado pelo teto de duração da autora (#10893/#11281);
 *   5. `interpretInstagramTimerOutput` (puro) lê o JSON do publish-shorts e,
 *      quando o Reels não saiu e o editor precisa agir (acima do teto,
 *      credencial, falha, atraso), abre/atualiza UM alarme por edição
 *      (`notifyEditor`, fingerprint = AAMMDD), sem repetir o mesmo motivo a
 *      cada execução (`_internal/.shorts-instagram-timer-alarm.json`).
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
 *   --dry-run: decide e imprime os comandos, sem rodar nenhum e sem alarme.
 *
 * Exit: 0 = feito, nada a fazer, esperando ou avisado; 1 = falha (Drive,
 * publish, alarme não aberto); 2 = uso.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule, parseArgs } from "./lib/cli-args.ts";
import { runCli } from "./lib/cli-exit.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { editionDir as editionDirFor } from "./lib/edition-paths.ts";
import { resolveEditionScheduledAt } from "./lib/edition-scheduled-at.ts";
import { notifyEditor } from "./lib/editor-notify.ts";
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
import { acquireTimerLock, interpretDriveLookup, type DriveLookup } from "./shorts-linkedin-profile-timer.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOG_PREFIX = "[shorts-instagram-timer]";
export const INSTAGRAM_TIMER_LOCK_FILE = "_internal/.shorts-instagram-timer.lock";
/** Motivos já avisados ao editor nesta edição (não repete o mesmo a cada hora). */
export const INSTAGRAM_TIMER_ALARM_STATE_FILE = "_internal/.shorts-instagram-timer-alarm.json";

export type InstagramTimerDecision =
  | { kind: "skip"; reason: string }
  | { kind: "wait"; reason: string }
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
  if (deltaMs < 0) return { kind: "wait", reason: `antes do horário do vertical (${hhmm} BRT)` };
  if (deltaMs > MAX_FIRE_LATENESS_MS) {
    return {
      kind: "late",
      at,
      hhmm,
      reason: `${hhmm} BRT passou há ${Math.round(deltaMs / 60_000)} min (teto ${MAX_FIRE_LATENESS_MS / 3_600_000} h) e o Reels não está registrado`,
    };
  }
  return { kind: "publish", at, hhmm };
}

export type InstagramVideoChoice =
  | { kind: "use"; path: string; source: "instagram-cut" | "generic"; driveFileId?: string; driveName?: string }
  | { kind: "wait"; reason: string }
  | { kind: "error"; reason: string };

/**
 * Puro: qual arquivo o timer publica. O corte do Instagram vence (é o recorte
 * para o teto de duração dele, #11222); sem ele no Drive, o vertical genérico
 * só se já estiver no disco. `lookup` é a leitura do Drive com `--target
 * instagram` (null quando o corte já está no disco e o Drive nem foi lido).
 */
export function chooseInstagramVideo(input: {
  instagramCutPath: string;
  instagramCutExists: boolean;
  genericPath: string;
  genericExists: boolean;
  lookup: DriveLookup | null;
}): InstagramVideoChoice {
  if (input.instagramCutExists) return { kind: "use", path: input.instagramCutPath, source: "instagram-cut" };
  const lookup = input.lookup;
  if (!lookup) return { kind: "error", reason: "corte do Instagram fora do disco e o Drive não foi lido" };
  if (lookup.kind === "error") return { kind: "error", reason: lookup.reason };
  if (lookup.kind === "found") {
    return { kind: "use", path: input.instagramCutPath, source: "instagram-cut", driveFileId: lookup.fileId, driveName: lookup.name };
  }
  // `exists` não acontece com --target instagram (o corte nunca é "já no disco"
  // pelo fetch-drive-video); tratado como "sem corte" por segurança.
  if (input.genericExists) return { kind: "use", path: input.genericPath, source: "generic" };
  const why = lookup.kind === "wait" ? lookup.reason : "o Drive não devolveu o corte do Instagram";
  return { kind: "wait", reason: `sem corte do Instagram (${why}) e sem o vertical genérico no disco` };
}

export type InstagramTimerOutcome =
  | { kind: "done"; detail: string }
  | { kind: "wait"; detail: string }
  /** O Reels não sai sozinho: o editor precisa agir (acima do teto, atraso, credencial). */
  | { kind: "needs-editor"; detail: string }
  | { kind: "failed"; detail: string };

/** Puro: lê a saída do `publish-shorts.ts --only instagram --publish --instagram-timer`. */
export function interpretInstagramTimerOutput(exitCode: number | null, stdout: string): InstagramTimerOutcome {
  let out: any;
  try {
    out = JSON.parse(stdout);
  } catch {
    return { kind: "failed", detail: `publish-shorts.ts sem JSON (exit ${exitCode})` };
  }
  const result = Array.isArray(out?.results) ? out.results.find((r: any) => r?.destination === "instagram") : undefined;
  if (result) {
    if (result.ok && result.entry) {
      const e = result.entry;
      return { kind: "done", detail: `${result.alreadyRegistered ? "já estava na conta/registro" : "publicado"}: ${e.status}${e.url ? ` ${e.url}` : ` ${e.id}`}` };
    }
    return { kind: "failed", detail: String(result.error ?? "falha sem mensagem") };
  }
  const item = Array.isArray(out?.items) ? out.items.find((i: any) => i?.destination === "instagram") : undefined;
  if (!item) return { kind: "failed", detail: `plano sem o destino instagram (exit ${exitCode})` };
  switch (item.action) {
    case "skip_done":
      return { kind: "done", detail: "já registrado" };
    case "pending_schedule":
      return { kind: "wait", detail: String(item.detail ?? "antes do horário") };
    case "guided":
      return { kind: "needs-editor", detail: `acima do teto de duração da API: ${item.detail ?? "passo guiado"}` };
    case "skip_late":
    case "skip_invalid":
    case "skip_delegated":
      return { kind: "needs-editor", detail: `${item.action}: ${item.detail ?? ""}` };
    case "skip_missing_credentials":
      return { kind: "failed", detail: `sem credencial do Instagram no 300: ${item.detail ?? ""}` };
    default:
      return { kind: "failed", detail: `ação inesperada do plano: ${item.action} (exit ${exitCode})` };
  }
}

/** Puro: corpo do alarme quando o Reels do dia não saiu sozinho. */
export function buildInstagramTimerAlarm(aammdd: string, reason: string): { subject: string; body: string } {
  return {
    subject: `[diar.ia.br] Reels do Instagram de ${aammdd} não saiu pelo timer do 300`,
    body: [
      "Achado automático da task `Diaria-Shorts-Instagram`",
      "(`scripts/shorts-instagram-timer.ts`, #11265).",
      "",
      `Motivo: ${reason}`,
      "",
      "O que fazer:",
      "- Vertical acima do teto da API: postar no instagram.com (Passo B3b do `/diaria-publica-video`)",
      `  e registrar com \`npx tsx scripts/publish-shorts.ts ${aammdd} --confirm-instagram\`.`,
      "- Corte do Instagram faltando no Drive: subir `_Instagram_` em `{AAMMDD}/Final/`; a próxima execução",
      "  (de hora em hora, até 3 h depois do horário do vertical) publica.",
      `- Para publicar desta máquina mesmo assim: \`npx tsx scripts/publish-shorts.ts ${aammdd} --only instagram --publish --instagram-timer --now\``,
      "  (confira antes que o Reels não está na conta).",
    ].join("\n"),
  };
}

/** Puro: o motivo já foi avisado nesta edição? */
export function alreadyAlarmed(stateRaw: string | null, reasonKey: string): boolean {
  if (!stateRaw) return false;
  try {
    const keys = JSON.parse(stateRaw)?.alarmed;
    return Array.isArray(keys) && keys.includes(reasonKey);
  } catch {
    return false; // estado ilegível: avisa de novo (melhor um alarme a mais do que nenhum)
  }
}

function runTsx(args: string[], capture: boolean): { status: number | null; stdout: string } {
  const r = spawnSync(process.execPath, ["--import", "tsx", ...args], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (r.error) throw r.error;
  return { status: r.status, stdout: capture ? (r.stdout ?? "") : "" };
}

async function alarm(dir: string, aammdd: string, reasonKey: string, reason: string): Promise<boolean> {
  const statePath = join(dir, INSTAGRAM_TIMER_ALARM_STATE_FILE);
  const stateRaw = existsSync(statePath) ? readFileSync(statePath, "utf8") : null;
  if (alreadyAlarmed(stateRaw, reasonKey)) {
    console.log(`${LOG_PREFIX} ${aammdd}: alarme "${reasonKey}" já aberto nesta edição — não repete`);
    return true;
  }
  const { subject, body } = buildInstagramTimerAlarm(aammdd, reason);
  const res = await notifyEditor({ check: "shorts-instagram-timer", fingerprint: aammdd, severity: "acao", subject, body }, { cwd: ROOT });
  if (res.issue?.action === "failed") {
    console.error(`${LOG_PREFIX} ${aammdd}: alarme não aberto (${res.issue.error})`);
    return false;
  }
  let prev: string[] = [];
  try {
    prev = stateRaw ? (JSON.parse(stateRaw)?.alarmed ?? []) : [];
  } catch {
    prev = [];
  }
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileAtomic(statePath, JSON.stringify({ aammdd, alarmed: [...new Set([...prev, reasonKey])] }, null, 2) + "\n");
  console.log(`${LOG_PREFIX} ${aammdd}: alarme aberto (${reasonKey})${res.issue?.url ? ` ${res.issue.url}` : ""}`);
  return true;
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
  const config = JSON.parse(readFileSync(join(ROOT, "platform.config.json"), "utf8"));
  const decision = decideInstagramTimerRun({
    config,
    reviewedExists: existsSync(join(dir, "02-reviewed.md")),
    registryRaws: readShortsRegistryRaws(dir),
    aammdd,
    now: new Date(),
  });
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
    const instagramCutPath = join(dir, shortInstagramVideoFileName(aammdd));
    const genericPath = join(dir, shortVideoFileName(aammdd));
    const instagramCutExists = existsSync(instagramCutPath);
    let lookup: DriveLookup | null = null;
    if (!instagramCutExists) {
      const fetchArgs = ["scripts/fetch-drive-video.ts", "--edition", aammdd, "--orientation", "vertical", "--target", "instagram", "--edition-dir", dir];
      const r = runTsx(fetchArgs, true);
      lookup = interpretDriveLookup(r.status, r.stdout);
    }
    const choice = chooseInstagramVideo({ instagramCutPath, instagramCutExists, genericPath, genericExists: existsSync(genericPath), lookup });
    if (choice.kind === "wait") {
      console.log(`${LOG_PREFIX} ${aammdd}: ${choice.reason} — tenta de novo na próxima execução`);
      return 0;
    }
    if (choice.kind === "error") {
      console.error(`${LOG_PREFIX} ${aammdd}: ${choice.reason}`);
      if (!dryRun) await alarm(dir, aammdd, "drive", `Drive: ${choice.reason}`);
      return 1;
    }
    console.log(`${LOG_PREFIX} ${aammdd}: vídeo = ${choice.source === "instagram-cut" ? "corte do Instagram" : "vertical genérico"}${choice.driveName ? ` (Drive: ${choice.driveName})` : ""} → ${choice.path}`);
    const publishArgs = ["scripts/publish-shorts.ts", aammdd, "--only", "instagram", "--publish", "--instagram-timer", "--video", choice.path];
    if (choice.driveFileId) publishArgs.push("--from-drive", choice.driveFileId);
    if (dryRun) {
      console.log(`${LOG_PREFIX} dry-run: npx tsx ${publishArgs.join(" ")}`);
      return 0;
    }
    const r = runTsx(publishArgs, true);
    if (r.stdout) process.stdout.write(r.stdout.endsWith("\n") ? r.stdout : `${r.stdout}\n`);
    const outcome = interpretInstagramTimerOutput(r.status, r.stdout);
    console.log(`${LOG_PREFIX} ${aammdd}: ${outcome.kind} — ${outcome.detail}`);
    if (outcome.kind === "done" || outcome.kind === "wait") return 0;
    const alarmed = await alarm(dir, aammdd, outcome.kind === "failed" ? `failed:${outcome.detail.slice(0, 80)}` : `needs-editor:${outcome.detail.slice(0, 80)}`, outcome.detail);
    return outcome.kind === "failed" || !alarmed ? 1 : 0;
  } finally {
    release();
  }
}

if (isMainModule(import.meta.url)) {
  runCli(main, { onError: (e) => console.error("shorts-instagram-timer:", e instanceof Error ? e.message : e) });
}
