/**
 * cloudflare-kv-rest.ts (#11253)
 *
 * Cliente mínimo do KV da Cloudflare pela API REST
 * (`/client/v4/accounts/{account}/storage/kv/namespaces/{ns}/keys|values/{key}`),
 * com `Authorization: Bearer {token}`. Nasceu pra `purge-leaderboard.ts`
 * operar o KV do POLL numa máquina sem `wrangler login` (o servidor `300`,
 * #11253) — o login OAuth do wrangler precisa de navegador.
 *
 * Semântica (a mesma que o backend wrangler de `purge-leaderboard.ts` já
 * tinha, pra os dois backends serem intercambiáveis):
 *   - `list(prefix)`  pagina por `cursor` até esgotar (limit 1000/página);
 *   - `get(key)`      404 → `null` (chave inexistente); outro erro lança;
 *   - `put(key, v)`   lança em status != 2xx;
 *   - `delete(key)`   idempotente — a Cloudflare já responde 200 pra chave
 *                     inexistente; um 404 (namespace/rota) também é tratado
 *                     como ok, por defesa; outro erro lança;
 *   - `probe()`       checa LEITURA e ESCRITA: 1 GET de `keys?limit=10` e
 *                     depois PUT + DELETE da chave sentinela
 *                     `KV_PROBE_SENTINEL_KEY` (usado por `--check-auth`). A
 *                     sentinela não casa com nenhum prefixo que o Worker POLL
 *                     lê (`score:`, `vote:`, `stats:`...), então o probe não
 *                     afeta dado nenhum; se o DELETE falhar, ela fica órfã e
 *                     inofensiva, e o probe lança.
 *
 * Toda request tem timeout (`timeoutMs`, default 30s, via `AbortSignal.timeout`)
 * — um `fetch` pendurado travaria o §6h do Stage 6.
 *
 * As mensagens de erro nunca incluem o token: só método, chave, status e o
 * texto de `errors[]` que a Cloudflare devolve.
 *
 * `fetchFn` é injetável pra teste (nenhum teste fala com a Cloudflare real).
 * Outros pontos que falam com o KV por REST têm cada um sua cópia inline
 * (`migrate-nickname-index.ts`, `rebuild-stats.ts`, `backfill-score-by-month.ts`,
 * `backfill-seq-state.ts`, `coupon-clarice-class.ts`,
 * `build-diaria-dashboard-data.ts`, `lib/cloudflare-kv-upload.ts` — conferido
 * por `grep storage/kv/namespaces` em 27/10/2026); migrá-los pra cá fica fora
 * deste escopo.
 */

export type KvFetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface KvRestConfig {
  accountId: string;
  token: string;
  namespaceId: string;
  fetchFn?: KvFetch;
  /** Timeout por request, em ms (default `KV_REST_TIMEOUT_MS`). */
  timeoutMs?: number;
}

/**
 * Contrato comum aos dois backends de KV de `purge-leaderboard.ts` (REST
 * aqui, wrangler no próprio script) — os dois são checados contra o mesmo
 * tipo em compilação.
 */
export interface KvOps {
  list: (prefix: string) => Promise<string[]>;
  /** `null` = chave inexistente; qualquer outro erro lança. */
  get: (key: string) => Promise<string | null>;
  put: (key: string, value: string) => Promise<void>;
  /** Idempotente: chave inexistente não é erro. */
  delete: (key: string) => Promise<void>;
  /** Checa leitura E escrita no namespace sem tocar dado real; lança se falhar. */
  probe: () => Promise<void>;
}

/** @deprecated alias histórico — use `KvOps`. */
export type KvRestOps = KvOps;

/** Chave sentinela do probe de escrita (PUT + DELETE). */
export const KV_PROBE_SENTINEL_KEY = "__purge_probe__";
export const KV_REST_TIMEOUT_MS = 30_000;

interface CfEnvelope {
  success?: boolean;
  errors?: Array<{ code?: number; message?: string }>;
  result?: Array<{ name: string }>;
  result_info?: { cursor?: string; count?: number };
}

/** Página de `keys` já validada: `result` garantidamente é array. */
interface KeysPage {
  names: string[];
  cursor: string | undefined;
}

const API_BASE = "https://api.cloudflare.com/client/v4";
const LIST_PAGE_LIMIT = 1000;

async function errorDetail(res: Response): Promise<string> {
  try {
    const text = await res.text();
    try {
      const json = JSON.parse(text) as CfEnvelope;
      const msgs = (json.errors ?? []).map((e) => `${e.code ?? "?"}: ${e.message ?? ""}`.trim());
      if (msgs.length > 0) return msgs.join("; ");
    } catch {
      /* corpo não-JSON: devolve o texto cru, truncado */
    }
    return text.slice(0, 300);
  } catch {
    return "(corpo ilegível)";
  }
}

async function discardBody(res: Response): Promise<void> {
  // #9991: corpo não lido segura o socket e atrasa a saída do processo.
  await res.body?.cancel().catch(() => {});
}

export function createKvRestOps(cfg: KvRestConfig): KvOps {
  if (!cfg.accountId || !cfg.token || !cfg.namespaceId) {
    throw new Error("createKvRestOps: accountId, token e namespaceId são obrigatórios");
  }
  const rawFetch: KvFetch = cfg.fetchFn ?? ((url, init) => fetch(url, init));
  const timeoutMs = cfg.timeoutMs ?? KV_REST_TIMEOUT_MS;
  const fetchFn: KvFetch = (url, init) => rawFetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const base = `${API_BASE}/accounts/${encodeURIComponent(cfg.accountId)}/storage/kv/namespaces/${encodeURIComponent(cfg.namespaceId)}`;
  const auth = { Authorization: `Bearer ${cfg.token}` };
  const valueUrl = (key: string) => `${base}/values/${encodeURIComponent(key)}`;

  async function listPage(prefix: string | null, limit: number, cursor?: string): Promise<KeysPage> {
    const params = new URLSearchParams({ limit: String(limit) });
    if (prefix) params.set("prefix", prefix);
    if (cursor) params.set("cursor", cursor);
    const op = `KV REST list (prefix "${prefix ?? ""}")`;
    const res = await fetchFn(`${base}/keys?${params}`, { headers: auth });
    if (!res.ok) {
      throw new Error(`${op} falhou: HTTP ${res.status} — ${await errorDetail(res)}`);
    }
    const text = await res.text();
    let json: CfEnvelope;
    try {
      json = JSON.parse(text) as CfEnvelope;
    } catch {
      throw new Error(`${op} devolveu HTTP ${res.status} com corpo não-JSON: ${text.slice(0, 200)}`);
    }
    if (json === null || typeof json !== "object" || json.success === false || !Array.isArray(json.result)) {
      throw new Error(`${op} devolveu envelope inválido: ${JSON.stringify(json?.errors ?? [])}`);
    }
    return { names: json.result.map((k) => k.name), cursor: json.result_info?.cursor || undefined };
  }

  const ops: KvOps = {
    async list(prefix) {
      const names: string[] = [];
      let cursor: string | undefined;
      const seen = new Set<string>();
      do {
        const page = await listPage(prefix, LIST_PAGE_LIMIT, cursor);
        names.push(...page.names);
        cursor = page.cursor;
        // Guard contra cursor que se repete (API defeituosa) — evita loop infinito.
        if (cursor) {
          if (seen.has(cursor)) throw new Error(`KV REST list: cursor repetido (${cursor}) — abortando paginação`);
          seen.add(cursor);
        }
      } while (cursor);
      return names;
    },

    async get(key) {
      const res = await fetchFn(valueUrl(key), { headers: auth });
      if (res.status === 404) {
        await discardBody(res);
        return null;
      }
      if (!res.ok) throw new Error(`KV REST get ${key} falhou: HTTP ${res.status} — ${await errorDetail(res)}`);
      return await res.text();
    },

    async put(key, value) {
      const res = await fetchFn(valueUrl(key), {
        method: "PUT",
        headers: { ...auth, "Content-Type": "text/plain" },
        body: value,
      });
      if (!res.ok) throw new Error(`KV REST put ${key} falhou: HTTP ${res.status} — ${await errorDetail(res)}`);
      await discardBody(res);
    },

    async delete(key) {
      const res = await fetchFn(valueUrl(key), { method: "DELETE", headers: auth });
      if (res.status === 404) {
        await discardBody(res);
        return;
      }
      if (!res.ok) throw new Error(`KV REST delete ${key} falhou: HTTP ${res.status} — ${await errorDetail(res)}`);
      await discardBody(res);
    },

    async probe() {
      // Leitura: limit mínimo aceito pela API de keys é 10.
      await listPage(null, 10);
      // Escrita: o token pode ler sem poder gravar — a purga precisa dos dois.
      await ops.put(KV_PROBE_SENTINEL_KEY, new Date().toISOString());
      await ops.delete(KV_PROBE_SENTINEL_KEY);
    },
  };
  return ops;
}
