/**
 * replies-skip-log.ts (#7166 item B — "nunca pular em silêncio")
 *
 * O playbook já prescrevia logar o skip de §0-replies (`info "0-replies
 * skipped: ..."`), mas na prática isso aconteceu só 1x em ~2 semanas de
 * regressão (#7166) — a instrução em prosa não bastou (mesma classe de
 * incidente #6864/#6941: "instrução em prosa não é guard"). Esta função
 * trava as mensagens/args exatos que o playbook deve passar a
 * `scripts/log-event.ts`, pra reduzir a chance de o passo "esquecer" o log
 * — o texto sai daqui, não é redigitado a cada invocação.
 */

export type RepliesSkipReason = "gmail_mcp_unavailable" | "no_editor_supervision";

const SKIP_MESSAGES: Record<RepliesSkipReason, string> = {
  gmail_mcp_unavailable: "0-replies skipped: Gmail MCP unavailable",
  // Texto preservado do skip pré-#7166 (#2288) — mesma mensagem, agora emitida
  // de forma determinística em vez de deixada à prosa.
  no_editor_supervision: "0-replies skipped: headless --no-gates",
};

/**
 * Monta os argumentos exatos de `npx tsx scripts/log-event.ts` pro skip de
 * §0-replies. `edition` é o `AAMMDD` da edição corrente (pode ser
 * `undefined` só quando o skip acontece ANTES da edição existir — nunca
 * deveria, mas o parâmetro é opcional pra não quebrar em cenário de borda).
 */
export function buildRepliesSkipLogArgs(reason: RepliesSkipReason, edition: string): string[] {
  const message = SKIP_MESSAGES[reason];
  return [
    "scripts/log-event.ts",
    "--edition",
    edition,
    "--stage",
    "0",
    "--agent",
    "orchestrator",
    "--level",
    "info",
    "--message",
    message,
    "--details",
    JSON.stringify({ section: "0-replies", reason }),
  ];
}
