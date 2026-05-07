/**
 * verify-options.ts (#836)
 *
 * Bag de opções compartilhada entre `verify-accessibility.ts` e
 * `verify-dates.ts`. Substitui ~11 vars module-level que tinham
 * acumulado entre #835/#839/#841/#842.
 *
 * Cada consumer pega só os campos que precisa (todos opcionais). Mantém
 * compatibilidade pra chamadas sem opts (legacy paths).
 */

import type { CacheEntry } from "./url-verify-cache.ts";

/**
 * Opções pra `verify-accessibility.ts`. Threaded via `verify(url, opts)`.
 */
export interface VerifyOptions {
  /**
   * Diretório do body cache intra-edição (#717 hyp 1, #835). Quando set,
   * `verify()` salva o body raw de cada GET pra `verify-dates` reutilizar.
   * Null/undefined = cache desabilitado.
   */
  bodiesDir?: string | null;

  /**
   * Map cross-edition de verdicts (#717 hyp 2, #841). Quando set, URLs
   * com verdict cacheado dentro do TTL skipam HEAD+GET. Caller carrega
   * via `loadCache()` antes do batch e persiste com `saveCache()` no fim.
   */
  verifyCache?: Map<string, CacheEntry> | null;

  /**
   * TTL do cache em ms. Default = 7 dias (DEFAULT_TTL_MS de url-verify-cache).
   */
  verifyCacheTtlMs?: number;

  /**
   * Timeout HTTP em ms. Default = CONFIG.timeouts.verify.
   */
  timeoutMs?: number;
}

/**
 * Opções pra `verify-dates.ts`. Threaded via `verifyDate(article, opts)`.
 */
export interface VerifyDateOptions {
  /**
   * Diretório do body cache (#717 hyp 1). Quando set, `verifyDate()` lê
   * o body cacheado por `verify-accessibility` antes de fetchar.
   */
  bodiesDir?: string | null;

  /**
   * Cutoff ISO (YYYY-MM-DD) pra arxiv pre-skip (#717 hyp 4, #839). URLs
   * de arxiv com YYMM anterior ao cutoff retornam imediatamente sem fetch.
   */
  cutoffIso?: string | null;

  /**
   * Margem em meses pra interpretar arxiv YYMM. Default = 2 (cobre meses
   * de overlap entre publicação e indexação).
   */
  arxivMarginMonths?: number;
}
