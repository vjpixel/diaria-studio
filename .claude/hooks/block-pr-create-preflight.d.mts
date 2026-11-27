export const PREFLIGHT_PR_GUARD_BYPASS_ENV: string;
export const PREFLIGHT_SCRIPT: string;

export type ExtractedPrBody =
  | { kind: "text"; body: string }
  | { kind: "file"; path: string }
  | { kind: "unknown"; reason: string };

export interface PreflightRunResult {
  infra: boolean;
  missing?: boolean;
  code?: number;
  output?: string;
  result?: { deny: string[]; warn: string[]; removal?: unknown };
}

export function bypassSource(command: unknown, env?: Record<string, string | undefined>): "env" | "command" | null;
export function extractPrCreateBody(command: unknown): ExtractedPrBody;
export function resolveBody(extracted: ExtractedPrBody, cwd: string, readFile?: (path: string) => string): { body: string | null; reason: string | null };
export function runPreflight(
  cwd: string,
  arg: { body: string | null; bodyReason: string | null },
  spawnFn?: (...args: unknown[]) => unknown,
  exists?: (path: string) => boolean,
): PreflightRunResult & { result: { deny: string[]; warn: string[] } };
export function buildDenyMessage(deny: string[]): string;
export function logPreflightEvent(message: string, details: unknown, opts?: { repoRoot?: string; appendFn?: unknown; mkdirFn?: unknown }): void;
export function appliesTo(payload: unknown): boolean;
export function handlePayload(payload: unknown, deps?: Record<string, unknown>): unknown;
