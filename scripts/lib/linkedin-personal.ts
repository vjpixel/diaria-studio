/**
 * linkedin-personal.ts (#9568 — LinkedIn PESSOAL automatizado)
 *
 * Miolo do post automático do 4º post (item USE MELHOR, `## um`) no perfil
 * PESSOAL do editor no LinkedIn. Decisão do editor de 07/10/2026: um app
 * LinkedIn SEPARADO, com os produtos "Share on LinkedIn" (`w_member_social`)
 * e "Sign In with LinkedIn using OpenID Connect" (`openid profile`, pra
 * descobrir a URN da pessoa e checar se o token segue vivo) — sem tocar no
 * app da página (77tIvy0623oq84, em análise da Community Management API, que
 * a LinkedIn exige como produto único do app).
 *
 * Três peças usam este módulo:
 *   - `scripts/linkedin-personal-oauth.ts` — OAuth one-shot (authorization
 *     code com redirect local) que grava token + URN + expiração.
 *   - `scripts/publish-linkedin-personal.ts` — `--check`/`--arm` no Stage 6;
 *     `--fire-due` nas tasks `Diaria-LinkedIn-Personal` (07:46, logo depois
 *     do slot) e `Diaria-LinkedIn-Personal-Catchup` (de hora em hora).
 *   - `scripts/linkedin-personal-token-alarm.ts` — alarme diário (expiração,
 *     token revogado, intenções presas/vencidas).
 *
 * Tudo que fala HTTP recebe `fetchFn` injetado — os testes nunca chamam a
 * LinkedIn de verdade.
 *
 * Por que não pelo Worker `linkedin-cron` (que já agenda a página): o Worker
 * não lê `.env`/Doppler (só `wrangler secret`), e o deploy dele é manual. O
 * token pessoal mora onde os outros segredos de publisher moram, e o
 * agendamento fica com tasks systemd.
 */

import type { AlarmFinding } from "./alarm-issues.ts";
import { getScheduledTaskByName, type ScheduledTaskSchedule } from "./scheduled-tasks.ts";

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

/** `w_member_social` publica; `openid profile` servem pra ler o `sub` (URN da pessoa) e checar o token. */
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

/** Intenção `posting`/`send_unknown` há mais que isso = presa (alarme). */
export const STUCK_AFTER_MS = 60 * 60 * 1000;

/** Janela de varredura do alarme sobre as intenções das edições. */
export const ALARM_SCAN_DAYS = 7;

/** Timeout de cada chamada HTTP — sem isso um socket pendurado segura a task. */
export const HTTP_TIMEOUT_MS = 30_000;

export const REVOKED_REASON = "token revogado ou inválido (HTTP 401/403) — re-rode scripts/linkedin-personal-oauth.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
/** Brasil sem horário de verão desde 2019: BRT = UTC-3 fixo. */
const BRT_OFFSET_MS = -3 * HOUR_MS;

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

const withTimeout = (init: RequestInit = {}): RequestInit => ({ ...init, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });

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
 * Impressão digital do token SEM o token: a expiração gravada pelo OAuth.
 * Duas máquinas com o mesmo token têm o mesmo valor; `.env` defasado no
 * `300` aparece como divergência no disparo.
 */
export function tokenFingerprint(env: Record<string, string | undefined>): string | null {
  const raw = (env[LINKEDIN_PERSONAL_ENV.expiresAt] ?? "").trim();
  return raw || null;
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

/** Token vivo? `GET /v2/userinfo` (leitura). 401/403 = revogado; rede/5xx = indeterminado. */
export type TokenRemoteState = { state: "valid" } | { state: "revoked"; reason: string } | { state: "unknown"; reason: string };

export async function checkTokenRemote(fetchFn: FetchFn, accessToken: string): Promise<TokenRemoteState> {
  try {
    const res = await fetchFn(LINKEDIN_USERINFO_URL, withTimeout({ headers: { Authorization: `Bearer ${accessToken}` } }));
    if (res.status === 401 || res.status === 403) return { state: "revoked", reason: REVOKED_REASON };
    if (!res.ok) return { state: "unknown", reason: `userinfo HTTP ${res.status}` };
    return { state: "valid" };
  } catch (e) {
    return { state: "unknown", reason: `userinfo: erro de rede: ${(e as Error).message}` };
  }
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
  const res = await fetchFn(
    LINKEDIN_TOKEN_URL,
    withTimeout({
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: args.code,
        redirect_uri: LINKEDIN_PERSONAL_REDIRECT_URI,
        client_id: args.clientId,
        client_secret: args.clientSecret,
      }).toString(),
    }),
  );
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
  const res = await fetchFn(LINKEDIN_USERINFO_URL, withTimeout({ headers: { Authorization: `Bearer ${accessToken}` } }));
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
 * primeiro deles (o "1)" das listas do Use Melhor bastaria). Hashtag (no
 * início ou depois de espaço/quebra de linha) vira o template
 * `{hashtag|\#|tag}` pra continuar clicável; `#` no meio de palavra ou de URL
 * fica só escapado.
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

/**
 * Resultado do post. `phase` separa o que pode ser re-tentado do que não pode:
 *   - `before_send`: nada foi criado (credencial, upload da imagem, 4xx do
 *     POST) — a intenção vira `failed_before_send` e pode ser re-armada.
 *   - `ambiguous`: o POST pode ter sido aceito (exceção/timeout durante a
 *     chamada, 5xx) — vira `send_unknown`, terminal: repetir arriscaria post
 *     duplicado no perfil.
 */
export type PostResult =
  | { ok: true; postUrn: string | null; imageUsed: boolean }
  | { ok: false; phase: "before_send" | "ambiguous"; reason: string; revoked?: boolean };

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
): Promise<{ ok: true; urn: string } | { ok: false; reason: string; revoked?: boolean }> {
  try {
    const init = await fetchFn(
      LINKEDIN_IMAGES_INIT_URL,
      withTimeout({
        method: "POST",
        headers: restHeaders(creds.accessToken, apiVersion),
        body: JSON.stringify({ initializeUploadRequest: { owner: creds.personUrn } }),
      }),
    );
    if (init.status === 401 || init.status === 403) return { ok: false, reason: REVOKED_REASON, revoked: true };
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
    const put = await fetchFn(
      data.value.uploadUrl,
      withTimeout({
        method: "PUT",
        headers: { Authorization: `Bearer ${creds.accessToken}` },
        // Uint8Array é BodyInit válido em runtime; o lib.dom do TS só não aceita ArrayBufferLike.
        body: bytes as unknown as BodyInit,
      }),
    );
    if (!put.ok) {
      return { ok: false, reason: `upload da imagem falhou (HTTP ${put.status}): ${(await put.text()).slice(0, 200)}` };
    }
    return { ok: true, urn: data.value.image };
  } catch (e) {
    // Upload ainda não cria post: falha aqui é sempre antes do envio.
    return { ok: false, reason: `upload da imagem: erro de rede: ${(e as Error).message}` };
  }
}

/**
 * Publica no perfil pessoal. Imagem opcional: falha no upload derruba o post
 * inteiro (não sai sem a capa que a página tem). Nunca lança.
 */
export async function postToPersonalProfile(args: {
  fetchFn: FetchFn;
  creds: PersonalCreds;
  apiVersion: string;
  text: string;
  imageBytes?: Uint8Array | null;
}): Promise<PostResult> {
  const { fetchFn, creds, apiVersion } = args;
  let imageUrn: string | null = null;
  if (args.imageBytes && args.imageBytes.length > 0) {
    const up = await uploadImage(fetchFn, creds, apiVersion, args.imageBytes);
    if (!up.ok) return { ok: false, phase: "before_send", reason: up.reason, ...(up.revoked ? { revoked: true } : {}) };
    imageUrn = up.urn;
  }
  let res: Response;
  try {
    res = await fetchFn(
      LINKEDIN_POSTS_URL,
      withTimeout({
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
      }),
    );
  } catch (e) {
    return { ok: false, phase: "ambiguous", reason: `POST /rest/posts: erro de rede/timeout depois do envio: ${(e as Error).message}` };
  }
  if (res.status === 201 || res.ok) {
    return { ok: true, postUrn: res.headers.get("x-restli-id"), imageUsed: imageUrn !== null };
  }
  if (res.status === 401 || res.status === 403) return { ok: false, phase: "before_send", reason: REVOKED_REASON, revoked: true };
  let body = "";
  try {
    body = (await res.text()).slice(0, 300);
  } catch {
    /* corpo ilegível não muda a classificação */
  }
  const phase = res.status >= 500 ? "ambiguous" : "before_send";
  return { ok: false, phase, reason: `POST /rest/posts falhou (HTTP ${res.status}): ${body}` };
}

/** URL pública do post a partir da URN devolvida em `x-restli-id`. */
export function postUrlFromUrn(urn: string | null): string | null {
  return urn ? `https://www.linkedin.com/feed/update/${urn}/` : null;
}

// ── Intenção por edição ──────────────────────────────────────────────────

/** `_internal/06-linkedin-personal.json` — só existe se o Stage 6 armou o post. */
export const PERSONAL_INTENT_FILE = "06-linkedin-personal.json";
/** Lock O_EXCL: criá-lo é a transição real `armed → posting`. */
export const PERSONAL_LOCK_FILE = "06-linkedin-personal.lock";

/**
 * - `armed`: autorizado pelo `ok` do Stage 6, esperando o slot.
 * - `posting`: lock pego, chamada em curso. Preso aqui = crash no meio
 *   (o alarme avisa depois de 1h); nunca re-disparado.
 * - `published`: saiu, com `post_url`.
 * - `failed_before_send`: nada foi criado — pode ser re-armado.
 * - `send_unknown`: o POST pode ter saído — terminal, conferir o perfil.
 * - `expired`: passou da janela sem disparo — pode ser re-armado.
 */
export type PersonalIntentStatus = "armed" | "posting" | "published" | "failed_before_send" | "send_unknown" | "expired";

export interface PersonalPostIntent {
  edition: string;
  status: PersonalIntentStatus;
  text: string;
  /** Nome do arquivo de imagem na raiz da edição, ou null (post só texto). */
  image: string | null;
  /** ISO — o MESMO horário que a página agendou pro 4º post (entry linkedin/um). */
  scheduled_at: string;
  armed_at: string;
  /** `tokenFingerprint` da máquina que armou — divergência no disparo = `.env` defasado. */
  token_fingerprint?: string | null;
  posting_at?: string;
  published_at?: string;
  post_urn?: string | null;
  post_url?: string | null;
  reason?: string;
  note?: string;
}

export type FireDecision = "not_due" | "fire" | "expired" | "done";

/**
 * O que fazer com uma intenção agora. Só `armed` dispara: `posting` preso
 * (crash entre o lock e a gravação final) conta como feito e NUNCA é
 * repetido — post duplicado no perfil é pior que um post perdido; quem
 * destrava é o alarme (posting > 1h) e o editor, conferindo o perfil.
 * `failed_before_send`/`expired` também são `done` aqui: voltar a disparar
 * exige um novo `--arm`. Limites: `now === scheduled_at` dispara; atraso
 * EXATO de 3h ainda dispara; 3h + 1ms expira.
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

// ── Janela das tasks ─────────────────────────────────────────────────────

export const PERSONAL_TASK_NAME = "Diaria-LinkedIn-Personal";
export const PERSONAL_CATCHUP_TASK_NAME = "Diaria-LinkedIn-Personal-Catchup";

/** Próxima execução (≥ t) de UMA schedule daily/interval, em BRT. */
export function nextRunOf(schedule: ScheduledTaskSchedule, t: Date): Date | null {
  const local = t.getTime() + BRT_OFFSET_MS; // "relógio de parede" BRT em ms UTC
  if (schedule.kind === "daily") {
    const day = Math.floor(local / DAY_MS) * DAY_MS;
    let run = day + schedule.hour * HOUR_MS + schedule.minute * 60_000;
    if (run < local) run += DAY_MS;
    return new Date(run - BRT_OFFSET_MS);
  }
  if (schedule.kind === "interval") {
    const step = schedule.hours * HOUR_MS;
    const day = Math.floor(local / DAY_MS) * DAY_MS;
    let run = day + Math.ceil((local - day) / step) * step;
    if (run - day >= DAY_MS) run = day + DAY_MS; // systemd 0/N recomeça à meia-noite
    return new Date(run - BRT_OFFSET_MS);
  }
  return null;
}

/** Próxima execução de QUALQUER das duas tasks de disparo (≥ t). */
export function nextPersonalFireRun(t: Date): Date | null {
  const runs = [PERSONAL_TASK_NAME, PERSONAL_CATCHUP_TASK_NAME]
    .map((n) => getScheduledTaskByName(n))
    .filter((task) => task && task.enabled !== false)
    .map((task) => nextRunOf(task!.schedule, t))
    .filter((d): d is Date => d !== null);
  if (runs.length === 0) return null;
  return runs.reduce((a, b) => (a.getTime() <= b.getTime() ? a : b));
}

/**
 * O post sai de fato? Há uma execução das tasks entre `max(scheduled_at,
 * now)` e `scheduled_at + 3h`. Sem isso, armar diria "automático" ao editor
 * e o post nunca sairia (Stage 5/6 atrasados, slot deslocado).
 */
export function fireWindowCheck(scheduledAt: Date, now: Date): { ok: true; nextRun: Date } | { ok: false; reason: string } {
  if (Number.isNaN(scheduledAt.getTime())) return { ok: false, reason: "scheduled_at ilegível" };
  const from = new Date(Math.max(scheduledAt.getTime(), now.getTime()));
  const next = nextPersonalFireRun(from);
  if (!next) return { ok: false, reason: "tasks de disparo ausentes ou desligadas no registro" };
  if (next.getTime() - scheduledAt.getTime() > MAX_FIRE_LATENESS_MS) {
    return {
      ok: false,
      reason: `nenhuma execução da task até 3h depois de ${scheduledAt.toISOString()} (próxima: ${next.toISOString()})`,
    };
  }
  return { ok: true, nextRun: next };
}

// ── Alarme ───────────────────────────────────────────────────────────────

export const TOKEN_ALARM_CHECK = "linkedin-personal-token";
export const TOKEN_ALARM_FINGERPRINT = `${TOKEN_ALARM_CHECK}:expiry`;
export const INTENT_ALARM_CHECK = "linkedin-personal-intent";

const RENEW =
  "Renovar: no Neo, `npx tsx scripts/linkedin-personal-oauth.ts` (abre o navegador, grava o token novo no Doppler e no `.env`); " +
  "no `300`, `npm run sync-env` depois. Passo a passo: `docs/linkedin-personal-setup.md`.";

/**
 * Achado de expiração/revogação do token, ou null. Token nunca configurado
 * não alarma (modo manual é legítimo). Fingerprint ÚNICO e família `estado`:
 * renovar o token faz o achado sumir e a issue fecha sozinha;
 * `contentSignature` muda de faixa (warn → critical → expired, ou revoked)
 * pra comentar na issue já aberta. Faixas: > 14 dias = nada; 14 dias ou
 * menos = P2; 3 dias ou menos (inclui < 24h) e expirado = P1;
 * `EXPIRES_AT` ausente/ilegível = P2 "desconhecida".
 */
export function evaluateTokenExpiry(
  env: Record<string, string | undefined>,
  now: Date,
  remote: TokenRemoteState | null = null,
): AlarmFinding | null {
  const token = (env[LINKEDIN_PERSONAL_ENV.accessToken] ?? "").trim();
  if (!token) return null;
  const base = { check: TOKEN_ALARM_CHECK, fingerprint: TOKEN_ALARM_FINGERPRINT, family: "estado" as const, labels: ["bug"] };
  if (remote?.state === "revoked") {
    return {
      ...base,
      priority: "P1",
      title: "LinkedIn pessoal: token revogado — re-rode linkedin-personal-oauth.ts",
      body: `\`GET /v2/userinfo\` respondeu 401/403: o token foi revogado ou invalidado antes do vencimento. O post automático no perfil pessoal parou e o Stage 6 volta ao lembrete manual (#9568).\n\n${RENEW}`,
      contentSignature: "revoked",
    };
  }
  const expiresAt = parseExpiresAt(env[LINKEDIN_PERSONAL_ENV.expiresAt]);
  if (!expiresAt) {
    return {
      ...base,
      priority: "P2",
      title: `LinkedIn pessoal: expiração do token desconhecida (${LINKEDIN_PERSONAL_ENV.expiresAt} ausente ou ilegível)`,
      body:
        `\`${LINKEDIN_PERSONAL_ENV.accessToken}\` existe mas \`${LINKEDIN_PERSONAL_ENV.expiresAt}\` está ausente ou ilegível — ` +
        `o alarme não consegue avisar antes do token de ${LINKEDIN_TOKEN_TTL_DAYS} dias expirar (#9568).\n\n${RENEW}`,
      contentSignature: "unknown",
    };
  }
  const msLeft = expiresAt.getTime() - now.getTime();
  if (msLeft > TOKEN_WARN_DAYS * DAY_MS) return null;
  const daysLeft = Math.floor(msLeft / DAY_MS);
  const expired = msLeft <= 0;
  const band = expired ? "expired" : msLeft <= TOKEN_CRITICAL_DAYS * DAY_MS ? "critical" : "warn";
  const title = expired
    ? `LinkedIn pessoal: token expirou em ${expiresAt.toISOString().slice(0, 10)} — post automático parado`
    : `LinkedIn pessoal: token expira em ${daysLeft} dia(s) (${expiresAt.toISOString().slice(0, 10)})`;
  return {
    ...base,
    priority: band === "warn" ? "P2" : "P1",
    title,
    body:
      `O token do app LinkedIn pessoal (\`w_member_social\`, #9568) vale ${LINKEDIN_TOKEN_TTL_DAYS} dias e não tem refresh token. ` +
      (expired
        ? "Expirado: o Stage 6 volta ao lembrete manual e o post automático no perfil pessoal não sai.\n\n"
        : `Faltam ${daysLeft} dia(s). Depois disso o Stage 6 volta ao lembrete manual.\n\n`) +
      RENEW +
      `\n\nEsta issue fecha sozinha quando o token novo (expiração > ${TOKEN_WARN_DAYS} dias) aparecer no ambiente do \`300\`.`,
    contentSignature: band,
  };
}

/**
 * Achados sobre as intenções das edições recentes (família `evento` — cada
 * um é um fato sobre um post específico; nunca fecha sozinho):
 *   - `posting`/`send_unknown` há mais de 1h: o post pode ter saído ou não —
 *     conferir o perfil antes de qualquer re-arme;
 *   - `armed` com mais de 3h de atraso: nenhuma task disparou;
 *   - `armed` aguardando, sem token nesta máquina: vai falhar no disparo.
 */
export function evaluatePersonalIntents(
  intents: readonly PersonalPostIntent[],
  env: Record<string, string | undefined>,
  now: Date,
): AlarmFinding[] {
  const out: AlarmFinding[] = [];
  const hasToken = Boolean((env[LINKEDIN_PERSONAL_ENV.accessToken] ?? "").trim());
  for (const it of intents) {
    const at = new Date(it.scheduled_at).getTime();
    const mk = (kind: string, priority: "P1" | "P2", title: string, body: string): AlarmFinding => ({
      check: INTENT_ALARM_CHECK,
      fingerprint: `${INTENT_ALARM_CHECK}:${it.edition}:${kind}`,
      family: "evento",
      priority,
      labels: ["bug"],
      title: `LinkedIn pessoal ${it.edition}: ${title}`,
      body: `${body}\n\nArquivo: \`_internal/06-linkedin-personal.json\` da edição ${it.edition} (#9568).`,
    });
    if (it.status === "posting" || it.status === "send_unknown") {
      const since = new Date(it.posting_at ?? it.scheduled_at).getTime();
      if (!Number.isNaN(since) && now.getTime() - since > STUCK_AFTER_MS) {
        out.push(
          mk(
            it.status,
            "P1",
            it.status === "posting" ? "disparo preso em posting" : "envio com resultado desconhecido",
            `Status \`${it.status}\` desde ${new Date(since).toISOString()}. O post pode ter saído ou não: conferir o perfil pessoal antes de postar à mão ou re-armar. ${it.reason ?? ""}`.trim(),
          ),
        );
      }
    } else if (it.status === "armed") {
      if (!Number.isNaN(at) && now.getTime() - at > MAX_FIRE_LATENESS_MS) {
        out.push(mk("armed-overdue", "P1", "post armado e não disparado", `Agendado para ${it.scheduled_at} e ainda \`armed\` mais de 3h depois: nenhuma task \`${PERSONAL_TASK_NAME}\`/\`${PERSONAL_CATCHUP_TASK_NAME}\` disparou (timer desarmado? OneDrive atrasado?). O post não sai mais; postar à mão.`));
      } else if (!hasToken) {
        out.push(mk("armed-no-token", "P1", "armado mas sem token nesta máquina", "A intenção está armada, mas o `.env` desta máquina não tem `LINKEDIN_PERSONAL_ACCESS_TOKEN`: o disparo vai falhar. Rodar `npm run sync-env` no `300`."));
      }
    }
  }
  return out;
}
