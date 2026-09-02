// Declaração de tipos para o companheiro `.mjs` (#6956) — ver o comentário
// completo em `subagent-review-registry-start.d.mts` (mesmo racional).

export declare function hashLastAssistantMessage(
  lastAssistantMessage: string | null | undefined,
): string | null;

export interface SubagentReviewCompletedRecord {
  agent_id: string;
  agent_type: string;
  nonce: string;
  session_id: string | null;
  at: string;
  head_sha: string | null;
  status: "completed";
  completed_at: string;
  agent_type_at_stop: string | null;
  last_assistant_message_sha256: string | null;
}

export declare function buildCompletedRecord(
  existingRaw: string,
  payload: unknown,
): SubagentReviewCompletedRecord | null;

export declare function completeStartRecord(repoRoot: string, payload: unknown): boolean;
