/**
 * scripts/lib/distillation-cost-estimate.ts (#7981, Camada 3 da #7972 — Fase 7)
 *
 * Estimativa de custo/token por disparo de `distill-prompt-corrections.ts`
 * — issue #7981: "estimativa de custo/token publicada em cada disparo".
 * Pura, sem chamada de rede — estima a partir de contagens de token
 * PASSADAS pelo chamador (nunca mede de verdade; a medição real vem do
 * uso reportado pelo `claude --print`, fora do escopo deste módulo).
 *
 * Preço por MTok (Sonnet, $3 input / $15 output) é o preço PÚBLICO listado
 * pela Anthropic pra Sonnet — não deriva de nenhum dado deste repo. Serve
 * de estimativa aproximada, não de fatura: `context/scoring/` já documenta
 * (`Model mix`, CLAUDE.md) que Opus 5 é $5/$25; Sonnet segue o preço padrão
 * anunciado publicamente pra essa família. Exportado como constante — se o
 * preço mudar, é aqui que se atualiza, sem precisar tocar no chamador.
 */

export const SONNET_INPUT_USD_PER_MTOK = 3;
export const SONNET_OUTPUT_USD_PER_MTOK = 15;

export interface DistillationCostEstimate {
  votes: number;
  estimated_input_tokens_per_vote: number;
  estimated_output_tokens_per_vote: number;
  estimated_input_tokens_total: number;
  estimated_output_tokens_total: number;
  estimated_usd: number;
}

/**
 * Estima o custo de 1 disparo — `votes` chamadas independentes (a crítica
 * holística 3x da issue #7981), cada uma com o MESMO prompt (critic +
 * candidato) de entrada e uma resposta curta de saída (veredito +
 * justificativa breve, não geração de texto longo).
 */
export function estimateDistillationCost(
  inputTokensPerVote: number,
  outputTokensPerVote: number,
  votes = 3,
): DistillationCostEstimate {
  if (inputTokensPerVote < 0 || outputTokensPerVote < 0 || votes < 1) {
    throw new Error(
      `estimateDistillationCost: entradas inválidas (inputTokensPerVote=${inputTokensPerVote}, outputTokensPerVote=${outputTokensPerVote}, votes=${votes}) — nenhuma pode ser negativa, votes precisa ser >= 1.`,
    );
  }
  const totalInput = inputTokensPerVote * votes;
  const totalOutput = outputTokensPerVote * votes;
  const usd = (totalInput / 1_000_000) * SONNET_INPUT_USD_PER_MTOK + (totalOutput / 1_000_000) * SONNET_OUTPUT_USD_PER_MTOK;
  return {
    votes,
    estimated_input_tokens_per_vote: inputTokensPerVote,
    estimated_output_tokens_per_vote: outputTokensPerVote,
    estimated_input_tokens_total: totalInput,
    estimated_output_tokens_total: totalOutput,
    estimated_usd: usd,
  };
}
