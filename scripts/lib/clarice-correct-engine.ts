/**
 * clarice-correct-engine.ts (#2835) — núcleo REST + retry/backoff do fallback
 * Clarice, extraído de `scripts/clarice-correct.ts` (movimentação pura, sem
 * mudança de comportamento — #2835/#2808).
 *
 * Contém: chamada HTTP direta ao cortex Clarice (`correctTextViaREST`),
 * parsing/achatamento da resposta (`extractSuggestions`), e a política de
 * retry com backoff exponencial (`withClariceRetry`). O chunking (#2626) e a
 * CLI continuam em `scripts/clarice-correct.ts`, que reexporta tudo daqui
 * para preservar os call-sites e imports de teste existentes.
 *
 * Endpoint: POST https://cortex.clarice.ai/api-correction
 * Header:  X-API-Key: $CLARICE_API_KEY
 * Body:    { paragraphs: [{ description: <text>, offset: 0 }] }
 */

import type { ClariceSuggestions } from "./schemas/clarice-suggestions.ts";
import { parseClariceSuggestions } from "./schemas/clarice-suggestions.ts";

const CLARICE_ENDPOINT = "https://cortex.clarice.ai/api-correction";

/**
 * Erro estruturado lançado por `correctTextViaREST` em respostas HTTP não-2xx.
 * Carrega o `.status` numérico para que `withClariceRetry` possa detectar 4xx
 * de forma estrutural (sem string-matching da mensagem), resistindo a proxies
 * ou wrappers que alteram o prefixo da mensagem (#2338 fix 3).
 */
export class ClariceHttpError extends Error {
  readonly status: number;
  constructor(status: number, body: string) {
    super(`HTTP ${status}: ${body}`);
    this.name = "ClariceHttpError";
    this.status = status;
  }
}

export interface CorrectOptions {
  apiKey: string;
  text: string;
  /** Opcional — injeta fetch pra testes. Default = global fetch. */
  fetchImpl?: typeof fetch;
  /** Timeout em ms por tentativa — default 30s (60s quando via withClariceRetry). */
  timeoutMs?: number;
  /**
   * Observabilidade por tentativa (#2798) — callback opcional invocado após CADA
   * tentativa (sucesso ou falha) dentro de `withClariceRetry`. Sem callback,
   * nenhum I/O extra acontece (no-op por padrão) — isso mantém `withClariceRetry`
   * puro de efeito colateral em testes que não passam `onAttempt`, evitando
   * poluir `data/run-log.jsonl` real durante `npm test`. O caller CLI (`main`)
   * conecta este callback a `logEvent` (scripts/lib/run-log.ts).
   */
  onAttempt?: (entry: AttemptLogEntry) => void;
}

/**
 * Payload de uma tentativa individual do REST fallback, repassado ao callback
 * `onAttempt` (#2798). Pensado para virar `details` de um evento em
 * `data/run-log.jsonl` sem transformação adicional.
 */
export interface AttemptLogEntry {
  /** 1-indexed — primeira tentativa = 1. */
  attempt: number;
  maxAttempts: number;
  elapsedMs: number;
  payloadBytes: number;
  outcome: "success" | "retryable_failure" | "fatal_failure";
  suggestionsCount?: number;
  /** HTTP status quando disponível (ClariceHttpError). */
  status?: number;
  errorMessage?: string;
}

/**
 * Política de retry do Clarice REST (#2320).
 *
 * Por padrão: 3 tentativas, 60s timeout cada, backoff exponencial.
 * Backoff[i] = baseBackoffMs * 2^(i-1) pra tentativa i ≥ 2 (0ms na 1ª).
 *
 * Total máximo de espera POR CHUNK (excluindo tempo de fetch):
 *   attempts=3, baseBackoffMs=5000 → 0 + 5s + 10s = 15s de espera entre tentativas
 *   + 3 × 60s de timeout = teto de ~3min15s por chunk.
 *
 * ⚠️ Em `withClariceRetryChunked` (#2626) o timeout é POR CHUNK, não total: o teto no
 * PIOR CASO (todos os chunks precisando do máximo de tentativas) é ~⌈N / CLARICE_CHUNK_CONCURRENCY⌉
 * × 3min15s, já que os chunks são despachados com teto de concorrência (#2701 item 1),
 * não mais estritamente em série. Ex: edição de 25k chars → ~3 chunks → com concorrência
 * 3, os 3 cabem numa única "onda" → teto ~3min15s (não ~9min45s como seria sequencial).
 * `--timeout-ms` também é por-tentativa-por-chunk. Quem roda em ambiente com wall-clock
 * apertado (CI) deve dimensionar o limite considerando ⌈chunkCount / concurrency⌉.
 *
 * Exporta interface + factory para testabilidade: tests injetam `baseBackoffMs=0`
 * para não ter sleep real nos testes.
 */
export interface RetryPolicy {
  /** Número máximo de tentativas (inclui a primeira). Default: 3. */
  maxAttempts: number;
  /** Timeout por tentativa em ms. Default: 60000. */
  timeoutMs: number;
  /** Backoff base em ms (dobra por tentativa adicional). Default: 5000. */
  baseBackoffMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  timeoutMs: 60_000,
  baseBackoffMs: 5_000,
};

/**
 * Calcula o delay de backoff para tentativa `attempt` (0-indexed).
 * Tentativa 0 = 0ms (sem espera). Tentativa 1+ = baseBackoffMs × 2^(attempt-1).
 */
export function backoffDelayMs(attempt: number, baseBackoffMs: number): number {
  if (attempt === 0) return 0;
  return baseBackoffMs * Math.pow(2, attempt - 1);
}

export interface RetryResult {
  suggestions: ClariceSuggestions;
  /** Número de tentativas usadas (1 = sucesso na primeira). */
  attempts: number;
}

/**
 * Chama `correctTextViaREST` com retry + backoff exponencial.
 *
 * Em erros de rede/timeout (AbortError, TypeError de network) OU em HTTP 5xx
 * (server-side lento), tenta novamente até `policy.maxAttempts` vezes com delay
 * crescente entre tentativas. Em HTTP 4xx (auth, bad request), falha imediatamente
 * sem retry (retryable=false).
 *
 * O orchestrator ainda pode decidir fazer um skip consciente após este helper
 * retornar erro — este helper apenas aumenta a resiliência da tentativa REST.
 */
export async function withClariceRetry(
  opts: CorrectOptions,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
  sleepFn: (ms: number) => Promise<void> = (ms) =>
    new Promise((r) => setTimeout(r, ms)),
): Promise<RetryResult> {
  let lastError: Error | undefined;
  const payloadBytes = Buffer.byteLength(opts.text, "utf8");
  for (let attempt = 0; attempt < policy.maxAttempts; attempt++) {
    const delay = backoffDelayMs(attempt, policy.baseBackoffMs);
    if (delay > 0) await sleepFn(delay);
    const attemptStart = Date.now();
    try {
      const suggestions = await correctTextViaREST({
        ...opts,
        timeoutMs: opts.timeoutMs ?? policy.timeoutMs,
      });
      opts.onAttempt?.({
        attempt: attempt + 1,
        maxAttempts: policy.maxAttempts,
        elapsedMs: Date.now() - attemptStart,
        payloadBytes,
        outcome: "success",
        suggestionsCount: suggestions.length,
      });
      return { suggestions, attempts: attempt + 1 };
    } catch (e) {
      lastError = e as Error;
      const elapsedMs = Date.now() - attemptStart;
      // HTTP 4xx = não é problema de disponibilidade — não há sentido em retry.
      // Detecção estrutural: ClariceHttpError carrega .status — preferir isso a
      // string-matching da mensagem, que falha quando proxy/wrapper altera o prefixo
      // (#2338 fix 3). Fallback ao regex para erros lançados por código externo.
      const is4xx =
        (e instanceof ClariceHttpError && e.status >= 400 && e.status < 500) ||
        /^HTTP 4\d\d/.test(lastError.message ?? "");
      // #2798 — observabilidade por tentativa: registra timeout/5xx/4xx antes de
      // decidir retry vs. fast-fail, pra permitir diagnosticar padrões (ex: timeout
      // consistente em payloads >5k chars) sem depender só do resultado final.
      opts.onAttempt?.({
        attempt: attempt + 1,
        maxAttempts: policy.maxAttempts,
        elapsedMs,
        payloadBytes,
        outcome: is4xx ? "fatal_failure" : "retryable_failure",
        status: e instanceof ClariceHttpError ? e.status : undefined,
        errorMessage: lastError.message,
      });
      if (is4xx) break;
      // Timeout (AbortError) e erros de rede (TypeError: fetch failed) → retry.
      // HTTP 5xx → retry.
    }
  }
  throw lastError ?? new Error("clarice REST: todas as tentativas falharam");
}

/**
 * Chama REST API Clarice. Retorna lista de sugestões já parseada/validada
 * via Zod schema (`ClariceSuggestionsSchema`).
 *
 * Throws:
 *   - Error("HTTP {status}: {body}") em non-2xx
 *   - Error("invalid response shape: ...") se o JSON não bate com schema
 */
export async function correctTextViaREST(
  opts: CorrectOptions,
): Promise<ClariceSuggestions> {
  const fetchFn = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetchFn(CLARICE_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "X-API-Key": opts.apiKey,
      },
      body: JSON.stringify({
        paragraphs: [{ description: opts.text, offset: 0 }],
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    const bodyText = await res.text().catch(() => "<unreadable>");
    // Throw ClariceHttpError (carries .status) so withClariceRetry can detect
    // 4xx structurally instead of string-matching the message (#2338 fix 3).
    throw new ClariceHttpError(res.status, bodyText.slice(0, 500));
  }

  const raw = await res.json() as unknown;
  return extractSuggestions(raw);
}

/**
 * O endpoint pode envelopar a resposta de jeitos diferentes (paragraphs[].suggestions[],
 * results[], top-level array). Tenta achatar pra um array uniforme que valida
 * via ClariceSuggestionsSchema.
 *
 * Exporta pra teste — caller normal usa `correctTextViaREST`.
 */
export function extractSuggestions(raw: unknown): ClariceSuggestions {
  const flat = flatten(raw);
  return parseClariceSuggestions(flat);
}

function flatten(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    if (Array.isArray(obj.suggestions)) return obj.suggestions;
    if (Array.isArray(obj.paragraphs)) {
      return (obj.paragraphs as Array<Record<string, unknown>>).flatMap((p) =>
        Array.isArray(p?.suggestions) ? p.suggestions as unknown[] : [],
      );
    }
    if (Array.isArray(obj.results)) return obj.results;
  }
  return [];
}
