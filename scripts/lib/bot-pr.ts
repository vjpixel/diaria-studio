/**
 * scripts/lib/bot-pr.ts (#13185)
 *
 * Fonte única de "esta PR é de bot". Antes havia duas respostas: `prLane`
 * (`scripts/list-continuo-escalation-queue.ts`) e `isDependencyBotPr`
 * (`scripts/lib/open-pr-cap.ts`) divergiam — branch `renovate/` de autor
 * humano era `manual` numa e bot na outra; `bot/` (regen semanal do heatmap,
 * autor `app/github-actions`) saía da fila numa e contava no teto na outra.
 *
 * PR de bot tem ciclo próprio e não sai de nenhuma rodada: fica fora do teto
 * de PRs abertos (#12765) e da triagem `--all-open` (#13094).
 *
 * Puro (sem I/O).
 */

export interface BotPrLike {
  headRefName: string;
  author?: { login?: string; is_bot?: boolean } | null;
}

/** Prefixos de branch que só automação de bot usa. */
export const BOT_BRANCH_PREFIXES = ["dependabot/", "renovate/", "bot/"] as const;

/**
 * Pure: PR de bot — autor marcado como bot pelo GitHub (`is_bot`), login de
 * app (`app/...`, `...[bot]`, `dependabot`/`renovate`) ou branch de bot.
 */
export function isBotPr(pr: BotPrLike): boolean {
  const login = (pr.author?.login ?? "").toLowerCase();
  if (pr.author?.is_bot === true) return true;
  if (/\[bot\]$/.test(login) || login.startsWith("app/")) return true;
  if (login === "dependabot" || login === "renovate") return true;
  return BOT_BRANCH_PREFIXES.some((p) => pr.headRefName.startsWith(p));
}
