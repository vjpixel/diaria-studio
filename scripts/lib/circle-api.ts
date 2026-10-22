/**
 * circle-api.ts (#10904)
 *
 * Cliente mínimo da Admin API v2 do Circle (comunidade da Stack,
 * `plataforma.stack.com.br`) — só o que o publicador semanal
 * (`publish-circle-stack.ts`) usa: criar post num espaço e listar espaços
 * (pra descobrir o `space_id`).
 *
 * Três pontos ainda NÃO confirmados contra a API real (o token de moderador
 * estava sendo gerado pela Stack quando isto foi escrito) e por isso ficam
 * configuráveis em vez de fixos:
 *   1. Esquema do header de auth — a spec OpenAPI diz `Token <token>`, o
 *      quick-start oficial mostra `Bearer <token>`. `auth_scheme: "auto"`
 *      tenta `Token` e, só em 401, repete uma vez com `Bearer`.
 *   2. Campo do corpo — `body` (HTML) é o default; se a API recusar, trocar
 *      pra `tiptap_body` exige mudar `buildCreatePostPayload`, não a config.
 *   3. Autor — `user_email` só entra no payload se configurado. Sem ele, o
 *      post sai como o dono do token (a conta diar.ia.br, se o token for dela).
 */

export const CIRCLE_DEFAULT_BASE_URL = "https://app.circle.so";
export const CIRCLE_ADMIN_V2_PATH = "/api/admin/v2";

export type CircleAuthScheme = "Token" | "Bearer" | "auto";
export type CirclePostStatus = "draft" | "published" | "scheduled";

export interface CircleClientConfig {
  token: string;
  baseUrl?: string;
  authScheme?: CircleAuthScheme;
}

export interface CircleCreatePostInput {
  spaceId: number;
  name: string;
  html: string;
  status: CirclePostStatus;
  /** ISO 8601 — obrigatório quando `status === "scheduled"`. */
  publishedAt?: string;
  userEmail?: string;
  isCommentsEnabled?: boolean;
  /** `true` evita notificar os membros do espaço (útil em teste). */
  skipNotifications?: boolean;
}

export interface CirclePostResult {
  id: number | null;
  url: string | null;
  status: string | null;
  raw: unknown;
}

export interface CircleSpace {
  id: number;
  name: string;
  slug: string;
}

/** Pure: corpo JSON de `POST /api/admin/v2/posts`. Campos opcionais só entram quando definidos. */
export function buildCreatePostPayload(input: CircleCreatePostInput): Record<string, unknown> {
  if (!Number.isInteger(input.spaceId) || input.spaceId <= 0) {
    throw new Error(`space_id inválido: ${input.spaceId}`);
  }
  if (!input.name.trim()) throw new Error("Título do post vazio");
  if (!input.html.trim()) throw new Error("Corpo do post vazio");
  if (input.status === "scheduled" && !input.publishedAt) {
    throw new Error('status "scheduled" exige publishedAt');
  }
  const payload: Record<string, unknown> = {
    space_id: input.spaceId,
    name: input.name,
    body: input.html,
    status: input.status,
  };
  if (input.publishedAt) payload.published_at = input.publishedAt;
  if (input.userEmail) payload.user_email = input.userEmail;
  if (input.isCommentsEnabled !== undefined) payload.is_comments_enabled = input.isCommentsEnabled;
  if (input.skipNotifications !== undefined) payload.skip_notifications = input.skipNotifications;
  return payload;
}

/** Pure: valor do header `Authorization`. */
export function authHeader(token: string, scheme: "Token" | "Bearer"): string {
  return `${scheme} ${token}`;
}

/** Pure: extrai id/url/status da resposta de criação — o shape exato ainda não foi visto ao vivo. */
export function parsePostResponse(raw: unknown): CirclePostResult {
  const obj = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const post = (obj.post && typeof obj.post === "object" ? obj.post : obj) as Record<string, unknown>;
  const id = typeof post.id === "number" ? post.id : null;
  const url = typeof post.url === "string" ? post.url : null;
  const status = typeof post.status === "string" ? post.status : null;
  return { id, url, status, raw };
}

/** Pure: normaliza a listagem de espaços (`records` na v2; aceita array cru por tolerância). */
export function parseSpacesResponse(raw: unknown): CircleSpace[] {
  const obj = raw as Record<string, unknown> | unknown[] | null;
  const list = Array.isArray(obj) ? obj : Array.isArray((obj as Record<string, unknown>)?.records) ? ((obj as Record<string, unknown>).records as unknown[]) : [];
  return list
    .map((s) => s as Record<string, unknown>)
    .filter((s) => typeof s.id === "number")
    .map((s) => ({ id: s.id as number, name: String(s.name ?? ""), slug: String(s.slug ?? "") }));
}

type FetchLike = typeof fetch;

async function circleRequest(
  cfg: CircleClientConfig,
  method: "GET" | "POST",
  path: string,
  body: unknown,
  fetchImpl: FetchLike,
): Promise<unknown> {
  const base = (cfg.baseUrl ?? CIRCLE_DEFAULT_BASE_URL).replace(/\/$/, "");
  const url = `${base}${CIRCLE_ADMIN_V2_PATH}${path}`;
  const configured = cfg.authScheme ?? "auto";
  const schemes: Array<"Token" | "Bearer"> = configured === "auto" ? ["Token", "Bearer"] : [configured];

  let lastStatus = 0;
  let lastText = "";
  for (const scheme of schemes) {
    const res = await fetchImpl(url, {
      method,
      headers: {
        Authorization: authHeader(cfg.token, scheme),
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    lastStatus = res.status;
    lastText = await res.text();
    if (res.status === 401 && configured === "auto") continue;
    if (!res.ok) break;
    return lastText ? JSON.parse(lastText) : {};
  }
  throw new Error(`Circle ${method} ${path} falhou: HTTP ${lastStatus} ${lastText.slice(0, 500)}`);
}

export async function createCirclePost(
  cfg: CircleClientConfig,
  input: CircleCreatePostInput,
  fetchImpl: FetchLike = fetch,
): Promise<CirclePostResult> {
  const raw = await circleRequest(cfg, "POST", "/posts", buildCreatePostPayload(input), fetchImpl);
  return parsePostResponse(raw);
}

export async function listCircleSpaces(cfg: CircleClientConfig, fetchImpl: FetchLike = fetch): Promise<CircleSpace[]> {
  const raw = await circleRequest(cfg, "GET", "/spaces?per_page=100", undefined, fetchImpl);
  return parseSpacesResponse(raw);
}
