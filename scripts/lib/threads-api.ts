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
/** Teto de cada POST (container/publish): sem ele um socket pendurado segura o script indefinidamente. */
export const THREADS_POST_TIMEOUT_MS = 30_000;

export type ThreadsFetch = (input: string, init?: RequestInit) => Promise<Response>;

const defaultFetch: ThreadsFetch = (input, init) => fetch(input, init);
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Natureza da falha de uma chamada à Threads API (#10772, fleet review):
 *   - `network`: o `fetch` lançou (rede, DNS, timeout do `AbortSignal`) — o
 *     pedido pode ter chegado à Meta;
 *   - `http`: resposta não-2xx (`httpStatus` traz o código);
 *   - `api_error`: 2xx com objeto `error` num GET de status do container
 *     (leitura, não há envio a reconciliar);
 *   - `malformed_ok`: 2xx num POST sem `id` usável (corpo ilegível, `error` no
 *     corpo, sem `id`) — a Meta aceitou o pedido, então pode ter executado;
 *   - `container_failed`: o container ficou `ERROR`/`EXPIRED`;
 *   - `container_timeout`: o container não ficou `FINISHED` no teto de polls.
 */
export type ThreadsApiErrorKind = "network" | "http" | "api_error" | "malformed_ok" | "container_failed" | "container_timeout";

export class ThreadsApiError extends Error {
  constructor(
    message: string,
    readonly kind: ThreadsApiErrorKind,
    readonly httpStatus: number | null = null,
  ) {
    super(message);
    this.name = "ThreadsApiError";
  }

  /**
   * Envio AMBÍGUO: a Meta pode ter executado o pedido sem a gente saber. Só
   * rede/timeout, 5xx e 2xx sem `id` usável. Container `ERROR`/`EXPIRED` e
   * timeout do processamento acontecem ANTES do publish e não são ambíguos;
   * 4xx (incluindo 429) é recusa explícita.
   */
  get sendMayHaveSucceeded(): boolean {
    if (this.kind === "network" || this.kind === "malformed_ok") return true;
    return this.kind === "http" && this.httpStatus !== null && this.httpStatus >= 500;
  }
}

export type ThreadsContainerInput =
  | { mediaType: "TEXT"; text: string; replyToId?: string | null }
  | { mediaType: "VIDEO"; text: string; videoUrl: string; replyToId?: string | null };

async function postForm(fetchFn: ThreadsFetch, url: string, params: URLSearchParams, label: string): Promise<string> {
  let res: Response;
  try {
    res = await fetchFn(url, { method: "POST", body: params, signal: AbortSignal.timeout(THREADS_POST_TIMEOUT_MS) });
  } catch (e) {
    throw new ThreadsApiError(`Threads ${label} fetch falhou: ${(e as Error).message}`, "network");
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new ThreadsApiError(`Threads ${label} HTTP ${res.status}: ${body.slice(0, 300)}`, "http", res.status);
  }
  const raw = await res.text().catch(() => "");
  let data: { id?: unknown; error?: unknown } | null;
  try {
    data = JSON.parse(raw) as { id?: unknown; error?: unknown } | null;
  } catch {
    throw new ThreadsApiError(`Threads ${label} HTTP ${res.status} com corpo ilegível: ${raw.slice(0, 300)}`, "malformed_ok", res.status);
  }
  if (data?.error) throw new ThreadsApiError(`Threads ${label} API error: ${JSON.stringify(data.error)}`, "malformed_ok", res.status);
  if (typeof data?.id !== "string" || !data.id) {
    throw new ThreadsApiError(`Threads ${label} response sem id: ${JSON.stringify(data)}`, "malformed_ok", res.status);
  }
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
  /**
   * Esgotou sem `FINISHED`: `continue` (texto, best-effort #3995) ou `throw`
   * (vídeo). Também decide o 4xx num poll: em `throw` qualquer 4xx falha na
   * hora; em `continue` só o de token (401, ou 400 com code 190) — os demais
   * seguem best-effort, porque o texto já tolerava propagação lenta da Meta (#3995).
   */
  onTimeout: "continue" | "throw";
  sleep?: (ms: number) => Promise<void>;
  fetchFn?: ThreadsFetch;
}

/** 401, ou 400 com `error.code` 190 (token inválido/expirado): nenhum poll a mais resolve. */
function isTokenError(status: number, body: string): boolean {
  if (status === 401) return true;
  if (status !== 400) return false;
  try {
    return (JSON.parse(body) as { error?: { code?: unknown } })?.error?.code === 190;
  } catch {
    return false;
  }
}

/**
 * Poll do status do container até `FINISHED` (ou `PUBLISHED`, terminal: o
 * container já virou post e não pode ser publicado de novo). `ERROR`/`EXPIRED`
 * abortam cedo com a `error_message` da API. Falha de rede e 5xx num poll são
 * best-effort (tenta de novo até esgotar); o último status HTTP e o trecho do
 * corpo dessas falhas entram na mensagem do timeout.
 */
export async function waitForThreadsContainer(
  containerId: string,
  accessToken: string,
  apiVersion: string,
  opts: WaitForContainerOptions,
): Promise<"finished" | "published" | "timeout"> {
  const fetchFn = opts.fetchFn ?? defaultFetch;
  const sleep = opts.sleep ?? defaultSleep;
  const url = `${THREADS_API_BASE}/${apiVersion}/${containerId}?fields=status,error_message`;
  let lastFailure: string | null = null;
  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    let status: string | undefined;
    let errorMessage: string | undefined;
    let res: Response | null = null;
    try {
      res = await fetchFn(url, { method: "GET", headers: { Authorization: `Bearer ${accessToken}` } });
    } catch (e) {
      // Falha de rede no polling — best-effort, tenta de novo até esgotar.
      lastFailure = `rede: ${(e as Error).message}`;
    }
    if (res) {
      if (res.ok) {
        type PollBody = { status?: string; error_message?: string; error?: { code?: unknown } } | null;
        let data: PollBody = null;
        try {
          data = (await res.json()) as PollBody;
        } catch {
          lastFailure = `HTTP ${res.status} com corpo ilegível`;
        }
        if (data?.error) {
          const detail = JSON.stringify(data.error).slice(0, 300);
          if (data.error.code === 190) {
            throw new ThreadsApiError(`Threads container ${containerId}: token inválido no poll: ${detail}`, "api_error", res.status);
          }
          lastFailure = `HTTP ${res.status} com error: ${detail}`;
        }
        status = data?.status;
        errorMessage = data?.error_message;
      } else {
        const body = typeof res.text === "function" ? await res.text().catch(() => "") : "";
        lastFailure = `HTTP ${res.status}: ${body.slice(0, 200)}`;
        const fatal4xx = res.status >= 400 && res.status < 500 && (opts.onTimeout === "throw" || isTokenError(res.status, body));
        if (fatal4xx) {
          throw new ThreadsApiError(`Threads container ${containerId} poll HTTP ${res.status}: ${body.slice(0, 300)}`, "http", res.status);
        }
      }
    }
    if (status === "FINISHED") return "finished";
    if (status === "PUBLISHED") return "published";
    if (status === "ERROR" || status === "EXPIRED") {
      throw new ThreadsApiError(`Threads container ${containerId} status=${status}: ${errorMessage ?? "sem detalhe"}`, "container_failed");
    }
    if (attempt < opts.maxAttempts) await sleep(opts.intervalMs);
  }
  if (opts.onTimeout === "throw") {
    // Entre o 1º e o último poll há (maxAttempts - 1) intervalos.
    const waitedS = Math.round(((opts.maxAttempts - 1) * opts.intervalMs) / 1000);
    throw new ThreadsApiError(
      `Threads container ${containerId} não ficou FINISHED em ${opts.maxAttempts} tentativas (${waitedS}s entre o 1º e o último poll)` +
        (lastFailure ? `; última falha de poll: ${lastFailure}` : ""),
      "container_timeout",
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
  | { ok: false; status: number | null; reason: string; tooYoung: boolean };

/**
 * Mensagem da Meta para refresh de token com menos de 24h (a doc exige ≥24h).
 * O texto exato não é documentado; casa as formas comuns ("24 hours", "24h").
 */
const TOO_YOUNG_RE = /\b24\s*(?:h\b|hours?\b|horas?\b)/i;

/**
 * Renova um token de longa duração (60 dias) — mesmo endpoint do Worker
 * (`workers/linkedin-cron/src/maintenance.ts`, #9569/#9618). Só funciona com o
 * token ainda válido e com ≥24h; token vencido exige novo OAuth manual. Nunca
 * inclui o token na mensagem de erro. `tooYoung` = a Meta recusou por o token
 * ter menos de 24h (esperado logo depois de gerar/renovar à mão).
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
    return { ok: false, status: null, reason: `erro de rede: ${(e as Error).name}`, tooYoung: false };
  }
  const data = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: { message?: string } };
  if (!res.ok || !data.access_token) {
    const message = data.error?.message ?? "sem access_token";
    return { ok: false, status: res.status, reason: `HTTP ${res.status}: ${message}`, tooYoung: !res.ok && TOO_YOUNG_RE.test(message) };
  }
  const expires = typeof data.expires_in === "number" && Number.isFinite(data.expires_in) && data.expires_in > 0 ? data.expires_in : null;
  return { ok: true, accessToken: data.access_token, expiresInSeconds: expires };
}
