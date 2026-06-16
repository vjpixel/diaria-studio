/**
 * outros-count.ts (#2331/F4)
 *
 * Shared helper: calcula o total de itens não-destaque da edição
 * (lancamento + radar + use_melhor + video). Esse é o número correto
 * para "mais N destaques" no comment_diaria do LinkedIn.
 *
 * Importado por:
 *   - scripts/publish-linkedin.ts   (Stage 5 — resolve do approved FINAL)
 *   - scripts/lint-social-numbers.ts (Stage 2 gate — lint deterministico)
 *
 * Manter a formula sincronizada nos dois pontos de consumo era frágil;
 * este módulo garante compile-time que usam a mesma lógica.
 */

export interface ApprovedBuckets {
  lancamento?: unknown[];
  radar?: unknown[];
  use_melhor?: unknown[];
  video?: unknown[];
}

/**
 * Conta itens não-destaque do approved JSON.
 * Determinístico — nunca deve ser estimado pelo LLM.
 */
export function outrosCount(approved: ApprovedBuckets): number {
  return (
    (approved.lancamento?.length ?? 0) +
    (approved.radar?.length ?? 0) +
    (approved.use_melhor?.length ?? 0) +
    (approved.video?.length ?? 0)
  );
}
