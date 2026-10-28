/**
 * scripts/lib/disk-space-guard.ts (#11446)
 *
 * Lógica PURA do guard de espaço livre que o `/diaria-overnight` roda entre
 * ondas (I/O em `scripts/check-disk-space-guard.ts`).
 *
 * Origem: na rodada 261027e o disco do `300` chegou a 100% (ENOSPC) com 150
 * worktrees somando 54 GB, e a rodada parou. Nada media o disco antes de
 * abrir a onda seguinte. O guard mede, limpa worktrees descartáveis quando o
 * espaço está abaixo do limiar e diz ao coordenador se pode abrir a próxima
 * onda.
 *
 * Dois limiares, e basta um deles cair para o disco contar como baixo:
 * bytes livres absolutos (`minFreeBytes`) e fração livre (`minFreePct`). O
 * absoluto protege disco grande, onde 10% ainda é muito; a fração protege
 * disco pequeno. Configuráveis por flag ou variável de ambiente.
 */

export const DEFAULT_MIN_FREE_GB = 10;
export const DEFAULT_MIN_FREE_PCT = 0.1;
export const ENV_MIN_FREE_GB = "DIARIA_DISK_GUARD_MIN_FREE_GB";
export const ENV_MIN_FREE_PCT = "DIARIA_DISK_GUARD_MIN_FREE_PCT";

const GIB = 1024 * 1024 * 1024;

export interface DiskUsage {
  totalBytes: number;
  /** Bytes disponíveis para processo não-root (`bavail * bsize`). */
  availableBytes: number;
}

export interface DiskGuardThresholds {
  minFreeBytes: number;
  /** Fração 0-1. */
  minFreePct: number;
}

export type DiskGuardVerdict = "ok" | "low" | "unknown";

export interface DiskGuardEvaluation {
  verdict: DiskGuardVerdict;
  totalBytes: number;
  availableBytes: number;
  freePct: number;
  /** Quais limiares caíram (vazio quando `ok` ou `unknown`). */
  breached: Array<"min-free-bytes" | "min-free-pct">;
}

/**
 * Pura. `unknown` quando a leitura é inválida (total <= 0, número não
 * finito): o chamador decide o que fazer, a função nunca transforma leitura
 * inválida em `ok`.
 */
export function evaluateDiskSpace(usage: DiskUsage, thresholds: DiskGuardThresholds): DiskGuardEvaluation {
  const { totalBytes, availableBytes } = usage;
  if (!Number.isFinite(totalBytes) || !Number.isFinite(availableBytes) || totalBytes <= 0 || availableBytes < 0) {
    return { verdict: "unknown", totalBytes, availableBytes, freePct: 0, breached: [] };
  }
  const freePct = availableBytes / totalBytes;
  const breached: DiskGuardEvaluation["breached"] = [];
  if (availableBytes < thresholds.minFreeBytes) breached.push("min-free-bytes");
  if (freePct < thresholds.minFreePct) breached.push("min-free-pct");
  return { verdict: breached.length > 0 ? "low" : "ok", totalBytes, availableBytes, freePct, breached };
}

function parsePositiveNumber(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Resolve os limiares: flag > variável de ambiente > default. Valor inválido
 * cai no próximo nível e entra em `warnings`. `--min-free-pct` e a variável de
 * ambiente são sempre percentual 0-100 (`15` = 15%, `1` = 1%, `0.5` = 0,5%);
 * o `minFreePct` devolvido é fração 0-1.
 */
export function resolveDiskGuardThresholds(
  args: Record<string, string | undefined>,
  env: Record<string, string | undefined>,
): { thresholds: DiskGuardThresholds; warnings: string[] } {
  const warnings: string[] = [];
  const pick = (flag: string, envName: string, fallback: number): number => {
    for (const [source, raw] of [
      [`--${flag}`, args[flag]],
      [envName, env[envName]],
    ] as const) {
      if (raw === undefined) continue;
      const n = parsePositiveNumber(raw);
      if (n === null) {
        warnings.push(`${source}=${raw} inválido, ignorado`);
        continue;
      }
      return n;
    }
    return fallback;
  };
  const minFreeGb = pick("min-free-gb", ENV_MIN_FREE_GB, DEFAULT_MIN_FREE_GB);
  // Flag e env são SEMPRE percentual (0-100): `1` é 1%, nunca 100%. A versão
  // anterior aceitava fração ou percentual e só convertia valor > 1, então
  // `--min-free-pct 1` virava 100% e travava toda onda (review do PR #11453).
  const minFreePctRaw = pick("min-free-pct", ENV_MIN_FREE_PCT, DEFAULT_MIN_FREE_PCT * 100);
  let minFreePct = minFreePctRaw / 100;
  if (minFreePctRaw > 100) {
    warnings.push(`min-free-pct=${minFreePctRaw} acima de 100%, usando o default ${DEFAULT_MIN_FREE_PCT * 100}%`);
    minFreePct = DEFAULT_MIN_FREE_PCT;
  }
  return { thresholds: { minFreeBytes: minFreeGb * GIB, minFreePct }, warnings };
}

export function formatGiB(bytes: number): string {
  return `${(bytes / GIB).toFixed(1)} GiB`;
}

export function describeEvaluation(e: DiskGuardEvaluation, t: DiskGuardThresholds): string {
  if (e.verdict === "unknown") return "leitura de disco inválida";
  return (
    `${formatGiB(e.availableBytes)} livres de ${formatGiB(e.totalBytes)} ` +
    `(${(e.freePct * 100).toFixed(1)}%; limiar ${formatGiB(t.minFreeBytes)} e ${(t.minFreePct * 100).toFixed(1)}%)`
  );
}
