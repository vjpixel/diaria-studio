/**
 * test/types/workers-durable-objects-ambient.d.ts (#14064)
 *
 * Shim ambiente MÍNIMO dos tipos de Durable Object (e do `KVNamespaceListResult`)
 * que o Worker `poll` usa, para o typecheck do ratchet
 * (`tsconfig.test.json`, `scripts/typecheck-ratchet.ts`).
 *
 * O Worker declara `types: ["@cloudflare/workers-types"]` só no próprio
 * `workers/poll/tsconfig.json` (o deploy via `wrangler` usa esse). O
 * `tsconfig.test.json` compila `workers/poll/src/*` e os testes dele sem esses
 * globais, e cada `DurableObjectState`/`DurableObjectNamespace`/... virava
 * TS2304 aceito no `tsc-baseline.json` (159 dos erros aceitos), escondendo os
 * erros reais atrás deles.
 *
 * Por que não `types: ["@cloudflare/workers-types"]` no `tsconfig.test.json`:
 * o pacote redeclara `Request`/`Response`/`fetch`/... globais e brigaria com
 * os tipos do Node que `scripts/**` e `test/**` usam. Mesma escolha do shim
 * de KV de `scripts/studio-ui/workers-ambient.d.ts` (#3563), que já vale para
 * os dois tsconfigs e define `KVNamespace`.
 *
 * Superfície: só o que `workers/poll/src` e os testes de poll chamam
 * (`idFromName`/`get`/`fetch`, `storage.get|put|delete|deleteAll`,
 * `blockConcurrencyWhile`), com as assinaturas do runtime real. NÃO substitui
 * `@cloudflare/workers-types` no deploy. Membro novo usado pelo Worker que
 * falte aqui aparece como erro novo no ratchet, que é o sinal certo para
 * acrescentá-lo.
 *
 * Fora de `scripts/**` de propósito: o `tsconfig.json` raiz (`npx tsc
 * --noEmit`) não compila o Worker `poll`, então não precisa destes globais.
 *
 * Sem `import`/`export` no topo do arquivo: as declarações são globais
 * ambientes (script, não módulo).
 */

interface DurableObjectId {
  toString(): string;
  equals(other: DurableObjectId): boolean;
  readonly name?: string;
}

interface DurableObjectStub {
  readonly id: DurableObjectId;
  readonly name?: string;
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

interface DurableObjectNamespace {
  idFromName(name: string): DurableObjectId;
  idFromString(id: string): DurableObjectId;
  newUniqueId(): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub;
}

interface DurableObjectStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  get<T = unknown>(keys: string[]): Promise<Map<string, T>>;
  put<T>(key: string, value: T): Promise<void>;
  put<T>(entries: Record<string, T>): Promise<void>;
  delete(key: string): Promise<boolean>;
  delete(keys: string[]): Promise<number>;
  deleteAll(): Promise<void>;
}

interface DurableObjectState {
  readonly id: DurableObjectId;
  readonly storage: DurableObjectStorage;
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
  waitUntil(promise: Promise<unknown>): void;
}

/**
 * Formato devolvido por `KVNamespace.list` — compatível com o `list` do shim
 * de `scripts/studio-ui/workers-ambient.d.ts`, que é o `KVNamespace` que o
 * typecheck enxerga (`workers/poll/src/leaderboard-routes.ts` anota o retorno
 * com este nome).
 */
interface KVNamespaceListResult<Metadata = unknown, Key extends string = string> {
  keys: { name: Key; expiration?: number; metadata?: Metadata }[];
  list_complete: boolean;
  cursor?: string;
}
