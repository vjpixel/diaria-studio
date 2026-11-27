export const PREFLIGHT_PR_GUARD_BYPASS_ENV: string;
export const PREFLIGHT_SCRIPT: string;
export const TSX_LOADER: string;

export type ExtractedPrBody = (
  | { kind: "text"; body: string }
  | { kind: "file"; path: string }
  | { kind: "unknown"; reason: string }
) & { base?: string | null; head?: string | null };

export type RawWordValue = { text: string; dynamic?: undefined } | { dynamic: true; text?: undefined };

export interface PreflightDecision {
  deny: string[];
  warn: string[];
  removal?: unknown;
  body_unknown_reason?: string | null;
}

export type PreflightRunResult =
  | { infra: true; missing?: boolean; output: string }
  | { infra: false; code: 0 | 1; result: PreflightDecision };

export interface PreflightRunInput {
  body: string | null;
  bodyReason: string | null;
  base?: string | null;
  warnOnly?: string | null;
}

export interface HandlePayloadDeps {
  env?: Record<string, string | undefined>;
  hookDir?: string;
  resolveRepoRoot?: (payload: unknown, hookDir: string | undefined, command: unknown) => string | null;
  isForeignRepo?: (command: unknown, cwd: string) => boolean;
  isStudio?: (cwd: string, hookDir: string | undefined, opts: { command: unknown }) => boolean | null;
  resolveLogRoot?: (hookDir: string | undefined) => string;
  readFile?: (path: string) => string;
  runPreflightFn?: (cwd: string, input: PreflightRunInput) => PreflightRunResult;
  logFn?: (message: string, details: unknown, opts: { repoRoot?: string; level?: string }) => void;
  exists?: (path: string) => boolean;
  branchOf?: (cwd: string) => string | null;
  platform?: string;
}

export type HookOutput =
  | { hookSpecificOutput: { hookEventName: "PreToolUse"; permissionDecision: "deny"; permissionDecisionReason: string } }
  | { systemMessage: string; hookSpecificOutput: { hookEventName: "PreToolUse"; additionalContext: string } };

export function bypassSource(command: unknown, env?: Record<string, string | undefined>): "env" | "command" | null;
export function rawCommandWords(src: unknown): string[][];
export function rawWordValue(raw: unknown): RawWordValue;
export function extractPrCreateBody(command: unknown): ExtractedPrBody;
export function resolveBody(
  extracted: ExtractedPrBody,
  dir: string,
  readFile?: (path: string) => string,
  platform?: string,
): { body: string | null; reason: string | null };
export function commandDir(command: unknown, payloadCwd: unknown, fallback: string, platform?: string): string;
export function normalizeMsysPath(p: string, platform?: string, tmp?: () => string): string;
export function headIsOtherBranch(head: string | null | undefined, branch: string | null): boolean;
export function runPreflight(
  cwd: string,
  input: PreflightRunInput,
  spawnFn?: (...args: any[]) => any,
  exists?: (path: string) => boolean,
): PreflightRunResult;
export function buildDenyMessage(deny: string[]): string;
export function buildInfraMessage(output: unknown): string;
export function logPreflightEvent(
  message: string,
  details: unknown,
  opts?: { repoRoot?: string; level?: string; appendFn?: unknown; mkdirFn?: unknown },
): void;
export function appliesTo(payload: unknown): boolean;
export function handlePayload(payload: unknown, deps?: HandlePayloadDeps): HookOutput | undefined;
