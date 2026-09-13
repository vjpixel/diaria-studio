/**
 * sqlite-busy-retry.ts — retry com backoff pra transação SQLite que colide
 * com SQLITE_BUSY/"database is locked" (#6035).
 *
 * Contexto: o store `clarice-users.db` (`scripts/lib/clarice-db.ts`) é
 * escrito por várias tasks systemd concorrentes (Diaria-Clarice-Sync,
 * Diaria-Clarice-Novos, etc.). `PRAGMA busy_timeout` (ver
 * `resolveBusyTimeoutMs` em `clarice-db.ts`) já faz o SQLite esperar
 * bloqueado por um tempo antes de lançar `SQLITE_BUSY`/"database is
 * locked" — mas se a transação concorrente segura o lock por mais tempo que
 * esse timeout (medido ao vivo: `diaria-clarice-sync.service` saiu com esse
 * erro 32min após o início, #6035), a chamada falha mesmo assim.
 *
 * Este helper dá uma 2ª chance no nível do APLICATIVO, só para erros de
 * lock — qualquer outro erro relança imediatamente, sem retry — com um
 * número de tentativas FINITO e backoff crescente. Decisão deliberada
 * (documentada no PR #6035): nunca retry infinito. Um lock genuinamente
 * preso (processo morto segurando a conexão, ou uma tarefa que trava por
 * muito mais tempo que o esperado) não deve fazer o chamador ficar preso
 * retry-ando pra sempre — o systemd timer diário já roda de novo no dia
 * seguinte, e o checkpoint do sync (`clarice-sync-brevo.ts`) já permite
 * retomar de onde parou. "Desistir logo, de forma limpa (exit code
 * diagnosticável), e deixar o checkpoint resumir depois" é preferível a
 * mascarar um lock preso com espera indefinida.
 */

/** Reconhece o erro de contenção SQLite que este módulo trata (não qualquer erro). */
export function isSqliteBusyError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /database is locked|SQLITE_BUSY/i.test(msg);
}

// 3 tentativas extras (1s, 3s, 6s — ~10s de espera total além da 1ª
// tentativa) — folga suficiente pra uma transação concorrente breve
// terminar, sem alongar demais um processo que roda desassistido.
export const DEFAULT_SQLITE_BUSY_RETRY_DELAYS_MS = [1000, 3000, 6000];

export interface RetryOnSqliteBusyOptions {
  /** Delays (ms) entre tentativas, na ordem. Esgotar a lista relança o erro original. */
  delays?: number[];
  /** Injeção de teste — nunca aguardar o tempo real num teste unitário. */
  sleep?: (ms: number) => Promise<void>;
  /** Chamado ANTES de cada espera — hook de logging do chamador. */
  onRetry?: (info: { error: Error; attemptIndex: number; delayMs: number }) => void;
}

/**
 * Roda `attempt()`. Se lançar um erro de lock SQLite (`isSqliteBusyError`),
 * tenta de novo após cada delay em `delays`, nesta ordem, até esgotar a
 * lista — aí relança o erro original da ÚLTIMA tentativa. Qualquer erro que
 * NÃO seja de lock relança imediatamente, sem retry algum.
 */
export async function retryOnSqliteBusy<T>(
  attempt: () => T | Promise<T>,
  options: RetryOnSqliteBusyOptions = {},
): Promise<T> {
  const delays = options.delays ?? DEFAULT_SQLITE_BUSY_RETRY_DELAYS_MS;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attemptIndex = 0; ; attemptIndex++) {
    try {
      return await attempt();
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      if (!isSqliteBusyError(err) || attemptIndex >= delays.length) throw err;
      const delayMs = delays[attemptIndex];
      options.onRetry?.({ error: err, attemptIndex, delayMs });
      await sleep(delayMs);
    }
  }
}
