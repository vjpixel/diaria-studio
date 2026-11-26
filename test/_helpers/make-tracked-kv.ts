/**
 * test/_helpers/make-tracked-kv.ts
 *
 * In-memory KV stub that tracks puts (including expirationTtl).
 * Shared between poll-snapshot test files to avoid copy-paste drift (#F7).
 *
 * Desde o #14058 é também o KV em memória comum de `test/`: substitui as
 * cópias locais `makeMapKV`/`makeKv` (Map com get/put/delete) que ~55 arquivos
 * reescreviam. As extensões são aditivas:
 * - `_map` expõe o `Map` interno (antes só as cópias locais expunham);
 * - `get(key, "json")` (ou `{ type: "json" }`) devolve o valor parseado, como
 *   o KV real faz (os testes do `brevo-dashboard` dependem disso);
 * - `makeTrackedKvNamespace` devolve o mesmo stub tipado como `KVNamespace`,
 *   no lugar do cast `as unknown as KVNamespace` que cada cópia repetia.
 *
 * Cópia com semântica própria (put que lança, list paginado ou sempre vazio,
 * metadata, contagem de operações) continua local no próprio teste.
 */

type GetType = string | { type?: string } | undefined;

function wantsJson(type: GetType): boolean {
  return type === "json" || (typeof type === "object" && type !== null && type.type === "json");
}

/** KV mínimo em memória que rastreia opts do put (incluindo expirationTtl). */
export function makeTrackedKv(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial));
  const puts: Array<{ key: string; value: string; opts?: { expirationTtl?: number } }> = [];
  // Overload: sem `type` o retorno segue `string | null` (contrato de antes do
  // #14058 para os importadores existentes); com `"json"` vem o valor parseado.
  function get(key: string): Promise<string | null>;
  function get(key: string, type: GetType): Promise<unknown>;
  async function get(key: string, type?: GetType): Promise<unknown> {
    const value = store.get(key);
    if (value === undefined) return null;
    return wantsJson(type) ? JSON.parse(value) : value;
  }
  const kv = {
    puts,
    /** O `Map` interno, para asserções e seeds diretos no teste (#14058). */
    _map: store,
    get,
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

export type TrackedKv = ReturnType<typeof makeTrackedKv>;

/**
 * O mesmo stub de `makeTrackedKv`, tipado como `KVNamespace` para entrar
 * direto num `Env` de worker (#14058). O cast fica aqui, uma vez, em vez de
 * em cada arquivo de teste.
 */
export function makeTrackedKvNamespace(initial: Record<string, string> = {}): KVNamespace & TrackedKv {
  return makeTrackedKv(initial) as unknown as KVNamespace & TrackedKv;
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
