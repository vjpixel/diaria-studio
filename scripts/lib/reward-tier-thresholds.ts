/**
 * scripts/lib/reward-tier-thresholds.ts
 *
 * Fonte única dos 4 limiares de nível de recompensa (R$/mês pago) — extraído
 * de `scripts/studio-ui/studio-apoios.ts` (`computeRewardGroup`, #3844)
 * porque `scripts/lib/**` não pode importar de `scripts/studio-ui/**`
 * (`test/lib-boundary.test.ts` regra 4, #5899) e a página `/apoiar`
 * (`site-apoiar-page.ts`, #7915, removida no #8498) precisava dos mesmos valores pra exibir
 * preço por nível. A página foi REMOVIDA no #8498 (a campanha do Apoia.se é a
 * fonte única); o módulo FICA porque o gate do Artigo Especial
 * (`artigo-especial-gate-cta.ts`, `workers/artigos/src/gate-page.ts`) e o
 * painel de Apoios continuam consumindo os limiares.
 *
 * Antes desta extração, a página duplicava os 4 valores como strings
 * literais ("R$5/mês" etc.) — sem NENHUM link mecânico com
 * `studio-apoios.ts` (achado do fleet review da #7915/#8137, `type-design-analyzer`).
 *
 * Decisão de VALOR (não de onde o valor mora) já é do editor, confirmada ao
 * vivo na campanha real (https://apoia.se/diaria, 260722, #3844) — ver
 * docstring de `computeRewardGroup` em `studio-apoios.ts` pra tabela
 * completa de benefícios por nível. Regra de atribuição: MAIOR faixa cujo
 * limiar ≤ valor pago no mês; Patrono é o teto (não há nível acima).
 */

import type { ApoioNivel } from "./shared/apoio-nivel-types.ts";

export const REWARD_TIER_AMIGO_MIN = 5;
export const REWARD_TIER_APOIADOR_MIN = 10;
export const REWARD_TIER_MANTENEDOR_MIN = 25;
export const REWARD_TIER_PATRONO_MIN = 50;

/** Maior faixa cujo limiar é menor ou igual ao valor pago no mês; `null` abaixo
 * do piso ou sem valor. `computeRewardGroup` do painel delega para cá (#11225). */
export function computeRewardGroup(thisMonthPaidValue: number | undefined): ApoioNivel | null {
  if (typeof thisMonthPaidValue !== "number" || !Number.isFinite(thisMonthPaidValue)) return null;
  if (thisMonthPaidValue < REWARD_TIER_AMIGO_MIN) return null;
  if (thisMonthPaidValue < REWARD_TIER_APOIADOR_MIN) return "amigo";
  if (thisMonthPaidValue < REWARD_TIER_MANTENEDOR_MIN) return "apoiador";
  if (thisMonthPaidValue < REWARD_TIER_PATRONO_MIN) return "mantenedor";
  return "patrono";
}
