/**
 * threads-api.ts (#10772) — cliente da Threads API oficial da Meta, sem efeito
 * no import. Extraído de `scripts/publish-threads.ts` (#2479/#3995/#7779), que
 * continua usando estas funções para os posts de texto da diar.ia.br; o
 * vertical do perfil PESSOAL (`threads-personal-video.ts`) usa as mesmas com
 * `media_type=VIDEO`.
 *
 * Docs oficiais (Meta):
 *   - Publicação (container → `threads_publish`, `media_type` TEXT/IMAGE/VIDEO,
 *     `video_url` público):  https://developers.facebook.com/docs/threads/posts
 *   - Status do container (`GET /{container-id}?fields=status,error_message`,
 *     `IN_PROGRESS`/`FINISHED`/`ERROR`/`EXPIRED`/`PUBLISHED`):
 *     https://developers.facebook.com/docs/threads/troubleshooting (seção "Publishing Does Not
 *     Return a Media ID"; a Meta recomenda consultar 1x por minuto, por no máximo 5 min)
 *   - Token de longa duração e refresh (`GET /refresh_access_token?grant_type=th_refresh_token`,
 *     token com ≥24h e ainda válido; devolve outro token de 60 dias):
 *     https://developers.facebook.com/docs/threads/get-started/long-lived-tokens
 *   A doc atual usa o host graph.threads.com; o repo (script e Worker) segue em
 *   graph.threads.net, que continua respondendo — mantido por paridade.
 *
 * Token: nos POST vai no corpo (form), como sempre foi em `publish-threads.ts`;
 * nos GET vai no header `Authorization: Bearer` — nunca na query string (#7779/#7893).
 */

export const THREADS_API_BASE = "https://graph.threads.net";
export const THREADS_API_VERSION = "v1.0";
/** Limite de caracteres do texto de um post no Threads. */
export const THREADS_TEXT_MAX_CHARS = 500;

export type ThreadsFetch = (input: string, init?: RequestInit) => Promise<Response>;

const defaultFetch: ThreadsFetch = (input, init) => fetch(input, init);
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Erro de chamada à Threads API. `status` = HTTP da resposta; `null` = falha de
 * rede/timeout (o pedido pode ter chegado à Meta — envio ambíguo no publish).
 */
export class ThreadsApiError extends Error {
  constructor(message: string, readonly status: number | null) {
    super(message);
    this.name = "ThreadsApiError";
  }
}

export type ThreadsContainerInput =
  | { mediaType: "TEXT"; text: string; replyToId?: string | null }
  | { mediaType: "VIDEO"; text: string; videoUrl: string; replyToId?: string | null };

async function postForm(fetchFn: ThreadsFetch, url: string, params: URLSearchParams, label: string): Promise<string> {
  let res: Response;
  try {
    res = await fetchFn(url, { method: "POST", body: params });
  } catch (e) {
    throw new ThreadsApiError(`Threads ${label} fetch falhou: ${(e as Error).message}`, null);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new ThreadsApiError(`Threads ${label} HTTP ${res.status}: ${body.slice(0, 300)}`, res.status);
  }
  const data = (await res.json().catch(() => ({}))) as { id?: string; error?: unknown };
  if (data.error) throw new ThreadsApiError(`Threads ${label} API error: ${JSON.stringify(data.error)}`, res.status);
  if (!data.id) throw new ThreadsApiError(`Threads ${label} response sem id: ${JSON.stringify(data)}`, res.status);
  return data.id;
}

/** Passo 1: `POST /{threads-user-id}/threads` — devolve o id do container. */
export async function createThreadsContainer(
  userId: string,
  accessToken: string,
  input: ThreadsContainerInput,
  apiVersion: string = THREADS_API_VERSION,
  fetchFn: ThreadsFetch = defaultFetch,
): Promise<string> {
  const params = new URLSearchParams();
  params.append("media_type", input.mediaType);
  if (input.mediaType === "VIDEO") params.append("video_url", input.videoUrl);
  params.append("text", input.text);
  params.append("access_token", accessToken);
  if (input.replyToId) params.append("reply_to_id", input.replyToId);
  return postForm(fetchFn, `${THREADS_API_BASE}/${apiVersion}/${userId}/threads`, params, "/threads");
}

/** Passo 2: `POST /{threads-user-id}/threads_publish` — devolve o media id publicado. */
export async function publishThreadsContainer(
  userId: string,
  accessToken: string,
  containerId: string,
  apiVersion: string = THREADS_API_VERSION,
  fetchFn: ThreadsFetch = defaultFetch,
): Promise<string> {
  const params = new URLSearchParams();
  params.append("creation_id", containerId);
  params.append("access_token", accessToken);
  return postForm(fetchFn, `${THREADS_API_BASE}/${apiVersion}/${userId}/threads_publish`, params, "/threads_publish");
}

export interface WaitForContainerOptions {
  maxAttempts: number;
  intervalMs: number;
  /** Esgotou sem `FINISHED`: `continue` (texto, best-effort #3995) ou `throw` (vídeo). */
  onTimeout: "continue" | "throw";
  sleep?: (ms: number) => Promise<void>;
  fetchFn?: ThreadsFetch;
}

/**
 * Poll do status do container até `FINISHED`. `ERROR`/`EXPIRED` lançam cedo,
 * com a `error_message` da API. Falha de rede/HTTP num poll é best-effort
 * (tenta de novo até esgotar).
 */
export async function waitForThreadsContainer(
  containerId: string,
  accessToken: string,
  apiVersion: string,
  opts: WaitForContainerOptions,
): Promise<"finished" | "timeout"> {
  const fetchFn = opts.fetchFn ?? defaultFetch;
  const sleep = opts.sleep ?? defaultSleep;
  const url = `${THREADS_API_BASE}/${apiVersion}/${containerId}?fields=status,error_message`;
  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    let status: string | undefined;
    let errorMessage: string | undefined;
    try {
      const res = await fetchFn(url, { method: "GET", headers: { Authorization: `Bearer ${accessToken}` } });
      if (res.ok) {
        const data = (await res.json()) as { status?: string; error_message?: string };
        status = data.status;
        errorMessage = data.error_message;
      } else {
        await res.body?.cancel().catch(() => {});
      }
    } catch {
      // Falha de rede no polling — best-effort, tenta de novo até esgotar.
    }
    if (status === "FINISHED") return "finished";
    if (status === "ERROR" || status === "EXPIRED") {
      throw new ThreadsApiError(`Threads container ${containerId} status=${status}: ${errorMessage ?? "sem detalhe"}`, null);
    }
    if (attempt < opts.maxAttempts) await sleep(opts.intervalMs);
  }
  if (opts.onTimeout === "throw") {
    throw new ThreadsApiError(
      `Threads container ${containerId} não ficou FINISHED em ${opts.maxAttempts} tentativas (${Math.round((opts.maxAttempts * opts.intervalMs) / 1000)}s)`,
      null,
    );
  }
  return "timeout";
}

/** Permalink público do post. Best-effort: qualquer falha devolve null. */
export async function fetchThreadsPermalink(
  mediaId: string,
  accessToken: string,
  apiVersion: string = THREADS_API_VERSION,
  fetchFn: ThreadsFetch = defaultFetch,
): Promise<string | null> {
  try {
    const url = `${THREADS_API_BASE}/${apiVersion}/${mediaId}?fields=permalink`;
    const res = await fetchFn(url, { method: "GET", headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) {
      // #9991: corpo não lido segura o socket e a saída via exitCode.
      await res.body?.cancel().catch(() => {});
      return null;
    }
    const data = (await res.json()) as { permalink?: string; error?: unknown };
    if (data.error || !data.permalink) return null;
    return data.permalink;
  } catch {
    return null;
  }
}

export type ThreadsRefreshResult =
  | { ok: true; accessToken: string; expiresInSeconds: number | null }
  | { ok: false; status: number | null; reason: string };

/**
 * Renova um token de longa duração (60 dias) — mesmo endpoint do Worker
 * (`workers/linkedin-cron/src/maintenance.ts`, #9569/#9618). Só funciona com o
 * token ainda válido e com ≥24h; token vencido exige novo OAuth manual. Nunca
 * inclui o token na mensagem de erro.
 */
export async function refreshThreadsLongLivedToken(
  accessToken: string,
  fetchFn: ThreadsFetch = defaultFetch,
): Promise<ThreadsRefreshResult> {
  const url = `${THREADS_API_BASE}/refresh_access_token?grant_type=th_refresh_token`;
  let res: Response;
  try {
    res = await fetchFn(url, { method: "GET", headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(15_000) });
  } catch (e) {
    return { ok: false, status: null, reason: `erro de rede: ${(e as Error).name}` };
  }
  const data = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: { message?: string } };
  if (!res.ok || !data.access_token) {
    return { ok: false, status: res.status, reason: `HTTP ${res.status}: ${data.error?.message ?? "sem access_token"}` };
  }
  const expires = typeof data.expires_in === "number" && Number.isFinite(data.expires_in) && data.expires_in > 0 ? data.expires_in : null;
  return { ok: true, accessToken: data.access_token, expiresInSeconds: expires };
}
