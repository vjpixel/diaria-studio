#!/usr/bin/env node
/**
 * scripts/publica-phase.ts (#12655)
 *
 * Telemetria e travas do fluxo híbrido do `/diaria-publica`
 * (`docs/publica-video-fluxo-hibrido.md`). Cada fase grava início/fim/erro em
 * `_internal/publica-phases.jsonl` da edição e no run-log, com edição,
 * tentativa, sessão (`CLAUDE_CODE_SESSION_ID`), task-id, parte/stage e o hash
 * do plano. Lógica pura em `scripts/lib/diaria/publica-phases.ts` e
 * `publica-effect-gate.ts`.
 *
 * Uso:
 *   npx tsx scripts/publica-phase.ts start AAMMDD --phase P --part horizontal|vertical|sessao
 *       [--background] [--task-id ID] [--attempt N] [--plan-sha256 H] [--resources a,b]
 *       [--serial-reason TEXTO] [--edition-dir DIR]
 *   npx tsx scripts/publica-phase.ts end|error|interrupted AAMMDD --phase P --part X
 *       [--task-id ID] [--attempt N] [--exit-code N] [--detail TEXTO] [--edition-dir DIR]
 *   npx tsx scripts/publica-phase.ts run AAMMDD --phase P --part X [--background] [...] -- comando args...
 *   npx tsx scripts/publica-phase.ts join AAMMDD [--edition-dir DIR]
 *   npx tsx scripts/publica-phase.ts report AAMMDD [--edition-dir DIR]
 *
 * - `start` recusa (exit 1, nada gravado) quando: o recurso (Chrome, um
 *   registro) está com outra fase; é fase do vídeo no thread principal com a
 *   Etapa 5/6 rodando, ou fase da Etapa 5/6 com fase do vídeo aberta no
 *   thread principal (isolamento de custo); é retry de upload/vertical
 *   (`vertical-api`, `vertical-guiado`) depois de erro, interrupção ou órfã
 *   sem uma releitura do registro gravada depois do fim da tentativa e
 *   cobrindo o início dela; é a 1ª pergunta bloqueante sem preparo em
 *   background (ou `--serial-reason`); o `publica-phases.jsonl` tem linha
 *   ilegível e a fase tem efeito externo ou segura recurso (a linha perdida
 *   pode ser o `start` de uma tentativa interrompida); ou o estado não
 *   autoriza o efeito externo (aprovação do plano atual para upload e
 *   vertical; link do vídeo para a Etapa 5 e o Schedule até o sentinel da
 *   Etapa 5, #12588 — depois dele o `check-video-before-publish` não bloqueia
 *   mais). O `link` passa por este gate: quem decide se o link entra é o
 *   próprio `link-video-d1.ts`. Check e gravação sob lock: duas fases não
 *   pegam o Chrome ao mesmo tempo. Erro de uso sai 2.
 * - `run` faz `start`, roda o comando (stdio herdado), grava o PID do filho
 *   (`spawned`) e grava `end` (exit 0), `error` (outro exit) ou `interrupted`
 *   (SIGINT/SIGTERM, repassado ao filho) com o exit code; sai com o exit do
 *   comando (1 se recusado antes, 2 em erro de uso). Comando OK com o fim não
 *   gravado sai 4: não repetir o comando (o upload já saiu), gravar o fim à
 *   mão. É o jeito de lançar trabalho em background (`run_in_background`)
 *   com o fim registrado pelo próprio processo, sem o thread principal
 *   precisar responder à notificação. A tarefa vira órfã quando o wrapper e
 *   o filho morreram sem gravar o fim; tarefa aberta por `start` manual não
 *   tem PID e nunca vira órfã (gravar `interrupted` à mão).
 * - `join` sai 1 com tarefa pendente (inclusive em background), órfã sem
 *   tentativa posterior concluída, linha ilegível no JSONL ou sentinel
 *   antecipado: nenhuma fase é dada por concluída assim.
 * - `report` imprime as durações por fase (`null` = indisponível, nunca
 *   zero), o caminho crítico pela união dos intervalos, execução × espera.
 *
 * Não publica nada nem chama API.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule, parseArgs } from "./lib/cli-args.ts";
import { editionDir as editionDirFor } from "./lib/edition-paths.ts";
import { withFileLock } from "./lib/file-lock.ts";
import { appendFileWithRetry } from "./lib/source-runs.ts";
import { logEvent } from "./lib/run-log.ts";
import { currentSessionId } from "./lib/session-transcript.ts";
import {
  PHASE_META,
  PUBLICA_PHASES_FILE,
  buildPhaseEvent,
  checkPhaseStart,
  deriveTasks,
  isPublicaPart,
  isPublicaPhase,
  joinCheck,
  nextAttempt,
  parsePhaseEvents,
  phaseReport,
  type PhaseEvent,
  type PhaseEventKind,
  type PublicaPart,
  type PublicaPhase,
  type RegistryCheckLike,
} from "./lib/diaria/publica-phases.ts";
import { checkExternalEffect, type VideoGateLike } from "./lib/diaria/publica-effect-gate.ts";
import {
  currentHost,
  isPidAliveHere,
  readAuthorizationStore,
  type VideoPublishAuthorizationStore,
} from "./lib/diaria/video-publish-authorization.ts";
import { planSha256, readVideoPlanManifest } from "./lib/diaria/video-publish-plan.ts";
import { assessVideoBeforePublish, STAGE5_DONE_FILE } from "./lib/diaria/video-before-publish.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STAGE6_DONE_FILE = "_internal/.step-6-done.json";
/** `run`: o comando saiu 0, mas o fim não foi gravado. Não repetir o comando. */
export const RUN_TELEMETRY_LOST_EXIT = 4;

const USAGE =
  "uso: publica-phase.ts start|end|error|interrupted AAMMDD --phase P --part horizontal|vertical|sessao [--background] [--task-id ID] [--attempt N] [--plan-sha256 H] [--resources a,b] [--serial-reason TEXTO] [--exit-code N] [--detail TEXTO] [--edition-dir DIR]\n" +
  "     publica-phase.ts run AAMMDD --phase P --part X [--background] [...] -- comando args...\n" +
  "     publica-phase.ts join|report AAMMDD [--edition-dir DIR]";

export interface PhaseCliDeps {
  log: (line: string) => void;
  err: (line: string) => void;
  now: () => Date;
  env: NodeJS.ProcessEnv;
  host: string;
  pid: number;
  isPidAlive: (pid: number) => boolean;
  /** Grava a linha no run-log (default: `logEvent` na raiz do repo). */
  runLog: (ev: PhaseEvent) => void;
  /** Lê o veredito do vídeo para as Etapas 5/6 (default: `assessVideoBeforePublish`). */
  videoGate: (editionDir: string, aammdd: string) => VideoGateLike;
  /** Roda o comando do `run` e devolve o exit code. */
  spawnCommand: (argv: string[], onStart: (pid: number | undefined) => void) => Promise<{ code: number; signal: NodeJS.Signals | null }>;
}

function defaultSpawn(argv: string[], onStart: (pid: number | undefined) => void): Promise<{ code: number; signal: NodeJS.Signals | null }> {
  return new Promise((resolvePromise) => {
    const child = spawn(argv[0], argv.slice(1), { stdio: "inherit", shell: process.platform === "win32" });
    onStart(child.pid);
    const forward = (sig: NodeJS.Signals) => {
      try {
        child.kill(sig);
      } catch {
        /* o filho já saiu */
      }
    };
    process.on("SIGINT", forward);
    process.on("SIGTERM", forward);
    child.on("error", (e) => {
      console.error(`publica-phase: falha ao iniciar ${argv[0]}: ${e.message}`);
      resolvePromise({ code: 127, signal: null });
    });
    child.on("exit", (code, signal) => {
      process.off("SIGINT", forward);
      process.off("SIGTERM", forward);
      resolvePromise({ code: code ?? 1, signal });
    });
  });
}

export const defaultPhaseCliDeps: PhaseCliDeps = {
  log: (l) => console.log(l),
  err: (l) => console.error(l),
  now: () => new Date(),
  env: process.env,
  host: currentHost(),
  pid: process.pid,
  isPidAlive: isPidAliveHere,
  runLog: (ev) => {
    logEvent(
      {
        edition: ev.edition,
        stage: ev.stage,
        agent: "publica-phase",
        level: ev.event === "error" || ev.event === "interrupted" ? "warn" : "info",
        message: `${ev.phase}/${ev.part} ${ev.event} (tentativa ${ev.attempt})`,
        details: ev,
      },
      ROOT,
    );
  },
  videoGate: (dir, aammdd) => assessVideoBeforePublish(dir, aammdd),
  spawnCommand: defaultSpawn,
};

function readEvents(dir: string, err: (l: string) => void): { events: PhaseEvent[]; problems: string[] } {
  const path = join(dir, PUBLICA_PHASES_FILE);
  if (!existsSync(path)) return { events: [], problems: [] };
  const { events, problems } = parsePhaseEvents(readFileSync(path, "utf8"));
  for (const p of problems) err(`[aviso] ${path}: ${p}`);
  return { events, problems: problems.map((p) => `${path}: ${p}`) };
}

function appendEvent(dir: string, ev: PhaseEvent): void {
  const path = join(dir, PUBLICA_PHASES_FILE);
  mkdirSync(dirname(path), { recursive: true });
  appendFileWithRetry(path, JSON.stringify(ev) + "\n");
}

function readStore(dir: string, aammdd: string): { store: VideoPublishAuthorizationStore | null; error: string | null } {
  try {
    return { store: readAuthorizationStore(dir, aammdd), error: null };
  } catch (e) {
    return { store: null, error: (e as Error).message };
  }
}

function registryChecksOf(store: VideoPublishAuthorizationStore | null): RegistryCheckLike[] {
  if (!store) return [];
  return store.events.filter((e) => e.kind === "registry-check").map((e) => ({ at: e.at, since: (e as { since: string }).since, verdict: (e as { verdict: string }).verdict }));
}

interface CommonArgs {
  aammdd: string;
  dir: string;
  phase: PublicaPhase;
  part: PublicaPart;
  values: Record<string, string>;
  flags: Set<string>;
}

function parseCommon(argv: string[], deps: PhaseCliDeps, needsPhase: boolean): CommonArgs | number {
  const { values, flags, positional } = parseArgs(argv);
  const aammdd = positional[0];
  if (!aammdd || !/^\d{6}$/.test(aammdd)) {
    deps.err(USAGE);
    return 2;
  }
  const dir = resolve(values["edition-dir"] ?? editionDirFor(aammdd));
  if (!existsSync(dir)) {
    deps.err(`publica-phase: ${dir} não existe`);
    return 2;
  }
  if (!needsPhase) return { aammdd, dir, phase: "preflight", part: "sessao", values, flags };
  const phase = values["phase"];
  const part = values["part"];
  if (!phase || !isPublicaPhase(phase) || !part || !isPublicaPart(part)) {
    deps.err(`publica-phase: --phase e --part obrigatórios e válidos`);
    deps.err(USAGE);
    return 2;
  }
  return { aammdd, dir, phase, part, values, flags };
}

function parseIntOpt(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isInteger(n) ? n : NaN;
}

/** `start` com check e gravação sob lock. Devolve o evento gravado, ou o exit de recusa/uso. */
function doStart(a: CommonArgs, deps: PhaseCliDeps, extra: { pid?: number; taskId?: string | null } = {}): PhaseEvent | number {
  const lockPath = join(a.dir, `${PUBLICA_PHASES_FILE}.lock`);
  mkdirSync(dirname(lockPath), { recursive: true });
  return withFileLock(lockPath, () => {
    const { events, problems: parseProblems } = readEvents(a.dir, deps.err);
    const attemptRaw = parseIntOpt(a.values["attempt"]);
    if (attemptRaw !== undefined && Number.isNaN(attemptRaw)) {
      deps.err("publica-phase: --attempt inválido");
      return 2;
    }
    let planHash: string | null = a.values["plan-sha256"] ?? null;
    const videoPartPlan = a.part === "horizontal" || a.part === "vertical" ? a.part : null;
    let currentPlanSha: string | null = null;
    if (videoPartPlan) {
      try {
        const m = readVideoPlanManifest(a.dir, videoPartPlan);
        currentPlanSha = m ? planSha256(m) : null;
      } catch (e) {
        deps.err(`[aviso] manifesto do plano ${videoPartPlan} ilegível: ${(e as Error).message}`);
      }
      planHash ??= currentPlanSha;
    }
    let ev: PhaseEvent;
    try {
      ev = buildPhaseEvent({
        edition: a.aammdd,
        phase: a.phase,
        part: a.part,
        event: "start",
        at: deps.now(),
        attempt: attemptRaw ?? nextAttempt(events, a.phase, a.part),
        sessionId: currentSessionId(deps.env),
        taskId: extra.taskId ?? a.values["task-id"] ?? null,
        background: a.flags.has("background"),
        planSha256: planHash,
        extraResources: a.values["resources"] ? a.values["resources"].split(",").map((s) => s.trim()).filter(Boolean) : [],
        pid: extra.pid,
        host: extra.pid !== undefined ? deps.host : undefined,
      });
    } catch (e) {
      deps.err(`publica-phase: ${(e as Error).message}`);
      return 2;
    }
    const { store, error: storeError } = readStore(a.dir, a.aammdd);
    const problems = checkPhaseStart({
      events,
      candidate: ev,
      deriveOptions: { isPidAlive: deps.isPidAlive, host: deps.host },
      registryChecks: registryChecksOf(store),
      serialReason: a.values["serial-reason"] ?? null,
    });
    if (parseProblems.length && (PHASE_META[a.phase].effect === "external" || ev.resources.length > 0)) {
      problems.push(
        `${parseProblems.length} linha(s) ilegível(is) em ${PUBLICA_PHASES_FILE}: a linha perdida pode ser o start de uma tentativa interrompida ` +
          `(sem ela, o retry pularia a releitura do registro, #11741). Confira o registro, corrija ou remova a linha e rode de novo`,
      );
    }
    if (PHASE_META[a.phase].effect === "external") {
      const gate = checkExternalEffect({
        phase: a.phase,
        part: a.part,
        store,
        storeError,
        currentPlanSha256: currentPlanSha,
        videoGate: a.phase === "stage5" || a.phase === "stage6-schedule" ? deps.videoGate(a.dir, a.aammdd) : null,
        host: deps.host,
      });
      if (!gate.ok) problems.push(`efeito externo: ${gate.reason}`);
      else deps.err(`[ok] ${a.phase}/${a.part}: ${gate.note}`);
    }
    if (problems.length) {
      for (const p of problems) deps.err(`publica-phase: recusado — ${p}`);
      deps.log(JSON.stringify({ ok: false, phase: a.phase, part: a.part, problems }, null, 2));
      return 1;
    }
    appendEvent(a.dir, ev);
    deps.runLog(ev);
    return ev;
  });
}

function doFinish(
  a: CommonArgs,
  kind: Exclude<PhaseEventKind, "start" | "spawned">,
  deps: PhaseCliDeps,
  extra: { taskId?: string | null; exitCode?: number; detail?: string; attempt?: number } = {},
): number {
  const { events } = readEvents(a.dir, deps.err);
  const taskId = extra.taskId ?? a.values["task-id"] ?? null;
  const openTasks = deriveTasks(events).filter((t) => t.status === "running" && t.phase === a.phase && t.part === a.part && t.task_id === taskId);
  const attemptOpt = extra.attempt ?? parseIntOpt(a.values["attempt"]);
  const target = attemptOpt !== undefined ? openTasks.find((t) => t.attempt === attemptOpt) : openTasks[openTasks.length - 1];
  if (!target) {
    deps.err(`publica-phase: nenhuma fase ${a.phase}/${a.part}${taskId ? ` (task ${taskId})` : ""} aberta para fechar — registre o start antes`);
    return 1;
  }
  const exitRaw = extra.exitCode ?? parseIntOpt(a.values["exit-code"]);
  const ev = buildPhaseEvent({
    edition: a.aammdd,
    phase: a.phase,
    part: a.part,
    event: kind,
    at: deps.now(),
    attempt: target.attempt,
    sessionId: currentSessionId(deps.env),
    taskId,
    background: target.background,
    planSha256: target.plan_sha256,
    exitCode: exitRaw !== undefined && !Number.isNaN(exitRaw) ? exitRaw : undefined,
    detail: extra.detail ?? a.values["detail"],
  });
  appendEvent(a.dir, ev);
  deps.runLog(ev);
  deps.log(JSON.stringify({ ok: true, event: ev }, null, 2));
  return 0;
}

export async function main(argv: string[] = process.argv.slice(2), deps: PhaseCliDeps = defaultPhaseCliDeps): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd === "start") {
    const a = parseCommon(rest, deps, true);
    if (typeof a === "number") return a;
    const r = doStart(a, deps);
    if (typeof r === "number") return r;
    deps.log(JSON.stringify({ ok: true, event: r }, null, 2));
    return 0;
  }
  if (cmd === "end" || cmd === "error" || cmd === "interrupted") {
    const a = parseCommon(rest, deps, true);
    if (typeof a === "number") return a;
    return doFinish(a, cmd, deps);
  }
  if (cmd === "run") {
    const sep = rest.indexOf("--");
    if (sep < 0 || sep === rest.length - 1) {
      deps.err("publica-phase run: falta o comando depois de `--`");
      return 2;
    }
    const a = parseCommon(rest.slice(0, sep), deps, true);
    if (typeof a === "number") return a;
    const command = rest.slice(sep + 1);
    const taskId = a.values["task-id"] ?? `pid-${deps.pid}`;
    const started = doStart(a, deps, { pid: deps.pid, taskId });
    if (typeof started === "number") return started === 2 ? 2 : 1;
    // O PID do filho (o publisher) também conta: ele pode sobreviver ao wrapper.
    const onChildStart = (childPid: number | undefined) => {
      if (childPid === undefined) return;
      try {
        const sp = buildPhaseEvent({
          edition: a.aammdd,
          phase: a.phase,
          part: a.part,
          event: "spawned",
          at: deps.now(),
          attempt: started.attempt,
          sessionId: currentSessionId(deps.env),
          taskId,
          background: started.background,
          planSha256: started.plan_sha256,
          childPid,
          host: deps.host,
        });
        appendEvent(a.dir, sp);
      } catch (e) {
        deps.err(`[aviso] PID do filho (${childPid}) não gravado: ${(e as Error).message}`);
      }
    };
    let interrupted: NodeJS.Signals | null = null;
    const onSignal = (sig: NodeJS.Signals) => {
      interrupted = sig;
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    let result: { code: number; signal: NodeJS.Signals | null };
    try {
      result = await deps.spawnCommand(command, onChildStart);
    } finally {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
    }
    const kind: Exclude<PhaseEventKind, "start" | "spawned"> = interrupted || result.signal ? "interrupted" : result.code === 0 ? "end" : "error";
    let finished: number;
    try {
      finished = doFinish(a, kind, deps, {
        taskId,
        attempt: started.attempt,
        exitCode: result.code,
        detail: interrupted || result.signal ? `sinal ${interrupted ?? result.signal}` : `exit ${result.code}`,
      });
    } catch (e) {
      deps.err(`publica-phase: falha ao gravar o fim: ${(e as Error).message}`);
      finished = 1;
    }
    if (finished !== 0) {
      const close = `npx tsx scripts/publica-phase.ts ${kind} ${a.aammdd} --phase ${a.phase} --part ${a.part} --attempt ${started.attempt} --task-id ${taskId} --exit-code ${result.code}`;
      if (kind === "end") {
        deps.err(`publica-phase: comando OK, telemetria não gravada — NÃO repita o comando (o efeito já saiu). Grave o fim à mão: ${close}`);
        return RUN_TELEMETRY_LOST_EXIT;
      }
      deps.err(`publica-phase: o fim (${kind}) não foi gravado; grave à mão: ${close}`);
    }
    return result.code;
  }
  if (cmd === "join") {
    const a = parseCommon(rest, deps, false);
    if (typeof a === "number") return a;
    const { events, problems: parseProblems } = readEvents(a.dir, deps.err);
    const r = joinCheck(
      events,
      { step5: existsSync(join(a.dir, STAGE5_DONE_FILE)), step6: existsSync(join(a.dir, STAGE6_DONE_FILE)) },
      { isPidAlive: deps.isPidAlive, host: deps.host },
    );
    // Linha ilegível pode esconder uma tarefa pendente: o join não fecha às cegas.
    const problems = [...r.problems, ...parseProblems.map((p) => `linha ilegível: ${p}`)];
    for (const p of problems) deps.err(`publica-phase join: ${p}`);
    const ok = problems.length === 0;
    deps.log(JSON.stringify({ ok, parts_pending: r.partsPending, problems }, null, 2));
    return ok ? 0 : 1;
  }
  if (cmd === "report") {
    const a = parseCommon(rest, deps, false);
    if (typeof a === "number") return a;
    const { events } = readEvents(a.dir, deps.err);
    deps.log(JSON.stringify(phaseReport(a.aammdd, events, { isPidAlive: deps.isPidAlive, host: deps.host }), null, 2));
    return 0;
  }
  deps.err(USAGE);
  return 2;
}

if (isMainModule(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error("publica-phase:", e instanceof Error ? e.message : e);
      process.exit(1);
    },
  );
}
