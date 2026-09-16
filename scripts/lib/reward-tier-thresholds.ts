/**
 * scripts/lib/reward-tier-thresholds.ts
 *
 * Fonte única dos 4 limiares de nível de recompensa (R$/mês pago) — extraído
 * de `scripts/studio-ui/studio-apoios.ts` (`computeRewardGroup`, #3844)
 * porque `scripts/lib/**` não pode importar de `scripts/studio-ui/**`
 * (`test/lib-boundary.test.ts` regra 4, #5899) e a página `/apoiar`
 * (`scripts/lib/site-apoiar-page.ts`, #7915) precisava dos mesmos valores
 * pra exibir preço por nível.
 *
 * Antes desta extração, `site-apoiar-page.ts` duplicava os 4 valores como
 * strings literais ("R$5/mês" etc.) — sem NENHUM link mecânico com
 * `studio-apoios.ts`. Uma mudança de preço lá desincronizaria a página em
 * silêncio (achado do fleet review da #7915/#8137, `type-design-analyzer`).
 *
 * Decisão de VALOR (não de onde o valor mora) já é do editor, confirmada ao
 * vivo na campanha real (https://apoia.se/diaria, 260722, #3844) — ver
 * docstring de `computeRewardGroup` em `studio-apoios.ts` pra tabela
 * completa de benefícios por nível. Regra de atribuição: MAIOR faixa cujo
 * limiar ≤ valor pago no mês; Patrono é o teto (não há nível acima).
 */

export const REWARD_TIER_AMIGO_MIN = 5;
export const REWARD_TIER_APOIADOR_MIN = 10;
export const REWARD_TIER_MANTENEDOR_MIN = 25;
export const REWARD_TIER_PATRONO_MIN = 50;
