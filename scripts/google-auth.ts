/**
 * google-auth.ts
 *
 * Módulo compartilhado de autenticação OAuth 2.0 para as APIs do Google.
 * Usa o refresh_token salvo em `data/.credentials.json` para obter um
 * access_token válido. Renova automaticamente quando próximo de expirar.
 *
 * Sem dependências externas — usa fetch nativo do Node 18+.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const CREDENTIALS_PATH = resolve(ROOT, "data", ".credentials.json");
const TOKEN_URL = "https://oauth2.googleapis.com/token";

export interface GoogleCredentials {
  client_id: string;
  client_secret: string;
  access_token: string;
  refresh_token: string;
  expiry_ms: number; // epoch ms quando o access_token expira
  /** #1973: epoch ms de quando o REFRESH token foi obtido (oauth-setup). Apps
   * OAuth em "Testing" no Google Cloud expiram o refresh token em 7 dias — com
   * este stamp dá pra avisar com antecedência. Ausente em creds legadas. */
  refresh_obtained_ms?: number;
}

/** #1973: refresh tokens de app OAuth em "Testing" expiram em 7 dias. */
export const TESTING_REFRESH_TTL_DAYS = 7;
/** Avisar quando a idade do refresh token cruzar este limite (≥ 5.5d). */
const NEAR_LIMIT_THRESHOLD_DAYS = TESTING_REFRESH_TTL_DAYS - 1.5;

export class GoogleAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoogleAuthError";
  }
}

function loadCredentials(): GoogleCredentials {
  if (!existsSync(CREDENTIALS_PATH)) {
    throw new GoogleAuthError(
      `Credenciais não encontradas em ${CREDENTIALS_PATH}.\n` +
        "Execute: npx tsx scripts/oauth-setup.ts"
    );
  }
  try {
    return JSON.parse(readFileSync(CREDENTIALS_PATH, "utf8")) as GoogleCredentials;
  } catch (e) {
    throw new GoogleAuthError(`Erro ao ler ${CREDENTIALS_PATH}: ${e}`);
  }
}

function saveCredentials(creds: GoogleCredentials): void {
  writeFileSync(CREDENTIALS_PATH, JSON.stringify(creds, null, 2), "utf8");
}

async function refreshAccessToken(
  creds: GoogleCredentials,
  fetchImpl: typeof fetch = fetch,
): Promise<GoogleCredentials> {
  const res = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: creds.client_id,
      client_secret: creds.client_secret,
      refresh_token: creds.refresh_token,
      grant_type: "refresh_token",
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new GoogleAuthError(`Token refresh falhou (${res.status}): ${body}`);
  }

  const data = (await res.json()) as { access_token: string; expires_in: number };
  const updated: GoogleCredentials = {
    ...creds,
    access_token: data.access_token,
    expiry_ms: Date.now() + data.expires_in * 1000,
  };
  saveCredentials(updated);
  return updated;
}

/**
 * Retorna um access_token válido, renovando automaticamente se necessário.
 * Chame antes de cada requisição à API.
 */
export async function getAccessToken(): Promise<string> {
  let creds = loadCredentials();
  // Renova se expira nos próximos 90 segundos
  if (Date.now() > creds.expiry_ms - 90_000) {
    creds = await refreshAccessToken(creds);
  }
  return creds.access_token;
}

// ── #1973: health-check proativo do token OAuth ──────────────────────────────
// O mesmo refresh token cobre Drive + Gmail (inbox-drain) + upload de imagens
// sociais. Quando expira (silenciosamente), 3 sistemas caem juntos e submissões
// do editor podem se perder. Checagem antecipada no Stage 0 + banner único.

export type TokenHealthStatus =
  | "valid"
  | "expiring_soon" // refresh ok, mas idade perto do limite de 7d (app em Testing)
  | "invalid_grant" // refresh falhou: expirado ou revogado
  | "no_credentials"
  | "error";

export interface TokenHealth {
  ok: boolean; // true só em "valid" (expiring_soon ainda funciona, mas avisa)
  status: TokenHealthStatus;
  detail: string;
  /** Idade do refresh token em dias (se `refresh_obtained_ms` presente). */
  refreshAgeDays?: number;
}

/**
 * Pure (#1973, #2318): classifica a mensagem de erro de um refresh falho.
 * `invalid_grant` (expirado/revogado) é o caso que pede re-auth; o resto é
 * erro transiente/outro.
 *
 * Cobre o legado (`invalid_grant`, `Invalid Credentials`) E o 401 moderno do
 * Google (`UNAUTHENTICATED`, `token has been expired or revoked`, `unauthorized`,
 * `invalid_token`) — alinhado com inbox-drain.ts::isAuthExpiredError (#1973).
 * Sem esta amplitude, um token morto que surge como 401 UNAUTHENTICATED resultaria
 * em warnings por arquivo em vez do alerta único consolidado.
 */
export function classifyRefreshError(msg: string): "invalid_grant" | "error" {
  return /invalid_grant|token has been expired or revoked|invalid[_ ]?(authentication )?credentials|unauthenticated|unauthorized|invalid_token/i.test(msg)
    ? "invalid_grant"
    : "error";
}

/**
 * Pure (#1973): idade do refresh token + se está perto do limite de 7d.
 * `now`/`obtainedMs` injetáveis pra teste determinístico.
 */
export function classifyRefreshAge(
  obtainedMs: number | undefined,
  now: number,
): { ageDays?: number; nearLimit: boolean } {
  if (!obtainedMs) return { nearLimit: false };
  const ageDays = (now - obtainedMs) / 86_400_000;
  return { ageDays, nearLimit: ageDays >= NEAR_LIMIT_THRESHOLD_DAYS };
}

/**
 * Pure (#1973): banner consolidado pro Stage 0 — UM aviso claro em vez de 3
 * falhas espalhadas (Drive + inbox-drain + imagens sociais).
 */
export function renderTokenHealthBanner(health: TokenHealth): string {
  if (health.status === "valid") return "";
  const age = health.refreshAgeDays !== undefined ? ` (idade ${health.refreshAgeDays.toFixed(1)}d)` : "";
  const head =
    health.status === "expiring_soon"
      ? `🔐 OAuth Google EXPIRANDO${age} — refresh token perto do limite de ${TESTING_REFRESH_TTL_DAYS}d (app em Testing).`
      : `🔐 OAuth Google ${health.status === "no_credentials" ? "AUSENTE" : "EXPIRADO/INVÁLIDO"} — ${health.detail}.`;
  return [
    head,
    "Afeta de uma vez: Drive sync · inbox-drain (submissões do editor) · upload de imagens sociais.",
    "Ação: npx tsx scripts/oauth-setup.ts  (re-autentica em ~1min; rode /diaria-inbox depois pra recuperar submissões).",
    "Causa raiz provável dos 7d: app OAuth em Testing — ver docs/google-oauth-production.md.",
  ].join("\n");
}

/**
 * #1973: checa proativamente a saúde do token OAuth. O refresh é o teste
 * DEFINITIVO de validade (invalid_grant = expirado/revogado). Também avalia a
 * idade do refresh token vs o limite de 7d de apps em Testing. Side-effect
 * benéfico: um refresh bem-sucedido renova o access_token salvo.
 */
export async function checkTokenHealth(fetchImpl: typeof fetch = fetch): Promise<TokenHealth> {
  if (!existsSync(CREDENTIALS_PATH)) {
    return { ok: false, status: "no_credentials", detail: `credenciais ausentes em ${CREDENTIALS_PATH}` };
  }
  let creds: GoogleCredentials;
  try {
    creds = loadCredentials();
  } catch (e) {
    return { ok: false, status: "error", detail: String((e as Error).message) };
  }
  const { ageDays, nearLimit } = classifyRefreshAge(creds.refresh_obtained_ms, Date.now());
  try {
    await refreshAccessToken(creds, fetchImpl);
  } catch (e) {
    const msg = String((e as Error).message);
    const status = classifyRefreshError(msg);
    return {
      ok: false,
      status,
      detail: status === "invalid_grant" ? "token expirado ou revogado (invalid_grant)" : msg,
      refreshAgeDays: ageDays,
    };
  }
  if (nearLimit) {
    return { ok: false, status: "expiring_soon", detail: "refresh ok, mas perto do limite de 7d", refreshAgeDays: ageDays };
  }
  return { ok: true, status: "valid", detail: "refresh ok", refreshAgeDays: ageDays };
}

// Força refresh bypassando o check de expiry — usado quando o Google
// rejeita (401) um token que julgávamos válido (clock skew, revogação
// server-side, edge case da lib).
async function forceRefreshAccessToken(): Promise<string> {
  const creds = await refreshAccessToken(loadCredentials());
  return creds.access_token;
}

async function authedFetch(
  url: string,
  options: RequestInit,
  token: string
): Promise<Response> {
  return fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.headers ?? {}),
    },
  });
}

/**
 * Helper para requests autenticados às APIs do Google.
 * Inclui o Authorization header automaticamente. Em caso de 401,
 * força um refresh do token e retenta a request exatamente 1x.
 */
export async function gFetch(
  url: string,
  options: RequestInit = {}
): Promise<Response> {
  const token = await getAccessToken();
  const res = await authedFetch(url, options, token);
  if (res.status !== 401) return res;

  // Drena o body pra liberar a conexão antes de retentar.
  try {
    await res.arrayBuffer();
  } catch {
    // ignore
  }

  const refreshed = await forceRefreshAccessToken();
  return authedFetch(url, options, refreshed);
}
