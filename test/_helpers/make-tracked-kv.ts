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
 * Desde o resíduo do #14058 o helper também cobre o que as cópias restantes
 * simulavam, sempre opt-in para não mudar o comportamento dos importadores:
 * - falha injetada: `failGet`/`failPut`/`failList` (mutáveis, como nas cópias)
 *   fazem a operação lançar `Error(failMessage)`;
 * - metadata: `put(..., { metadata })` guarda a metadata em `_meta`, recusa
 *   acima de 1024 bytes como o KV real, e `getWithMetadata`/`list` a devolvem;
 * - list paginado: `makeTrackedKv(seed, { listPageSize: N })` devolve N chaves
 *   por página, em ordem lexicográfica, com `cursor` = offset da próxima.
 *
 * Cópia com semântica realmente própria (KV sobre `fetch`, teto de operações
 * por invocação, valor em `Uint8Array`, interface `KvOps` com list de strings)
 * continua local no próprio teste.
 */

type GetType = string | { type?: string } | undefined;

function wantsJson(type: GetType): boolean {
  return type === "json" || (typeof type === "object" && type !== null && type.type === "json");
}

/** Limite de metadata por chave do KV da Cloudflare, em bytes do JSON. */
export const KV_METADATA_MAX_BYTES = 1024;

export interface TrackedKvOptions {
  /**
   * List paginado (#14058): no máximo `listPageSize` chaves por página, em
   * ordem lexicográfica como o KV real, com `cursor` = offset da próxima
   * página. Sem a opção, `list` devolve tudo numa página, em ordem de inserção.
   */
  listPageSize?: number;
}

type PutOpts = { expirationTtl?: number; metadata?: unknown };

/** KV mínimo em memória que rastreia opts do put (incluindo expirationTtl). */
export function makeTrackedKv(initial: Record<string, string> = {}, options: TrackedKvOptions = {}) {
  const store = new Map<string, string>(Object.entries(initial));
  const meta = new Map<string, unknown>();
  const puts: Array<{ key: string; value: string; opts?: PutOpts }> = [];
  const fail = (op: "get" | "put" | "list") => {
    const on = op === "get" ? kv.failGet : op === "put" ? kv.failPut : kv.failList;
    if (on) throw new Error(kv.failMessage);
  };
  // Overload: sem `type` o retorno segue `string | null` (contrato de antes do
  // #14058 para os importadores existentes); com `"json"` vem o valor parseado.
  function get(key: string): Promise<string | null>;
  function get(key: string, type: GetType): Promise<unknown>;
  async function get(key: string, type?: GetType): Promise<unknown> {
    fail("get");
    const value = store.get(key);
    if (value === undefined) return null;
    return wantsJson(type) ? JSON.parse(value) : value;
  }
  const kv = {
    puts,
    /** O `Map` interno, para asserções e seeds diretos no teste (#14058). */
    _map: store,
    /** Metadata gravada por chave via `put(..., { metadata })` (#14058). */
    _meta: meta,
    /** Falha injetada (#14058): a operação lança `Error(failMessage)`. */
    failGet: false,
    failPut: false,
    failList: false,
    failMessage: "kv fora",
    get,
    async getWithMetadata(key: string) {
      fail("get");
      return { value: store.get(key) ?? null, metadata: meta.get(key) ?? null };
    },
    async put(key: string, value: string, opts?: PutOpts) {
      fail("put");
      if (
        opts?.metadata !== undefined &&
        new TextEncoder().encode(JSON.stringify(opts.metadata)).length > KV_METADATA_MAX_BYTES
      ) {
        throw new Error("metadata too large");
      }
      puts.push({ key, value, opts });
      store.set(key, value);
      if (opts?.metadata !== undefined) meta.set(key, opts.metadata);
      else meta.delete(key);
    },
    async delete(key: string) {
      store.delete(key);
      meta.delete(key);
    },
    async list({ prefix = "", cursor }: { prefix?: string; cursor?: string } = {}) {
      fail("list");
      const names = [...store.keys()].filter((k) => k.startsWith(prefix));
      const entry = (name: string) => (meta.has(name) ? { name, metadata: meta.get(name) } : { name });
      const size = options.listPageSize;
      if (size === undefined) {
        return { keys: names.map(entry), list_complete: true, cursor: undefined as string | undefined };
      }
      names.sort();
      const start = cursor ? Number(cursor) : 0;
      const end = Math.min(names.length, start + size);
      const done = end >= names.length;
      return { keys: names.slice(start, end).map(entry), list_complete: done, cursor: done ? undefined : String(end) };
    },
  };
  return kv;
}

export type TrackedKv = ReturnType<typeof makeTrackedKv>;

/**
 * Seed de valores serializados com `JSON.stringify`, para os testes de KV que
 * guardam JSON e montam o estado inicial como objetos (#14058).
 */
export function jsonSeed(entries: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, JSON.stringify(v)]));
}

/**
 * O mesmo stub de `makeTrackedKv`, tipado como `KVNamespace` para entrar
 * direto num `Env` de worker (#14058). O cast fica aqui, uma vez, em vez de
 * em cada arquivo de teste.
 */
export function makeTrackedKvNamespace(
  initial: Record<string, string> = {},
  options: TrackedKvOptions = {},
): KVNamespace & TrackedKv {
  return makeTrackedKv(initial, options) as unknown as KVNamespace & TrackedKv;
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
