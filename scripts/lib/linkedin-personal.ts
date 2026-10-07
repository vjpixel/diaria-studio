/**
 * linkedin-personal.ts (#9568 — LinkedIn PESSOAL automatizado)
 *
 * Miolo do post automático do 4º post (item USE MELHOR, `## um`) no perfil
 * PESSOAL do editor no LinkedIn. Decisão do editor de 07/10/2026: um app
 * LinkedIn SEPARADO, com os produtos "Share on LinkedIn" (`w_member_social`)
 * e "Sign In with LinkedIn using OpenID Connect" (`openid profile`, só pra
 * descobrir a URN da pessoa) — sem tocar no app da página (77tIvy0623oq84,
 * em análise da Community Management API, que a LinkedIn exige como produto
 * único do app).
 *
 * Três peças usam este módulo:
 *   - `scripts/linkedin-personal-oauth.ts` — OAuth one-shot (authorization
 *     code com redirect local) que grava token + URN + expiração.
 *   - `scripts/publish-linkedin-personal.ts` — `--arm` no Stage 6 (depois do
 *     `ok` do gate) grava a intenção na edição; `--fire-due` (task
 *     `Diaria-LinkedIn-Personal`, no slot do 4º post) publica o que venceu.
 *   - `scripts/linkedin-personal-token-alarm.ts` — alarme de expiração (60d).
 *
 * Tudo que fala HTTP recebe `fetchFn` injetado — os testes nunca chamam a
 * LinkedIn de verdade.
 *
 * Por que não pelo Worker `linkedin-cron` (que já agenda a página): o Worker
 * não lê `.env`/Doppler (só `wrangler secret`), e o deploy dele é manual. O
 * token pessoal mora onde os outros segredos de publisher moram, e o
 * agendamento fica com uma task systemd no horário do slot.
 */

import type { AlarmFinding } from "./alarm-issues.ts";

// ── Configuração ─────────────────────────────────────────────────────────

/** Vars de ambiente (Doppler → `.env`). Nomes exatos — o setup doc cita estes. */
export const LINKEDIN_PERSONAL_ENV = {
  clientId: "LINKEDIN_PERSONAL_CLIENT_ID",
  clientSecret: "LINKEDIN_PERSONAL_CLIENT_SECRET",
  accessToken: "LINKEDIN_PERSONAL_ACCESS_TOKEN",
  personUrn: "LINKEDIN_PERSONAL_PERSON_URN",
  expiresAt: "LINKEDIN_PERSONAL_TOKEN_EXPIRES_AT",
  apiVersion: "LINKEDIN_PERSONAL_API_VERSION",
} as const;

/** Porta/rota do redirect local. A URL EXATA precisa estar cadastrada no app. */
export const LINKEDIN_PERSONAL_REDIRECT_PORT = 8766;
export const LINKEDIN_PERSONAL_REDIRECT_URI = `http://localhost:${LINKEDIN_PERSONAL_REDIRECT_PORT}/linkedin/callback`;

/** `w_member_social` publica; `openid profile` só servem pra ler o `sub` (URN da pessoa). */
export const LINKEDIN_PERSONAL_SCOPES = ["openid", "profile", "w_member_social"] as const;

export const LINKEDIN_AUTHORIZE_URL = "https://www.linkedin.com/oauth/v2/authorization";
export const LINKEDIN_TOKEN_URL = "https://www.linkedin.com/oauth/v2/accessToken";
export const LINKEDIN_USERINFO_URL = "https://api.linkedin.com/v2/userinfo";
export const LINKEDIN_POSTS_URL = "https://api.linkedin.com/rest/posts";
export const LINKEDIN_IMAGES_INIT_URL = "https://api.linkedin.com/rest/images?action=initializeUpload";

/** Token 3-legged da LinkedIn vale 60 dias e o app "Share on LinkedIn" não ganha refresh token. */
export const LINKEDIN_TOKEN_TTL_DAYS = 60;

/** Aviso com antecedência: issue P2 a partir de 14 dias, P1 a partir de 3 (e expirado). */
export const TOKEN_WARN_DAYS = 14;
export const TOKEN_CRITICAL_DAYS = 3;

/** Atraso máximo tolerado no disparo: passou disso, o post não sai (fora do slot). */
export const MAX_FIRE_LATENESS_MS = 3 * 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

// ── Credenciais ──────────────────────────────────────────────────────────

export type PersonalCreds = { accessToken: string; personUrn: string; expiresAt: Date | null };

export type PersonalCredsResult =
  | { ok: true; creds: PersonalCreds }
  | { ok: false; reason: string; configured: boolean };

/**
 * Lê token + URN + expiração do ambiente. `configured: false` = o editor
 * ainda não rodou o OAuth (modo manual legítimo, sem alarme). Token expirado
 * (ou vencendo antes de `mustBeValidAt`) = indisponível, com `configured: true`.
 */
export function readPersonalCreds(
  env: Record<string, string | undefined>,
  mustBeValidAt: Date,
): PersonalCredsResult {
  const accessToken = (env[LINKEDIN_PERSONAL_ENV.accessToken] ?? "").trim();
  const personUrn = (env[LINKEDIN_PERSONAL_ENV.personUrn] ?? "").trim();
  if (!accessToken) {
    return { ok: false, configured: false, reason: `${LINKEDIN_PERSONAL_ENV.accessToken} ausente — rode scripts/linkedin-personal-oauth.ts` };
  }
  if (!/^urn:li:person:[A-Za-z0-9_-]+$/.test(personUrn)) {
    return {
      ok: false,
      configured: true,
      reason: `${LINKEDIN_PERSONAL_ENV.personUrn} ausente ou malformado (esperado urn:li:person:{id}) — re-rode scripts/linkedin-personal-oauth.ts`,
    };
  }
  const expiresAt = parseExpiresAt(env[LINKEDIN_PERSONAL_ENV.expiresAt]);
  if (expiresAt && expiresAt.getTime() <= mustBeValidAt.getTime()) {
    return {
      ok: false,
      configured: true,
      reason: `token pessoal expira/expirou em ${expiresAt.toISOString()} (antes de ${mustBeValidAt.toISOString()}) — re-rode scripts/linkedin-personal-oauth.ts`,
    };
  }
  return { ok: true, creds: { accessToken, personUrn, expiresAt } };
}

export function parseExpiresAt(raw: string | undefined): Date | null {
  if (!raw || !raw.trim()) return null;
  const d = new Date(raw.trim());
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * `LinkedIn-Version` (YYYYMM). A LinkedIn mantém cada versão ~1 ano e lança
 * uma por mês; dois meses atrás sempre existe e nunca está perto do fim —
 * evita pinar uma versão que expira em silêncio (o Worker da página usa
 * "202401" fixo como default). Sobrescrevível por env.
 */
export function defaultLinkedInApiVersion(now: Date): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 2, 1));
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

// ── OAuth ────────────────────────────────────────────────────────────────

export function buildAuthorizeUrl(clientId: string, state: string): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: LINKEDIN_PERSONAL_REDIRECT_URI,
    state,
    scope: LINKEDIN_PERSONAL_SCOPES.join(" "),
  });
  return `${LINKEDIN_AUTHORIZE_URL}?${params}`;
}

export type TokenExchange = { accessToken: string; expiresInSec: number; scope: string };

export async function exchangeCodeForToken(
  fetchFn: FetchFn,
  args: { code: string; clientId: string; clientSecret: string },
): Promise<TokenExchange> {
  const res = await fetchFn(LINKEDIN_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: args.code,
      redirect_uri: LINKEDIN_PERSONAL_REDIRECT_URI,
      client_id: args.clientId,
      client_secret: args.clientSecret,
    }).toString(),
  });
  const text = await res.text();
  let data: { access_token?: string; expires_in?: number; scope?: string; error_description?: string };
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`troca de código: resposta não-JSON (HTTP ${res.status})`);
  }
  if (!res.ok || !data.access_token) {
    // Nunca ecoa o corpo inteiro: em sucesso parcial ele traria o token.
    throw new Error(`troca de código falhou (HTTP ${res.status}): ${data.error_description ?? "sem descrição"}`);
  }
  const scope = data.scope ?? "";
  if (!scope.split(/[\s,]+/).includes("w_member_social")) {
    throw new Error(
      `token emitido SEM w_member_social (scope="${scope}") — confira se o app tem o produto "Share on LinkedIn" aprovado`,
    );
  }
  return { accessToken: data.access_token, expiresInSec: data.expires_in ?? LINKEDIN_TOKEN_TTL_DAYS * 86400, scope };
}

/** URN da pessoa via OIDC (`/v2/userinfo` → `sub`). */
export async function fetchPersonUrn(fetchFn: FetchFn, accessToken: string): Promise<string> {
  const res = await fetchFn(LINKEDIN_USERINFO_URL, { headers: { Authorization: `Bearer ${accessToken}` } });
  const text = await res.text();
  let data: { sub?: string };
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`userinfo: resposta não-JSON (HTTP ${res.status})`);
  }
  if (!res.ok || !data.sub) {
    throw new Error(
      `userinfo falhou (HTTP ${res.status}) — o app precisa do produto "Sign In with LinkedIn using OpenID Connect" (escopos openid profile)`,
    );
  }
  return `urn:li:person:${data.sub}`;
}

export function computeExpiresAt(now: Date, expiresInSec: number): Date {
  return new Date(now.getTime() + expiresInSec * 1000);
}

// ── Texto ────────────────────────────────────────────────────────────────

/**
 * `commentary` da Posts API usa o "little text format": `\ | { } @ [ ] ( ) <
 * > # * _ ~` são reservados e, sem escape, a LinkedIn corta o texto no
 * primeiro deles (o "1)" das listas do Use Melhor bastaria). Hashtag vira o
 * template `{hashtag|\#|tag}` pra continuar clicável.
 */
export function toLittleText(text: string): string {
  const escape = (s: string) => s.replace(/[\\|{}@[\]()<>#*_~]/g, (c) => `\\${c}`);
  let out = "";
  let last = 0;
  const re = /(^|\s)#([\p{L}\p{N}_]+)/gu;
  for (const m of text.matchAll(re)) {
    const start = m.index ?? 0;
    out += escape(text.slice(last, start)) + m[1] + `{hashtag|\\#|${escape(m[2])}}`;
    last = start + m[0].length;
  }
  return out + escape(text.slice(last));
}

// ── Publicação ───────────────────────────────────────────────────────────

export type PostResult = { ok: true; postUrn: string | null; imageUsed: boolean } | { ok: false; reason: string };

function restHeaders(token: string, apiVersion: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "LinkedIn-Version": apiVersion,
    "X-Restli-Protocol-Version": "2.0.0",
  };
}

async function uploadImage(
  fetchFn: FetchFn,
  creds: PersonalCreds,
  apiVersion: string,
  bytes: Uint8Array,
): Promise<{ ok: true; urn: string } | { ok: false; reason: string }> {
  const init = await fetchFn(LINKEDIN_IMAGES_INIT_URL, {
    method: "POST",
    headers: restHeaders(creds.accessToken, apiVersion),
    body: JSON.stringify({ initializeUploadRequest: { owner: creds.personUrn } }),
  });
  const text = await init.text();
  let data: { value?: { uploadUrl?: string; image?: string } };
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, reason: `initializeUpload: resposta não-JSON (HTTP ${init.status})` };
  }
  if (!init.ok || !data.value?.uploadUrl || !data.value?.image) {
    return { ok: false, reason: `initializeUpload falhou (HTTP ${init.status}): ${text.slice(0, 200)}` };
  }
  const put = await fetchFn(data.value.uploadUrl, {
    method: "PUT",
    headers: { Authorization: `Bearer ${creds.accessToken}` },
    // Uint8Array é BodyInit válido em runtime; o lib.dom do TS só não aceita ArrayBufferLike.
    body: bytes as unknown as BodyInit,
  });
  if (!put.ok) {
    return { ok: false, reason: `upload da imagem falhou (HTTP ${put.status}): ${(await put.text()).slice(0, 200)}` };
  }
  return { ok: true, urn: data.value.image };
}

/**
 * Publica no perfil pessoal. Imagem opcional: falha no upload derruba o post
 * inteiro (não sai um post sem a capa que a página tem) — o caller decide.
 * Erros de rede viram `{ ok: false }`, nunca exceção.
 */
export async function postToPersonalProfile(args: {
  fetchFn: FetchFn;
  creds: PersonalCreds;
  apiVersion: string;
  text: string;
  imageBytes?: Uint8Array | null;
}): Promise<PostResult> {
  const { fetchFn, creds, apiVersion } = args;
  try {
    let imageUrn: string | null = null;
    if (args.imageBytes && args.imageBytes.length > 0) {
      const up = await uploadImage(fetchFn, creds, apiVersion, args.imageBytes);
      if (!up.ok) return { ok: false, reason: up.reason };
      imageUrn = up.urn;
    }
    const res = await fetchFn(LINKEDIN_POSTS_URL, {
      method: "POST",
      headers: restHeaders(creds.accessToken, apiVersion),
      body: JSON.stringify({
        author: creds.personUrn,
        commentary: toLittleText(args.text),
        visibility: "PUBLIC",
        distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
        ...(imageUrn ? { content: { media: { id: imageUrn } } } : {}),
        lifecycleState: "PUBLISHED",
        isReshareDisabledByAuthor: false,
      }),
    });
    if (res.status === 201 || res.ok) {
      return { ok: true, postUrn: res.headers.get("x-restli-id"), imageUsed: imageUrn !== null };
    }
    return { ok: false, reason: `POST /rest/posts falhou (HTTP ${res.status}): ${(await res.text()).slice(0, 300)}` };
  } catch (e) {
    return { ok: false, reason: `erro de rede: ${(e as Error).message}` };
  }
}

/** URL pública do post a partir da URN devolvida em `x-restli-id`. */
export function postUrlFromUrn(urn: string | null): string | null {
  return urn ? `https://www.linkedin.com/feed/update/${urn}/` : null;
}

// ── Intenção por edição ──────────────────────────────────────────────────

/** `_internal/06-linkedin-personal.json` — só existe se o Stage 6 armou o post. */
export const PERSONAL_INTENT_FILE = "06-linkedin-personal.json";

export type PersonalIntentStatus = "armed" | "posting" | "published" | "failed" | "expired";

export interface PersonalPostIntent {
  edition: string;
  status: PersonalIntentStatus;
  text: string;
  /** Nome do arquivo de imagem na raiz da edição, ou null (post só texto). */
  image: string | null;
  /** ISO — o MESMO horário que a página agendou pro 4º post (entry linkedin/um). */
  scheduled_at: string;
  armed_at: string;
  published_at?: string;
  post_urn?: string | null;
  post_url?: string | null;
  reason?: string;
}

export type FireDecision = "not_due" | "fire" | "expired" | "done";

/**
 * O que fazer com uma intenção agora. `posting` conta como feito: um crash
 * entre o POST e a gravação deixa o status ali e o post NÃO é repetido (post
 * duplicado no perfil é pior que um post perdido, que o run-log registra).
 */
export function decideFire(intent: PersonalPostIntent, now: Date, maxLatenessMs = MAX_FIRE_LATENESS_MS): FireDecision {
  if (intent.status !== "armed") return "done";
  const at = new Date(intent.scheduled_at).getTime();
  if (Number.isNaN(at)) return "expired";
  if (now.getTime() < at) return "not_due";
  if (now.getTime() - at > maxLatenessMs) return "expired";
  return "fire";
}

/** Formata uma data como AAMMDD no fuso de São Paulo. */
export function aammddBrt(d: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "2-digit",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}${get("month")}${get("day")}`;
}

// ── Alarme de expiração ──────────────────────────────────────────────────

export const TOKEN_ALARM_CHECK = "linkedin-personal-token";
export const TOKEN_ALARM_FINGERPRINT = `${TOKEN_ALARM_CHECK}:expiry`;

/**
 * Achado do alarme, ou null. Token nunca configurado não alarma (modo manual
 * é legítimo). Fingerprint ÚNICO e família `estado`: renovar o token faz o
 * achado sumir e a issue fecha sozinha; `contentSignature` muda de faixa
 * (aviso → crítico → expirado) pra comentar na issue já aberta.
 */
export function evaluateTokenExpiry(env: Record<string, string | undefined>, now: Date): AlarmFinding | null {
  const token = (env[LINKEDIN_PERSONAL_ENV.accessToken] ?? "").trim();
  if (!token) return null;
  const expiresAt = parseExpiresAt(env[LINKEDIN_PERSONAL_ENV.expiresAt]);
  const renew =
    "Renovar: no Neo, `npx tsx scripts/linkedin-personal-oauth.ts` (abre o navegador, grava o token novo no Doppler e no `.env`); " +
    "no `300`, `npm run sync-env` depois. Passo a passo: `docs/linkedin-personal-setup.md`.";
  if (!expiresAt) {
    return {
      check: TOKEN_ALARM_CHECK,
      fingerprint: TOKEN_ALARM_FINGERPRINT,
      family: "estado",
      priority: "P2",
      labels: ["bug"],
      title: `LinkedIn pessoal: expiração do token desconhecida (${LINKEDIN_PERSONAL_ENV.expiresAt} ausente)`,
      body:
        `\`${LINKEDIN_PERSONAL_ENV.accessToken}\` existe mas \`${LINKEDIN_PERSONAL_ENV.expiresAt}\` está ausente ou ilegível — ` +
        `o alarme não consegue avisar antes do token de ${LINKEDIN_TOKEN_TTL_DAYS} dias expirar (#9568).\n\n${renew}`,
      contentSignature: "unknown",
    };
  }
  const daysLeft = Math.floor((expiresAt.getTime() - now.getTime()) / DAY_MS);
  if (daysLeft > TOKEN_WARN_DAYS) return null;
  const expired = expiresAt.getTime() <= now.getTime();
  const band = expired ? "expired" : daysLeft <= TOKEN_CRITICAL_DAYS ? "critical" : "warn";
  const title = expired
    ? `LinkedIn pessoal: token expirou em ${expiresAt.toISOString().slice(0, 10)} — post automático parado`
    : `LinkedIn pessoal: token expira em ${daysLeft} dia(s) (${expiresAt.toISOString().slice(0, 10)})`;
  return {
    check: TOKEN_ALARM_CHECK,
    fingerprint: TOKEN_ALARM_FINGERPRINT,
    family: "estado",
    priority: band === "warn" ? "P2" : "P1",
    labels: ["bug"],
    title,
    body:
      `O token do app LinkedIn pessoal (\`w_member_social\`, #9568) vale ${LINKEDIN_TOKEN_TTL_DAYS} dias e não tem refresh token. ` +
      (expired
        ? "Expirado: o Stage 6 volta ao lembrete manual e o post automático no perfil pessoal não sai.\n\n"
        : `Faltam ${daysLeft} dia(s). Depois disso o Stage 6 volta ao lembrete manual.\n\n`) +
      renew +
      "\n\nEsta issue fecha sozinha quando o token novo (expiração > " +
      `${TOKEN_WARN_DAYS} dias) aparecer no ambiente do \`300\`.`,
    contentSignature: band,
  };
}
