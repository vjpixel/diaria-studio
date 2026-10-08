/**
 * kit-review-record.ts (#9594)
 *
 * Registro por edição do resultado do loop `review-test-email` (§5f do Stage 5)
 * quando `publishing.newsletter.backend === "kit"`. O backend Beehiiv grava
 * `review_*` dentro de `_internal/05-published.json`; o Kit não tem esse
 * arquivo (schema `KitNewsletterPublished` não carrega `review_*`), e até o
 * #9594 o resultado só ia pro `data/run-log.jsonl` — sem nada por edição que
 * o invariante `stage-5-review-completed` ou o gate do Stage 6 pudessem ler.
 * Edição 261005: o §5f não rodou, nada acusou, e o gate mostrou "review
 * automático" sem dado.
 *
 * Fonte única do nome do arquivo, do vocabulário de status e do shape —
 * consumida por `scripts/record-kit-review.ts` (escrita) e por
 * `scripts/lib/invariant-checks/stage-5.ts` (leitura).
 */

export const KIT_REVIEW_FILENAME = "05-review-kit.json";

export const KIT_REVIEW_STATUSES = ["ok", "inconclusive", "issues_unfixable"] as const;
export type KitReviewStatus = (typeof KIT_REVIEW_STATUSES)[number];

/** Mesmo vocabulário de `review_reason` do caminho Beehiiv (#8902). */
export const KIT_REVIEW_REASONS = ["mcp_unavailable", "not_found_timeout", "truncated_fetch"] as const;
export type KitReviewReason = (typeof KIT_REVIEW_REASONS)[number];

export interface KitReviewRecord {
  review_status: KitReviewStatus;
  /** 1 ou 2; 0 só com `inconclusive` sem despachar o agente (#9885). */
  review_attempts: number;
  /** Só com `review_status === "inconclusive"`. */
  review_reason?: KitReviewReason;
  /** Issues que sobraram após o filtro de falso-positivo (§5f passo 4.5). */
  review_final_issues: string[];
  recorded_at: string;
}

export function isKitReviewStatus(v: unknown): v is KitReviewStatus {
  return typeof v === "string" && (KIT_REVIEW_STATUSES as readonly string[]).includes(v);
}

export function isKitReviewReason(v: unknown): v is KitReviewReason {
  return typeof v === "string" && (KIT_REVIEW_REASONS as readonly string[]).includes(v);
}

/**
 * Valida a entrada e monta o registro. Lança com mensagem clara em vez de
 * gravar um arquivo que o invariante depois trataria como inválido.
 *
 * @pure (exceto `now`, injetável)
 */
export function buildKitReviewRecord(input: {
  status: unknown;
  attempts?: number;
  reason?: unknown;
  issues?: unknown;
  now?: Date;
}): KitReviewRecord {
  if (!isKitReviewStatus(input.status)) {
    throw new Error(
      `review_status inválido: ${JSON.stringify(input.status)} (válidos: ${KIT_REVIEW_STATUSES.join(", ")})`,
    );
  }
  const attempts = input.attempts ?? 1;
  // #9885: 0 = o agente nem foi despachado (§5f passo 0 — e-mail não achado
  // ou conector Gmail indisponível). Só faz sentido com `inconclusive`: `ok`
  // e `issues_unfixable` só existem depois de o review ter rodado ao menos 1x.
  const minAttempts = input.status === "inconclusive" ? 0 : 1;
  if (!Number.isInteger(attempts) || attempts < minAttempts || attempts > 2) {
    throw new Error(
      `review_attempts inválido: ${attempts} (o loop do §5f tem 1 ou 2 tentativas; ` +
        `0 só com review_status=inconclusive, quando o agente não foi despachado)`,
    );
  }
  if (input.reason !== undefined && !isKitReviewReason(input.reason)) {
    throw new Error(
      `review_reason inválido: ${JSON.stringify(input.reason)} (válidos: ${KIT_REVIEW_REASONS.join(", ")})`,
    );
  }
  if (input.reason !== undefined && input.status !== "inconclusive") {
    throw new Error("review_reason só se aplica a review_status=inconclusive");
  }
  const issues = input.issues ?? [];
  if (!Array.isArray(issues) || issues.some((i) => typeof i !== "string")) {
    throw new Error("review_final_issues precisa ser um array de strings");
  }
  return {
    review_status: input.status,
    review_attempts: attempts,
    ...(input.reason !== undefined ? { review_reason: input.reason as KitReviewReason } : {}),
    review_final_issues: issues as string[],
    recorded_at: (input.now ?? new Date()).toISOString(),
  };
}
