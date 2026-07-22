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

/**
 * Paleta de STATUS do Studio (#3874) — deliberadamente FORA de
 * `design-tokens.ts`: aquele arquivo é a paleta editorial canônica (ink ·
 * bege · papel · teal) que também alimenta o render do e-mail/site
 * (`render-newsletter-html.ts`/`monthly-render.ts`) — "reduzida a 4 cores-base"
 * por decisão de design documentada lá. Badges de status (ok/warn/danger/info)
 * são conceito exclusivo de admin UI, sem equivalente no e-mail; vivem aqui
 * pra nunca vazar pro bundle de produção da newsletter.
 *
 * Consolida os 7+ hex ad-hoc antes duplicados (e frequentemente divergentes
 * em tom) entre triagem.css/rodada.css/apoios.css/integracoes.css/
 * revisao.css/edicao.css/chat-drawer.css/style.css — mapeamento por FAMÍLIA
 * de matiz (verde/laranja-amarelo/vermelho/roxo-azul), não por redesenho
 * semântico badge-a-badge:
 *   ok     (verde)        — dispatch-elegivel, ci-green, wave-chip-active,
 *                            status-apoiando, state-configured/reachable,
 *                            track-edicao, diff add.
 *   warn   (laranja)      — priority-p1/p2, dispatch-ambigua,
 *                            status-apoiou_e_parou, wave-capacity-warning,
 *                            state-partial/error, track-mensal, ci-pending,
 *                            log warn, chat-msg.system.
 *   danger (vermelho)     — priority-p0, ci-red, alert-banner, dispatch-
 *                            bloqueada, state-unreachable, rv-lint-row.fail,
 *                            probe-error, conn dot down, diff del — reservado
 *                            SÓ pra "ruim/perigo" (convenção #3075/brevo).
 *   info   (roxo)         — kind-mcp, track-develop, open-rate-ok.
 * `warnInk` é o par de texto escuro pra usar OBRIGATORIAMENTE em badges com
 * `background: var(--status-warn)` preenchido — branco sobre laranja falha
 * WCAG AA (~2.85:1); com `warnInk` o par passa a ~4.7:1 (contraste calibrado,
 * critério de aceite #3874). Simplificação deliberada e documentada: P1 e P2
 * (antes 2 tons de laranja/amarelo) passam a compartilhar `--status-warn` —
 * se o editor quiser um degradê de severidade de volta, é follow-up via
 * `color-mix(in srgb, var(--status-warn) N%, var(--paper-alt))`, não um hex
 * novo hardcoded.
 */
export const STATUS_COLORS = {
  ok: "#1a7f37",
  warn: "#e67e22",
  /** Texto sobre `--status-warn` preenchido (nunca branco — ver docstring acima). */
  warnInk: "#3a2e00",
  danger: "#c0392b",
  info: "#5319e7",
} as const;

/** Monta o CSS de `:root { --token: valor; ... }` a partir dos tokens do DS. */
export function buildTokensCss(
  colors: typeof COLORS = COLORS,
  fonts: typeof FONTS = FONTS,
  status: typeof STATUS_COLORS = STATUS_COLORS,
): string {
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
  --status-ok: ${status.ok};
  --status-warn: ${status.warn};
  --status-warn-ink: ${status.warnInk};
  --status-danger: ${status.danger};
  --status-info: ${status.info};
}
`;
}
