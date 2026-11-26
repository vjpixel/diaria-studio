/** Um guard do despachante único de PreToolUse/Bash (#14045). */
export interface DispatchGuard {
  /** Nome do arquivo em `.claude/hooks/`. */
  file: string;
  /** `worker`: exporta `runHook(data, write)` e roda numa Worker; `spawn-if-applies`: exporta `appliesTo(payload)` e roda como processo filho quando se aplica. */
  mode: "worker" | "spawn-if-applies";
  /** Teto de tempo do guard, em ms (o `timeout` antigo do settings.json). */
  timeoutMs: number;
  /** Só `spawn-if-applies`: `"run"` roda o guard quando o `appliesTo` lança (fail-closed). */
  onFilterError?: "run" | "skip";
}

export interface GuardRun {
  /** Saídas cruas, na ordem dos guards (`""` para pendente encerrado numa saída antecipada). */
  outputs: string[];
  /** Falhas de guard (carga, exceção, teto, filtro), uma por linha. */
  notices: string[];
  /** `true` quando um deny saiu antes de todos terminarem. */
  early: boolean;
}

export const GUARDS: readonly DispatchGuard[];
export const STARTUP_MARGIN_MS: number;
export function worstCaseMs(guards?: readonly DispatchGuard[]): number;
export function combineHookOutputs(outputs: readonly string[], notices?: readonly string[]): Record<string, unknown> | null;
export function runGuards(
  raw: string,
  opts?: { guards?: readonly DispatchGuard[]; hooksDir?: string },
): Promise<GuardRun>;
export function dispatch(raw: string, opts?: { guards?: readonly DispatchGuard[]; hooksDir?: string }): Promise<string>;
