export interface GhMergeDetectOptions {
  /** Aliases do gh (`nome → expansão`; `null` = expansão ilegível). Default: `config.yml` do gh. */
  aliases?: Map<string, string | null>;
}
export function parseShellCommands(src: unknown, depth?: number): string[][];
export function findGhPrMergeInvocations(command: unknown, opts?: GhMergeDetectOptions): string[][];
export function isGhPrMergeCommand(command: unknown, opts?: GhMergeDetectOptions): boolean;
export function extractGhPrMergeTargetPr(command: unknown, opts?: GhMergeDetectOptions): number | undefined;
export function isHeredocDataCommand(command: unknown): boolean;
export function parseGhAliasesYaml(text: unknown): Map<string, string | null>;
export function loadGhAliases(env?: NodeJS.ProcessEnv): Map<string, string | null>;
