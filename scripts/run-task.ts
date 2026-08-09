#!/usr/bin/env node
/**
 * scripts/run-task.ts (#4805 Fase 2, épica #4798)
 *
 * Entrypoint CLI único que roda uma task do registro declarativo
 * (`scripts/lib/scheduled-tasks.ts`) via `scripts/lib/task-runner.ts`.
 * Destinado a substituir, uma a uma conforme forem cortadas pra cá, as 14
 * invocações hoje feitas por `scripts/run-*.ps1` — sem removê-los (ver "Não
 * fazer" da #4805; cutover real do Task Scheduler é decisão futura, fora
 * deste escopo).
 *
 * Uso:
 *   npx tsx scripts/run-task.ts --task <Nome-Exato-Da-Task>
 *   node --import tsx scripts/run-task.ts --task Diaria-Apoios-Diff-Alarm
 *
 * Exit code: propagado de `runScheduledTask` (ver docstring de
 * task-runner.ts) — 1 quando `--task` está ausente/desconhecido, ANTES de
 * rodar qualquer passo.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getStringArg, isMainModule } from "./lib/cli-args.ts";
import { getScheduledTaskByName, listScheduledTaskNames } from "./lib/scheduled-tasks.ts";
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
