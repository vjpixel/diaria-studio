/**
 * tokens-css.ts (#3555)
 *
 * Gera CSS custom properties a partir dos tokens canônicos do DS
 * (`scripts/lib/shared/design-tokens.ts` — a mesma fonte que
 * `scripts/generate-worker-tokens.ts` usa pros bundles dos Workers).
 *
 * Decisão de design (documentada também no PR body): NÃO reusar o padrão de
 * arquivo gerado + commitado de `generate-worker-tokens.ts`. Esse padrão
 * existe porque o ambiente de build do Cloudflare Worker não tem `tsx`
 * disponível (precisa do `.generated.ts` já commitado no repo pro
 * `wrangler deploy` funcionar). O studio-server é um processo Node local
 * rodando via `tsx` — computar o CSS em memória a cada request (função pura,
 * custo desprezível) elimina a classe inteira de "esqueci de regenerar" sem
 * precisar de um teste de drift dedicado. Se o studio-server um dia ganhar
 * um build/deploy step real, revisitar essa escolha.
 */

import { COLORS, FONTS } from "../lib/shared/design-tokens.ts";

/** Monta o CSS de `:root { --token: valor; ... }` a partir dos tokens do DS. */
export function buildTokensCss(colors: typeof COLORS = COLORS, fonts: typeof FONTS = FONTS): string {
  return `/* Gerado em memória por scripts/studio-ui/tokens-css.ts a partir de
   scripts/lib/shared/design-tokens.ts — não editar como arquivo estático. */
:root {
  --brand: ${colors.brand};
  --ink: ${colors.ink};
  --paper: ${colors.paper};
  --paper-email: ${colors.paperEmail};
  --paper-alt: ${colors.paperAlt};
  --rule: ${colors.rule};
  --rule-strong: ${colors.ruleStrong};
  --on-ink: ${colors.onInk};
  --font-serif: ${fonts.serif};
  --font-sans: ${fonts.sans};
  --font-mono: ${fonts.mono};
}
`;
}
