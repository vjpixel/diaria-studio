/** Um guard do despachante único de PreToolUse/Bash (#14045). */
export interface DispatchGuard {
  /** Nome do arquivo em `.claude/hooks/`. */
  file: string;
  /** `in-process`: exporta `runHook(data, write)`; `spawn-if-applies`: exporta `appliesTo(payload)` e roda como processo filho quando se aplica. */
  mode: "in-process" | "spawn-if-applies";
  /** Teto de tempo do guard, em ms (o `timeout` antigo do settings.json). */
  timeoutMs: number;
}

export const GUARDS: readonly DispatchGuard[];
export function combineHookOutputs(outputs: readonly string[]): Record<string, unknown> | null;
export function runGuards(
  raw: string,
  opts?: { guards?: readonly DispatchGuard[]; hooksDir?: string },
): Promise<string[]>;
export function dispatch(raw: string, opts?: { guards?: readonly DispatchGuard[]; hooksDir?: string }): Promise<string>;
