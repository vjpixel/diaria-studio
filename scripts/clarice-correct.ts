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
 * #2835: o núcleo REST + retry/backoff (ClariceHttpError, correctTextViaREST,
 * withClariceRetry, etc.) vive em `scripts/lib/clarice-correct-engine.ts` e é
 * reexportado aqui — este arquivo mantém só o chunking (#2626) e a CLI.
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
 *     [--edition AAMMDD]      # (#2798) contexto pra observabilidade em data/run-log.jsonl
 *     [--stage N]             # (#2798) default 2 — só usado se --edition/--retry
 *     [--agent nome]          # (#2798) default "clarice-correct-rest"
 *
 * Observabilidade (#2798): com --retry, cada tentativa (sucesso, retry por
 * timeout/5xx, ou falha fatal por 4xx) é logada em data/run-log.jsonl via
 * scripts/lib/run-log.ts com message "clarice_rest_attempt" e details
 * { attempt, maxAttempts, elapsedMs, payloadBytes, outcome, status?, errorMessage? }.
 * Isso permite diagnosticar padrões como "timeout consistente em payloads >5k
 * chars" (ver #2320, #2798) direto no run-log, sem precisar reproduzir o skip.
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
import {
  splitIntoChunks,
  mergeChunkSuggestions,
  CLARICE_CHUNK_THRESHOLD,
  type TextChunk,
  type ClariceChunkSuggestion,
} from "./lib/clarice-chunk.ts";
import { logEvent } from "./lib/run-log.ts";
import { isMainModule } from "./lib/cli-args.ts";

// #2835 — núcleo REST + retry/backoff extraído pra scripts/lib/clarice-correct-engine.ts
// (movimentação pura). Reexportado abaixo pra preservar os call-sites/imports de teste
// existentes, que importam tudo de "../scripts/clarice-correct.ts".
import {
  ClariceHttpError,
  correctTextViaREST,
  extractSuggestions,
  withClariceRetry,
  backoffDelayMs,
  DEFAULT_RETRY_POLICY,
  type CorrectOptions,
  type AttemptLogEntry,
  type RetryPolicy,
  type RetryResult,
} from "./lib/clarice-correct-engine.ts";

export {
  ClariceHttpError,
  correctTextViaREST,
  extractSuggestions,
  withClariceRetry,
  backoffDelayMs,
  DEFAULT_RETRY_POLICY,
  type CorrectOptions,
  type AttemptLogEntry,
  type RetryPolicy,
  type RetryResult,
};

// ---------------------------------------------------------------------------
// Chunked REST fallback (#2626)
// ---------------------------------------------------------------------------

/**
 * Resultado de `correctTextChunked`.
 *
 * - `correctedText`: texto com sugestões aplicadas chunk-local via `mergeChunkSuggestions`.
 *   Para texto ≤ threshold, equivale a aplicar as sugestões do único chunk ao texto.
 * - `rawSuggestions`: lista plana de TODAS as sugestões brutas coletadas de todos os chunks,
 *   na ordem dos chunks (não necessariamente a ordem de chegada da rede — ver nota de
 *   concorrência em `mapWithConcurrencyLimit`). Compatível com `clarice-apply.ts` e com o
 *   formato de `02-clarice-suggestions.json` (auditoria / resume).
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
 * Teto de concorrência para dispatch de chunks (#2701 item 1 do self-review #2700).
 *
 * O dispatch sequencial original (1 chunk por vez) multiplicava o wall-clock pelo
 * número de chunks (ex: edição de 3 chunks ≈ 3× a latência de 1 request). Concorrência
 * total (`Promise.all` sem teto) foi descartada porque o Clarice REST pode ter
 * rate-limit por-segundo não documentado — uma edição de 5+ chunks disparando tudo de
 * uma vez arriscaria 429s que o `withClariceRetry` trataria como 4xx→fast-fail (sem
 * retry), piorando a confiabilidade em vez de melhorá-la. Teto de 3 é um meio-termo:
 * cobre o caso comum (2-3 chunks) com paralelismo total, e limita o burst para
 * edições excepcionalmente longas.
 */
export const CLARICE_CHUNK_CONCURRENCY = 3;

/**
 * Executa `fn` sobre `items` com um teto de concorrência (#2701 item 1).
 *
 * Preserva a ORDEM do array de retorno (índice de saída = índice de entrada),
 * independente da ordem de conclusão das promises — necessário porque
 * `mergeChunkSuggestions` concatena os chunks corrigidos em ordem para reconstruir
 * o texto original.
 *
 * Fail-fast parcial: se qualquer `fn(item)` rejeitar, a função pára de DISPARAR itens
 * ainda não iniciados e propaga o primeiro erro assim que ele ocorre — sem esperar o
 * restante das chamadas em voo terminarem. As chamadas já em voo continuam executando
 * em segundo plano (não canceladas), mas seus resultados são descartados porque o
 * caller trata qualquer erro como fail-clean (ver JSDoc de `correctTextChunked`) — não
 * há resultado parcial a preservar.
 */
async function mapWithConcurrencyLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  let hasError = false;
  let firstError: unknown;

  async function worker(): Promise<void> {
    for (;;) {
      if (hasError) return;
      const i = nextIndex++;
      if (i >= items.length) return;
      try {
        results[i] = await fn(items[i], i);
      } catch (e) {
        if (!hasError) {
          hasError = true;
          firstError = e;
        }
        return;
      }
    }
  }

  const workerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  if (hasError) throw firstError;
  return results;
}

/**
 * Núcleo compartilhado de `correctTextChunked`/`withClariceRetryChunked` (#2701 item 3
 * do self-review #2700 — antes as duas funções duplicavam o scaffold split → dispatch →
 * acumular → merge; só o `perChunk` por-chunk divergia).
 *
 * Divide `text` em chunks via `splitIntoChunks`, despacha `perChunk` para cada um
 * (com teto de concorrência via `mapWithConcurrencyLimit`), e aplica o merge chunk-local
 * via `mergeChunkSuggestions`. `perChunk` retorna `{ suggestions, extra }` — `extra` é
 * bookkeeping específico do caller (ex.: `attempts` em `withClariceRetryChunked`); este
 * helper não interpreta `extra`, só acumula em ordem de chunk para o caller reduzir.
 *
 * Sem cast: `suggestions` já vem tipado como `ClariceSuggestions` (validado via Zod em
 * `correctTextViaREST`/`extractSuggestions`), que é o mesmo tipo de `ClariceChunkSuggestion`
 * (alias, #2701 item 2) — a atribuição a `mergeChunkSuggestions` não precisa de
 * `as ClariceChunkSuggestion[]`.
 */
async function runChunked<Extra>(
  text: string,
  chunkThreshold: number,
  concurrency: number,
  perChunk: (chunk: TextChunk) => Promise<{ suggestions: ClariceSuggestions; extra: Extra }>,
): Promise<{
  correctedText: string;
  rawSuggestions: ClariceSuggestions;
  chunkCount: number;
  extras: Extra[];
}> {
  const chunks = splitIntoChunks(text, chunkThreshold);

  const perChunkResults = await mapWithConcurrencyLimit(chunks, concurrency, async (chunk) => {
    const { suggestions, extra } = await perChunk(chunk);
    return { chunk, suggestions, extra };
  });

  const chunkSuggestions: Array<{ chunk: TextChunk; suggestions: ClariceChunkSuggestion[] }> =
    perChunkResults.map(({ chunk, suggestions }) => ({ chunk, suggestions }));
  const rawSuggestions: ClariceSuggestions = perChunkResults.flatMap((r) => r.suggestions);
  const mergeResult = mergeChunkSuggestions(chunkSuggestions);

  return {
    correctedText: mergeResult.text,
    rawSuggestions,
    chunkCount: chunks.length,
    extras: perChunkResults.map((r) => r.extra),
  };
}

/**
 * Versão com chunking de `correctTextViaREST` (#2626).
 *
 * Para textos > `chunkThreshold` (default: CLARICE_CHUNK_THRESHOLD = 9.000 chars),
 * divide em fronteiras seguras (seção `---` > parágrafo vazio > fim de linha) via
 * `splitIntoChunks`, faz 1 request REST por chunk (com teto de concorrência —
 * `CLARICE_CHUNK_CONCURRENCY`, #2701 item 1), e usa `mergeChunkSuggestions` para aplicar
 * as sugestões chunk-localmente (sem aritmética de offset).
 *
 * Para textos ≤ threshold, faz 1 request único (sem overhead de chunking/concorrência).
 *
 * Cuidado central do merge: sugestões são aplicadas somente no chunk onde o Clarice
 * as gerou — isso evita replace global ambíguo de termos curtos como `"os"→""` que
 * apareceriam múltiplas vezes no texto completo mas são únicos em um chunk.
 *
 * Falha parcial (fail-clean, por design): os chunks são despachados com teto de
 * concorrência (não mais estritamente sequencial, #2701 item 1). Se um chunk lançar
 * (HTTP non-2xx, rede), a função pára de despachar chunks ainda não iniciados e propaga
 * o erro — NÃO retorna resultado parcial, mesmo que outros chunks já em voo tenham
 * sucesso (seus resultados são descartados). Isso é intencional: um texto parcialmente
 * corrigido (alguns chunks revisados, outros crus) é pior que um fail limpo, porque
 * entraria silenciosamente na newsletter. O caller (main → exit 3) re-roda do zero. Não
 * há checkpoint por chunk (custo de re-enviar 2-3 chunks é baixo).
 *
 * @param opts CorrectOptions com `text`, `apiKey`, `fetchImpl` (para testes), `timeoutMs`
 * @param chunkThreshold Limite de chars por chunk (default: CLARICE_CHUNK_THRESHOLD)
 * @param concurrency Teto de chunks em voo simultaneamente (default: CLARICE_CHUNK_CONCURRENCY)
 */
export async function correctTextChunked(
  opts: CorrectOptions,
  chunkThreshold = CLARICE_CHUNK_THRESHOLD,
  concurrency = CLARICE_CHUNK_CONCURRENCY,
): Promise<ChunkedResult> {
  const result = await runChunked(opts.text, chunkThreshold, concurrency, async (chunk) => {
    const suggestions = await correctTextViaREST({ ...opts, text: chunk.text });
    return { suggestions, extra: undefined };
  });

  return {
    correctedText: result.correctedText,
    rawSuggestions: result.rawSuggestions,
    chunkCount: result.chunkCount,
  };
}

/**
 * Versão com chunking + retry de `withClariceRetry` (#2626).
 *
 * Combina a divisão em chunks de `correctTextChunked` com a política de retry de
 * `withClariceRetry`: cada chunk é enviado com retry independente (backoff exponencial,
 * fast-fail em 4xx), respeitando o mesmo teto de concorrência (`CLARICE_CHUNK_CONCURRENCY`,
 * #2701 item 1). O `totalAttempts` acumula as tentativas de todos os chunks.
 *
 * Para textos ≤ threshold, comporta-se como `withClariceRetry` com 1 chunk.
 *
 * Falha parcial (fail-clean): igual a `correctTextChunked` — se um chunk esgotar os retries
 * e lançar, o erro propaga e o trabalho dos chunks já concluídos é descartado (sem resultado
 * parcial). Ver justificativa no JSDoc de `correctTextChunked`.
 *
 * @param opts CorrectOptions com `text`, `apiKey`, `fetchImpl`, `timeoutMs`
 * @param policy RetryPolicy (default: DEFAULT_RETRY_POLICY)
 * @param sleepFn Injetável para testes (default: setTimeout)
 * @param chunkThreshold Limite de chars por chunk (default: CLARICE_CHUNK_THRESHOLD)
 * @param concurrency Teto de chunks em voo simultaneamente (default: CLARICE_CHUNK_CONCURRENCY)
 */
export async function withClariceRetryChunked(
  opts: CorrectOptions,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
  sleepFn: (ms: number) => Promise<void> = (ms) =>
    new Promise((r) => setTimeout(r, ms)),
  chunkThreshold = CLARICE_CHUNK_THRESHOLD,
  concurrency = CLARICE_CHUNK_CONCURRENCY,
): Promise<ChunkedRetryResult> {
  const result = await runChunked(opts.text, chunkThreshold, concurrency, async (chunk) => {
    const retryResult = await withClariceRetry({ ...opts, text: chunk.text }, policy, sleepFn);
    return { suggestions: retryResult.suggestions, extra: retryResult.attempts };
  });

  const totalAttempts = result.extras.reduce((sum, attempts) => sum + attempts, 0);

  return {
    correctedText: result.correctedText,
    rawSuggestions: result.rawSuggestions,
    chunkCount: result.chunkCount,
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
  /** #2798 — contexto opcional pra observabilidade em data/run-log.jsonl. */
  edition?: string;
  stage?: number;
  agent?: string;
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
    else if (flag === "--edition" && value) { out.edition = value; i++; }
    else if (flag === "--stage" && value) {
      const n = Number(value);
      if (!Number.isInteger(n)) {
        console.error(`--stage deve ser um inteiro (recebido: ${value})`);
        process.exit(1);
      }
      out.stage = n;
      i++;
    }
    else if (flag === "--agent" && value) { out.agent = value; i++; }
  }
  if (!out.inPath || !out.outPath) return null;
  return out as CliArgs;
}

/** Exportado pra testes CLI end-to-end (#2798) — invocado automaticamente no bottom do arquivo. */
export async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  if (!args) {
    console.error(
      "Uso: clarice-correct.ts --in <text-file> --out <suggestions-json> [--corrected-out <corrected-text>] [--retry] [--timeout-ms N] [--max-attempts N] [--edition AAMMDD] [--stage N] [--agent nome]",
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
      // #2798 — loga cada tentativa (sucesso/retry/fatal) em data/run-log.jsonl,
      // pra permitir diagnosticar padrões (ex: timeout consistente em chunks >5k
      // chars) sem depender só do resultado final consolidado.
      const onAttempt = (entry: AttemptLogEntry): void => {
        logEvent({
          edition: args.edition ?? null,
          stage: args.stage ?? 2,
          agent: args.agent ?? "clarice-correct-rest",
          level:
            entry.outcome === "success"
              ? "info"
              : entry.outcome === "fatal_failure"
                ? "error"
                : "warn",
          message: "clarice_rest_attempt",
          details: entry,
        });
      };
      const result = await withClariceRetryChunked(
        { apiKey, text, timeoutMs: args.timeoutMs, onAttempt },
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

if (isMainModule(import.meta.url)) {
  await main();
}
