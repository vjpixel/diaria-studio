#!/usr/bin/env node
/**
 * scripts/session-registry-gc.ts (#6130)
 *
 * Task periódica — GC de registros ENCERRADOS de `data/sessions/` (arquivo
 * de sessão real + suas cópias de conflito do OneDrive, e backups órfãos
 * sem arquivo real correspondente — "Defeito 1" da issue #6130). Wrapper
 * fino: toda a árvore de decisão vive em `garbageCollectSessions`/
 * `planSessionGc` (`scripts/lib/session-registry.ts`) — **nunca remove por
 * staleness de heartbeat sozinha** (ressalva do #6130: um registro
 * `stale: true` pode corresponder a uma sessão VIVA que só parou de bater
 * heartbeat; ver docstring de `decideSessionGc` pra árvore completa —
 * checagem de PID vivo na mesma máquina, janela conservadora de 7 dias
 * quando não há sinal de processo verificável).
 *
 * Uso:
 *   npx tsx scripts/session-registry-gc.ts                       # avalia + remove
 *   npx tsx scripts/session-registry-gc.ts --dry-run              # avalia + imprime, NÃO remove nada
 *   npx tsx scripts/session-registry-gc.ts --max-age-days 14      # override da janela conservadora (default 7)
 *
 * Guard de máquina sem `data/` (sessão cloud, clone fresco): pulado
 * inteiramente — `planSessionGc`/`garbageCollectSessions` já são fail-soft
 * (diretório ausente → plano vazio), mas o guard evita até a tentativa.
 */
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { hasFlag, getIntArg, isMainModule } from "./lib/cli-args.ts";
import { planSessionGc, garbageCollectSessions } from "./lib/session-registry.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = resolve(ROOT, "data");
const LOG_PREFIX = "[session-registry-gc]";

function main(): void {
  loadProjectEnv(ROOT);
  const argv = process.argv.slice(2);
  const isDryRun = hasFlag(argv, "dry-run");
  const maxAgeDays = getIntArg(argv, "max-age-days", { min: 1 });
  const opts = maxAgeDays !== undefined ? { conservativeMaxAgeMs: maxAgeDays * 24 * 60 * 60 * 1000 } : {};

  if (!existsSync(DATA_DIR)) {
    console.log(`${LOG_PREFIX} data/ ausente nesta máquina (sessão cloud/clone fresco) — nada a fazer.`);
    return;
  }

  const plan = isDryRun ? planSessionGc(ROOT, opts) : garbageCollectSessions(ROOT, opts);
  for (const entry of plan) {
    const verb = isDryRun && entry.action === "removed" ? "would-remove" : entry.action;
    console.log(`${LOG_PREFIX} ${verb} ${entry.identity} (${entry.files.length} arquivo(s)) — ${entry.reason}`);
  }
  const removedCount = plan.filter((e) => e.action === "removed").length;
  console.log(
    `${LOG_PREFIX} ${isDryRun ? "--dry-run: " : ""}${removedCount}/${plan.length} identidade(s) ${isDryRun ? "seriam removidas" : "removidas"}.`,
  );
}

if (isMainModule(import.meta.url)) {
  main();
}
