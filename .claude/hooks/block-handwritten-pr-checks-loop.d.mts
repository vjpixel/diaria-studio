export function stripQuotedSpans(command: string): string;
export function stripHeredocSpans(command: string): string;
export function splitLiveCode(command: string): { outer: string; subs: string[] };
export function commandHasHandwrittenPrChecksLoop(command: unknown): boolean;
export const HANDWRITTEN_PR_CHECKS_LOOP_BLOCK_REASON: string;
