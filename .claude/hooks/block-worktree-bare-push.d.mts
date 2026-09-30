export function stripQuotedSpans(command: string): string;
export function stripHeredocSpans(command: string): string;
export function isBareGitPush(tokens: string[]): boolean;
export function commandHasBareGitPush(command: unknown): boolean;
export function isLinkedWorktree(startDir: string): boolean;
export const BARE_PUSH_IN_WORKTREE_BLOCK_REASON: string;
