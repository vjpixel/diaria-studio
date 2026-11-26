/**
 * facebook-publish-retry.ts (#14131)
 *
 * Retry do POST do post diário do Facebook (`publish-facebook.ts`) sem criar
 * post duplicado na página.
 *
 * Antes do #14131 o laço de 3 tentativas repetia o POST `/photos` (ou o
 * `/feed` do carrossel) em QUALQUER erro. Quando a Graph criava o post
 * agendado e a resposta voltava 5xx ou a conexão caía antes dela, a 2ª
 * tentativa criava um 2º post agendado igual, no mesmo horário, que saía
 * publicado para o público. Se as 3 falhavam, a entry virava `failed` e o
 * re-run da Etapa 5 criava mais um.
 *
 * Regra daqui, no mesmo desenho do #14010 para a fila do Worker
 * (`daily-worker-enqueue.ts`): erro que PROVA que nada foi criado (4xx da
 * Graph, falha antes do envio, falha no upload das fotos não publicadas do
 * carrossel) pode repetir. Erro ambíguo (5xx, timeout, conexão caída depois
 * do envio, 2xx ilegível ou sem id) consulta a página antes de repetir:
 * `GET /{page-id}/scheduled_posts`, procurando post com o mesmo
 * `scheduled_publish_time` e o mesmo início de legenda. Achou: adota o id, sem
 * novo POST. Não achou em todas as leituras: repete. Leitura falhou, ou não há
 * o que consultar (post sem agendamento): `send_unknown`, sem novo POST — a
 * retomada pula `send_unknown` (`RESUME_SKIP_STATUSES`, #13074).
 */

/** Erro de envio do post do Facebook com a classificação de ambiguidade. */
export class FacebookPublishError extends Error {
  /** `true`: o post pode ter sido criado (5xx, timeout, resposta ilegível). */
  readonly ambiguous: boolean;
  readonly httpStatus?: number;
  constructor(message: string, opts: { ambiguous: boolean; httpStatus?: number }) {
    super(message);
    this.name = "FacebookPublishError";
    this.ambiguous = opts.ambiguous;
    this.httpStatus = opts.httpStatus;
  }
}

/**
 * Códigos de erro de rede em que a requisição nunca saiu da máquina (DNS,
 * conexão recusada): nada chegou à Graph, repetir é seguro.
 */
const PRE_SEND_NETWORK_CODES = new Set(["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED"]);

function networkErrorCode(e: unknown): string | undefined {
  const err = e as { code?: unknown; cause?: { code?: unknown } } | null;
  const code = err?.cause?.code ?? err?.code;
  return typeof code === "string" ? code : undefined;
}

/**
 * Pure: erro lançado pelo `fetch` (antes de existir resposta) é ambíguo,
 * exceto os códigos de rede anteriores ao envio.
 */
export function isPreSendNetworkError(e: unknown): boolean {
  const code = networkErrorCode(e);
  return code !== undefined && PRE_SEND_NETWORK_CODES.has(code);
}

/**
 * Pure: classificação do status HTTP de uma resposta de erro da Graph. 5xx é
 * ambíguo (a Graph devolve 500 "unknown error" com o post criado); 4xx prova
 * que o pedido foi recusado.
 */
export function isAmbiguousHttpStatus(status: number): boolean {
  return status >= 500;
}

/**
 * Pure: o erro capturado pelo laço de retry pode ter criado o post? Erro que
 * não é `FacebookPublishError` (bug, exceção inesperada no meio do envio) é
 * tratado como ambíguo, salvo o de rede anterior ao envio: na dúvida, nunca
 * repetir cego.
 */
export function isAmbiguousFacebookFailure(e: unknown): boolean {
  if (e instanceof FacebookPublishError) return e.ambiguous;
  return !isPreSendNetworkError(e);
}

/**
 * `fetch` que traduz erro de rede em `FacebookPublishError` classificado.
 * Usado pelos POSTs que podem criar o post visível.
 */
export async function fetchForFacebookPublish(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  label: string,
): Promise<Response> {
  try {
    return await fetchImpl(url, init);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const code = networkErrorCode(e);
    throw new FacebookPublishError(`${label}: ${msg}${code ? ` (${code})` : ""}`, {
      ambiguous: !isPreSendNetworkError(e),
    });
  }
}

export interface FbScheduledPostLite {
  id?: unknown;
  message?: unknown;
  scheduled_publish_time?: unknown;
}

/** Quantos caracteres do início da legenda precisam coincidir. */
const CAPTION_PREFIX_LEN = 120;

function normalizeCaption(s: string): string {
  return s.replace(/\s+/g, " ").trim().slice(0, CAPTION_PREFIX_LEN);
}

/**
 * Pure: post agendado da página que é o mesmo que tentamos criar — mesmo
 * `scheduled_publish_time` (segundos Unix) e o mesmo início de legenda
 * (espaços normalizados). Devolve o id ou `null`.
 */
export function matchFacebookScheduledPost(
  items: readonly FbScheduledPostLite[],
  caption: string,
  scheduledUnix: number,
): string | null {
  const want = normalizeCaption(caption);
  if (!want) return null;
  for (const it of items) {
    if (typeof it?.id !== "string" || !it.id) continue;
    const t = typeof it.scheduled_publish_time === "string" ? Number(it.scheduled_publish_time) : it.scheduled_publish_time;
    if (t !== scheduledUnix) continue;
    if (typeof it.message !== "string") continue;
    if (normalizeCaption(it.message) === want) return it.id;
  }
  return null;
}

export type FacebookPageLookupResult =
  | { status: "found"; id: string }
  | { status: "absent" }
  | { status: "error"; error: string };

/**
 * `GET /{page-id}/scheduled_posts` (token no header, #7779) e procura o post.
 * Nunca lança: erro de leitura vira `{ status: "error" }`. Lista com mais de
 * uma página (`paging.next`) sem o post é inconclusiva (`error`): o post pode
 * estar na página seguinte.
 */
export async function lookupFacebookScheduledPost(input: {
  pageId: string;
  pageToken: string;
  apiVersion: string;
  caption: string;
  scheduledUnix: number;
  fetchImpl?: typeof fetch;
}): Promise<FacebookPageLookupResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const url =
    `https://graph.facebook.com/${input.apiVersion}/${input.pageId}/scheduled_posts` +
    `?fields=id,message,scheduled_publish_time&limit=100`;
  try {
    const res = await fetchImpl(url, { headers: { Authorization: `OAuth ${input.pageToken}` } });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { status: "error", error: `scheduled_posts HTTP ${res.status}: ${body.slice(0, 200)}` };
    }
    const data = (await res.json()) as { data?: unknown; error?: unknown; paging?: { next?: unknown } };
    if (data.error) return { status: "error", error: `scheduled_posts error: ${JSON.stringify(data.error).slice(0, 200)}` };
    if (!Array.isArray(data.data)) return { status: "error", error: "scheduled_posts sem `data`" };
    const id = matchFacebookScheduledPost(data.data as FbScheduledPostLite[], input.caption, input.scheduledUnix);
    if (id) return { status: "found", id };
    if (typeof data.paging?.next === "string" && data.paging.next) {
      return { status: "error", error: "scheduled_posts tem mais de uma página de resultados e o post não está na 1ª" };
    }
    return { status: "absent" };
  } catch (e) {
    return { status: "error", error: `scheduled_posts: ${e instanceof Error ? e.message : String(e)}` };
  }
}

export type FacebookPublishOutcome =
  | { kind: "created"; result: { id: string; post_id?: string }; recovered?: "page_lookup"; attempts: number }
  /** Nada foi criado (provado): o re-run é seguro. */
  | { kind: "failed"; reason: string; attempts: number }
  /** O post pode existir na página: nunca repetir sem conferir. */
  | { kind: "send_unknown"; reason: string; attempts: number };

export interface FacebookPublishRetryOptions {
  label: string;
  /** Um envio (POST que cria o post). */
  send: () => Promise<{ id: string; post_id?: string }>;
  /**
   * Consulta da página depois de falha ambígua. `null` quando não há o que
   * consultar (post sem `scheduled_publish_time`): a falha ambígua vira
   * `send_unknown` direto.
   */
  lookup: (() => Promise<FacebookPageLookupResult>) | null;
  maxAttempts?: number;
  /** Leituras da página antes de concluir "não existe" (a listagem pode atrasar). */
  lookupReads?: number;
  /** Espera entre leituras da página. */
  lookupDelayMs?: number;
  /** Backoff entre tentativas: `attempt` → ms. Default 1s, 2s. */
  backoffMs?: (attempt: number) => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (msg: string) => void;
}

/**
 * Envia com retry sem duplicar o post (ver docstring do módulo). Nunca lança.
 */
export async function publishFacebookWithReconciliation(
  opts: FacebookPublishRetryOptions,
): Promise<FacebookPublishOutcome> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const lookupReads = Math.max(1, opts.lookupReads ?? 2);
  const lookupDelayMs = opts.lookupDelayMs ?? 3000;
  const backoffMs = opts.backoffMs ?? ((attempt: number) => Math.pow(2, attempt - 1) * 1000);
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = opts.log ?? ((m: string) => console.error(m));

  let lastError = "";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await opts.send();
      return { kind: "created", result, attempts: attempt };
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      log(`Attempt ${attempt}/${maxAttempts} failed for ${opts.label}: ${lastError}`);

      if (isAmbiguousFacebookFailure(e)) {
        if (!opts.lookup) {
          return {
            kind: "send_unknown",
            reason:
              `send_unknown: ${lastError} — o post pode ter sido criado e não há agendamento para conferir em ` +
              `/scheduled_posts. Conferir a página antes de refazer este post (#14131).`,
            attempts: attempt,
          };
        }
        let verdict: FacebookPageLookupResult = { status: "absent" };
        for (let read = 1; read <= lookupReads; read++) {
          if (read > 1) await sleep(lookupDelayMs);
          verdict = await opts.lookup();
          if (verdict.status !== "absent") break;
        }
        if (verdict.status === "found") {
          log(`WARN ${opts.label}: o POST falhou (${lastError}), mas a página já tem o post agendado ${verdict.id}; adotado sem novo POST (#14131).`);
          return { kind: "created", result: { id: verdict.id, post_id: verdict.id }, recovered: "page_lookup", attempts: attempt };
        }
        if (verdict.status === "error") {
          return {
            kind: "send_unknown",
            reason:
              `send_unknown: ${lastError} — o post pode ter sido criado e a consulta a /scheduled_posts falhou ` +
              `(${verdict.error}). Conferir a página antes de refazer este post (#14131).`,
            attempts: attempt,
          };
        }
        // absent em todas as leituras: o POST não criou nada, repetir é seguro.
        lastError = `${lastError} (/scheduled_posts sem o post em ${lookupReads} leitura(s))`;
      }

      if (attempt < maxAttempts) await sleep(backoffMs(attempt));
    }
  }
  return { kind: "failed", reason: lastError, attempts: maxAttempts };
}
