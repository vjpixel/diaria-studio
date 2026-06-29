/**
 * pool.ts — pool de concorrência limitada (#2651: extraído de
 * clarice-build-waves.ts + clarice-sync-brevo.ts, que tinham cópias idênticas).
 *
 * Roda `worker(item)` sobre `items` com no máximo `n` execuções concorrentes.
 * Workers consomem um índice compartilhado (não fatiam o array em blocos), então
 * a carga fica balanceada mesmo com itens de duração desigual. Aguarda todos.
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
