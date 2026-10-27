/** Tipo de comentário de review cru encontrado no comando (#11300). */
export type RawPrReviewCommentKind = "rest" | "graphql" | "pr-review";

export const DEV_AGENT_PREFIX: string;
export const RAW_PR_REVIEW_COMMENT_BLOCK_REASON: string;
export function findRawPrReviewComment(command: unknown, depth?: number): RawPrReviewCommentKind | null;
export function isDevAgent(payload: unknown): boolean;
export function shouldBlockRawPrReviewComment(payload: unknown): RawPrReviewCommentKind | null;
