export const PROTECTED_CLAUDE_ENTRIES: readonly string[];
export const PROTECTED_BASENAMES: readonly string[];
export const PROTECTED_GIT_ENTRIES: readonly string[];

export interface ShellCommand {
  words: string[];
  redirects: Array<{ op: string; target: string }>;
  stdin: string[];
  pipeline: number;
}

export interface ProtectedPathWriteFinding {
  kind: string;
  path: string;
}

export interface ProtectedPathWriteOptions {
  cwd?: string;
  projectDirs?: string[];
  readFile?: (path: string) => string | null;
}

export function isProtectedPath(p: string, cwd?: string): boolean;
export function tokenizeShell(src: unknown): ShellCommand[];
export function codeWritesProtectedPath(code: unknown, cwd?: string): boolean;
export function findProtectedPathWrite(
  command: unknown,
  opts?: ProtectedPathWriteOptions,
  depth?: number,
): ProtectedPathWriteFinding | null;
export function shouldBlockProtectedPathWrite(
  payload: unknown,
  opts?: ProtectedPathWriteOptions,
): ProtectedPathWriteFinding | null;
export function protectedPathWriteReason(finding: ProtectedPathWriteFinding): string;
