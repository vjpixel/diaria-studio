/**
 * newsletter-reply-addresses.ts (#7168)
 *
 * Endereços de envio conhecidos para os quais uma resposta de assinante pode
 * chegar em `To:` — usados pelo §0-replies do Stage 0
 * (`orchestrator-stage-0-preflight.md`) pra montar a query de busca do
 * Gmail. Extraído pra cá (em vez de hardcoded na prosa do playbook, que era
 * `to:vjpixel@gmail.com` sozinho) porque essa lista muda toda vez que o
 * backend/domínio de envio muda — e já mudou 3x sem que a query
 * acompanhasse:
 *
 *   1. Beehiiv legado, sem domínio dedicado → replies chegavam em
 *      `vjpixel@gmail.com` (reply-to pessoal do editor).
 *   2. Migração pro Kit (#6046) → domínio de envio dedicado
 *      `oi@news.diar.ia.br`. Confirmado ao vivo em 02/09/2026 (#7168): a
 *      reply de `melina.ribeiro@gmail.com` de 01/09 chegou com
 *      `toRecipients: ["oi@news.diar.ia.br"]`, invisível à query antiga.
 *   3. Brevo diária (`platform.config.json` → `brevo_diaria.sender_email`,
 *      #6046) → domínio próprio `oi@reativa.diar.ia.br`, canal paralelo de
 *      reativação que também pode receber reply.
 *
 * O envio hoje é um MIX dos três a qualquer momento — `publishing.newsletter
 * .backend` é só o backend PADRÃO; o ramp por onda (`kit_diaria.audience_tag
 * = "rampa-kit"`) manda parte da audiência pelo Kit mesmo com o backend
 * nominal em `"beehiiv"` — então a query precisa cobrir todos os endereços
 * conhecidos, não só o backend corrente. Sem isso, trocar de backend/domínio
 * de novo silenciosamente volta a quebrar o filtro (mesma classe de bug do
 * #7168) — daí o guard `assertKnownAddressesCoverSenders` abaixo.
 */

/** Endereços conhecidos pra `to:(...)` da query do §0-replies. Adicionar um novo domínio de envio aqui é o fix completo do lado da query — 1 linha. */
export const KNOWN_NEWSLETTER_REPLY_ADDRESSES = [
  "vjpixel@gmail.com", // legado — reply-to Beehiiv pré-domínio dedicado
  "oi@news.diar.ia.br", // Kit — envio direto + ramp por onda (kit_diaria, #6046/#7168)
  "oi@reativa.diar.ia.br", // Brevo diária — canal de reativação Pending (#6046)
] as const;

/** Janela default da busca (#7168: 7d era curto demais depois de qualquer gap — fim de semana longo, outage do #7166). */
const DEFAULT_NEWER_THAN_DAYS = 14;

/**
 * Monta a query de busca do Gmail (`mcp__claude_ai_Gmail__search_threads`)
 * pro §0-replies. `Re`+`Res` cobre prefixos EN e PT-BR/Outlook (#1827).
 */
export function buildRepliesSearchQuery(opts: { newerThanDays?: number } = {}): string {
  const days = opts.newerThanDays ?? DEFAULT_NEWER_THAN_DAYS;
  if (!Number.isInteger(days) || days < 1) {
    throw new Error(`newerThanDays inválido: ${String(days)} (precisa ser inteiro >= 1)`);
  }
  const toClause = KNOWN_NEWSLETTER_REPLY_ADDRESSES.join(" OR ");
  return `to:(${toClause}) subject:(Re OR Res) newer_than:${days}d`;
}

/** Extrai os e-mails de um header `To:` cru (ex: `"Nome <a@b.com>, c@d.com"`), lowercased. */
function extractAddresses(toHeader: string): string[] {
  return (toHeader.match(/[^\s<>,]+@[^\s<>,]+/g) ?? []).map((a) => a.toLowerCase());
}

/**
 * Equivalente puro/testável do operador `to:(...)` do Gmail — usado em teste
 * de regressão (#7168: fixture com `To: oi@news.diar.ia.br`, que a lista
 * antiga (só `vjpixel@gmail.com`) rejeitava e a lista atual aceita). O
 * playbook real delega o matching de verdade ao servidor Gmail via MCP —
 * esta função nunca substitui a chamada real, só trava o comportamento
 * esperado da lista de endereços em CI.
 */
export function matchesKnownReplyAddress(
  toHeader: string,
  addresses: readonly string[] = KNOWN_NEWSLETTER_REPLY_ADDRESSES,
): boolean {
  const known = new Set(addresses.map((a) => a.toLowerCase()));
  return extractAddresses(toHeader).some((a) => known.has(a));
}

/**
 * Guard (#7168, item 3 da correção proposta): confere que todo endereço de
 * envio conhecido em `platform.config.json` está coberto por
 * `KNOWN_NEWSLETTER_REPLY_ADDRESSES`. Retorna a lista dos que NÃO estão
 * cobertos (vazia = tudo coberto). O chamador (playbook/orchestrator) loga
 * um warn quando o retorno não é vazio — nunca falha silenciosamente quando
 * o config ganha um domínio de envio novo sem a lista acima acompanhar.
 */
export function findUncoveredSenderAddresses(
  configuredSenderEmails: readonly (string | undefined | null)[],
): string[] {
  const known = new Set(KNOWN_NEWSLETTER_REPLY_ADDRESSES.map((a) => a.toLowerCase()));
  const uncovered = new Set<string>();
  for (const raw of configuredSenderEmails) {
    if (!raw) continue;
    const addr = raw.trim().toLowerCase();
    if (addr && !known.has(addr)) uncovered.add(addr);
  }
  return [...uncovered];
}
