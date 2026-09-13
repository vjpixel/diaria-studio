/**
 * pool.ts — pool de concorrência limitada (#2651: extraído de
 * clarice-build-waves.ts + clarice-sync-brevo.ts, que tinham cópias idênticas).
 *
 * Roda `worker(item)` sobre `items` com no máximo `n` execuções concorrentes.
 * Workers consomem um índice compartilhado (não fatiam o array em blocos), então
 * a carga fica balanceada mesmo com itens de duração desigual. Aguarda todos.
 *
 * NÃO aborta os demais workers se um lançar (Promise.all rejeita, mas as outras
 * coroutines continuam puxando itens). Quem precisa de abort-on-error use
 * `poolAbortOnError` abaixo (#8091 — extraído da variante que
 * `clarice-engagement-cohorts.ts` mantinha localmente, #2426 review; e agora
 * também usada por `clarice-sync-brevo.ts` para não continuar martelando
 * Brevo/SQLite depois que uma lane já decidiu abortar o run inteiro).
 */
export async function pool<T>(
  items: T[],
  n: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let i = 0;
  const run = async (): Promise<void> => {
    while (i < items.length) await worker(items[i++]);
  };
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(n, items.length)) }, run),
  );
}

/**
 * Pool de concorrência limitada com ABORT no primeiro erro (#2426 review,
 * extraído para cá em #8091 — antes vivia só como cópia local em
 * `clarice-engagement-cohorts.ts`).
 *
 * Nota sobre "unhandled rejection" (#8091): `Promise.all` já se inscreve em
 * TODAS as promises de `run()` de forma síncrona, no mesmo turno em que são
 * criadas — então mesmo que várias lanes rejeitem depois que a 1ª rejeição já
 * fez `Promise.all` (e o `pool()` genérico acima) resolver/rejeitar para o
 * chamador, nenhuma dessas rejeições fica "sem handler" (`unhandledRejection`)
 * do ponto de vista do Node: cada `run()` sempre teve um `.then` anexado desde
 * o início. Verificado empiricamente (ver PR #8091) — o risco real do `pool()`
 * sem abort não é crash por unhandled rejection, é DESPERDÍCIO: as demais
 * lanes continuam consumindo a fila e martelando a API/DB depois que o run
 * inteiro já está fadado a abortar. `aborted` corta esse desperdício assim
 * que a 1ª lane lança — os demais workers param de puxar itens novos após o
 * `await` em curso, sem esperar o item atual terminar de rodar.
 */
export async function poolAbortOnError<T>(
  items: T[],
  n: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let i = 0;
  let aborted = false;
  const run = async (): Promise<void> => {
    while (i < items.length && !aborted) {
      const item = items[i++];
      try {
        await worker(item);
      } catch (e) {
        aborted = true;
        throw e;
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(n, items.length)) }, run),
  );
}
