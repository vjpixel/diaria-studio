export function parseShellCommands(src: unknown, depth?: number): string[][];
export function findGhPrMergeInvocations(command: unknown): string[][];
export function isGhPrMergeCommand(command: unknown): boolean;
export function extractGhPrMergeTargetPr(command: unknown): number | undefined;
