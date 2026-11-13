#!/usr/bin/env node
/**
 * scripts/run-task.ts (#4805 Fase 2, épica #4798)
 *
 * Entrypoint CLI único que roda uma task do registro declarativo
 * (`scripts/lib/scheduled-tasks.ts`) via `scripts/lib/task-runner.ts`.
 * Substituiu as invocações que antes eram feitas por `scripts/run-*.ps1`
 * (removidos no #5115, cutover final — nenhuma máquina Windows roda mais
 * tasks `Diaria-*`).
 *
 * Uso:
 *   npx tsx scripts/run-task.ts --task <Nome-Exato-Da-Task>
 *   node --import tsx scripts/run-task.ts --task Diaria-Apoios-Diff-Alarm
 *
 * Exit code: propagado de `runScheduledTask` (ver docstring de
 * task-runner.ts) — 1 quando `--task` está ausente/desconhecido, ANTES de
 * rodar qualquer passo. Exceção: nome de task RETIRADA conhecida
 * (`RETIRED_TASK_NAMES`, ver `scripts/lib/scheduled-tasks.ts`) sai 0 — é o
 * caso de um unit systemd instalado que ainda invoca um nome removido do
 * registro (#5733), diferente de um nome que nunca existiu (typo).
 *
 * **Gate de failover (#12982).** Antes de rodar, `runFailoverGate`
 * (`scripts/lib/failover/task-gate.ts`) decide se esta máquina pode agir: task
 * `critical` adquire o lease anti-duplicação entre o `300` e o Neo; cedendo, a
 * run sai 0 sem rodar nada. `--failover-standby` (só as tasks
 * `Diaria-Failover-*` do Neo passam) marca a run como do Neo, que é
 * fail-closed. Ver `docs/failover-neo.md`.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getStringArg, isMainModule } from "./lib/cli-args.ts";
import { parse as parseDotenv } from "dotenv";
import { createKvRestOps } from "./lib/cloudflare-kv-rest.ts";
import { runFailoverGate, type FailoverGateDeps } from "./lib/failover/task-gate.ts";
import { getScheduledTaskByName, isRetiredTaskName, listScheduledTaskNames } from "./lib/scheduled-tasks.ts";
import { runScheduledTask, type RunScheduledTaskOptions } from "./lib/task-runner.ts";
import type { GitSyncResult } from "./lib/git-sync.ts";

function usage(): string {
  const names = listScheduledTaskNames()
    .map((n) => `  - ${n}`)
    .join("\n");
  return `Uso: run-task.ts --task <nome> [--failover-standby]\n\nTasks conhecidas:\n${names}`;
}

function readPlatformConfig(repoRootAbs: string): unknown {
  try {
    return JSON.parse(readFileSync(join(repoRootAbs, "platform.config.json"), "utf8"));
  } catch {
    return null;
  }
}

/** Dependências injetáveis (testes). Default: env real, KV REST real, runner real. */
export interface RunTaskDeps {
  gate?: Partial<FailoverGateDeps>;
  runner?: RunScheduledTaskOptions;
  /** Lê o `.env` do repo para o env do gate (default: `readDotenv`). */
  readDotenv?: (repoRootAbs: string) => Record<string, string>;
}

/** Resultado de sync "pulado" para a run do Neo. Não há outcome próprio no
 * `GitSyncOutcome`; `already_up_to_date` evita o retry do runner, e
 * `up_to_date=false` + o WARN deixam no log que nada foi conferido. */
export function standbySkippedSync(): GitSyncResult {
  return {
    outcome: "already_up_to_date",
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

  // #12982 — o gate só lê .env/KV para task `critical` ou run do Neo; as
  // demais seguem exatamente como antes. O .env entra só no env DO GATE (o
  // ambiente vence o arquivo, como em `loadProjectEnv`), sem mutar
  // `process.env`: os passos da task continuam herdando o ambiente de sempre.
  const needsEnv = def.failover === "critical" || argv.includes("--failover-standby");
  const gate = await runFailoverGate(def, argv, {
    env: deps.gate?.env ?? (needsEnv ? { ...(deps.readDotenv ?? readDotenv)(repoRootAbs), ...process.env } : process.env),
    platformConfig: deps.gate?.platformConfig !== undefined ? deps.gate.platformConfig : readPlatformConfig(repoRootAbs),
    makeKv: deps.gate?.makeKv ?? createKvRestOps,
    now: deps.gate?.now,
  });
  if (!gate.proceed) {
    (gate.code === 0 ? console.log : console.error)(gate.message);
    return gate.code;
  }
  if (gate.message) console.log(gate.message);

  // #12982 — no Neo o checkout é o de trabalho do editor, compartilhado com as
  // sessões interativas: o sync de código do runner (checkout master, stash,
  // ff) a cada hora atropelaria quem estiver trabalhando nele. A run do Neo
  // usa o código como está; manter o checkout em dia é passo do runbook.
  const standbyNoSync: Pick<RunScheduledTaskOptions, "syncCode"> = argv.includes("--failover-standby")
    ? { syncCode: () => standbySkippedSync() }
    : {};
  const result = runScheduledTask(def, { rootDir: repoRootAbs, ...standbyNoSync, ...deps.runner });
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
