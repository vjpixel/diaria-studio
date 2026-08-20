/**
 * scripts/lib/shutdown-with-timeout.ts (#5737)
 *
 * Garante que um processo SEMPRE morre quando pedido pra reiniciar, mesmo
 * que a função de fechamento (tipicamente `http.Server#close()`) nunca
 * resolva — causa raiz observada ao vivo no Studio server: conexões
 * penduradas (SSE de `/api/events`, keep-alive) podem deixar `close()`
 * esperando pra sempre, o que significa que o `process.exit(0)` dentro do
 * `.finally()` nunca dispara. Como `Restart=always` do systemd só reage a
 * saída REAL do PID, o processo fica "vivo" (active/running) sem escutar a
 * porta — zumbi, 502 na borda, sem o serviço nunca entrar em estado
 * `failed`.
 *
 * Lógica pura e testável: injeta `exit` (default `process.exit`) e
 * `timeoutMs` (default 10s) — testes substituem `exit` por um spy e usam
 * `timeoutMs` pequeno pra não esperar 10s reais.
 */

export interface ShutdownWithTimeoutOptions {
  /** Tempo máximo (ms) pra esperar `closeFn()` resolver antes de forçar saída. */
  timeoutMs?: number;
  /** Injeção pra teste — default `process.exit`. */
  exit?: (code: number) => void;
  /** Chamado se o timeout disparar antes de `closeFn()` resolver. */
  onTimeout?: () => void;
}

export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;

/**
 * Roda `closeFn` e garante que `exit` é chamado exatamente uma vez — com
 * código 0 se `closeFn` resolver (ou rejeitar) dentro do timeout, ou com
 * código 1 se o timeout disparar primeiro. Nunca lança.
 */
export function shutdownWithTimeout(
  closeFn: () => Promise<void>,
  opts: ShutdownWithTimeoutOptions = {},
): void {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  let settled = false;

  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    opts.onTimeout?.();
    exit(1);
  }, timeoutMs);
  // Não deixar este timer ser o único motivo do event loop continuar vivo —
  // se tudo mais já saiu, o timer não deve segurar o processo.
  timer.unref?.();

  closeFn()
    .catch(() => {
      // Ignorado de propósito: independente de close() resolver ou
      // rejeitar, o processo precisa sair — só o timeout muda o exit code.
    })
    .finally(() => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      exit(0);
    });
}
