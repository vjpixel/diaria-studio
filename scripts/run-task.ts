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
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getStringArg, isMainModule } from "./lib/cli-args.ts";
import { getScheduledTaskByName, isRetiredTaskName, listScheduledTaskNames } from "./lib/scheduled-tasks.ts";
import { runScheduledTask } from "./lib/task-runner.ts";

function usage(): string {
  const names = listScheduledTaskNames()
    .map((n) => `  - ${n}`)
    .join("\n");
  return `Uso: run-task.ts --task <nome>\n\nTasks conhecidas:\n${names}`;
}

export function main(argv: string[], repoRootAbs: string): number {
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

  const result = runScheduledTask(def, { rootDir: repoRootAbs });
  return result.code;
}

if (isMainModule(import.meta.url)) {
  const repoRootAbs = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  process.exit(main(process.argv.slice(2), repoRootAbs));
}
