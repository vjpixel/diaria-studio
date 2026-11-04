/**
 * linkedin-page-oauth.ts (#8055 — token da PÁGINA diar.ia.br no LinkedIn)
 *
 * Miolo puro de `scripts/linkedin-page-oauth.ts`: constantes do app da
 * página (77tlvy0623oq84, Community Management API no Development Tier) e a
 * descoberta da URN da organização. O authorization code e a troca por token
 * reusam `buildAuthorizeUrl`/`exchangeCodeForToken` de `linkedin-personal.ts`
 * com redirect e escopos próprios.
 *
 * Por que não o Token Generator do Developer Portal: em 04/11/2026 ele falhou
 * duas vezes seguidas com "the state parameter was modified", e o token dele
 * vale 60 dias sem refresh, então a renovação precisa ser um comando, não um
 * passo de UI.
 */

import { restHeaders, type FetchFn } from "./linkedin-personal.ts";

/** Vars de ambiente (Doppler → `.env`; o Worker `linkedin-cron` lê as duas primeiras via `wrangler secret`). */
export const LINKEDIN_PAGE_ENV = {
  accessToken: "LINKEDIN_ACCESS_TOKEN",
  authorUrn: "LINKEDIN_AUTHOR_URN",
  expiresAt: "LINKEDIN_TOKEN_EXPIRES_AT",
  clientId: "LINKEDIN_PAGE_CLIENT_ID",
  clientSecret: "LINKEDIN_PAGE_CLIENT_SECRET",
} as const;

/** Client ID do app da página — público (aparece na URL de autorização). */
export const LINKEDIN_PAGE_DEFAULT_CLIENT_ID = "77tlvy0623oq84";

/** Porta diferente da do app pessoal (8766), pra os dois fluxos nunca colidirem. */
export const LINKEDIN_PAGE_REDIRECT_PORT = 8767;
export const LINKEDIN_PAGE_REDIRECT_PATH = "/linkedin/page-callback";
export const LINKEDIN_PAGE_REDIRECT_URI = `http://localhost:${LINKEDIN_PAGE_REDIRECT_PORT}${LINKEDIN_PAGE_REDIRECT_PATH}`;

/**
 * `w_organization_social` publica como a página; `r_organization_social` lê
 * os posts dela; `rw_organization_admin` é o que libera `organizationAcls`,
 * de onde sai a URN da página sem ninguém digitá-la.
 */
export const LINKEDIN_PAGE_SCOPES = ["w_organization_social", "r_organization_social", "rw_organization_admin"] as const;

export const LINKEDIN_ORG_ACLS_URL =
  "https://api.linkedin.com/rest/organizationAcls?q=roleAssignee&role=ADMINISTRATOR&state=APPROVED";

const ORG_URN_RE = /^urn:li:organization:\d+$/;

export function isOrganizationUrn(value: string): boolean {
  return ORG_URN_RE.test(value);
}

/**
 * URNs das páginas que o dono do token administra. Erro HTTP ou resposta
 * malformada lança; lista vazia volta vazia (o chamador decide a mensagem).
 */
export async function fetchAdministeredOrgUrns(fetchFn: FetchFn, accessToken: string, apiVersion: string): Promise<string[]> {
  const res = await fetchFn(LINKEDIN_ORG_ACLS_URL, {
    headers: restHeaders(accessToken, apiVersion),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw new Error(`organizationAcls falhou (HTTP ${res.status}) — o token tem rw_organization_admin?`);
  }
  const text = await res.text();
  let data: { elements?: Array<{ organization?: string }> };
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`organizationAcls: resposta não-JSON (HTTP ${res.status})`);
  }
  const urns = (data.elements ?? []).map((e) => e.organization ?? "").filter(isOrganizationUrn);
  return [...new Set(urns)];
}

/**
 * Escolhe a URN da página. `administered = null` = a consulta de
 * organizationAcls falhou: só segue com `--org` explícito (o token já foi
 * emitido, e perder o consentimento por causa da descoberta seria pior).
 * Com a lista em mãos, `--org` precisa estar nela; sem `--org`, só decide
 * sozinho se o usuário administra exatamente uma página.
 */
export function pickOrgUrn(administered: string[] | null, explicit: string | undefined): { ok: true; urn: string } | { ok: false; reason: string } {
  if (explicit) {
    if (!isOrganizationUrn(explicit)) return { ok: false, reason: `--org inválido: "${explicit}" (esperado urn:li:organization:{id})` };
    if (administered === null) return { ok: true, urn: explicit };
    if (!administered.includes(explicit)) {
      return { ok: false, reason: `${explicit} não está entre as páginas que esta conta administra: ${administered.join(", ")}` };
    }
    return { ok: true, urn: explicit };
  }
  if (administered === null) return { ok: false, reason: "a consulta de organizationAcls falhou e não há --org — rode de novo com --org urn:li:organization:{id}" };
  if (administered.length === 1) return { ok: true, urn: administered[0] };
  if (administered.length === 0) {
    return { ok: false, reason: "a conta que autorizou não administra nenhuma página (entre como admin da diar.ia.br)" };
  }
  return { ok: false, reason: `a conta administra ${administered.length} páginas (${administered.join(", ")}) — rode de novo com --org urn:li:organization:{id}` };
}
