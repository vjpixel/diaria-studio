/**
 * test/_helpers/make-tracked-kv.ts
 *
 * In-memory KV stub that tracks puts (including expirationTtl).
 * Shared between poll-snapshot test files to avoid copy-paste drift (#F7).
 */

/** KV mínimo em memória que rastreia opts do put (incluindo expirationTtl). */
export function makeTrackedKv(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial));
  const puts: Array<{ key: string; value: string; opts?: { expirationTtl?: number } }> = [];
  const kv = {
    puts,
    async get(key: string) { return store.get(key) ?? null; },
    async getWithMetadata(key: string) { return { value: store.get(key) ?? null, metadata: null }; },
    async put(key: string, value: string, opts?: { expirationTtl?: number }) {
      puts.push({ key, value, opts });
      store.set(key, value);
    },
    async delete(key: string) { store.delete(key); },
    async list({ prefix = "" }: { prefix?: string; cursor?: string } = {}) {
      const keys = [...store.keys()]
        .filter((k) => k.startsWith(prefix))
        .map((name) => ({ name }));
      return { keys, list_complete: true, cursor: undefined };
    },
  };
  return kv;
}
