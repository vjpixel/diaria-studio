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
 *     [--granularity paragraph]      # (#5082) força granularidade máxima desde o início —
 *                                     bypassa o chunking normal, 1 request por parágrafo
 *                                     substantivo, sem retry, timeout curto. Ignora --retry.
 *     [--no-paragraph-fallback]      # (#5082) desliga o fallback automático de 2º nível
 *                                     (default: habilitado em granularity=default)
 *     [--paragraph-timeout-ms N]     # (#5082) timeout por request no fallback/granularity=paragraph
 *                                     (default: PARAGRAPH_FALLBACK_TIMEOUT_MS = 20000)
 *
 * Observabilidade (#2798, campo chunksInFlight adicionado em #4952): com
 * --retry, cada tentativa (sucesso, retry por timeout/5xx, ou falha fatal por
 * 4xx) é logada em data/run-log.jsonl via scripts/lib/run-log.ts com message
 * "clarice_rest_attempt" e details { attempt, maxAttempts, elapsedMs,
 * payloadBytes, outcome, status?, errorMessage?, chunksInFlight?, viaParagraphFallback? }.
 * `chunksInFlight` (só presente em chamadas chunked) é o número de OUTROS
 * chunks com request em voo no cortex.clarice.ai no momento desta tentativa —
 * permite correlacionar timeout com concorrência alta direto no run-log (#4952:
 * refutou o diagnóstico anterior de "timeout consistente em payloads >5k chars",
 * #2320/#2798 — a causa real era concorrência de dispatch, não tamanho).
 * `viaParagraphFallback: true` (#5082) marca tentativas feitas pelo fallback
 * por-parágrafo (2º nível automático OU --granularity paragraph forçado) —
 * filtrar por esse campo mede a frequência do fallback sem ambiguidade com
 * `outcome` (que descreve o resultado HTTP, não o modo de granularidade).
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
 *   5 — guard de staleness do --corrected-out (#5755): o arquivo escrito
 *       tem mtime ANTERIOR ao início desta chamada — sinal de que o write
 *       não refletiu esta execução (ex: no-op silencioso do fallback REST
 *       em background já observado ao vivo, #5755). Nunca confiar no
 *       conteúdo nesse caso — ver `checkCorrectedOutFreshness` abaixo.
 */

import "dotenv/config";
import { readFileSync, writeFileSync } from "node:fs";

import type { ClariceSuggestions } from "./lib/schemas/clarice-suggestions.ts";
import {
  splitIntoChunks,
  splitIntoParagraphs,
  isSubstantiveParagraph,
  applyChunkSuggestions,
  mergeChunkSuggestions,
  CLARICE_CHUNK_THRESHOLD,
  type TextChunk,
  type ClariceChunkSuggestion,
} from "./lib/clarice-chunk.ts";
import { logEvent } from "./lib/run-log.ts";
import { isMainModule } from "./lib/cli-args.ts";
import { mtimeMs } from "./lib/mtime.ts";

// #2835 — núcleo REST + retry/backoff extraído pra scripts/lib/clarice-correct-engine.ts
// (movimentação pura). Reexportado abaixo pra preservar os call-sites/imports de teste
// existentes, que importam tudo de "../scripts/clarice-correct.ts".
import {
  ClariceHttpError,
  correctTextViaREST,
  extractSuggestions,
  withClariceRetry,
  backoffDelayMs,
  isFatalHttpError,
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
  isFatalHttpError,
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
  /**
   * #5082 — número de chunks que esgotaram os retries normais e caíram no
   * fallback de 2º nível por-parágrafo. 0 = fallback nunca acionado nesta
   * chamada (caminho feliz). Útil pra medir a frequência do fallback sem
   * precisar grepar `data/run-log.jsonl` (`viaParagraphFallback: true`).
   */
  usedParagraphFallbackChunks: number;
  /**
   * #5082 — stats de cada chunk que usou o fallback (1 entrada por chunk que
   * caiu no fallback, na ordem em que os chunks completaram). `[]` quando
   * `usedParagraphFallbackChunks === 0`.
   */
  paragraphFallbackStats: ParagraphFallbackStats[];
}

/**
 * Resolve o teto de concorrência do dispatch de chunks (#4952), lido do env
 * `CLARICE_CHUNK_CONCURRENCY` — inteiro positivo válido honra o override;
 * ausente ou inválido (0, negativo, decimal, não-numérico) cai no default 1.
 *
 * Exportada (não só interna) pra permitir teste de regressão direto sem
 * precisar de módulo cache-busting — `CLARICE_CHUNK_CONCURRENCY` abaixo é
 * resolvida uma vez no module-load, então testar o default/override exige
 * chamar esta função pura isoladamente com `process.env.CLARICE_CHUNK_CONCURRENCY`
 * mockado.
 */
export function resolveChunkConcurrency(): number {
  const raw = process.env.CLARICE_CHUNK_CONCURRENCY;
  if (raw === undefined) return 1;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : 1;
}

/**
 * Teto de concorrência para dispatch de chunks (#2701 item 1 do self-review #2700,
 * revertido pro default serial em #4952).
 *
 * Histórico: o dispatch sequencial original (1 chunk por vez) multiplicava o
 * wall-clock pelo número de chunks (ex: edição de 3 chunks ≈ 3× a latência de 1
 * request). O #2701 subiu o default pra 3 como meio-termo entre "cobre o caso
 * comum (2-3 chunks) com paralelismo total" e "limita o burst pra não estourar
 * rate-limit não documentado do lado do servidor".
 *
 * #4952 (260810): esse meio-termo nunca funcionou na prática. Padrão observado em
 * `data/run-log.jsonl` (260807/10/11): `elapsedMs` batendo quase exatamente no
 * timeout do cliente (60s REST / 30s MCP) INDEPENDENTE do tamanho do payload
 * (inclusive chunks de 740B, muito abaixo do threshold de chunking), múltiplas
 * tentativas com `elapsedMs` quase idêntico no mesmo round de retry, `504 Gateway
 * Timeout` ocasional do lado do servidor, e o fato de que um pedido MANUAL isolado
 * (nunca concorrente) sempre funciona enquanto a pipeline (sempre rajada de até 3)
 * sempre falha. Isso refuta o diagnóstico do #2798 (tamanho de payload) — baixar o
 * threshold 9k→4.5k naquele fix não resolveu porque reduzir tamanho de chunk não
 * reduz CONCORRÊNCIA, só aumenta o número de chunks disparados em paralelo. Ver
 * comentário atualizado em `scripts/lib/clarice-chunk.ts` (CLARICE_CHUNK_THRESHOLD).
 *
 * Default agora é 1 (serial): o "melhor caso" da concorrência 3 nunca era
 * alcançado — era sempre timeout garantido + halt manual + retry, que já é mais
 * lento que serial bem-sucedido. Overridável via env `CLARICE_CHUNK_CONCURRENCY`
 * (ver `resolveChunkConcurrency` acima) pra quem quiser re-testar concorrência
 * mais alta sem mudar código, uma vez que o problema do lado do servidor seja
 * investigado/resolvido.
 */
export const CLARICE_CHUNK_CONCURRENCY = resolveChunkConcurrency();

// ---------------------------------------------------------------------------
// Fallback por-parágrafo (#5082) — granularidade de 2º nível
// ---------------------------------------------------------------------------

/**
 * Timeout default por chamada REST no modo por-parágrafo — bem mais curto que
 * o timeout de chunk normal (30-60s) porque um parágrafo isolado é pequeno
 * (dezenas a poucas centenas de bytes) e o objetivo é fail-fast: se um
 * parágrafo travar, não vale a pena esperar tanto quanto um chunk inteiro
 * travaria — melhor desistir DELE rápido e seguir pros próximos (#5082,
 * validado ao vivo na edição 260813: 20s bastou pra 74/75 parágrafos
 * responderem em poucos segundos cada).
 */
export const PARAGRAPH_FALLBACK_TIMEOUT_MS = 20_000;

/** Estatísticas de uma corrida de fallback por-parágrafo sobre 1 chunk (ou sobre o texto inteiro, no modo `--granularity paragraph` forçado). */
export interface ParagraphFallbackStats {
  /** Total de parágrafos produzidos por `splitIntoParagraphs` (inclui não-substantivos). */
  paragraphsTotal: number;
  /** Parágrafos substantivos (enviados ao Clarice) — exclui separadores `---`/vazios. */
  paragraphsSubstantive: number;
  /** Parágrafos substantivos que tiveram request REST bem-sucedido (mesmo com 0 sugestões). */
  paragraphsSucceeded: number;
  /** Parágrafos substantivos cujo request falhou (timeout/erro) — SEM retry, fail-fast. */
  paragraphsFailed: number;
  /** Detalhe de cada falha, pra auditoria/log — preview truncado (não o parágrafo inteiro). */
  failedParagraphs: Array<{ startOffset: number; preview: string; errorMessage: string }>;
}

export interface ParagraphFallbackChunkResult {
  /** Texto do chunk com as sugestões de cada parágrafo aplicadas chunk(parágrafo)-localmente e re-concatenadas. */
  correctedText: string;
  /** Sugestões brutas de TODOS os parágrafos que responderam com sucesso (mesma semântica de `ChunkedResult.rawSuggestions`, um nível abaixo). */
  rawSuggestions: ClariceSuggestions;
  stats: ParagraphFallbackStats;
}

export interface ParagraphFallbackOptions {
  apiKey: string;
  fetchImpl?: typeof fetch;
  /** Timeout por chamada REST — default `PARAGRAPH_FALLBACK_TIMEOUT_MS` (20s). */
  timeoutMs?: number;
  /**
   * Observabilidade por tentativa (mesmo shape de `CorrectOptions.onAttempt`).
   * Cada entrada emitida aqui já vem com `viaParagraphFallback: true` —
   * o caller não precisa (re)marcar isso.
   */
  onAttempt?: (entry: AttemptLogEntry) => void;
}

/**
 * Corrige UM chunk via granularidade máxima: divide `chunk.text` em parágrafos
 * (`splitIntoParagraphs`), faz 1 chamada REST ISOLADA por parágrafo substantivo
 * — SEM retry (fail-fast: um parágrafo problemático não trava os demais nem
 * gasta o orçamento de tempo dos outros) e com timeout mais curto que o de um
 * chunk normal (default `PARAGRAPH_FALLBACK_TIMEOUT_MS`) — e re-aplica via
 * `mergeChunkSuggestions` (mesmo princípio de `applyChunkSuggestions`: só um
 * nível de granularidade mais fino, mesma política de ambiguidade por âncora).
 *
 * Parágrafo que falha: fica com `suggestions: []` no merge (texto original
 * desse parágrafo é preservado sem correção) — NÃO aborta os parágrafos
 * seguintes nem propaga exceção. É uma divergência DELIBERADA do "fail-clean"
 * do resto deste módulo (ver JSDoc de `correctTextChunked`): a alternativa a
 * "parte do chunk corrigida, parte não" aqui não é "chunk inteiro corrigido",
 * é "chunk inteiro descartado" (o motivo de estarmos no fallback é justamente
 * que a correção normal do chunk INTEIRO já falhou) — recuperar parte é
 * estritamente melhor que recuperar nada. O caller decide se uma taxa de
 * sucesso 0 (`paragraphsSucceeded === 0` com `paragraphsSubstantive > 0`)
 * ainda conta como "fallback não ajudou, propague o erro original".
 *
 * @param chunk O chunk que falhou na granularidade normal.
 */
export async function correctChunkViaParagraphs(
  chunk: TextChunk,
  opts: ParagraphFallbackOptions,
): Promise<ParagraphFallbackChunkResult> {
  const timeoutMs = opts.timeoutMs ?? PARAGRAPH_FALLBACK_TIMEOUT_MS;
  const paragraphs = splitIntoParagraphs(chunk.text, chunk.startOffset);
  const paragraphSuggestions: Array<{ chunk: TextChunk; suggestions: ClariceChunkSuggestion[] }> = [];
  const rawSuggestions: ClariceSuggestions = [];
  const failedParagraphs: ParagraphFallbackStats["failedParagraphs"] = [];
  let paragraphsSubstantive = 0;
  let paragraphsSucceeded = 0;

  for (const paragraph of paragraphs) {
    if (!isSubstantiveParagraph(paragraph.text)) {
      paragraphSuggestions.push({ chunk: paragraph, suggestions: [] });
      continue;
    }
    paragraphsSubstantive++;
    const attemptStart = Date.now();
    const payloadBytes = Buffer.byteLength(paragraph.text, "utf8");
    try {
      // Fail-fast de propósito: 1 tentativa, sem backoff/retry — o retry é
      // exatamente o que já esgotou no nível de chunk e acumulou o
      // timeout de 40-60s+ que a issue #5082 investigou.
      const suggestions = await correctTextViaREST({
        apiKey: opts.apiKey,
        text: paragraph.text,
        fetchImpl: opts.fetchImpl,
        timeoutMs,
      });
      paragraphSuggestions.push({ chunk: paragraph, suggestions });
      rawSuggestions.push(...suggestions);
      paragraphsSucceeded++;
      opts.onAttempt?.({
        attempt: 1,
        maxAttempts: 1,
        elapsedMs: Date.now() - attemptStart,
        payloadBytes,
        outcome: "success",
        suggestionsCount: suggestions.length,
        viaParagraphFallback: true,
      });
    } catch (e) {
      const err = e as Error;
      paragraphSuggestions.push({ chunk: paragraph, suggestions: [] });
      failedParagraphs.push({
        startOffset: paragraph.startOffset,
        preview: paragraph.text.slice(0, 80),
        errorMessage: err.message,
      });
      opts.onAttempt?.({
        attempt: 1,
        maxAttempts: 1,
        elapsedMs: Date.now() - attemptStart,
        payloadBytes,
        outcome: "fatal_failure",
        status: e instanceof ClariceHttpError ? e.status : undefined,
        errorMessage: err.message,
        viaParagraphFallback: true,
      });
    }
  }

  const merge = mergeChunkSuggestions(paragraphSuggestions);

  return {
    correctedText: merge.text,
    rawSuggestions,
    stats: {
      paragraphsTotal: paragraphs.length,
      paragraphsSubstantive,
      paragraphsSucceeded,
      paragraphsFailed: failedParagraphs.length,
      failedParagraphs,
    },
  };
}

/**
 * Versão "forçada" do fallback por-parágrafo (#5082) — invocável direto via
 * CLI (`--granularity paragraph`), sem passar pelo chunking normal
 * (`splitIntoChunks`) nem por nenhuma tentativa/retry prévia. Trata o texto
 * INTEIRO como um único "chunk" de entrada pra `correctChunkViaParagraphs`.
 *
 * Uso principal: forçar manualmente o comportamento que o script ad-hoc da
 * investigação #5082 validou ao vivo (edição 260813 — 74/75 parágrafos com
 * sucesso), sem precisar esperar o caminho automático (chunk normal +
 * retries esgotados) disparar o fallback primeiro.
 */
export async function correctTextViaParagraphs(
  opts: CorrectOptions,
  paragraphTimeoutMs = PARAGRAPH_FALLBACK_TIMEOUT_MS,
): Promise<ChunkedResult & { stats: ParagraphFallbackStats }> {
  const wholeTextChunk: TextChunk = { text: opts.text, startOffset: 0 };
  const result = await correctChunkViaParagraphs(wholeTextChunk, {
    apiKey: opts.apiKey,
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs ?? paragraphTimeoutMs,
    onAttempt: opts.onAttempt,
  });

  return {
    correctedText: result.correctedText,
    rawSuggestions: result.rawSuggestions,
    chunkCount: result.stats.paragraphsSubstantive,
    stats: result.stats,
  };
}

/**
 * Config do fallback automático de 2º nível (#5082) — opt-out disponível
 * (`enabled: false`) pra testes/CLI que precisam do fail-clean estrito
 * original (ex: assertar que um chunk falho propaga erro sem mascarar via
 * fallback).
 */
export interface ParagraphFallbackConfig {
  /** Default: `true` — cai no fallback por-parágrafo quando um chunk esgota os retries normais. */
  enabled?: boolean;
  /** Timeout por parágrafo — default `PARAGRAPH_FALLBACK_TIMEOUT_MS`. */
  timeoutMs?: number;
}

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
 *
 * `fn` recebe um 3º argumento `getInFlight()` (#4952) — lido a qualquer momento
 * dentro de `fn`, retorna quantas chamadas de `fn` estão em voo agora, INCLUINDO
 * a própria (mínimo 1 enquanto `fn` roda). Usado por `withClariceRetryChunked`
 * pra anexar o estado real de concorrência a cada tentativa logada em
 * `clarice_rest_attempt` (subtraindo 1 pra reportar só as OUTRAS chamadas —
 * ver `AttemptLogEntry.chunksInFlight`).
 */
async function mapWithConcurrencyLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number, getInFlight: () => number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  let hasError = false;
  let firstError: unknown;
  let inFlight = 0;
  const getInFlight = (): number => inFlight;

  async function worker(): Promise<void> {
    for (;;) {
      if (hasError) return;
      const i = nextIndex++;
      if (i >= items.length) return;
      inFlight++;
      try {
        results[i] = await fn(items[i], i, getInFlight);
      } catch (e) {
        if (!hasError) {
          hasError = true;
          firstError = e;
        }
        return;
      } finally {
        inFlight--;
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
 * (com teto de concorrência via `mapWithConcurrencyLimit`). `perChunk` é responsável
 * por produzir o `correctedText` FINAL daquele chunk — normalmente aplicando as
 * sugestões via `applyChunkSuggestions(chunk, suggestions)`, mas um caller que caiu no
 * fallback por-parágrafo (#5082, `correctChunkViaParagraphs`) já recebe o texto
 * corrigido pronto daquela função (que faz seu próprio merge um nível abaixo, com
 * parágrafos em vez de chunks) — por isso `runChunked` não assume mais internamente
 * QUAL foi o mecanismo de apply, só concatena o `correctedText` de cada chunk na
 * ordem correta. `extra` é bookkeeping específico do caller (ex.: `attempts` em
 * `withClariceRetryChunked`); este helper não interpreta `extra`, só acumula em
 * ordem de chunk para o caller reduzir.
 *
 * #5082: refatorado de "perChunk retorna sugestões cruas + runChunked aplica via
 * mergeChunkSuggestions" pra "perChunk retorna correctedText pronto" — mudança
 * puramente estrutural pro caminho normal (perChunk simplesmente chama
 * `applyChunkSuggestions` ele mesmo antes de retornar, produzindo resultado
 * byte-idêntico ao `mergeChunkSuggestions` anterior), necessária pro fallback
 * por-parágrafo poder substituir SÓ a produção do correctedText de um chunk sem
 * o merge externo re-tentar aplicar as (poucas) sugestões brutas do fallback contra
 * o `chunk.text` INTEIRO — o que reintroduziria a ambiguidade multi-nível que
 * `applyChunkSuggestions`/chunk-local já existe pra evitar (uma âncora única dentro
 * de 1 parágrafo pode não ser única dentro do chunk inteiro).
 */
async function runChunked<Extra>(
  text: string,
  chunkThreshold: number,
  concurrency: number,
  perChunk: (
    chunk: TextChunk,
    getInFlight: () => number,
  ) => Promise<{ correctedText: string; rawSuggestions: ClariceSuggestions; extra: Extra }>,
): Promise<{
  correctedText: string;
  rawSuggestions: ClariceSuggestions;
  chunkCount: number;
  extras: Extra[];
}> {
  const chunks = splitIntoChunks(text, chunkThreshold);

  const perChunkResults = await mapWithConcurrencyLimit(chunks, concurrency, (chunk, _i, getInFlight) =>
    perChunk(chunk, getInFlight),
  );

  return {
    correctedText: perChunkResults.map((r) => r.correctedText).join(""),
    rawSuggestions: perChunkResults.flatMap((r) => r.rawSuggestions),
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
 * **Exceção controlada a esse fail-clean (#5082):** se `paragraphFallback.enabled`
 * (default `true`) e o chunk falhar por um motivo NÃO-fatal (não 4xx — ver
 * `isFatalHttpError`), a falha aciona o fallback por-parágrafo (`correctChunkViaParagraphs`)
 * antes de desistir do chunk. Só se o fallback também recuperar zero parágrafos
 * substantivos é que o erro original propaga (fail-clean preservado nesse caso-limite).
 * Ver JSDoc de `correctChunkViaParagraphs` pra por que essa exceção é segura.
 *
 * @param opts CorrectOptions com `text`, `apiKey`, `fetchImpl` (para testes), `timeoutMs`
 * @param chunkThreshold Limite de chars por chunk (default: CLARICE_CHUNK_THRESHOLD)
 * @param concurrency Teto de chunks em voo simultaneamente (default: CLARICE_CHUNK_CONCURRENCY)
 * @param paragraphFallback Config do fallback de 2º nível (default: habilitado)
 */
export async function correctTextChunked(
  opts: CorrectOptions,
  chunkThreshold = CLARICE_CHUNK_THRESHOLD,
  concurrency = CLARICE_CHUNK_CONCURRENCY,
  paragraphFallback: ParagraphFallbackConfig = {},
): Promise<ChunkedResult> {
  const fallbackEnabled = paragraphFallback.enabled ?? true;
  const fallbackTimeoutMs = paragraphFallback.timeoutMs ?? PARAGRAPH_FALLBACK_TIMEOUT_MS;

  const result = await runChunked(opts.text, chunkThreshold, concurrency, async (chunk) => {
    try {
      const suggestions = await correctTextViaREST({ ...opts, text: chunk.text });
      const applyResult = applyChunkSuggestions(chunk, suggestions);
      return { correctedText: applyResult.text, rawSuggestions: suggestions, extra: undefined };
    } catch (chunkError) {
      if (!fallbackEnabled || isFatalHttpError(chunkError)) throw chunkError;

      const fallbackResult = await correctChunkViaParagraphs(chunk, {
        apiKey: opts.apiKey,
        fetchImpl: opts.fetchImpl,
        timeoutMs: fallbackTimeoutMs,
        onAttempt: opts.onAttempt,
      });
      if (fallbackResult.stats.paragraphsSubstantive > 0 && fallbackResult.stats.paragraphsSucceeded === 0) {
        throw chunkError;
      }
      return { correctedText: fallbackResult.correctedText, rawSuggestions: fallbackResult.rawSuggestions, extra: undefined };
    }
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
 * **Fallback de 2º nível (#5082):** quando um chunk esgota TODOS os `policy.maxAttempts`
 * (o cenário que a issue #5082 investigou — timeout/abort não-linear do lado do servidor,
 * não correlacionado a tamanho de payload), e `paragraphFallback.enabled` (default `true`),
 * o chunk cai em `correctChunkViaParagraphs` ANTES de propagar o erro — subdivide em
 * parágrafos, 1 request isolado por parágrafo substantivo, SEM retry, timeout mais curto
 * (`paragraphFallback.timeoutMs`, default `PARAGRAPH_FALLBACK_TIMEOUT_MS`). Erros fatais
 * (4xx — auth/bad request) NÃO acionam o fallback (`isFatalHttpError`): repetiriam o
 * mesmo erro em cada parágrafo sem chance de recuperação, então propagam direto. Se o
 * fallback recuperar ao menos 1 parágrafo substantivo, o chunk é considerado "resgatado"
 * (parte ou toda a correção aplicada) — só falha 100% dos parágrafos substantivos é que
 * preserva o fail-clean original (rethrow do erro do chunk). `usedParagraphFallbackChunks`/
 * `paragraphFallbackStats` no retorno permitem medir a frequência do fallback.
 *
 * @param opts CorrectOptions com `text`, `apiKey`, `fetchImpl`, `timeoutMs`
 * @param policy RetryPolicy (default: DEFAULT_RETRY_POLICY)
 * @param sleepFn Injetável para testes (default: setTimeout)
 * @param chunkThreshold Limite de chars por chunk (default: CLARICE_CHUNK_THRESHOLD)
 * @param concurrency Teto de chunks em voo simultaneamente (default: CLARICE_CHUNK_CONCURRENCY)
 * @param paragraphFallback Config do fallback de 2º nível (default: habilitado)
 */
export async function withClariceRetryChunked(
  opts: CorrectOptions,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
  sleepFn: (ms: number) => Promise<void> = (ms) =>
    new Promise((r) => setTimeout(r, ms)),
  chunkThreshold = CLARICE_CHUNK_THRESHOLD,
  concurrency = CLARICE_CHUNK_CONCURRENCY,
  paragraphFallback: ParagraphFallbackConfig = {},
): Promise<ChunkedRetryResult> {
  const fallbackEnabled = paragraphFallback.enabled ?? true;
  const fallbackTimeoutMs = paragraphFallback.timeoutMs ?? PARAGRAPH_FALLBACK_TIMEOUT_MS;

  interface ChunkExtra {
    attempts: number;
    usedParagraphFallback: boolean;
    paragraphStats?: ParagraphFallbackStats;
  }

  const result = await runChunked(opts.text, chunkThreshold, concurrency, async (chunk, getInFlight) => {
    // #4952 — anexa o número de OUTROS chunks em voo no momento de cada tentativa
    // ao AttemptLogEntry, sem alterar o comportamento do onAttempt original do
    // caller (chama-o normalmente, só enriquece o payload antes).
    const chunkOpts: CorrectOptions = opts.onAttempt
      ? {
          ...opts,
          text: chunk.text,
          onAttempt: (entry) =>
            opts.onAttempt!({ ...entry, chunksInFlight: Math.max(0, getInFlight() - 1) }),
        }
      : { ...opts, text: chunk.text };

    try {
      const retryResult = await withClariceRetry(chunkOpts, policy, sleepFn);
      const applyResult = applyChunkSuggestions(chunk, retryResult.suggestions);
      const extra: ChunkExtra = { attempts: retryResult.attempts, usedParagraphFallback: false };
      return {
        correctedText: applyResult.text,
        rawSuggestions: retryResult.suggestions,
        extra,
      };
    } catch (chunkError) {
      if (!fallbackEnabled || isFatalHttpError(chunkError)) throw chunkError;

      const fallbackResult = await correctChunkViaParagraphs(chunk, {
        apiKey: opts.apiKey,
        fetchImpl: opts.fetchImpl,
        timeoutMs: fallbackTimeoutMs,
        onAttempt: opts.onAttempt
          ? (entry) => opts.onAttempt!({ ...entry, chunksInFlight: Math.max(0, getInFlight() - 1) })
          : undefined,
      });

      // Fallback também não recuperou nada substantivo — preserva o fail-clean
      // original (propaga o erro REAL do chunk, não um erro sintético do fallback).
      if (fallbackResult.stats.paragraphsSubstantive > 0 && fallbackResult.stats.paragraphsSucceeded === 0) {
        throw chunkError;
      }

      const extra: ChunkExtra = {
        attempts: policy.maxAttempts + fallbackResult.stats.paragraphsSubstantive,
        usedParagraphFallback: true,
        paragraphStats: fallbackResult.stats,
      };
      return {
        correctedText: fallbackResult.correctedText,
        rawSuggestions: fallbackResult.rawSuggestions,
        extra,
      };
    }
  });

  const totalAttempts = result.extras.reduce((sum, e) => sum + e.attempts, 0);
  const usedParagraphFallbackChunks = result.extras.filter((e) => e.usedParagraphFallback).length;
  const paragraphFallbackStats = result.extras
    .filter((e): e is ChunkExtra & { paragraphStats: ParagraphFallbackStats } => e.paragraphStats !== undefined)
    .map((e) => e.paragraphStats);

  return {
    correctedText: result.correctedText,
    rawSuggestions: result.rawSuggestions,
    chunkCount: result.chunkCount,
    totalAttempts,
    usedParagraphFallbackChunks,
    paragraphFallbackStats,
  };
}

// ---------------------------------------------------------------------------
// Guard de staleness do --corrected-out (#5755)
// ---------------------------------------------------------------------------

/**
 * Resultado de `checkCorrectedOutFreshness` — pure, sem I/O além do
 * `statFn` injetado (default `mtimeMs`, ver `scripts/lib/mtime.ts`).
 */
export interface CorrectedOutFreshnessResult {
  /** `true` quando o arquivo é mais antigo que `callStartMs` — sinal de que
   * esta chamada NÃO reescreveu o arquivo (no-op silencioso). */
  stale: boolean;
  /** mtime do arquivo em ms, ou `null` se ausente/inacessível. */
  mtimeMs: number | null;
  callStartMs: number;
}

/**
 * Guard determinístico (#5755, achado ao vivo na edição 260820): uma chamada
 * em background de `--retry` pode terminar sem disparar nenhuma requisição
 * HTTP nova (sem erro, sem entrada fresca de `clarice_rest_attempt`) e ainda
 * assim deixar `--corrected-out` no disco com o conteúdo de uma execução
 * ANTERIOR — risco real de "correção" reverter uma reescrita mais recente do
 * texto se aplicada sem checagem. Este guard compara o mtime do arquivo
 * (lido DEPOIS do write que esta própria execução tentou fazer) contra
 * `callStartMs` — um timestamp capturado no INÍCIO da execução, antes de
 * qualquer I/O. Um mtime anterior ao início da chamada não pode ter sido
 * produzido por esta execução — é sempre conteúdo de uma execução anterior.
 *
 * `mtimeMs === null` (arquivo ausente) nunca é staleness — `writeFileSync`
 * já teria lançado (exit 4, ver `main`) antes deste guard rodar se o write
 * tivesse falhado a ponto do arquivo não existir.
 *
 * A causa raiz do no-op silencioso em si (item 1 da sugestão da issue —
 * processo não disparando? race de working directory? cache de resultado
 * anterior?) segue como investigação em aberto, não coberta por este guard —
 * ver docstring do topo do arquivo. O guard é a mitigação determinística
 * (item 2 da issue): nunca deixar o sintoma passar silenciosamente, mesmo
 * sem a causa raiz identificada.
 *
 * `toleranceMs` (default `FRESHNESS_TOLERANCE_MS`) absorve a diferença entre
 * `Date.now()` e o clock que o filesystem usa pra popular `mtime` — medido
 * ao vivo: um `writeFileSync` seguido de `statSync` NO MESMO processo já
 * produziu `mtimeMs` ~1-2ms ANTERIOR ao `callStartMs` capturado alguns
 * microssegundos antes (resolução/fonte de clock distintas entre
 * `Date.now()` e o timestamp que o kernel grava no inode). Sem tolerância,
 * o guard falsearia positivo (abortaria uma escrita legítima desta própria
 * execução) — o objetivo é detectar um arquivo VELHO de uma execução
 * anterior (diferença de segundos/minutos), não uma diferença de
 * milissegundos por jitter de clock.
 */
export const FRESHNESS_TOLERANCE_MS = 2_000;

export function checkCorrectedOutFreshness(
  path: string,
  callStartMs: number,
  statFn: (p: string) => number | null = mtimeMs,
  toleranceMs: number = FRESHNESS_TOLERANCE_MS,
): CorrectedOutFreshnessResult {
  const currentMtimeMs = statFn(path);
  return {
    stale: currentMtimeMs !== null && currentMtimeMs < callStartMs - toleranceMs,
    mtimeMs: currentMtimeMs,
    callStartMs,
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
  /**
   * #5082 — `"paragraph"` força a granularidade por-parágrafo desde o início
   * (bypassa `splitIntoChunks`/threshold normal inteiramente — trata o texto
   * inteiro como um único chunk pra `correctChunkViaParagraphs`). Ignora
   * `--retry`/`--max-attempts` quando setado (fail-fast por parágrafo, sem
   * retry, é o comportamento inerente desta granularidade). Default:
   * `"default"` (chunking normal + fallback automático de 2º nível).
   */
  granularity: "default" | "paragraph";
  /** #5082 — desliga o fallback automático de 2º nível no modo `granularity: "default"`. */
  noParagraphFallback: boolean;
  /** #5082 — timeout por request no fallback/modo por-parágrafo (default: PARAGRAPH_FALLBACK_TIMEOUT_MS). */
  paragraphTimeoutMs?: number;
}

export function parseCliArgs(argv: string[]): CliArgs | null {
  const out: Partial<CliArgs> = { retry: false, granularity: "default", noParagraphFallback: false };
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
    else if (flag === "--granularity" && value) {
      if (value !== "default" && value !== "paragraph") {
        console.error(`--granularity deve ser "default" ou "paragraph" (recebido: ${value})`);
        process.exit(1);
      }
      out.granularity = value;
      i++;
    }
    else if (flag === "--no-paragraph-fallback") { out.noParagraphFallback = true; }
    else if (flag === "--paragraph-timeout-ms" && value) {
      const n = Number(value);
      if (!Number.isFinite(n) || n <= 0) {
        console.error(`--paragraph-timeout-ms deve ser um número positivo (recebido: ${value})`);
        process.exit(1);
      }
      out.paragraphTimeoutMs = n;
      i++;
    }
  }
  if (!out.inPath || !out.outPath) return null;
  return out as CliArgs;
}

/** Exportado pra testes CLI end-to-end (#2798) — invocado automaticamente no bottom do arquivo. */
export async function main(): Promise<void> {
  // #5755 — capturado ANTES de qualquer I/O, é o "início desta chamada" que
  // checkCorrectedOutFreshness usa como referência.
  const callStartMs = Date.now();
  const args = parseCliArgs(process.argv.slice(2));
  if (!args) {
    console.error(
      "Uso: clarice-correct.ts --in <text-file> --out <suggestions-json> [--corrected-out <corrected-text>] [--retry] [--timeout-ms N] [--max-attempts N] [--edition AAMMDD] [--stage N] [--agent nome] [--granularity default|paragraph] [--no-paragraph-fallback] [--paragraph-timeout-ms N]",
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

  // #2798 — loga cada tentativa (sucesso/retry/fatal) em data/run-log.jsonl,
  // pra permitir diagnosticar padrões sem depender só do resultado final
  // consolidado. #5082: tentativas do fallback por-parágrafo chegam com
  // `viaParagraphFallback: true` — rebaixadas pra "warn" mesmo em falha
  // (nunca "error"), porque 1 parágrafo falhar isolado é esperado/tolerado
  // (fail-fast por design) e não deve soar como incidente igual a um chunk
  // inteiro esgotando os retries normais.
  const onAttempt = (entry: AttemptLogEntry): void => {
    logEvent({
      edition: args.edition ?? null,
      stage: args.stage ?? 2,
      agent: args.agent ?? "clarice-correct-rest",
      level:
        entry.outcome === "success"
          ? "info"
          : entry.viaParagraphFallback
            ? "warn"
            : entry.outcome === "fatal_failure"
              ? "error"
              : "warn",
      message: "clarice_rest_attempt",
      details: entry,
    });
  };

  try {
    if (args.granularity === "paragraph") {
      const result = await correctTextViaParagraphs(
        { apiKey, text, timeoutMs: args.paragraphTimeoutMs ?? args.timeoutMs, onAttempt },
        args.paragraphTimeoutMs ?? args.timeoutMs ?? PARAGRAPH_FALLBACK_TIMEOUT_MS,
      );
      rawSuggestions = result.rawSuggestions;
      correctedText = result.correctedText;
      logExtra = {
        granularity: "paragraph",
        paragraphs_total: result.stats.paragraphsTotal,
        paragraphs_substantive: result.stats.paragraphsSubstantive,
        paragraphs_succeeded: result.stats.paragraphsSucceeded,
        paragraphs_failed: result.stats.paragraphsFailed,
      };
    } else if (args.retry) {
      const policy: RetryPolicy = {
        maxAttempts: args.maxAttempts ?? DEFAULT_RETRY_POLICY.maxAttempts,
        timeoutMs: args.timeoutMs ?? DEFAULT_RETRY_POLICY.timeoutMs,
        baseBackoffMs: DEFAULT_RETRY_POLICY.baseBackoffMs,
      };
      const result = await withClariceRetryChunked(
        { apiKey, text, timeoutMs: args.timeoutMs, onAttempt },
        policy,
        undefined,
        undefined,
        undefined,
        { enabled: !args.noParagraphFallback, timeoutMs: args.paragraphTimeoutMs },
      );
      rawSuggestions = result.rawSuggestions;
      correctedText = result.correctedText;
      logExtra = {
        attempts_used: result.totalAttempts,
        chunks: result.chunkCount,
        chunks_used_paragraph_fallback: result.usedParagraphFallbackChunks,
      };
    } else {
      const result = await correctTextChunked(
        { apiKey, text, timeoutMs: args.timeoutMs, onAttempt },
        undefined,
        undefined,
        { enabled: !args.noParagraphFallback, timeoutMs: args.paragraphTimeoutMs },
      );
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

    // #5755 — guard de staleness: falha explicitamente se o arquivo
    // recém-escrito tiver mtime anterior ao início desta chamada (sinal de
    // no-op silencioso — ver docstring de checkCorrectedOutFreshness).
    const freshness = checkCorrectedOutFreshness(args.correctedOutPath, callStartMs);
    if (freshness.stale) {
      console.error(
        `[clarice-correct] --corrected-out (${args.correctedOutPath}) tem mtime anterior ao início desta chamada ` +
          `(mtime=${freshness.mtimeMs}, callStart=${freshness.callStartMs}) — provável no-op silencioso ` +
          `(#5755). NÃO use este arquivo: rode novamente em foreground e confira se novas entradas ` +
          `clarice_rest_attempt aparecem em data/run-log.jsonl.`,
      );
      process.exit(5);
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
