/**
 * test/_helpers/make-mock-do-state.ts
 *
 * Mock mínimo de DurableObjectState para testes isolados de DOs (VoteDedup,
 * StatsCounter). Extrai o copy-paste duplicado de poll-vote-dedup-2187.test.ts
 * e poll-stats-counter-2223.test.ts em helper compartilhado (#cleanup fix #7).
 *
 * Usa Map em memória com interface idêntica ao DO storage real.
 * `blockConcurrencyWhile` usa fila de promises (mutex) para serializar
 * chamadas concorrentes — espelha o comportamento do CF runtime que processa
 * um request por vez dentro do mesmo DO.
 */

/**
 * Cria um mock de DurableObjectState com Map em memória e mutex serializado.
 *
 * Suporta assinatura batch (array de chaves → Map) e single (string → valor)
 * em `storage.get` — espelha a CF DurableObjectStorage real.
 */
export function makeMockDoState(): DurableObjectState {
  const storage = new Map<string, unknown>();

  // Mutex via fila de promises: cada blockConcurrencyWhile encadeia na fila,
  // garantindo que fn() só executa quando a invocação anterior terminar.
  let queue: Promise<unknown> = Promise.resolve();

  return {
    storage: {
      // Suporta assinatura batch (array de chaves → Map) e single (string → valor).
      // A CF DurableObjectStorage real suporta ambas; o mock também deve.
      async get<T>(key: string | string[]): Promise<T | undefined | Map<string, T | undefined>> {
        if (Array.isArray(key)) {
          const map = new Map<string, T | undefined>();
          for (const k of key) map.set(k, storage.get(k) as T | undefined);
          return map as unknown as T;
        }
        return storage.get(key) as T | undefined;
      },
      async put<T>(key: string, value: T): Promise<void> {
        storage.set(key, value);
      },
      async delete(key: string): Promise<void> {
        storage.delete(key);
      },
    } as unknown as DurableObjectStorage,
    blockConcurrencyWhile: <T>(fn: () => Promise<T>): Promise<T> => {
      // Encadeia na fila: aguarda a invocação anterior antes de executar fn().
      // Serializa requests concorrentes ao mesmo DO — igual ao CF runtime.
      const next = queue.then(() => fn());
      // Atualiza a fila para o próximo blockConcurrencyWhile esperar nesta invocação.
      queue = next.then(() => undefined, () => undefined);
      return next;
    },
  } as unknown as DurableObjectState;
}
