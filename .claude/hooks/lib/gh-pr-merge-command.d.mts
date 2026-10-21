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

/** Argumentos de uma invocação de merge; `targetUnknown` = repo indeterminado. */
export type GhMergeInvocation = string[] & { readonly targetUnknown?: true };

export function parseShellCommands(src: unknown, depth?: number): string[][];
export function findGhPrMergeInvocations(command: unknown, opts?: GhMergeDetectOptions): GhMergeInvocation[];
export function isGhPrMergeCommand(command: unknown, opts?: GhMergeDetectOptions): boolean;
export function extractGhPrMergeTargetPr(command: unknown, opts?: GhMergeDetectOptions): number | undefined;
export function mergeTargetHints(command: unknown, opts?: GhMergeDetectOptions): { repos: string[]; unknown: boolean };
export function isHeredocDataCommand(command: unknown): boolean;
export function parseGhAliasesYaml(text: unknown): LoadedGhAliases;
export function loadGhAliases(env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform): LoadedGhAliases;
export function ghConfigPath(env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform): string;
