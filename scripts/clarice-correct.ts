/**
 * clarice-correct.ts (#1329) — fallback REST direto pro Clarice cortex API.
 *
 * Existe pra quando o MCP `mcp__clarice__correct_text` está offline e a
 * pipeline precisa continuar sem halt. Caminho normal continua sendo MCP
 * (top-level Claude faz a chamada inline em Stage 2 §3b). Este script vira
 * fallback automático quando o MCP retorna erro/disconnect.
 *
 * Pareado com `scripts/clarice-healthcheck.ts` que roda no Stage 0 pra
 * forewarn antes de chegar no Stage 2.
 *
 * Endpoint: POST https://cortex.clarice.ai/api-correction
 * Header:  X-API-Key: $CLARICE_API_KEY
 * Body:    { paragraphs: [{ description: <text>, offset: 0 }] }
 *
 * Uso (CLI):
 *   npx tsx scripts/clarice-correct.ts \
 *     --in data/editions/{AAMMDD}/_internal/02-humanized.md \
 *     --out data/editions/{AAMMDD}/_internal/02-clarice-suggestions.json
 *     [--corrected-out path]  # (opcional) grava o texto corrigido (pós-apply chunk-local)
 *     [--retry]               # habilita retry com backoff exponencial (recomendado)
 *     [--timeout-ms N]        # timeout por tentativa em ms (default: 60000 com --retry, 30000 sem)
 *     [--max-attempts N]      # número máximo de tentativas com --retry (default: 3)
 *
 * Saída:
 *   --out: JSON array de `{ from, to, rule?, explanation? }` — lista plana de todas as
 *     sugestões brutas coletadas de todos os chunks (auditoria / diff / resume).
 *     ⚠️ NÃO re-aplicar esta lista ao texto completo via clarice-apply.ts quando houver
 *     >1 chunk: uma âncora `from` única DENTRO de um chunk pode aparecer 2+× no texto
 *     inteiro, e clarice-apply.ts a pularia como "ambígua" (count≠1) — sub-corrigindo
 *     silenciosamente vs. o resultado chunk-local. A compat com clarice-apply.ts só vale
 *     para texto de 1 chunk (≤ CLARICE_CHUNK_THRESHOLD = 9k chars). Para textos maiores,
 *     o resultado correto é o de --corrected-out (mergeChunkSuggestions, apply chunk-local).
 *   --corrected-out: texto corrigido produzido pelo mergeChunkSuggestions (apply chunk-local).
 *     É a ÚNICA saída que aplica todas as sugestões corretamente para textos multi-chunk —
 *     o consumidor (orchestrator / SKILL) deve usá-lo diretamente em vez de re-aplicar --out.
 *
 * Exit codes:
 *   0 — sucesso
 *   1 — args inválidos
 *   2 — env CLARICE_API_KEY ausente
 *   3 — HTTP non-2xx da API Clarice (todas as tentativas esgotadas)
 *   4 — I/O (read --in ou write --out/--corrected-out)
 */

import "dotenv/config";
import { readFileSync, writeFileSync } from "node:fs";

import type { ClariceSuggestions } from "./lib/schemas/clarice-suggestions.ts";
import { parseClariceSuggestions } from "./lib/schemas/clarice-suggestions.ts";
import {
  splitIntoChunks,
  mergeChunkSuggestions,
  CLARICE_CHUNK_THRESHOLD,
  type TextChunk,
  type ClariceChunkSuggestion,
} from "./lib/clarice-chunk.ts";

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
 * ⚠️ Em `withClariceRetryChunked` (#2626) o timeout é POR CHUNK, não total: um texto que
 * divide em N chunks tem teto ~N × 3min15s. Ex: edição de 25k chars → ~3 chunks → ~9min45s.
 * `--timeout-ms` também é por-tentativa-por-chunk. Quem roda em ambiente com wall-clock
 * apertado (CI) deve dimensionar o limite considerando o chunkCount esperado.
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
  for (let attempt = 0; attempt < policy.maxAttempts; attempt++) {
    const delay = backoffDelayMs(attempt, policy.baseBackoffMs);
    if (delay > 0) await sleepFn(delay);
    try {
      const suggestions = await correctTextViaREST({
        ...opts,
        timeoutMs: opts.timeoutMs ?? policy.timeoutMs,
      });
      return { suggestions, attempts: attempt + 1 };
    } catch (e) {
      lastError = e as Error;
      // HTTP 4xx = não é problema de disponibilidade — não há sentido em retry.
      // Detecção estrutural: ClariceHttpError carrega .status — preferir isso a
      // string-matching da mensagem, que falha quando proxy/wrapper altera o prefixo
      // (#2338 fix 3). Fallback ao regex para erros lançados por código externo.
      const is4xx =
        (e instanceof ClariceHttpError && e.status >= 400 && e.status < 500) ||
        /^HTTP 4\d\d/.test(lastError.message ?? "");
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

// ---------------------------------------------------------------------------
// Chunked REST fallback (#2626)
// ---------------------------------------------------------------------------

/**
 * Resultado de `correctTextChunked`.
 *
 * - `correctedText`: texto com sugestões aplicadas chunk-local via `mergeChunkSuggestions`.
 *   Para texto ≤ threshold, equivale a aplicar as sugestões do único chunk ao texto.
 * - `rawSuggestions`: lista plana de TODAS as sugestões brutas coletadas de todos os chunks,
 *   na ordem de chegada. Compatível com `clarice-apply.ts` e com o formato de
 *   `02-clarice-suggestions.json` (auditoria / resume).
 * - `chunkCount`: número de chunks processados (1 = texto ≤ threshold, sem split).
 */
export interface ChunkedResult {
  correctedText: string;
  rawSuggestions: ClariceSuggestions;
  chunkCount: number;
}

/**
 * Resultado de `withClariceRetryChunked`.
 */
export interface ChunkedRetryResult extends ChunkedResult {
  /** Total de tentativas somadas de todos os chunks (cada chunk pode ter ≥1 tentativa). */
  totalAttempts: number;
}

/**
 * Versão com chunking de `correctTextViaREST` (#2626).
 *
 * Para textos > `chunkThreshold` (default: CLARICE_CHUNK_THRESHOLD = 9.000 chars),
 * divide em fronteiras seguras (seção `---` > parágrafo vazio > fim de linha) via
 * `splitIntoChunks`, faz 1 request REST por chunk, e usa `mergeChunkSuggestions`
 * para aplicar as sugestões chunk-localmente (sem aritmética de offset).
 *
 * Para textos ≤ threshold, faz 1 request único (sem overhead de chunking).
 *
 * Cuidado central do merge: sugestões são aplicadas somente no chunk onde o Clarice
 * as gerou — isso evita replace global ambíguo de termos curtos como `"os"→""` que
 * apareceriam múltiplas vezes no texto completo mas são únicos em um chunk.
 *
 * Falha parcial (fail-clean, por design): os chunks são processados em sequência. Se um
 * chunk lançar (HTTP non-2xx, rede), a função propaga o erro e NÃO retorna resultado
 * parcial — as sugestões dos chunks já processados são descartadas. Isso é intencional:
 * um texto parcialmente corrigido (alguns chunks revisados, outros crus) é pior que um
 * fail limpo, porque entraria silenciosamente na newsletter. O caller (main → exit 3)
 * re-roda do zero. Não há checkpoint por chunk (custo de re-enviar 2-3 chunks é baixo).
 *
 * @param opts CorrectOptions com `text`, `apiKey`, `fetchImpl` (para testes), `timeoutMs`
 * @param chunkThreshold Limite de chars por chunk (default: CLARICE_CHUNK_THRESHOLD)
 */
export async function correctTextChunked(
  opts: CorrectOptions,
  chunkThreshold = CLARICE_CHUNK_THRESHOLD,
): Promise<ChunkedResult> {
  const chunks = splitIntoChunks(opts.text, chunkThreshold);
  const chunkSuggestions: Array<{ chunk: TextChunk; suggestions: ClariceChunkSuggestion[] }> = [];
  const rawSuggestions: ClariceSuggestions = [];

  for (const chunk of chunks) {
    const suggestions = await correctTextViaREST({ ...opts, text: chunk.text });
    chunkSuggestions.push({ chunk, suggestions: suggestions as ClariceChunkSuggestion[] });
    rawSuggestions.push(...suggestions);
  }

  const mergeResult = mergeChunkSuggestions(chunkSuggestions);

  return {
    correctedText: mergeResult.text,
    rawSuggestions,
    chunkCount: chunks.length,
  };
}

/**
 * Versão com chunking + retry de `withClariceRetry` (#2626).
 *
 * Combina a divisão em chunks de `correctTextChunked` com a política de retry de
 * `withClariceRetry`: cada chunk é enviado com retry independente (backoff exponencial,
 * fast-fail em 4xx). O `totalAttempts` acumula as tentativas de todos os chunks.
 *
 * Para textos ≤ threshold, comporta-se como `withClariceRetry` com 1 chunk.
 *
 * Falha parcial (fail-clean): igual a `correctTextChunked` — se um chunk esgotar os retries
 * e lançar, o erro propaga e o trabalho dos chunks anteriores é descartado (sem resultado
 * parcial). Ver justificativa no JSDoc de `correctTextChunked`.
 *
 * @param opts CorrectOptions com `text`, `apiKey`, `fetchImpl`, `timeoutMs`
 * @param policy RetryPolicy (default: DEFAULT_RETRY_POLICY)
 * @param sleepFn Injetável para testes (default: setTimeout)
 * @param chunkThreshold Limite de chars por chunk (default: CLARICE_CHUNK_THRESHOLD)
 */
export async function withClariceRetryChunked(
  opts: CorrectOptions,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
  sleepFn: (ms: number) => Promise<void> = (ms) =>
    new Promise((r) => setTimeout(r, ms)),
  chunkThreshold = CLARICE_CHUNK_THRESHOLD,
): Promise<ChunkedRetryResult> {
  const chunks = splitIntoChunks(opts.text, chunkThreshold);
  const chunkSuggestions: Array<{ chunk: TextChunk; suggestions: ClariceChunkSuggestion[] }> = [];
  const rawSuggestions: ClariceSuggestions = [];
  let totalAttempts = 0;

  for (const chunk of chunks) {
    const result = await withClariceRetry(
      { ...opts, text: chunk.text },
      policy,
      sleepFn,
    );
    chunkSuggestions.push({ chunk, suggestions: result.suggestions as ClariceChunkSuggestion[] });
    rawSuggestions.push(...result.suggestions);
    totalAttempts += result.attempts;
  }

  const mergeResult = mergeChunkSuggestions(chunkSuggestions);

  return {
    correctedText: mergeResult.text,
    rawSuggestions,
    chunkCount: chunks.length,
    totalAttempts,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export interface CliArgs {
  inPath: string;
  outPath: string;
  /** Caminho opcional para gravar o texto corrigido (pós-apply chunk-local). */
  correctedOutPath?: string;
  retry: boolean;
  timeoutMs?: number;
  maxAttempts?: number;
}

export function parseCliArgs(argv: string[]): CliArgs | null {
  const out: Partial<CliArgs> = { retry: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    // Guard: only treat the next token as a value if it is not itself a --flag.
    // Without this guard, `--max-attempts --retry` would consume "--retry" as
    // the integer value of --max-attempts (argv-consumption bug, finding #8).
    const value = argv[i + 1]?.startsWith("--") ? undefined : argv[i + 1];
    if (flag === "--in" && value) { out.inPath = value; i++; }
    else if (flag === "--out" && value) { out.outPath = value; i++; }
    else if (flag === "--corrected-out" && value) { out.correctedOutPath = value; i++; }
    else if (flag === "--retry") { out.retry = true; }
    else if (flag === "--timeout-ms" && value) {
      const n = Number(value);
      if (!Number.isFinite(n) || n <= 0) {
        console.error(`--timeout-ms deve ser um número positivo (recebido: ${value})`);
        process.exit(1);
      }
      out.timeoutMs = n;
      i++;
    }
    else if (flag === "--max-attempts" && value) {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1) {
        console.error(`--max-attempts deve ser um inteiro positivo (recebido: ${value})`);
        process.exit(1);
      }
      out.maxAttempts = n;
      i++;
    }
  }
  if (!out.inPath || !out.outPath) return null;
  return out as CliArgs;
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  if (!args) {
    console.error(
      "Uso: clarice-correct.ts --in <text-file> --out <suggestions-json> [--corrected-out <corrected-text>] [--retry] [--timeout-ms N] [--max-attempts N]",
    );
    process.exit(1);
  }
  const apiKey = process.env.CLARICE_API_KEY;
  if (!apiKey) {
    console.error("CLARICE_API_KEY ausente no env");
    process.exit(2);
  }

  let text: string;
  try {
    text = readFileSync(args.inPath, "utf8");
  } catch (e) {
    console.error(`erro lendo --in: ${(e as Error).message}`);
    process.exit(4);
  }

  let rawSuggestions: ClariceSuggestions;
  let correctedText: string;
  let logExtra: Record<string, unknown> = {};

  try {
    if (args.retry) {
      const policy: RetryPolicy = {
        maxAttempts: args.maxAttempts ?? DEFAULT_RETRY_POLICY.maxAttempts,
        timeoutMs: args.timeoutMs ?? DEFAULT_RETRY_POLICY.timeoutMs,
        baseBackoffMs: DEFAULT_RETRY_POLICY.baseBackoffMs,
      };
      const result = await withClariceRetryChunked(
        { apiKey, text, timeoutMs: args.timeoutMs },
        policy,
      );
      rawSuggestions = result.rawSuggestions;
      correctedText = result.correctedText;
      logExtra = { attempts_used: result.totalAttempts, chunks: result.chunkCount };
    } else {
      const result = await correctTextChunked({
        apiKey,
        text,
        timeoutMs: args.timeoutMs,
      });
      rawSuggestions = result.rawSuggestions;
      correctedText = result.correctedText;
      logExtra = { chunks: result.chunkCount };
    }
  } catch (e) {
    console.error(`erro chamando Clarice REST: ${(e as Error).message}`);
    process.exit(3);
  }

  try {
    writeFileSync(args.outPath, JSON.stringify(rawSuggestions, null, 2), "utf8");
  } catch (e) {
    console.error(`erro escrevendo --out: ${(e as Error).message}`);
    process.exit(4);
  }

  if (args.correctedOutPath) {
    try {
      writeFileSync(args.correctedOutPath, correctedText, "utf8");
    } catch (e) {
      console.error(`erro escrevendo --corrected-out: ${(e as Error).message}`);
      process.exit(4);
    }
  }

  console.log(
    JSON.stringify({
      suggestions_count: rawSuggestions.length,
      out: args.outPath,
      ...(args.correctedOutPath ? { corrected_out: args.correctedOutPath } : {}),
      ...logExtra,
    }),
  );
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  await main();
}
