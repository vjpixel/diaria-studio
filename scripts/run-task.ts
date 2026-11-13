#!/usr/bin/env node
/**
 * scripts/run-task.ts (#4805 Fase 2, épica #4798)
 *
 * Entrypoint CLI único que roda uma task do registro declarativo
 * (`scripts/lib/scheduled-tasks.ts`) via `scripts/lib/task-runner.ts`.
 * Substituiu as invocações que antes eram feitas por `scripts/run-*.ps1`
 * (removidos no #5115, cutover final — nenhuma máquina Windows roda mais
 * tasks `Diaria-*`, salvo a contingência do #12982, ver abaixo).
 *
 * Uso:
 *   npx tsx scripts/run-task.ts --task <Nome-Exato-Da-Task> [--failover-standby]
 *   node --import tsx scripts/run-task.ts --task Diaria-Apoios-Diff-Alarm
 *
 * Exit code: propagado de `runScheduledTask` (ver docstring de
 * task-runner.ts) — 1 quando `--task` está ausente/desconhecido, ANTES de
 * rodar qualquer passo. Exceção: nome de task RETIRADA conhecida
 * (`RETIRED_TASK_NAMES`, ver `scripts/lib/scheduled-tasks.ts`) sai 0 — é o
 * caso de um unit systemd instalado que ainda invoca um nome removido do
 * registro (#5733), diferente de um nome que nunca existiu (typo). Quando o
 * gate de failover não deixa a task rodar: 0 ao ceder ao lease ativo da outra
 * máquina, 1 nos demais casos (fail-closed, tier errado, anomalia de lease);
 * lista completa na docstring de `scripts/lib/failover/task-gate.ts`.
 *
 * **Gate de failover (#12982).** Antes de rodar, `runFailoverGate`
 * (`scripts/lib/failover/task-gate.ts`) decide se esta máquina pode agir: task
 * `critical` adquire o lease anti-duplicação entre o `300` e o Neo.
 * `--failover-standby` (só as tasks `Diaria-Failover-*` do Neo passam) marca a
 * run como do Neo, que é fail-closed, não faz o sync de código e passa o
 * `.env` parseado aos passos. Tasks não-`critical` no `300` seguem exatamente
 * como antes. Ver `docs/failover-neo.md`.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getStringArg, isMainModule } from "./lib/cli-args.ts";
import { parse as parseDotenv } from "dotenv";
import { createKvRestOps } from "./lib/cloudflare-kv-rest.ts";
import { defaultLeaseMemoryPath, fileLeaseMemory } from "./lib/failover/lease-memory.ts";
import { STANDBY_HOST } from "./lib/failover/scheduler-lease.ts";
import {
  failoverRole,
  mergeDotenvUnderEnv,
  readPlatformConfigFile,
  runFailoverGate,
  type FailoverGateDeps,
} from "./lib/failover/task-gate.ts";
import { getScheduledTaskByName, isRetiredTaskName, listScheduledTaskNames, resolveFailoverTier } from "./lib/scheduled-tasks.ts";
import { execTsxStep, runScheduledTask, STEP_MAX_BUFFER_BYTES, type RunScheduledTaskOptions } from "./lib/task-runner.ts";
import type { GitSyncResult } from "./lib/git-sync.ts";

function usage(): string {
  const names = listScheduledTaskNames()
    .map((n) => `  - ${n}`)
    .join("\n");
  return `Uso: run-task.ts --task <nome> [--failover-standby]\n\nTasks conhecidas:\n${names}`;
}

/** Dependências injetáveis (testes). Default: env real, KV REST real, runner real. */
export interface RunTaskDeps {
  gate?: Partial<FailoverGateDeps>;
  runner?: RunScheduledTaskOptions;
  /** Lê o `.env` do repo (default: `readDotenv`). */
  readDotenv?: (repoRootAbs: string) => Record<string, string>;
  /** Ambiente do processo (default `process.env`). */
  processEnv?: Record<string, string | undefined>;
  /** Executor real de passo, usado na run do Neo com o env mesclado (default `execTsxStep`). */
  execTsxStep?: typeof execTsxStep;
}

/** Resultado de sync "pulado" para a run do Neo (`outcome: "skipped"`, nada conferido). */
export function standbySkippedSync(): GitSyncResult {
  return {
    outcome: "skipped",
    message: "sync de código pulado no Neo (#12982)",
    branch_before: "",
    warnings: ["sync de código pulado no Neo (#12982): o checkout do editor roda como está; conferir no runbook (docs/failover-neo.md)"],
    proceed: true,
    up_to_date: false,
    commits_behind: -1,
    preserved_stash: null,
    stale_autostash_count: 0,
  };
}

/** `.env` do repo parseado, sem tocar `process.env`; `{}` se ausente/ilegível. */
function readDotenv(repoRootAbs: string): Record<string, string> {
  try {
    return parseDotenv(readFileSync(join(repoRootAbs, ".env"), "utf8"));
  } catch {
    return {};
  }
}

export async function main(argv: string[], repoRootAbs: string, deps: RunTaskDeps = {}): Promise<number> {
  let taskName: string | undefined;
  try {
    taskName = getStringArg(argv, "task", { example: "Diaria-Apoios-Diff-Alarm" });
  } catch (e) {
    console.error((e as Error).message);
    console.error(`\n${usage()}`);
    return 1;
  }

  if (!taskName) {
    console.error(usage());
    return 1;
  }

  const def = getScheduledTaskByName(taskName);
  if (!def) {
    if (isRetiredTaskName(taskName)) {
      console.log(
        `Task "${taskName}" foi retirada do registro (ver RETIRED_TASK_NAMES em scripts/lib/scheduled-tasks.ts, #5733). ` +
          `Nenhuma ação necessária — o unit systemd correspondente ainda precisa ser removido manualmente pelo editor.`,
      );
      return 0;
    }
    console.error(`Task desconhecida: "${taskName}".\n\n${usage()}`);
    return 1;
  }

  // #12982 — papel calculado UMA vez e usado no gate, no env e no sync.
  const role = failoverRole(argv);
  const standby = role === STANDBY_HOST;
  // Só task `critical` ou run do Neo lê .env/config/KV; as demais seguem
  // exatamente como antes. O .env fica por baixo do ambiente (valor vazio do
  // ambiente não apaga o do arquivo), sem mutar `process.env`.
  const needsEnv = resolveFailoverTier(def) === "critical" || standby;
  const processEnv = deps.processEnv ?? process.env;
  const mergedEnv = needsEnv ? mergeDotenvUnderEnv((deps.readDotenv ?? readDotenv)(repoRootAbs), processEnv) : null;

  if (needsEnv) {
    const gate = await runFailoverGate(def, role, {
      env: deps.gate?.env ?? mergedEnv ?? processEnv,
      platformConfig: deps.gate?.platformConfig ?? readPlatformConfigFile(repoRootAbs),
      makeKv: deps.gate?.makeKv ?? createKvRestOps,
      now: deps.gate?.now,
      memory: deps.gate?.memory ?? fileLeaseMemory(defaultLeaseMemoryPath(processEnv)),
      platform: deps.gate?.platform,
    });
    const print = gate.level === "info" ? console.log : console.error;
    if (!gate.proceed) {
      print(gate.message);
      return gate.code;
    }
    if (gate.message) print(gate.message);
  }

  // #12982 — no Neo o checkout é o de trabalho do editor, compartilhado com as
  // sessões interativas: o sync de código do runner (checkout master, stash,
  // ff) a cada hora atropelaria quem estiver trabalhando nele. A run do Neo
  // usa o código como está; manter o checkout em dia é passo do runbook. E os
  // passos recebem o .env mesclado: no Task Scheduler não há EnvironmentFile,
  // e scripts como os timers `shorts-*-timer.ts` não carregam o .env sozinhos.
  const standbyOpts: Pick<RunScheduledTaskOptions, "syncCode" | "execStep"> = {};
  if (standby) {
    const exec = deps.execTsxStep ?? execTsxStep;
    const stepEnv = mergedEnv as NodeJS.ProcessEnv;
    standbyOpts.syncCode = () => standbySkippedSync();
    standbyOpts.execStep = (script, args, cwd) => exec(script, args, cwd, STEP_MAX_BUFFER_BYTES, stepEnv);
  }
  const result = runScheduledTask(def, { rootDir: repoRootAbs, ...standbyOpts, ...deps.runner });
  return result.code;
}

if (isMainModule(import.meta.url)) {
  const repoRootAbs = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  main(process.argv.slice(2), repoRootAbs).then(
    (code) => process.exit(code),
    (e) => {
      console.error(e instanceof Error ? e.stack ?? e.message : e);
      process.exit(1);
    },
  );
}
