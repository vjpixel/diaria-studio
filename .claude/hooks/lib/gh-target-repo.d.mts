export const DIARIA_STUDIO_REPO: string;
export function normalizeRepoSlug(input: unknown): string | null;
export function repoFromRemoteUrl(url: unknown): string | null;
export function mergeLockFileName(repo?: string | null): string;
export function loadAllowedForeignRepos(root?: string): Set<string>;
export function splitShellWords(command: unknown): string[];
/** #10776: valor de `--body`/`--title` que é só texto (nada executa ao expandir). */
export function isInertMessageValue(w: unknown): boolean;
/** #10776: palavras do comando sem o valor inerte de `--body`/`--title` dos segmentos `gh pr|issue`. */
export function commandWithoutMessageText(command: unknown): string;

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
/** `gh pr merge` na forma exata da whitelist, ou `null`. */
export function parseStrictMerge(command: unknown): { repo: string | null; pr: number; cd: string | null } | null;

/** Resolução de um merge com ônus da prova invertido (#10618). */
export type MergeResolution =
  | { mode: "foreign-whitelist"; targets: [string]; grantRepo: string; pr: number; explicitRepo: string }
  | { mode: "studio-plain"; targets: [string]; grantRepo: string; pr: number; explicitRepo: string | null }
  | {
      mode: "strict";
      targets: string[];
      grantRepo: null;
      pr: number | null;
      explicitRepo: null;
      /** Alvo do merge indeterminado (#10689 M): todo repo de `issue_repos` está em `targets`. */
      indeterminate: boolean;
      /**
       * #11501: o comando PROVA (whitelist estrita) que mira um único repo
       * FORA de `issue_repos`. Continua estrito (lock do diaria-studio, sem
       * concessão — #10618 D), mas a mensagem nomeia o lock que falta.
       */
      unlistedRepo: string | null;
    };
export function resolveMergeTargets(
  command: unknown,
  cwd: unknown,
  opts?: {
    execFn?: ExecFn;
    allowed?: Set<string>;
    env?: Record<string, string | undefined>;
    aliases?: ReadonlyMap<string, string | null>;
  },
): MergeResolution;
/** O detector acha merge e nenhuma invocação exige o modo estrito (#10751); exceção → `false`. */
export function detectorConfirmsPlainMerge(command: unknown, opts?: { aliases?: ReadonlyMap<string, string | null> }): boolean;
/** `/c/x` → `C:\x` só em win32. */
export function toNativePath<T>(path: T, platform?: string): T;

/** Motivos de o comando não estar na forma simples (vazio = simples). */
export function commandComplexity(command: unknown): string[];
export function reposMentioned(command: unknown, allowed?: Set<string>): Set<string>;
/** `true` quando a resolução caiu no modo complexo (fail-closed). */
export function isComplexTarget(targets: GhTarget[]): boolean;
export function isForeignRepo(repo: string | null | undefined, allowed?: Set<string>): boolean;
export function isForeignRepoGhCommand(command: unknown, cwd: unknown, opts?: ResolveOpts): boolean;
