export interface GuardedOp {
  sub: string;
  dir: string;
}
export function stripHeredocs(command: string): string;
export function tokenize(command: string): string[][] | null;
export function findGuardedOps(command: unknown, baseCwd: string): GuardedOp[];
export function commandHasGitCommit(command: unknown): boolean;
export function isContinuoSession(env?: Record<string, string | undefined>): boolean;
export function isProtectedBranch(branch: string | null): boolean;
export function getHeadBranch(cwd: string): string | null;
export const BLOCK_REASON: string;
export function decide(
  payload: { tool_name?: string; cwd?: string; tool_input?: { command?: string } } | null | undefined,
  env?: Record<string, string | undefined>,
  headBranch?: (cwd: string) => string | null,
): string | null;
