/**
 * preflight-utm-arms.ts (#5545)
 *
 * Fonte única dos 3 braços do teste de canais pago (#5522) — google-ads,
 * microsoft-ads, meta-ads. Consumida por `scripts/print-preflight-plan.ts`,
 * `scripts/verify-utm-attribution.ts`, `scripts/cleanup-preflight-subscribers.ts`
 * e `docs/preflight-utm-cookie-roteiro.md` (URLs impressas ali vêm deste
 * módulo em runtime — nunca hardcoded em duplicata no doc).
 *
 * ## E-mail de teste por braço
 *
 * Plus-addressing sobre o e-mail pessoal do editor (`vjpixel@gmail.com`,
 * o mesmo endereço da inbox editorial usada pelo projeto — ver
 * `docs/gmail-inbox-setup.md`) — chega na mesma caixa (double opt-in
 * confirmável sem conta extra) e o sufixo `+test-preflight-{arm}-{campaign}`
 * mantém os 3 braços + campanhas distintos entre si sem precisar de 3
 * contas de e-mail reais.
 *
 * O prefixo `test-` logo após o `+` é DELIBERADO, não cosmético: bate com
 * `TEST_ACCOUNT_PATTERNS` (`/^vjpixel\+test/i`, `scripts/lib/cohorts.ts`)
 * — o mesmo padrão que já exclui contas de teste do editor de `leitor-v1`/
 * custo-por-canal via `isTestAccount`/`filterInternalAndTestSubscribers`
 * (`scripts/lib/cac.ts`). Os 3 cadastros de preflight ficam automaticamente
 * fora dessas métricas mesmo ANTES de `cleanup-preflight-subscribers.ts`
 * rodar — a limpeza (item 2 do critério de aprovação da #5522) continua
 * necessária pra tirar os registros da base Beehiiv em si, mas a
 * convenção de nome já é uma segunda camada de proteção.
 */

export interface PreflightUtmArm {
  key: "google-ads" | "microsoft-ads" | "meta-ads";
  utm_source: string;
  utm_medium: string;
}

/** Os 3 braços exatos descritos na #5522 — `utm_source`/`utm_medium` batem
 *  literal com o texto da issue ("Repetir com utm_source=microsoft-ads e
 *  utm_source=meta-ads&utm_medium=paid_social"). @pure */
export const PREFLIGHT_UTM_ARMS: readonly PreflightUtmArm[] = [
  { key: "google-ads", utm_source: "google-ads", utm_medium: "cpc" },
  { key: "microsoft-ads", utm_source: "microsoft-ads", utm_medium: "cpc" },
  { key: "meta-ads", utm_source: "meta-ads", utm_medium: "paid_social" },
];

export const DEFAULT_PREFLIGHT_BASE_EMAIL = "vjpixel@gmail.com";
export const DEFAULT_HOME_URL = "https://diar.ia.br/";

/**
 * Monta o e-mail de teste de um braço via plus-addressing — ver docstring
 * do módulo pro porquê do prefixo `test-`. @pure
 */
export function buildPreflightEmail(
  armKey: string,
  campaign: string,
  baseEmail: string = DEFAULT_PREFLIGHT_BASE_EMAIL,
): string {
  const at = baseEmail.indexOf("@");
  if (at === -1) {
    throw new Error(`buildPreflightEmail: baseEmail sem "@" válido: "${baseEmail}"`);
  }
  const local = baseEmail.slice(0, at);
  const domain = baseEmail.slice(at + 1);
  return `${local}+test-preflight-${armKey}-${campaign}@${domain}`;
}

/**
 * Monta a URL da home com a query string do braço — destino real dos 3
 * anúncios (não `/subscribe`, ver #5522 "O risco"). @pure
 */
export function buildPreflightUrl(
  arm: PreflightUtmArm,
  campaign: string,
  homeUrl: string = DEFAULT_HOME_URL,
): string {
  const params = new URLSearchParams({
    utm_source: arm.utm_source,
    utm_medium: arm.utm_medium,
    utm_campaign: campaign,
  });
  return `${homeUrl}?${params.toString()}`;
}

export interface PreflightArmPlan {
  arm: PreflightUtmArm;
  email: string;
  url: string;
}

/** Monta o plano completo (URL + e-mail por braço) pra uma campanha de
 *  preflight — usado por todo script/doc que precisa dos 3 braços juntos.
 *  @pure */
export function buildPreflightPlan(
  campaign: string,
  baseEmail: string = DEFAULT_PREFLIGHT_BASE_EMAIL,
  homeUrl: string = DEFAULT_HOME_URL,
): PreflightArmPlan[] {
  return PREFLIGHT_UTM_ARMS.map((arm) => ({
    arm,
    email: buildPreflightEmail(arm.key, campaign, baseEmail),
    url: buildPreflightUrl(arm, campaign, homeUrl),
  }));
}
