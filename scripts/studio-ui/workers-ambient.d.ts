/**
 * workers-ambient.d.ts (#3563)
 *
 * Shim ambiente para os poucos globals do runtime Cloudflare Workers
 * (`KVNamespace`, `CacheStorage.default`) que `workers/diaria-dashboard/src/index.ts`
 * e `workers/brevo-dashboard/src/*.ts` assumem disponíveis via
 * `@cloudflare/workers-types` — instalado só no `node_modules` PRÓPRIO de
 * cada worker (`workers/{nome}/package-lock.json`, projeto wrangler separado), não
 * hoisted pro `node_modules` da raiz.
 *
 * #3563 é a primeira fatia a importar esses módulos como VALOR (`import {
 * renderDashboardHtml } from "...index.ts"`, não `import type`) a partir de
 * `scripts/**`, pelos painéis embutidos do studio-server
 * (`dashboard-diaria.ts`/`dashboard-clarice.ts`). Isso faz `npx tsc --noEmit`
 * (raiz, `tsconfig.json` com `include: ["scripts/**\/*.ts"]`) passar a checar
 * o CORPO INTEIRO desses arquivos pela primeira vez (TS segue imports
 * transitivamente independente do `include`) — expondo os globals ausentes,
 * que nunca precisaram existir no projeto raiz antes (código morto do ponto
 * de vista do root project até esta fatia).
 *
 * Shim MÍNIMO — só a superfície de fato usada pelos call sites importados
 * aqui (confirmado por grep em ambos os workers: `.get`/`.put`/`.delete`
 * — `.delete` adicionado em #3644 (`releaseRefreshLock`, brevo-dashboard);
 * nenhum `.list`/`.getWithMetadata`). NÃO substitui
 * `@cloudflare/workers-types` (cada worker mantém a dependência real no
 * próprio `tsconfig.json`/`node_modules`, usada pelo deploy via `wrangler`) —
 * só o suficiente para o `tsc` da raiz não quebrar ao seguir os imports.
 *
 * Sem `import`/`export` no topo do arquivo — as declarações abaixo são
 * globais ambientes automaticamente (script, não módulo).
 */

interface KVNamespacePutOptions {
  expiration?: number;
  expirationTtl?: number;
  metadata?: unknown;
}

interface KVNamespace {
  get(key: string, type?: "text"): Promise<string | null>;
  get<ExpectedValue = unknown>(key: string, type: "json"): Promise<ExpectedValue | null>;
  get(key: string, type: "arrayBuffer"): Promise<ArrayBuffer | null>;
  get(key: string, type: "stream"): Promise<ReadableStream | null>;
  put(
    key: string,
    value: string | ArrayBuffer | ArrayBufferView | ReadableStream,
    options?: KVNamespacePutOptions,
  ): Promise<void>;
  delete(key: string): Promise<void>;
}

interface CacheStorage {
  default: Cache;
}
