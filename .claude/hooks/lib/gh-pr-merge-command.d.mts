/** Aliases do gh: `nome → expansão`; `null` = expansão ilegível (conta como merge). */
export type GhAliasMap = ReadonlyMap<string, string | null>;

export interface GhMergeDetectOptions {
  /** Aliases do gh. Default: `config.yml` do gh. Valor que não é Map → `TypeError`. */
  aliases?: GhAliasMap;
  /** Config do gh que não pôde ser lido por inteiro (`gh_alias_config_unreadable`/`gh_alias_config_unparsed`). */
  onDiagnostic?: (kind: string, details: Record<string, unknown>) => void;
}

/** Map de aliases lido do config; `loadError`/`unparsed` presentes = leitura não confiável (fail-closed). */
export type LoadedGhAliases = Map<string, string | null> & {
  readonly loadError?: { code: string; message: string; path: string };
  readonly unparsed?: readonly string[];
};

/** Por que uma invocação é `opaque` (informativo: todas têm o mesmo tratamento). */
export type GhOpaqueMergeReason =
  | "xargs"
  | "endpoint"
  | "subcommand"
  | "alias-unreadable"
  | "alias-import"
  | "alias-loop"
  | "depth"
  | "shell-var"
  | "git-config"
  | "gh-config";

/** Repo de um `gh api` REST de merge: literal do caminho, o do diretório (`{owner}/{repo}`), ou indeterminado. */
export type GhRestMergeRepo = { kind: "literal"; slug: string } | { kind: "cwd" } | { kind: "unknown" };

/**
 * Uma invocação de merge (#10751). `pr-merge.args` = o que vem depois de
 * `merge` (com `-R` global antes); `opaque.args` = o que deu pra ler, no
 * mesmo formato. Só `pr-merge` pode sair do modo estrito (`requiresStrict`).
 */
export type GhMergeInvocation =
  | { readonly via: "pr-merge"; readonly args: string[] }
  | { readonly via: "api-rest"; readonly repo: GhRestMergeRepo; readonly pr: number | null }
  | { readonly via: "api-graphql" }
  | { readonly via: "opaque"; readonly reason: GhOpaqueMergeReason; readonly args: string[] };

export function parseShellCommands(src: unknown, depth?: number): string[][];
export function findGhPrMergeInvocations(command: unknown, opts?: GhMergeDetectOptions): GhMergeInvocation[];
/** `true` pra toda invocação que não é `gh pr merge` literal (#10751). */
export function requiresStrict(inv: GhMergeInvocation): boolean;
/** Nº da PR de uma invocação; `undefined` = não legível. */
export function invocationTargetPr(inv: GhMergeInvocation): number | undefined;
export function isGhPrMergeCommand(command: unknown, opts?: GhMergeDetectOptions): boolean;
export function extractGhPrMergeTargetPr(command: unknown, opts?: GhMergeDetectOptions): number | undefined;
export function mergeTargetHints(command: unknown, opts?: GhMergeDetectOptions): { repos: string[]; unknown: boolean };
export function isHeredocDataCommand(command: unknown): boolean;
/** Variáveis cujo valor o git/gh executam como shell (#11513); fonte única da denylist do heredoc (#11522). */
export const SHELL_VALUE_VARS: ReadonlySet<string>;
/** Nomes exatos que nunca são atribuição inócua na whitelist de heredoc (#11522). */
export const UNSAFE_ASSIGN_NAMES: ReadonlySet<string>;
/** Prefixos de nome que nunca são atribuição inócua na whitelist de heredoc (#11522). */
export const UNSAFE_ASSIGN_PREFIXES: readonly string[];
export function parseGhAliasesYaml(text: unknown): LoadedGhAliases;
export function loadGhAliases(env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform): LoadedGhAliases;
export function ghConfigPath(env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform): string;
