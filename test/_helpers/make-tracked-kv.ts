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

/**
 * Helper de teste que lê uma chave do KV e falha com AssertionError descritivo
 * quando a chave não existe, em vez de retornar null silenciosamente (o que
 * causaria TypeError em JSON.parse(null!) — difícil de debugar).
 *
 * Uso: `const score = JSON.parse(await readKv(kv, "score:x@y.com"));`
 */
export async function readKv(
  kv: ReturnType<typeof makeTrackedKv>,
  key: string,
): Promise<string> {
  const value = await kv.get(key);
  if (value === null) {
    const { strict: assert } = await import("node:assert");
    assert.fail(`KV key "${key}" não encontrada — verifique o fixture inicial do makeTrackedKv`);
  }
  return value;
}
