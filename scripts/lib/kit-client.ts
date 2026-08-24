/**
 * kit-client.ts (#463 — migração Beehiiv → Kit, #461)
 *
 * Camada fina de REST sobre a API v4 do Kit — as operações de LEITURA que
 * `#463` precisa pros 6 consumidores hoje acoplados à Beehiiv
 * (`refresh-dedup.ts`, `refresh-past-editions.ts`, `fetch-monthly-posts.ts`,
 * `collect-edition-signals.ts`, `beehiiv-sync.ts`/cache, agente
 * `beehiiv-clicks-enricher`). Este módulo NÃO migra nenhum desses
 * consumidores ainda — é a fundação que eles vão chamar quando migrarem
 * atrás da flag `platform.newsletter` (hoje `"beehiiv"`, ver
 * `platform.config.json`).
 *
 * ## Por que existe (achado do #6047/#463)
 *
 * O risco de abort original do #463 era "cliques por link podem não existir
 * no Kit" — **refutado ao vivo em 260824**: `GET /v4/broadcasts/{id}/clicks`
 * é REST público (não precisa de MCP, ao contrário da Beehiiv, onde só o
 * agente `beehiiv-clicks-enricher` via MCP expõe isso). `getBroadcastClicks`
 * abaixo é essa chamada.
 *
 * ## Rate limit (achado ao vivo, #6047)
 *
 * Endpoints singulares (`/v4/subscribers`, `/v4/broadcasts`) toleram só
 * dezenas de chamadas sequenciais sem espaçamento antes de 429 — confirmado
 * durante o import de 585 assinantes no #6047 (bateu em ~240 chamadas sem
 * espera). `kitFetch` usa `fetchWithRetry` com `isRetriableStatus` incluindo
 * 429 (além do default `>=500`), o que absorve um blip ISOLADO de 429 via o
 * backoff fixo do `fetchWithRetry` (~1s/3s/9s, 3 tentativas) — **não é um
 * mecanismo geral de recuperação de rate limit**: nada aqui lê `Retry-After`
 * nem garante que a janela de cooldown real do Kit caiba nesse backoff. Um
 * CALLER que itera sobre N broadcasts (1 chamada por post, sem fila) precisa
 * se auto-espaçar (mesmo padrão do import do #6047: ~350ms entre chamadas)
 * — não confiar só no retry deste módulo pra volume alto.
 *
 * ## O que este módulo NÃO faz
 *
 * Não sabe nada sobre o formato de dado da Beehiiv, nem sobre
 * `data/beehiiv-cache/`, nem sobre a lógica de dedup/extração de link — é
 * REST puro devolvendo o shape que a API do Kit devolve. A tradução pro
 * formato que os consumidores esperam é trabalho de cada migração
 * individual (#463 propriamente dito).
 */

import { kitApiBase, resolveKitConfig, type KitConfig } from "./kit-config.ts";
import { fetchWithRetry, type FetchRetryOptions } from "./fetch-retry.ts";

export class KitApiError extends Error {
  constructor(
    public readonly path: string,
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`Kit API ${path} -> ${status}: ${body}`);
    this.name = "KitApiError";
  }
}

/** 429 é retriável aqui além do default (>=500) — ver docstring do módulo
 *  sobre o rate limit dos endpoints singulares confirmado no #6047. */
function isRetriableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * GET/POST/PATCH/DELETE genérico contra a API do Kit — auth via header
 * `X-Kit-Api-Key`, retry com backoff (incluindo 429), parse de JSON. Lança
 * `KitApiError` pra qualquer status não-2xx que sobreviva ao retry, e um
 * `Error` com contexto (path + trecho do body) se o body de uma resposta 2xx
 * não for JSON válido — nunca deixa `JSON.parse` vazar um `SyntaxError` cru
 * sem dizer de qual chamada veio (achado do review do #6074).
 *
 * `config` é injetável (mesmo padrão de `resolveBeehiivConfig`) — pra
 * testes chamarem sem `KIT_API_KEY` real no ambiente. Default: resolve de
 * `process.env` via `resolveKitConfig()`, lançando se ausente (fail-fast —
 * este módulo não tem um modo "degrada silenciosamente sem key").
 *
 * `retry` é injetável (repassado direto pra `fetchWithRetry`) — sobretudo
 * pra testes passarem um `sleep` fake e não pagar o backoff real (~1s+) a
 * cada teste que exercita um caminho de retry, mesmo padrão já usado em
 * `test/fetch-retry.test.ts`. `isRetriableStatus` sempre inclui 429 (ver
 * docstring do módulo) — não é sobrescrevível via `retry`, só os outros
 * campos de `FetchRetryOptions` (`attempts`/`backoffMs`/`sleep`/`timeoutMs`).
 */
export async function kitFetch<T = unknown>(
  path: string,
  opts: {
    method?: string;
    body?: unknown;
    config?: KitConfig;
    retry?: Omit<FetchRetryOptions, "isRetriableStatus">;
  } = {},
): Promise<T> {
  const config = opts.config ?? (() => {
    const resolved = resolveKitConfig();
    if (!resolved.ok) throw new Error(`[kit-client] ${resolved.reason}`);
    return resolved.config;
  })();

  const res = await fetchWithRetry(
    (signal) =>
      fetch(`${kitApiBase()}${path}`, {
        method: opts.method ?? "GET",
        signal,
        headers: {
          "X-Kit-Api-Key": config.apiKey,
          "Content-Type": "application/json",
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      }),
    { ...opts.retry, isRetriableStatus },
  );

  const text = await res.text();
  if (!res.ok) throw new KitApiError(path, res.status, text);
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch (e) {
    throw new Error(
      `[kit-client] resposta 2xx de ${path} não é JSON válido: ${(e as Error).message} (body: ${text.slice(0, 200)})`,
      { cause: e },
    );
  }
}

// ---------------------------------------------------------------------------
// Broadcasts (equivalente a "posts" na Beehiiv)
// ---------------------------------------------------------------------------

export interface KitBroadcastSummary {
  id: number;
  subject: string;
  send_at: string | null;
  status: "draft" | "scheduled" | "sending" | "completed" | "aborted";
  public: boolean;
  published_at: string | null;
  created_at: string;
  preview_text: string | null;
  description: string | null;
  thumbnail_alt: string | null;
  thumbnail_url: string | null;
  publication_id: number;
}

export interface KitPagination {
  has_previous_page: boolean;
  has_next_page: boolean;
  start_cursor: string | null;
  end_cursor: string | null;
  per_page: number;
}

export interface ListBroadcastsOptions {
  status?: KitBroadcastSummary["status"];
  perPage?: number;
  after?: string;
  includeContent?: boolean;
  config?: KitConfig;
}

export async function listBroadcasts(
  opts: ListBroadcastsOptions = {},
): Promise<{ broadcasts: KitBroadcastSummary[]; pagination: KitPagination }> {
  const params = new URLSearchParams();
  if (opts.status) params.set("status", opts.status);
  if (opts.perPage) params.set("per_page", String(opts.perPage));
  if (opts.after) params.set("after", opts.after);
  if (opts.includeContent) params.set("include[]", "content");
  const qs = params.toString();
  return kitFetch(`/broadcasts${qs ? `?${qs}` : ""}`, { config: opts.config });
}

export interface KitBroadcastDetail extends KitBroadcastSummary {
  content: string | null;
  public_url: string;
  email_address: string;
  email_template: { id: number; name: string };
}

export async function getBroadcast(id: number, config?: KitConfig): Promise<KitBroadcastDetail> {
  const data = await kitFetch<{ broadcast: KitBroadcastDetail } | undefined>(`/broadcasts/${id}`, { config });
  if (!data?.broadcast) {
    throw new Error(`[kit-client] getBroadcast(${id}): resposta 2xx sem o envelope "broadcast" esperado`);
  }
  return data.broadcast;
}

// ---------------------------------------------------------------------------
// Cliques por link — o achado que destrava o #463 (ver docstring do módulo)
// ---------------------------------------------------------------------------

/** Campo `url`/`unique_clicks`/`click_to_delivery_rate`/`click_to_open_rate`
 *  ainda não verificados com um clique real (a conta não tem nenhum
 *  broadcast enviado — só o shape do envelope `{broadcast: {id, clicks}}`
 *  foi confirmado ao vivo em 260824, com `clicks: []`). Reverificar os
 *  nomes de campo do item quando o 1º clique real existir. */
export interface KitBroadcastClick {
  url: string;
  unique_clicks: number;
  click_to_delivery_rate: number;
  click_to_open_rate: number;
}

export async function getBroadcastClicks(
  id: number,
  opts: { perPage?: number; after?: string; config?: KitConfig } = {},
): Promise<{ clicks: KitBroadcastClick[]; pagination: KitPagination }> {
  const params = new URLSearchParams();
  if (opts.perPage) params.set("per_page", String(opts.perPage));
  if (opts.after) params.set("after", opts.after);
  const qs = params.toString();
  const data = await kitFetch<
    { broadcast: { id: number; clicks: KitBroadcastClick[] }; pagination: KitPagination } | undefined
  >(`/broadcasts/${id}/clicks${qs ? `?${qs}` : ""}`, { config: opts.config });
  if (!data?.broadcast) {
    throw new Error(`[kit-client] getBroadcastClicks(${id}): resposta 2xx sem o envelope "broadcast" esperado`);
  }
  return { clicks: data.broadcast.clicks, pagination: data.pagination };
}

// ---------------------------------------------------------------------------
// Stats (abertura, CTR) — equivalente a collect-edition-signals.ts
// ---------------------------------------------------------------------------

/** Shape confirmado ao vivo em 260824 contra um draft real (`{recipients:
 *  585, open_rate: 0, ...}` — 585 é o total da conta pro draft, não um
 *  envio real ainda). `click_rate` aqui é a mesma armadilha click-to-open
 *  documentada em `scripts/lib/leitor.ts` pra Beehiiv — reverificar contra
 *  `emails_opened`/`recipients` quando houver envio real antes de usar como
 *  CTR sobre entregas. */
export interface KitBroadcastStats {
  recipients: number;
  open_rate: number;
  emails_opened: number;
  click_rate: number;
  unsubscribe_rate: number;
  unsubscribes: number;
  total_clicks: number;
  show_total_clicks: boolean;
  status: string;
  progress: number;
  open_tracking_disabled: boolean;
  click_tracking_disabled: boolean;
}

export async function getBroadcastStats(id: number, config?: KitConfig): Promise<KitBroadcastStats> {
  const data = await kitFetch<{ broadcast: { id: number; stats: KitBroadcastStats } } | undefined>(
    `/broadcasts/${id}/stats`,
    { config },
  );
  if (!data?.broadcast?.stats) {
    throw new Error(`[kit-client] getBroadcastStats(${id}): resposta 2xx sem o envelope "broadcast.stats" esperado`);
  }
  return data.broadcast.stats;
}
