export const DIARIA_STUDIO_REPO: string;
export function normalizeRepoSlug(input: unknown): string | null;
export function repoFromRemoteUrl(url: unknown): string | null;
export function mergeLockFileName(repo?: string | null): string;
export function splitShellWords(command: unknown): string[];
export interface GhTargetRepo {
  repo: string | null;
  source: "flag" | "pr-url" | "gh-repo-env" | "cwd-origin" | null;
}
type ExecFn = (cmd: string, args: string[], opts: object) => string | Buffer;
export function repoFromGhCommand(command: unknown, subcommands?: string[]): GhTargetRepo | null;
export function repoFromCwdOrigin(cwd: unknown, execFn?: ExecFn): string | null;
export function resolveGhTargetRepo(
  command: unknown,
  cwd: unknown,
  opts?: { execFn?: ExecFn; subcommands?: string[] },
): GhTargetRepo;
export function isForeignRepo(repo: string | null | undefined): boolean;
export function isForeignRepoGhCommand(
  command: unknown,
  cwd: unknown,
  opts?: { execFn?: ExecFn; subcommands?: string[] },
): boolean;
