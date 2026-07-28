/**
 * cloudflare-kv-upload.ts (#1119)
 *
 * Upload de imagens pro KV do Worker `poll` via Cloudflare API.
 * Worker serve via `/img/{key}` com Content-Type: image/jpeg e Cache-Control
 * imutável — apropriado pra hotlink em email (Beehiiv, Brevo).
 *
 * Originalmente embutido em `publish-monthly.ts` (só pro digest Brevo).
 * Extraído pra lib em #1119 quando foi adicionado suporte pra newsletter
 * daily (publish via Beehiiv).
 *
 * Por que NÃO usar Google Drive:
 * - `drive.google.com/uc?id=...` retorna HTML wrapper na primeira request
 *   (proxy quirk), só serve bytes na 2ª. Clientes de email não esperam.
 * - Sem Cache-Control adequado.
 * - Throttle agressivo pra hotlink em volume.
 *
 * Cloudflare Worker KV é estável, imutável após upload (key-based), CDN-cached.
 */

import { readFileSync } from "node:fs";
import https from "node:https";
import { DIARIA_EIA_URL } from "./canonical-urls.ts"; // #3904

export interface CloudflareKVConfig {
  /** Account ID Cloudflare. Lê de process.env.CLOUDFLARE_ACCOUNT_ID por default. */
  accountId?: string;
  /** API token com permissão Workers KV. Lê de process.env.CLOUDFLARE_WORKERS_TOKEN. */
  token?: string;
  /** Namespace ID do KV (do wrangler.toml `[[kv_namespaces]] id`). */
  kvNamespaceId: string;
  /** URL pública do Worker (sem trailing slash). Default: https://eia.diar.ia.br
   * (domínio de marca, #3904; poll.diaria.workers.dev segue ativo só por
   * compat de links já enviados). */
  workerUrl?: string;
}

/**
 * Faz upload de um arquivo pro KV do Worker e retorna a URL pública servida
 * via `/img/{key}`. A chave (`key`) é fornecida pelo caller — deve ser única
 * por edição pra evitar colisão entre meses/dias.
 *
 * @param filePath caminho local do arquivo (jpg/png)
 * @param key chave KV única (ex: `img-260512-04-d1-2x1.jpg`)
 * @param cfg credenciais + namespace
 * @returns URL pública (`https://{workerUrl}/img/{key}`)
 *
 * @throws Error se credenciais faltam, ou se upload retorna status != 2xx
 */
export async function uploadImageToWorkerKV(
  filePath: string,
  key: string,
  cfg: CloudflareKVConfig,
): Promise<string> {
  const accountId = cfg.accountId ?? process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = cfg.token ?? process.env.CLOUDFLARE_WORKERS_TOKEN;
  const workerUrl = cfg.workerUrl ?? DIARIA_EIA_URL; // #3904

  if (!accountId || !token) {
    throw new Error(
      "uploadImageToWorkerKV: CLOUDFLARE_ACCOUNT_ID ou CLOUDFLARE_WORKERS_TOKEN não definidos. " +
        "Passar via cfg ou env.",
    );
  }
  if (!cfg.kvNamespaceId) {
    throw new Error("uploadImageToWorkerKV: cfg.kvNamespaceId obrigatório");
  }

  const buf = readFileSync(filePath);

  // https nativo (evita chunked-encoding quirk do fetch global em alguns Node builds)
  await new Promise<void>((resolve, reject) => {
    const req = https.request(
      {
        hostname: "api.cloudflare.com",
        path: `/client/v4/accounts/${accountId}/storage/kv/namespaces/${cfg.kvNamespaceId}/values/${encodeURIComponent(key)}`,
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/octet-stream",
          "Content-Length": buf.length,
        },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => (body += chunk.toString()));
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve();
          } else {
            reject(
              new Error(
                `Cloudflare KV upload de '${key}' falhou (${res.statusCode}): ${body}`,
              ),
            );
          }
        });
      },
    );
    req.on("error", reject);
    req.write(buf);
    req.end();
  });

  return `${workerUrl}/img/${encodeURIComponent(key)}`;
}

/**
 * #2426: grava um VALOR DE TEXTO (string) numa chave KV via Cloudflare API.
 * Análogo a uploadImageToWorkerKV, mas pra payloads de texto (ex: JSON de
 * coortes lido pelo worker clarice-dashboard) em vez de arquivo binário.
 *
 * Diferente de uploadImageToWorkerKV: o `key` aqui é a própria chave KV lida
 * pelo Worker via binding (`env.STATS_CACHE.get(key)`), não um path `/img/{key}`.
 * Não retorna URL — o consumo é server-side (binding), não hotlink HTTP.
 *
 * @param value          conteúdo (string já serializada, ex: JSON.stringify(...))
 * @param key            chave KV (ex: "cohorts:engagement")
 * @param cfg            credenciais + namespace + contentType opcional
 * @throws Error se credenciais faltam, ou se o PUT retorna status != 2xx
 */
export async function uploadTextToWorkerKV(
  value: string,
  key: string,
  cfg: CloudflareKVConfig & { contentType?: string },
): Promise<void> {
  const accountId = cfg.accountId ?? process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = cfg.token ?? process.env.CLOUDFLARE_WORKERS_TOKEN;

  if (!accountId || !token) {
    throw new Error(
      "uploadTextToWorkerKV: CLOUDFLARE_ACCOUNT_ID ou CLOUDFLARE_WORKERS_TOKEN não definidos. " +
        "Passar via cfg ou env.",
    );
  }
  if (!cfg.kvNamespaceId) {
    throw new Error("uploadTextToWorkerKV: cfg.kvNamespaceId obrigatório");
  }

  const buf = Buffer.from(value, "utf-8");
  const contentType = cfg.contentType ?? "text/plain; charset=utf-8";

  await new Promise<void>((resolve, reject) => {
    const req = https.request(
      {
        hostname: "api.cloudflare.com",
        path: `/client/v4/accounts/${accountId}/storage/kv/namespaces/${cfg.kvNamespaceId}/values/${encodeURIComponent(key)}`,
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": contentType,
          "Content-Length": buf.length,
        },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => (body += chunk.toString()));
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve();
          } else {
            reject(
              new Error(
                `Cloudflare KV upload de '${key}' falhou (${res.statusCode}): ${body}`,
              ),
            );
          }
        });
      },
    );
    req.on("error", reject);
    req.write(buf);
    req.end();
  });
}

/**
 * #4165/#4173: contraparte de LEITURA de `uploadTextToWorkerKV` — GET de uma
 * chave via Cloudflare API HTTP, mesmas credenciais (accountId+token).
 * Introduzida pro adaptador de KV real do Studio (`dashboard-clarice.ts`):
 * antes desta issue, o painel local só sabia ESCREVER no KV (scripts batch
 * como `clarice-engagement-cohorts.ts`); ler de volta exigia `wrangler kv key
 * get` manual no terminal.
 *
 * Usa `fetch` (injetável via `fetchImpl`, mesmo padrão de
 * `check-cloudflare-token.ts`) em vez do `https` nativo das funções de upload
 * acima — deliberado: precisa ser mockável em teste sem rede (as funções de
 * upload só têm cobertura de validação de input, nunca do round-trip HTTP).
 *
 * @returns o valor cru (string) da chave, ou `null` em 404 (miss — caso comum,
 * nunca tratado como erro). Lança em qualquer outra falha (credenciais
 * ausentes, rede, status != 200/404) — o caller decide a política de
 * fail-soft (ver `RemoteKvNamespace.get`, que envolve esta função num
 * try/catch e nunca deixa o painel depender de rede pra carregar).
 */
export async function getTextFromWorkerKV(
  key: string,
  cfg: CloudflareKVConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  const accountId = cfg.accountId ?? process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = cfg.token ?? process.env.CLOUDFLARE_WORKERS_TOKEN;

  if (!accountId || !token) {
    throw new Error(
      "getTextFromWorkerKV: CLOUDFLARE_ACCOUNT_ID ou CLOUDFLARE_WORKERS_TOKEN não definidos. " +
        "Passar via cfg ou env.",
    );
  }
  if (!cfg.kvNamespaceId) {
    throw new Error("getTextFromWorkerKV: cfg.kvNamespaceId obrigatório");
  }

  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${cfg.kvNamespaceId}/values/${encodeURIComponent(key)}`;
  const res = await fetchImpl(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(8000), // 8s — mesmo timeout de check-cloudflare-token.ts (fail-fast, não trava o render)
  });

  if (res.status === 404) return null; // key não existe — miss normal, não é erro
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Cloudflare KV read de '${key}' falhou (${res.status}): ${body.slice(0, 300)}`);
  }
  return await res.text();
}

/**
 * #4165/#4173: contraparte de ESCRITA fetch-based (injetável), com suporte a
 * `expirationTtl` — que `uploadTextToWorkerKV` (acima, `https` nativo) NÃO
 * tem. Necessário porque `RemoteKvNamespace.put` (usado pelo Studio) recebe
 * chamadas com TTL vindas de `brevo-api.ts` (ex: lock de coalescing de
 * refresh, cache de nomes de lista com TTL de 7d) — sem repassar o TTL, essas
 * chaves ficariam permanentes no MESMO namespace KV de produção que o
 * `clarice-dashboard` Worker também escreve, o que é pior que não escrever.
 *
 * Função nova (não uma extensão de `uploadTextToWorkerKV`) para não alterar o
 * comportamento/assinatura de um helper já usado por vários scripts em
 * produção (`build-poll-eia-data.ts`, `clarice-engagement-cohorts.ts`, etc.).
 */
export async function putTextToWorkerKV(
  key: string,
  value: string,
  cfg: CloudflareKVConfig & { expirationTtl?: number; contentType?: string },
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const accountId = cfg.accountId ?? process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = cfg.token ?? process.env.CLOUDFLARE_WORKERS_TOKEN;

  if (!accountId || !token) {
    throw new Error(
      "putTextToWorkerKV: CLOUDFLARE_ACCOUNT_ID ou CLOUDFLARE_WORKERS_TOKEN não definidos. " +
        "Passar via cfg ou env.",
    );
  }
  if (!cfg.kvNamespaceId) {
    throw new Error("putTextToWorkerKV: cfg.kvNamespaceId obrigatório");
  }

  const qs = cfg.expirationTtl ? `?expiration_ttl=${encodeURIComponent(String(cfg.expirationTtl))}` : "";
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${cfg.kvNamespaceId}/values/${encodeURIComponent(key)}${qs}`;
  const res = await fetchImpl(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": cfg.contentType ?? "text/plain; charset=utf-8",
    },
    body: value,
    signal: AbortSignal.timeout(8000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Cloudflare KV write de '${key}' falhou (${res.status}): ${body.slice(0, 300)}`);
  }
}

/**
 * #4186 (gap dormente P3): contraparte de EXCLUSÃO fetch-based, mesmo padrão
 * de `getTextFromWorkerKV`/`putTextToWorkerKV` acima. Necessária porque
 * `tryAcquireRefreshLock`/`releaseRefreshLock` (brevo-api.ts) chamam
 * `kv.delete(...)` -- antes desta função, `RemoteKvNamespace` não tinha
 * `delete` nenhum, então um call site futuro que exercitasse essa lógica a
 * partir do Studio lançaria `TypeError: kv.delete is not a function` sem
 * fail-soft. Hoje esses helpers só rodam a partir do Worker (`index.ts`),
 * nunca do Studio -- não é bug ATIVO, só um gap que fica fechado por
 * completude. Cloudflare KV DELETE responde 200 mesmo se a key já não
 * existir (idempotente) -- só um !res.ok real (rede/auth) é erro de fato.
 */
export async function deleteTextFromWorkerKV(
  key: string,
  cfg: CloudflareKVConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const accountId = cfg.accountId ?? process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = cfg.token ?? process.env.CLOUDFLARE_WORKERS_TOKEN;

  if (!accountId || !token) {
    throw new Error(
      "deleteTextFromWorkerKV: CLOUDFLARE_ACCOUNT_ID ou CLOUDFLARE_WORKERS_TOKEN não definidos. " +
        "Passar via cfg ou env.",
    );
  }
  if (!cfg.kvNamespaceId) {
    throw new Error("deleteTextFromWorkerKV: cfg.kvNamespaceId obrigatório");
  }

  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${cfg.kvNamespaceId}/values/${encodeURIComponent(key)}`;
  const res = await fetchImpl(url, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(8000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Cloudflare KV delete de '${key}' falhou (${res.status}): ${body.slice(0, 300)}`);
  }
}

/** Formato mínimo que os call sites de `brevo-api.ts`/`readKvTabs` esperam de
 * `env.STATS_CACHE` -- `get(key, "json"|"text")` e `put(key, value,
 * {expirationTtl})`, usados por praticamente toda leitura/escrita, e
 * `delete(key)` (#4186), usado só por `tryAcquireRefreshLock`/
 * `releaseRefreshLock` (hoje exclusivo do Worker; ver docstring de
 * `deleteTextFromWorkerKV` acima). Mesmo shape que `MemoryKv` (o stub em
 * `scripts/studio-ui/dashboard-clarice.ts`) já implementa. */
export interface MinimalKvNamespace {
  get(key: string, type?: "json" | "text"): Promise<unknown>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

/**
 * #4165/#4173: adaptador que fala com o namespace KV REAL do Cloudflare via
 * API HTTP, no lugar do `MemoryKv` em processo — é o que faz `cohorts`,
 * `mvStatus`(dead, ver #2736)/`couponUsage`/`eiaEngagement` deixarem de vir
 * `null` sempre no painel local (`dashboard-clarice.ts`).
 *
 * **Fail-soft por construção**: `get`/`put` NUNCA lançam — qualquer falha
 * (rede indisponível, token inválido/expirado, timeout, 5xx da Cloudflare)
 * é logada e degrada pro mesmo contrato de "miss" que um KV vazio já teria
 * (`get` → `null`; `put` → no-op). Isso é o que garante que o painel local
 * NUNCA passa a depender de rede pra carregar — na pior das hipóteses, ele
 * volta a se comportar como o `MemoryKv` de antes desta issue (todas as
 * abas KV-dependentes ficam null, mas a página carrega normalmente).
 */
export class RemoteKvNamespace implements MinimalKvNamespace {
  constructor(
    private cfg: CloudflareKVConfig,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  async get(key: string, type?: "json" | "text"): Promise<unknown> {
    let raw: string | null;
    try {
      raw = await getTextFromWorkerKV(key, this.cfg, this.fetchImpl);
    } catch (e) {
      console.error(
        `[RemoteKvNamespace] get('${key}') falhou — degradando pra null (fail-soft, #4165/#4173):`,
        e instanceof Error ? e.message : e,
      );
      return null;
    }
    if (raw === null) return null;
    if (type === "json") {
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    }
    return raw;
  }

  async put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void> {
    try {
      await putTextToWorkerKV(key, value, { ...this.cfg, expirationTtl: opts?.expirationTtl }, this.fetchImpl);
    } catch (e) {
      console.error(
        `[RemoteKvNamespace] put('${key}') falhou — no-op (fail-soft, #4165/#4173):`,
        e instanceof Error ? e.message : e,
      );
    }
  }

  /** #4186: fail-soft pelo mesmo motivo de `get`/`put` acima -- nunca lança. */
  async delete(key: string): Promise<void> {
    try {
      await deleteTextFromWorkerKV(key, this.cfg, this.fetchImpl);
    } catch (e) {
      console.error(
        `[RemoteKvNamespace] delete('${key}') falhou — no-op (fail-soft, #4186):`,
        e instanceof Error ? e.message : e,
      );
    }
  }
}

/**
 * Factory fail-soft: só retorna um `RemoteKvNamespace` quando as credenciais
 * Cloudflare (`CLOUDFLARE_ACCOUNT_ID`+`CLOUDFLARE_WORKERS_TOKEN`, ou
 * `cfg.accountId`/`cfg.token` explícitos) estão presentes — caller decide o
 * fallback (`MemoryKv`) quando `null`. Não faz nenhuma chamada de rede (só
 * checa presença das credenciais) — barato o suficiente pra chamar em todo
 * `buildEnv()`.
 */
export function createRemoteKvNamespace(
  kvNamespaceId: string,
  cfg: Partial<Pick<CloudflareKVConfig, "accountId" | "token">> = {},
): RemoteKvNamespace | null {
  const accountId = cfg.accountId ?? process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = cfg.token ?? process.env.CLOUDFLARE_WORKERS_TOKEN;
  if (!accountId || !token) return null;
  return new RemoteKvNamespace({ accountId, token, kvNamespaceId });
}
