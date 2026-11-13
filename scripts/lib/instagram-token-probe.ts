/**
 * scripts/lib/instagram-token-probe.ts (#13002)
 *
 * Leitura MÍNIMA da Graph API para saber se o token do Instagram (o par
 * `INSTAGRAM_ACCESS_TOKEN` + `INSTAGRAM_BUSINESS_ACCOUNT_ID` que o
 * `publish-shorts.ts` usa) ainda vale: `GET /{ig-user-id}?fields=id,username`.
 * Só leitura do perfil da conta: nada publicado, nada alterado, e o perfil é
 * lido com a mesma permissão que a publicação já exige (`instagram_basic`).
 *
 * Usado pelo check de prontidão do Neo (`scripts/failover/neo-readiness.ts`),
 * com o mesmo tratamento do Threads: token recusado = falta; rede, 5xx ou
 * limite de taxa = não verificado (transitório).
 *
 * Token no header Authorization, nunca na query string (#7779): o motivo
 * devolvido nunca carrega a URL com o token nem o próprio token.
 */

import { resolveFacebookApiVersion } from "./facebook-pages.ts";

const GRAPH_BASE = "https://graph.facebook.com";

/** Variáveis lidas (mesmos nomes que `publish-shorts.ts` usa). */
export const INSTAGRAM_TOKEN_ENV = {
  accessToken: "INSTAGRAM_ACCESS_TOKEN",
  accountId: "INSTAGRAM_BUSINESS_ACCOUNT_ID",
} as const;

export type InstagramTokenProbe =
  | { state: "valid"; username: string | null }
  | { state: "invalid"; reason: string }
  | { state: "unknown"; reason: string }
  | { state: "skipped"; reason: string };

/**
 * Códigos de erro da Graph API que são limite de taxa ou falha temporária,
 * não token ruim: 4 (app), 17 (usuário), 32 (página), 613 (chamadas), 1 e 2
 * (erro desconhecido / serviço temporariamente indisponível).
 */
const TRANSIENT_GRAPH_CODES = new Set([1, 2, 4, 17, 32, 613]);

/**
 * Classifica a resposta, pura. `body` = JSON já parseado (ou `null` se não
 * era JSON). 190 (OAuthException: expirado, revogado, senha trocada) e
 * 401/403 = token inválido; outro 4xx também (conta errada ou permissão
 * retirada: a publicação falharia do mesmo jeito); 5xx e limite = desconhecido.
 */
export function classifyInstagramProfileResponse(status: number, body: unknown): InstagramTokenProbe {
  const err = (body as { error?: { code?: unknown; message?: unknown; type?: unknown } } | null)?.error;
  const code = typeof err?.code === "number" ? err.code : null;
  const msg = typeof err?.message === "string" ? err.message.slice(0, 160) : "";
  const detail = `HTTP ${status}${code !== null ? `, código ${code}` : ""}${msg ? `: ${msg}` : ""}`;
  if (status >= 200 && status < 300 && !err) {
    const id = (body as { id?: unknown } | null)?.id;
    if (typeof id !== "string" || id === "") return { state: "unknown", reason: `leitura do perfil sem id (HTTP ${status})` };
    const username = (body as { username?: unknown }).username;
    return { state: "valid", username: typeof username === "string" ? username : null };
  }
  if (code === 190) return { state: "invalid", reason: `token recusado (${detail})` };
  if (code !== null && TRANSIENT_GRAPH_CODES.has(code)) return { state: "unknown", reason: `limite ou falha temporária (${detail})` };
  if (status === 401 || status === 403) return { state: "invalid", reason: `leitura do perfil recusada (${detail})` };
  if (status >= 500 || status === 429) return { state: "unknown", reason: `Graph API indisponível (${detail})` };
  if (status >= 400) return { state: "invalid", reason: `leitura do perfil recusada (${detail})` };
  return { state: "unknown", reason: `resposta inesperada (${detail})` };
}

export interface ProbeInstagramTokenInput {
  /** `.env` (ou ambiente) de onde saem o token, a conta e a versão da API. */
  env: Record<string, string | undefined>;
  fetch: typeof fetch;
}

/** Lê o perfil da conta do Instagram com o token do env. Nunca lança. */
export async function probeInstagramToken(input: ProbeInstagramTokenInput): Promise<InstagramTokenProbe> {
  const token = (input.env[INSTAGRAM_TOKEN_ENV.accessToken] ?? "").trim();
  const account = (input.env[INSTAGRAM_TOKEN_ENV.accountId] ?? "").trim();
  if (!token || !account) return { state: "skipped", reason: "credencial ausente" };
  const apiVersion = resolveFacebookApiVersion(input.env);
  const url = `${GRAPH_BASE}/${apiVersion}/${encodeURIComponent(account)}?fields=id,username`;
  let res: Response;
  try {
    res = await input.fetch(url, { method: "GET", headers: { Authorization: `Bearer ${token}` } });
  } catch (e) {
    return { state: "unknown", reason: `leitura do perfil falhou: ${(e as Error).message.slice(0, 160)}` };
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return classifyInstagramProfileResponse(res.status, body);
}
