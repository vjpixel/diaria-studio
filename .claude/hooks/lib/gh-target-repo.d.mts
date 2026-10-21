export const DIARIA_STUDIO_REPO: string;
export function normalizeRepoSlug(input: unknown): string | null;
export function repoFromRemoteUrl(url: unknown): string | null;
export function mergeLockFileName(repo?: string | null): string;
export function loadAllowedForeignRepos(root?: string): Set<string>;
export function splitShellWords(command: unknown): string[];

/** Segmento `gh pr <sub>`: repo explícito, explícito-mas-ilegível, ou nada explícito. */
export type GhPrSegment =
  | { repo: string; source: "flag" | "pr-url" | "gh-repo-env"; cd: string | null }
  | { repo: null; source: "unparseable"; cd: string | null }
  | { repo: null; source: null; cd: string | null };

/** Alvo resolvido: `repo` sempre preenchido (indeterminado = diaria-studio). */
export interface GhTarget {
  repo: string;
  source: string | null;
}

/** Compat: um repo só, ou indeterminado/misto. */
export type GhTargetRepo =
  | { repo: string; source: string | null }
  | { repo: null; source: null | "mixed" };

type ExecFn = (cmd: string, args: string[], opts: object) => string | Buffer;
interface ResolveOpts {
  execFn?: ExecFn;
  subcommands?: string[];
  allowed?: Set<string>;
  cdStrict?: boolean;
  cwdAlreadyResolved?: boolean;
}
export function ghPrSegments(command: unknown, subcommands?: string[]): GhPrSegment[];
export function repoFromCwdOrigin(cwd: unknown, execFn?: ExecFn): string | null;
export function resolveGhTargets(command: unknown, cwd: unknown, opts?: ResolveOpts): GhTarget[];
export function resolveGhTargetRepo(command: unknown, cwd: unknown, opts?: ResolveOpts): GhTargetRepo;
/** Motivos de o comando não estar na forma simples (vazio = simples). */
export function commandComplexity(command: unknown): string[];
export function reposMentioned(command: unknown, allowed?: Set<string>): Set<string>;
/** `true` quando a resolução caiu no modo complexo (fail-closed). */
export function isComplexTarget(targets: GhTarget[]): boolean;
export function isForeignRepo(repo: string | null | undefined, allowed?: Set<string>): boolean;
export function isForeignRepoGhCommand(command: unknown, cwd: unknown, opts?: ResolveOpts): boolean;
