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
 *     [--retry]           # habilita retry com backoff exponencial (recomendado)
 *     [--timeout-ms N]    # timeout por tentativa em ms (default: 60000 com --retry, 30000 sem)
 *     [--max-attempts N]  # número máximo de tentativas com --retry (default: 3)
 *
 * Saída: `--out` recebe JSON array de `{ from, to, rule?, explanation? }` —
 * mesmo shape que `mcp__clarice__correct_text` retorna, então o
 * `clarice-apply.ts` consome sem mudança.
 *
 * Exit codes:
 *   0 — sucesso
 *   1 — args inválidos
 *   2 — env CLARICE_API_KEY ausente
 *   3 — HTTP non-2xx da API Clarice (todas as tentativas esgotadas)
 *   4 — I/O (read --in ou write --out)
 */

import "dotenv/config";
import { readFileSync, writeFileSync } from "node:fs";

import type { ClariceSuggestions } from "./lib/schemas/clarice-suggestions.ts";
import { parseClariceSuggestions } from "./lib/schemas/clarice-suggestions.ts";

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
 * Total máximo de espera (excluindo tempo de fetch):
 *   attempts=3, baseBackoffMs=5000 → 0 + 5s + 10s = 15s de espera entre tentativas
 *   + 3 × 60s de timeout = teto de ~3min15s por chamada.
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

export interface CliArgs {
  inPath: string;
  outPath: string;
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
      "Uso: clarice-correct.ts --in <text-file> --out <suggestions-json> [--retry] [--timeout-ms N] [--max-attempts N]",
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

  let suggestions: ClariceSuggestions;

  try {
    if (args.retry) {
      const policy: RetryPolicy = {
        maxAttempts: args.maxAttempts ?? DEFAULT_RETRY_POLICY.maxAttempts,
        timeoutMs: args.timeoutMs ?? DEFAULT_RETRY_POLICY.timeoutMs,
        baseBackoffMs: DEFAULT_RETRY_POLICY.baseBackoffMs,
      };
      const result = await withClariceRetry({ apiKey, text }, policy);
      suggestions = result.suggestions;
      try {
        writeFileSync(args.outPath, JSON.stringify(suggestions, null, 2), "utf8");
      } catch (e) {
        console.error(`erro escrevendo --out: ${(e as Error).message}`);
        process.exit(4);
      }
      console.log(
        JSON.stringify({
          suggestions_count: suggestions.length,
          out: args.outPath,
          attempts_used: result.attempts,
        }),
      );
    } else {
      suggestions = await correctTextViaREST({
        apiKey,
        text,
        timeoutMs: args.timeoutMs,
      });
      try {
        writeFileSync(args.outPath, JSON.stringify(suggestions, null, 2), "utf8");
      } catch (e) {
        console.error(`erro escrevendo --out: ${(e as Error).message}`);
        process.exit(4);
      }
      console.log(
        JSON.stringify({
          suggestions_count: suggestions.length,
          out: args.outPath,
        }),
      );
    }
  } catch (e) {
    console.error(`erro chamando Clarice REST: ${(e as Error).message}`);
    process.exit(3);
  }
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  await main();
}
