/**
 * ds-tokens.generated.ts — GERADO AUTOMATICAMENTE. NÃO EDITAR.
 *
 * Gerado por scripts/generate-worker-tokens.ts (#2107) a partir de
 * scripts/lib/design-tokens.ts (fonte canônica do DS Diar.ia).
 *
 * Para atualizar tokens: editar scripts/lib/design-tokens.ts e rodar:
 *   npx tsx scripts/generate-worker-tokens.ts
 * (ou simplesmente: npm test / wrangler deploy — ambos disparam o build step)
 *
 * Este arquivo é commitado intencionalmente — ver generate-worker-tokens.ts para
 * a justificativa. O check de sync em brevo-dashboard-ds-drift.test.ts garante
 * que o arquivo commitado não drifta da fonte (#2125).
 */

/**
 * Tokens de cor do DS (espelho de COLORS em design-tokens.ts).
 *
 * Exclusão intencional: paperEmail, ruleStrong e onInk existem em COLORS mas
 * NÃO são gerados — o dashboard não os usa. Se o dashboard passar a usar um
 * deles, adicione-o no template de scripts/generate-worker-tokens.ts e
 * regenere (senão fica undefined em runtime sem
 * erro de tipo).
 */
export const DS_COLORS = {
  brand:    "#00A0A0",
  ink:      "#171411",
  paper:    "#FBFAF6",
  paperAlt: "#EBE5D0",
  rule:     "#EBE5D0",
} as const;

/** Tokens de fonte do DS (espelho de FONTS em design-tokens.ts). */
export const DS_FONTS = {
  sans: "'Geist', -apple-system, BlinkMacSystemFont, system-ui, sans-serif",
} as const;
