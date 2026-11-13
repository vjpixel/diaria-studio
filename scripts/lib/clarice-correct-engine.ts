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

/**
 * #12693 — o próprio timeout do cliente estourou (o `AbortController` de
 * `correctTextViaREST`). Antes o erro chegava como o `AbortError` cru do
 * fetch, "This operation was aborted", sem dizer que foi timeout nem de quanto:
 * no log e no gate parecia um cancelamento sem causa.
 */
export class ClariceTimeoutError extends Error {
  readonly timeoutMs: number;
  constructor(timeoutMs: number, payloadBytes: number) {
    super(
      `a Clarice não respondeu em ${Math.round(timeoutMs / 1000)}s ` +
        `(timeout do cliente, payload ${payloadBytes} bytes)`,
    );
    this.name = "ClariceTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Códigos de erro de certificado do OpenSSL/Node. Com eles a conexão chegou a
 * um servidor, mas a cadeia apresentada não fecha numa raiz confiável — o caso
 * típico é a rede interceptando o HTTPS (Wi-Fi reconectando, portal cativo,
 * antivírus/proxy com inspeção TLS). Repetir em segundos dá o mesmo erro.
 */
const TLS_CERT_ERROR_CODES = new Set([
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "CERT_UNTRUSTED",
  "CERT_SIGNATURE_FAILURE",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

/**
 * #12693 — falha de rede/TLS antes de qualquer resposta HTTP. O fetch do Node
 * lança `TypeError: fetch failed` e esconde o motivo em `cause` (`ENOTFOUND`,
 * `ECONNRESET`, `SELF_SIGNED_CERT_IN_CHAIN`...); aqui o código sobe para a
 * mensagem e para `.code`.
 */
export class ClariceNetworkError extends Error {
  readonly code: string | undefined;
  readonly tls: boolean;
  constructor(code: string | undefined, detail: string) {
    const tls = !!code && TLS_CERT_ERROR_CODES.has(code);
    super(
      `${tls ? "certificado TLS recusado" : "falha de rede"} chamando a Clarice` +
        `${code ? ` (${code})` : ""}: ${detail}`,
    );
    this.name = "ClariceNetworkError";
    this.code = code;
    this.tls = tls;
  }
}

/** Motivo de uma falha da chamada à Clarice, para log, marcador e gate (#12693). */
export interface ClariceFailureReason {
  /** `deadline` = o teto total do clarice-correct.ts (exit 6), não uma tentativa. */
  kind: "timeout" | "tls" | "network" | "http" | "deadline" | "other";
  code?: string;
  status?: number;
  message: string;
}

export function classifyClariceError(e: unknown): ClariceFailureReason {
  const message = e instanceof Error ? e.message : String(e);
  if (e instanceof ClariceTimeoutError) return { kind: "timeout", message };
  if (e instanceof ClariceNetworkError) {
    return { kind: e.tls ? "tls" : "network", ...(e.code ? { code: e.code } : {}), message };
  }
  if (e instanceof ClariceHttpError) return { kind: "http", status: e.status, message };
  return { kind: "other", message };
}

/** Lê o `code` de `cause` (em profundidade, o undici aninha) de um erro do fetch. */
function causeCode(e: unknown): { code?: string; detail?: string } {
  let cur: unknown = (e as { cause?: unknown })?.cause;
  for (let depth = 0; cur && depth < 4; depth++) {
    const c = cur as { code?: unknown; message?: unknown; cause?: unknown };
    if (typeof c.code === "string") {
      return { code: c.code, detail: typeof c.message === "string" ? c.message : undefined };
    }
    cur = c.cause;
  }
  return {};
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
  /**
   * #4952 — número de OUTROS chunks com request em voo no cortex.clarice.ai no
   * momento em que esta tentativa foi disparada (não inclui a própria). Só
   * populado pelo caller chunked (`withClariceRetryChunked`, que enxerga o
   * estado de concorrência do dispatch); `undefined` em chamadas single-chunk
   * diretas de `withClariceRetry`, onde não há noção de "outros chunks".
   * Existe pra permitir correlacionar diretamente no run-log se um timeout
   * coincide com concorrência alta — evidência central do #4952.
   */
  chunksInFlight?: number;
  /**
   * #5082 — `true` quando esta tentativa foi feita pelo fallback de
   * granularidade por-parágrafo (`correctChunkViaParagraphs`/`correctTextViaParagraphs`
   * em `scripts/clarice-correct.ts`), seja como fallback automático de 2º nível
   * (chunk normal esgotou os retries) ou via `--granularity paragraph` forçado.
   * `undefined`/`false` = tentativa normal de chunk (granularidade padrão).
   * Permite filtrar `data/run-log.jsonl` pra medir a frequência do fallback sem
   * ambiguidade com `outcome` (que descreve o resultado HTTP, não o modo).
   */
  viaParagraphFallback?: boolean;
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
 * Detecção estrutural de erro fatal (HTTP 4xx) — não vale a pena retentar nem
 * tentar o fallback por-parágrafo (#5082), porque um 401/403/400 falha da
 * mesma forma independente de quão pequeno for o payload. Preferir `.status`
 * de `ClariceHttpError` a string-matching da mensagem, que falha quando um
 * proxy/wrapper altera o prefixo (#2338 fix 3); fallback ao regex para erros
 * lançados por código externo que não usa `ClariceHttpError`.
 *
 * Extraído do `is4xx` inline de `withClariceRetry` (#5082) pra ser reusado
 * pelo guard de fallback por-parágrafo em `scripts/clarice-correct.ts`, que
 * precisa da MESMA decisão (não adianta sub-dividir um chunk que falhou por
 * causa de auth/bad-request — cada parágrafo repetiria o mesmo erro).
 */
export function isFatalHttpError(e: unknown): boolean {
  if (e instanceof ClariceHttpError) return e.status >= 400 && e.status < 500;
  const message = e instanceof Error ? e.message : "";
  return /^HTTP 4\d\d/.test(message);
}

/**
 * Erro que não adianta repetir nem sub-dividir por parágrafo: HTTP 4xx
 * (`isFatalHttpError`) ou certificado TLS recusado (#12693). Nos logs do MCP
 * da Clarice em 09-10/11/2026 o cert recusado só apareceu na janela de
 * reconexão da rede, segundos depois de voltar o Wi-Fi: as tentativas
 * seguintes do retry (backoff de 5-10s) caem na mesma janela.
 */
export function isFatalClariceError(e: unknown): boolean {
  return isFatalHttpError(e) || (e instanceof ClariceNetworkError && e.tls);
}

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
      // #2852: observabilidade nunca pode mudar o resultado do retry. Sem este
      // guard, um onAttempt que lança aqui derrubaria uma correção BEM-SUCEDIDA
      // pro catch abaixo, descartando o resultado e retentando à toa.
      try {
        opts.onAttempt?.({
          attempt: attempt + 1,
          maxAttempts: policy.maxAttempts,
          elapsedMs: Date.now() - attemptStart,
          payloadBytes,
          outcome: "success",
          suggestionsCount: suggestions.length,
        });
      } catch (callbackError) {
        process.stderr.write(
          `[withClariceRetry] onAttempt (success) lançou: ${(callbackError as Error).message}\n`,
        );
      }
      return { suggestions, attempts: attempt + 1 };
    } catch (e) {
      lastError = e as Error;
      const elapsedMs = Date.now() - attemptStart;
      // HTTP 4xx = não é problema de disponibilidade — não há sentido em retry.
      // Certificado TLS recusado (#12693) idem: a próxima tentativa, segundos
      // depois, encontra a mesma rede.
      const isFatal = isFatalClariceError(e);
      // #2798 — observabilidade por tentativa: registra timeout/5xx/4xx antes de
      // decidir retry vs. fast-fail, pra permitir diagnosticar padrões (ex: timeout
      // consistente em payloads >5k chars) sem depender só do resultado final.
      // #2852: guard contra callback que lança — sem isso, a exceção do callback
      // ESCAPARIA no lugar do erro REAL (lastError), e pularia o `if (isFatal) break`
      // abaixo (o throw interromperia o loop antes de chegar lá).
      try {
        opts.onAttempt?.({
          attempt: attempt + 1,
          maxAttempts: policy.maxAttempts,
          elapsedMs,
          payloadBytes,
          outcome: isFatal ? "fatal_failure" : "retryable_failure",
          status: e instanceof ClariceHttpError ? e.status : undefined,
          errorMessage: lastError.message,
        });
      } catch (callbackError) {
        process.stderr.write(
          `[withClariceRetry] onAttempt (failure) lançou: ${(callbackError as Error).message}\n`,
        );
      }
      if (isFatal) break;
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
  } catch (e) {
    // #12693 — o AbortError do nosso próprio timeout vira erro com o motivo;
    // o `TypeError: fetch failed` ganha o código de `cause` (rede/TLS).
    if (controller.signal.aborted) {
      throw new ClariceTimeoutError(timeoutMs, Buffer.byteLength(opts.text, "utf8"));
    }
    const { code, detail } = causeCode(e);
    if (code) throw new ClariceNetworkError(code, detail ?? (e as Error).message);
    throw e;
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
