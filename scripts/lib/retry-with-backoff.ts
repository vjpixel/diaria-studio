/**
 * retry-with-backoff.ts (#4101 self-review finding 10)
 *
 * Helper genérico de retry com backoff exponencial (1s, 2s, ...) — extrai o
 * padrão que já existe (duplicado) em publish-facebook.ts/publish-instagram.ts/
 * publish-threads.ts (loop manual `for (attempt = 1; attempt <= 3; attempt++)`
 * com `Math.pow(2, attempt - 1)` entre tentativas, pulado em test-mode) pra
 * uso por qualquer dispatch de publisher que ainda não tenha essa proteção.
 *
 * Motivação (#4101 finding 10): `publish-weekly-social.ts` chamava a Graph API
 * do Facebook direto, sem retry — uma falha transiente de rede já marcava
 * `status: "failed"` na primeira tentativa, diferente do padrão dos
 * publishers diários. Em vez de reimplementar o loop uma 4ª vez, este helper
 * captura o mecanismo já usado e o `publish-weekly-social.ts` importa daqui.
 *
 * Os publishers diários (`publish-facebook.ts` etc.) NÃO foram refatorados
 * para usar este helper nesta mudança — já têm o próprio loop testado e
 * funcionando em produção; tocar neles é fora do escopo deste finding
 * (duplicação entre eles é o finding 8, explicitamente não corrigido aqui).
 */

export interface RetryWithBackoffOptions {
  /** Número de tentativas (default 3, mesmo valor usado pelos publishers diários). */
  maxAttempts?: number;
  /** Em test-mode, pula o `setTimeout` do delay entre tentativas (mesma convenção de `isTest` nos scripts diários). */
  isTest?: boolean;
  /** Prefixo usado nas mensagens de log de tentativa falha (ex: "publish-weekly-social/facebook"). */
  logPrefix?: string;
}

/**
 * Executa `fn` até `maxAttempts` vezes, com backoff exponencial (1s, 2s, ...)
 * entre tentativas. Rejeita com o último erro se todas as tentativas falharem.
 * `fn` recebe o número da tentativa atual (1-indexed) — útil para logging.
 */
export async function retryWithBackoff<T>(
  fn: (attempt: number) => Promise<T>,
  opts: RetryWithBackoffOptions = {},
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 3;
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
      if (opts.logPrefix) {
        console.error(`[${opts.logPrefix}] attempt ${attempt}/${maxAttempts} failed: ${lastError.message}`);
      }
      if (attempt < maxAttempts) {
        const delaySec = Math.pow(2, attempt - 1); // 1s, 2s, 4s, ...
        if (!opts.isTest) {
          await new Promise((r) => setTimeout(r, delaySec * 1000));
        }
      }
    }
  }

  throw lastError ?? new Error("retry_with_backoff: exhausted attempts without a captured error");
}
