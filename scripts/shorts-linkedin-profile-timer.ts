#!/usr/bin/env node
/**
 * scripts/shorts-linkedin-profile-timer.ts (#10982)
 *
 * Passo do timer do `300` (`Diaria-Shorts-LinkedIn-Profile` e o `-Catchup`,
 * `scripts/lib/scheduled-tasks.ts`) que publica o vertical da edição do dia no
 * LinkedIn PESSOAL do editor sem tarefa manual por edição:
 *
 *   1. edição = hoje em BRT (o vertical sai no dia da própria edição);
 *   2. sem `02-reviewed.md` (fim de semana, feriado), `linkedin_profile` já
 *      registrado em `_internal/06-shorts-published.json` (ou no registro do
 *      próprio timer / numa cópia de conflito do OneDrive, #11157), ou o destino
 *      desligado no config (`linkedin_profile` / `linkedin_profile_via_timer`)
 *      → nada a fazer, exit 0;
 *   3. vertical fora do disco → `fetch-drive-video.ts --orientation vertical`
 *      acha o id no Drive (decisão do editor 23/10/2026: o editor salva no
 *      Drive e o 300 baixa sozinho) e o download vai pelo `--from-drive` do
 *      `publish-shorts.ts`. Nenhum vertical "final" ainda → exit 0 (a próxima
 *      execução tenta de novo); dois candidatos → exit 0 com aviso (quem
 *      escolhe é o editor, no `/diaria-shorts`);
 *   4. `publish-shorts.ts AAMMDD --only linkedin_profile --publish
 *      --linkedin-timer`. O horário é o do vertical (#10831): antes dele o
 *      destino fica `pending_schedule` (nada sai), depois dele publica, e
 *      passadas 3 h vira `skip_late` (nunca publica fora da janela do teste).
 *      Sem `--now` de propósito: o horário do vertical alterna por dia, e a
 *      task das :31/hora cheia cobre os três.
 *
 * Lock O_EXCL em `_internal/.shorts-linkedin-timer.lock` (lock com mais de
 * 90 min é tratado como resto de um processo morto): a task diária e a de
 * hora em hora nunca publicam juntas.
 *
 * Uso: npx tsx scripts/shorts-linkedin-profile-timer.ts [--edition AAMMDD] [--dry-run]
 *   --dry-run: decide e imprime os comandos, sem rodar nenhum.
 *
 * Exit: 0 = feito, nada a fazer ou esperando; 1 = falha (Drive, publish); 2 = uso.
 */

import { spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule, parseArgs } from "./lib/cli-args.ts";
import { runCli } from "./lib/cli-exit.ts";
import { editionDir as editionDirFor } from "./lib/edition-paths.ts";
import { aammddBrt } from "./lib/linkedin-personal.ts";
import { SHORTS_PUBLISHED_FILE, loadShortsConfig, parseShortsPublishedFile, shortVideoFileName } from "./lib/diaria/short-video.ts";
import { readShortsRegistryRaws } from "./lib/diaria/shorts-published-store.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const TIMER_LOCK_FILE = "_internal/.shorts-linkedin-timer.lock";
export const TIMER_LOCK_STALE_MS = 90 * 60_000;

export type TimerDecision =
  | { kind: "skip"; reason: string }
  | { kind: "publish"; fromDrive: boolean };

/** Puro: o que fazer, antes de tocar no Drive. */
export function decideTimerRun(input: {
  config: unknown;
  reviewedExists: boolean;
  /** Conteúdo de `06-shorts-published.json`; null = ausente. */
  publishedRaw: string | null;
  /**
   * #11157: os outros arquivos do registro (o do próprio timer,
   * `06-shorts-published.linkedin-timer.json`, e cópias de conflito do
   * OneDrive). Entrada em qualquer um deles conta como registrada.
   */
  otherRegistryRaws?: ReadonlyArray<{ path: string; raw: string }>;
  aammdd: string;
  videoExists: boolean;
}): TimerDecision {
  const cfg = loadShortsConfig(input.config);
  if (!cfg.linkedinProfile) return { kind: "skip", reason: "publishing.shorts.linkedin_profile = false" };
  if (!cfg.linkedinProfileViaTimer) return { kind: "skip", reason: "publishing.shorts.linkedin_profile_via_timer = false (o /diaria-publica-video publica)" };
  if (!input.reviewedExists) return { kind: "skip", reason: `sem 02-reviewed.md da edição ${input.aammdd} (dia sem edição)` };
  const raws = [
    ...(input.publishedRaw !== null ? [{ path: SHORTS_PUBLISHED_FILE, raw: input.publishedRaw }] : []),
    ...(input.otherRegistryRaws ?? []),
  ];
  for (const { path, raw } of raws) {
    // Registro ilegível lança: nunca vira "nada publicado" (duplicaria o post).
    const file = parseShortsPublishedFile(raw, input.aammdd, path);
    const entry = file.entries.find((e) => e.destination === "linkedin_profile");
    if (entry) return { kind: "skip", reason: `linkedin_profile já registrado (${entry.status}${entry.url ? `, ${entry.url}` : ""}${path === SHORTS_PUBLISHED_FILE ? "" : ` em ${basename(path)}`})` };
  }
  return { kind: "publish", fromDrive: !input.videoExists };
}

export type DriveLookup = { kind: "found"; fileId: string; name: string } | { kind: "exists" } | { kind: "wait"; reason: string } | { kind: "error"; reason: string };

/** Puro: lê a saída do `fetch-drive-video.ts --orientation vertical`. */
export function interpretDriveLookup(exitCode: number | null, stdout: string): DriveLookup {
  let out: any;
  try {
    out = JSON.parse(stdout);
  } catch {
    return { kind: "error", reason: `fetch-drive-video.ts sem JSON (exit ${exitCode})` };
  }
  const action = out?.action;
  if (action === "print-id" && typeof out.file?.id === "string" && out.file.id) return { kind: "found", fileId: out.file.id, name: String(out.file.name ?? "") };
  if (action === "exists") return { kind: "exists" };
  if (action === "none") return { kind: "wait", reason: `nenhum vertical "final" no Drive ainda (${out.reason ?? "sem motivo"})` };
  if (action === "needs-editor") {
    return { kind: "wait", reason: `o Drive tem mais de um candidato (${out.selection}) — o editor escolhe no /diaria-publica-video (Passo B1); o timer não escolhe` };
  }
  return { kind: "error", reason: `fetch-drive-video.ts: ${action ?? "sem action"} (exit ${exitCode})${out?.error ? ` — ${out.error}` : ""}` };
}

/** Lock O_EXCL; devolve o release, ou null se outra execução está no meio. */
export function acquireTimerLock(path: string, now: number = Date.now()): (() => void) | null {
  mkdirSync(dirname(path), { recursive: true });
  const tryOpen = () => {
    try {
      closeSync(openSync(path, "wx"));
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw e;
    }
  };
  if (!tryOpen()) {
    let age = 0;
    try {
      age = now - statSync(path).mtimeMs;
    } catch {
      age = 0;
    }
    if (age <= TIMER_LOCK_STALE_MS) return null;
    rmSync(path, { force: true });
    if (!tryOpen()) return null;
  }
  return () => rmSync(path, { force: true });
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

async function main(): Promise<number> {
  const { flags, values } = parseArgs(process.argv.slice(2));
  const aammdd = values["edition"] ?? aammddBrt(new Date());
  if (!/^\d{6}$/.test(aammdd)) {
    console.error("uso: shorts-linkedin-profile-timer.ts [--edition AAMMDD] [--dry-run]");
    return 2;
  }
  const dryRun = flags.has("dry-run");
  const dir = editionDirFor(aammdd);
  const publishedPath = join(dir, SHORTS_PUBLISHED_FILE);
  const videoPath = join(dir, shortVideoFileName(aammdd));
  const config = JSON.parse(readFileSync(join(ROOT, "platform.config.json"), "utf8"));
  const decision = decideTimerRun({
    config,
    reviewedExists: existsSync(join(dir, "02-reviewed.md")),
    publishedRaw: existsSync(publishedPath) ? readFileSync(publishedPath, "utf8") : null,
    otherRegistryRaws: readShortsRegistryRaws(dir).filter((r) => r.path !== publishedPath),
    aammdd,
    videoExists: existsSync(videoPath),
  });
  if (decision.kind === "skip") {
    console.log(`[shorts-linkedin-timer] ${aammdd}: nada a fazer — ${decision.reason}`);
    return 0;
  }

  const release = dryRun ? () => {} : acquireTimerLock(join(dir, TIMER_LOCK_FILE));
  if (!release) {
    console.log(`[shorts-linkedin-timer] ${aammdd}: outra execução está no meio (${TIMER_LOCK_FILE}) — sai sem publicar`);
    return 0;
  }
  try {
    const publishArgs = ["scripts/publish-shorts.ts", aammdd, "--only", "linkedin_profile", "--publish", "--linkedin-timer"];
    if (decision.fromDrive) {
      const fetchArgs = ["scripts/fetch-drive-video.ts", "--edition", aammdd, "--orientation", "vertical", "--edition-dir", dir];
      const r = runTsx(fetchArgs, true);
      const lookup = interpretDriveLookup(r.status, r.stdout);
      if (lookup.kind === "wait") {
        console.log(`[shorts-linkedin-timer] ${aammdd}: ${lookup.reason} — tenta de novo na próxima execução`);
        return 0;
      }
      if (lookup.kind === "error") {
        console.error(`[shorts-linkedin-timer] ${aammdd}: ${lookup.reason}`);
        return 1;
      }
      if (lookup.kind === "found") {
        console.log(`[shorts-linkedin-timer] ${aammdd}: vertical no Drive: ${lookup.name} (${lookup.fileId})`);
        publishArgs.push("--from-drive", lookup.fileId);
      }
    }
    if (dryRun) {
      console.log(`[shorts-linkedin-timer] dry-run: npx tsx ${publishArgs.join(" ")}`);
      return 0;
    }
    const r = runTsx(publishArgs, false);
    return r.status === 0 ? 0 : 1;
  } finally {
    release();
  }
}

if (isMainModule(import.meta.url)) {
  runCli(main, { onError: (e) => console.error("shorts-linkedin-profile-timer:", e instanceof Error ? e.message : e) });
}
