/**
 * paywalls.ts (#701)
 *
 * Fonte única de domínios atrás de paywall hard. Usado por
 * `scripts/validate-domains.ts` pra bloquear newsletter publicada com link
 * que o leitor não consegue abrir.
 *
 * `editorial-rules.md:11`: "Sem paywall. Nunca incluir link atrás de
 * paywall. Paywalls comuns: Fortune, Bloomberg, Financial Times, Wall
 * Street Journal, NYT, The Information, Business Insider."
 *
 * `verify-accessibility.ts` cobre HTTP-status (403/410), mas paywalls
 * modernas servem 200 com preview parcial — precisamos de bloqueio por
 * domínio também.
 *
 * Lista intencionalmente curta — entra aqui apenas paywall hard
 * (>50% do conteúdo bloqueado). Sites com metering soft (X artigos
 * grátis/mês) ficam de fora porque o leitor pode abrir 1.
 */

export const PAYWALL_HOSTS = new Set<string>([
  "bloomberg.com",
  "wsj.com",
  "ft.com",
  "nytimes.com",
  "fortune.com",
  "businessinsider.com",
  "theinformation.com",
]);

/**
 * Retorna `true` se a URL aponta para um paywall hard conhecido.
 */
export function isPaywall(url: string): boolean {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "").toLowerCase();
    return PAYWALL_HOSTS.has(host);
  } catch {
    return false;
  }
}
