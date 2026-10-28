/**
 * scripts/check-disk-space-guard.ts (#11446)
 *
 * Guard de espaço livre entre ondas do `/diaria-overnight`. Mede o disco do
 * checkout; abaixo do limiar, roda `cleanup-merged-worktrees.ts` com
 * `--reclaim-open-pr` (inclui worktrees já enviados de PR aberta) e mede de
 * novo. Lógica pura em `scripts/lib/disk-space-guard.ts`.
 *
 * Origem: rodada 261027e, disco do `300` em 100% com 150 worktrees (54 GB).
 *
 * Uso:
 *   npx tsx scripts/check-disk-space-guard.ts [--path <dir>] [--min-free-gb N]
 *       [--min-free-pct P] [--check-only] [--dry-run]
 *
 * Limiares também por ambiente: `DIARIA_DISK_GUARD_MIN_FREE_GB`,
 * `DIARIA_DISK_GUARD_MIN_FREE_PCT` (defaults 10 GB e 10%).
 *
 * Saída:
 *   0 — espaço ok (de saída ou depois da limpeza): pode abrir a onda.
 *   1 — espaço continua abaixo do limiar depois da limpeza: NÃO abrir onda
 *       nova; terminar as unidades em voo e ir pro relatório.
 *   2 — não deu para medir (statfs falhou): aviso, o coordenador segue.
 *
 * Não passa `--session-id` para a limpeza: os worktrees que a própria
 * coordenadora tocou continuam protegidos como "em uso", o lado seguro no
 * meio da rodada.
 */
import { statfsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgsWithTrueDefault as parseArgs, isMainModule } from "./lib/cli-args.ts";
import {
  evaluateDiskSpace,
  resolveDiskGuardThresholds,
  describeEvaluation,
  type DiskUsage,
} from "./lib/disk-space-guard.ts";
import { runCleanupWithRealCheckers } from "./cleanup-merged-worktrees.ts";

export interface DiskGuardDeps {
  measure: (path: string) => DiskUsage;
  cleanup: (args: Record<string, string>) => void;
  log: (msg: string) => void;
  warn: (msg: string) => void;
}

/** Núcleo injetável; devolve o exit code. */
export function runDiskGuard(
  args: Record<string, string>,
  env: Record<string, string | undefined>,
  path: string,
  deps: DiskGuardDeps,
): number {
  const { thresholds, warnings } = resolveDiskGuardThresholds(args, env);
  for (const w of warnings) deps.warn(`[disk-guard] ${w}`);

  const measureSafe = () => {
    try {
      return evaluateDiskSpace(deps.measure(path), thresholds);
    } catch (e) {
      deps.warn(`[disk-guard] statfs falhou em ${path}: ${(e as Error).message}`);
      return null;
    }
  };

  const before = measureSafe();
  if (before === null || before.verdict === "unknown") {
    deps.warn("[disk-guard] não deu para medir o disco; seguindo sem o guard (exit 2).");
    return 2;
  }
  if (before.verdict === "ok") {
    deps.log(`[disk-guard] ok: ${describeEvaluation(before, thresholds)}`);
    return 0;
  }

  deps.warn(`[disk-guard] espaço BAIXO: ${describeEvaluation(before, thresholds)}`);
  if (args["check-only"] === "true") return 1;

  deps.log("[disk-guard] rodando cleanup-merged-worktrees.ts --reclaim-open-pr");
  const cleanupArgs: Record<string, string> = { "reclaim-open-pr": "true" };
  if (args["dry-run"] === "true") cleanupArgs["dry-run"] = "true";
  try {
    deps.cleanup(cleanupArgs);
  } catch (e) {
    deps.warn(`[disk-guard] limpeza lançou: ${(e as Error).message}`);
  }

  const after = measureSafe();
  if (after === null || after.verdict === "unknown") {
    deps.warn("[disk-guard] não deu para medir o disco depois da limpeza (exit 2).");
    return 2;
  }
  if (after.verdict === "ok") {
    deps.log(`[disk-guard] recuperado: ${describeEvaluation(after, thresholds)}`);
    return 0;
  }
  deps.warn(
    `[disk-guard] continua BAIXO depois da limpeza: ${describeEvaluation(after, thresholds)}. ` +
      "Não abrir onda nova; terminar as unidades em voo e seguir pro relatório.",
  );
  return 1;
}

function measureReal(path: string): DiskUsage {
  const s = statfsSync(path);
  return { totalBytes: s.blocks * s.bsize, availableBytes: s.bavail * s.bsize };
}

if (isMainModule(import.meta.url)) {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const args = parseArgs(process.argv.slice(2));
  const path = args.path ? resolve(String(args.path)) : ROOT;
  process.exitCode = runDiskGuard(args, process.env, path, {
    measure: measureReal,
    cleanup: (cleanupArgs) => runCleanupWithRealCheckers(cleanupArgs, ROOT),
    log: (m) => console.log(m),
    warn: (m) => console.warn(m),
  });
}
