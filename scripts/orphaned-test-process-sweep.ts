#!/usr/bin/env node
/**
 * scripts/orphaned-test-process-sweep.ts (#8661)
 *
 * Item 1 pendente do #7753: sweep standalone que lista processos Node com
 * `--test-isolation=process` cujo cmdline referencia um worktree que **não
 * existe mais no disco**, e mata por PID (nunca por nome de imagem — ver
 * `context/overnight-dispatch-rules.md` item 12 / memória
 * `taskkill-nunca-por-nome-de-imagem`). Lógica de detecção pura em
 * `scripts/lib/orphaned-test-process-sweep.ts`; enumeração de processos em
 * `scripts/lib/list-processes.ts` (POSIX apenas — ver docstring de lá).
 *
 * Causa raiz e mecanismo completos: issue #8661 (2 órfãos de ~291h medidos
 * ao vivo, mesma classe do #5959 "run-edition-stages.ts morto por OOM sem
 * causa raiz identificada" e do #7753, que corrigiu só o caminho onde o
 * próprio `run-tests.ts` mata o batch por timeout — este sweep cobre o
 * caminho RESTANTE: worktree removido por fora (`git worktree remove
 * --force`, tipicamente via `cleanup-merged-worktrees.ts`) enquanto um
 * teste ainda rodava dentro dele. Ver também `scripts/lib/worktree-remove.ts`
 * (`removeWorktreeSafe`), que passou a checar processo vivo ANTES de
 * remover — este sweep é a rede de segurança pro que escapar dessa checagem
 * (ex: processo que nasceu depois da checagem, ou removeu por outro
 * caminho que não passa por `removeWorktreeSafe`).
 *
 * Uso:
 *   npx tsx scripts/orphaned-test-process-sweep.ts             # varre e mata por PID
 *   npx tsx scripts/orphaned-test-process-sweep.ts --dry-run   # só lista, não mata
 *
 * Chamável por watchdog/cron (ex: junto de `scripts/overnight-watchdog.ts`)
 * ou manualmente quando `free -h`/`ps aux --sort=-%mem` sugerir residentes
 * antigos demais. Registro de armamento real (se/quando isto virar um timer
 * agendado) vai em `docs/scheduled-tasks-registry.md` — este script, por si
 * só, não se auto-agenda.
 */
import { hasFlag, isMainModule } from "./lib/cli-args.ts";
import { listAllProcesses } from "./lib/list-processes.ts";
import { findOrphanedTestProcesses } from "./lib/orphaned-test-process-sweep.ts";

const LOG_PREFIX = "[orphaned-test-process-sweep]";

/** Dependências injetáveis do CLI — default é a checagem/kill real da
 * máquina; testável passando fakes, sem precisar de `ps`/`kill` de verdade. */
export interface MainDeps {
  platform: NodeJS.Platform;
  listProcesses: typeof listAllProcesses;
  killPid: (pid: number, signal: NodeJS.Signals) => void;
  log: (line: string) => void;
  warn: (line: string) => void;
}

const defaultDeps: MainDeps = {
  platform: process.platform,
  listProcesses: listAllProcesses,
  killPid: (pid, signal) => process.kill(pid, signal),
  log: (line) => console.log(line),
  warn: (line) => console.warn(line),
};

/**
 * Corpo do CLI, extraído pra ser chamável em teste sem depender de
 * `process.exitCode`/`isMainModule`/`ps`/`kill` reais (`deps` injetável).
 * Devolve o exit code — 0 sempre que a varredura RODOU (achar 0 órfãos não
 * é falha), nunca lança.
 */
export function main(argv: string[] = process.argv.slice(2), deps: MainDeps = defaultDeps): number {
  if (deps.platform === "win32") {
    deps.log(`${LOG_PREFIX} plataforma ${deps.platform} não suportada (ver docstring de scripts/lib/list-processes.ts) — nada a varrer.`);
    return 0;
  }

  const dryRun = hasFlag(argv, "dry-run");
  const processes = deps.listProcesses();
  const orphans = findOrphanedTestProcesses(processes);

  if (orphans.length === 0) {
    deps.log(`${LOG_PREFIX} nenhum processo órfão encontrado (${processes.length} processo(s) na máquina).`);
    return 0;
  }

  for (const orphan of orphans) {
    if (dryRun) {
      deps.log(`${LOG_PREFIX} (dry-run) mataria PID ${orphan.pid} — path ausente na cmdline: ${orphan.missingPath}`);
      continue;
    }
    try {
      // #5432: sempre por PID, nunca por nome de imagem.
      deps.killPid(orphan.pid, "SIGKILL");
      deps.log(`${LOG_PREFIX} matou PID ${orphan.pid} — path ausente na cmdline: ${orphan.missingPath}`);
    } catch (e) {
      // Best-effort: processo já pode ter morrido entre o snapshot do `ps`
      // e agora (ESRCH), ou permissão negada — nunca aborta a varredura dos
      // demais.
      deps.warn(`${LOG_PREFIX} falha ao matar PID ${orphan.pid}: ${(e as Error).message}`);
    }
  }

  deps.log(`${LOG_PREFIX} ${orphans.length} processo(s) órfão(s) ${dryRun ? "encontrado(s)" : "processado(s)"}.`);
  return 0;
}

if (isMainModule(import.meta.url)) {
  process.exitCode = main();
}
