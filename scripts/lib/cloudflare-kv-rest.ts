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
 *   - `delete(key)`   404 → ok (idempotente); outro erro lança;
 *   - `probe()`       1 GET de `keys?limit=10` — checa que o token lê o
 *                     namespace, sem escrever nada (usado por `--check-auth`).
 *
 * As mensagens de erro nunca incluem o token: só método, chave, status e o
 * texto de `errors[]` que a Cloudflare devolve.
 *
 * `fetchFn` é injetável pra teste (nenhum teste fala com a Cloudflare real).
 * Os scripts mais antigos que falam com o KV por REST (`migrate-nickname-index.ts`,
 * `rebuild-stats.ts`, `backfill-*.ts`) têm cada um sua cópia inline; migrá-los
 * pra cá fica fora deste escopo.
 */

export type KvFetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface KvRestConfig {
  accountId: string;
  token: string;
  namespaceId: string;
  fetchFn?: KvFetch;
}

export interface KvRestOps {
  list: (prefix: string) => Promise<string[]>;
  get: (key: string) => Promise<string | null>;
  put: (key: string, value: string) => Promise<void>;
  delete: (key: string) => Promise<void>;
  probe: () => Promise<void>;
}

interface CfEnvelope {
  success?: boolean;
  errors?: Array<{ code?: number; message?: string }>;
  result?: Array<{ name: string }>;
  result_info?: { cursor?: string; count?: number };
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

export function createKvRestOps(cfg: KvRestConfig): KvRestOps {
  if (!cfg.accountId || !cfg.token || !cfg.namespaceId) {
    throw new Error("createKvRestOps: accountId, token e namespaceId são obrigatórios");
  }
  const fetchFn: KvFetch = cfg.fetchFn ?? ((url, init) => fetch(url, init));
  const base = `${API_BASE}/accounts/${encodeURIComponent(cfg.accountId)}/storage/kv/namespaces/${encodeURIComponent(cfg.namespaceId)}`;
  const auth = { Authorization: `Bearer ${cfg.token}` };
  const valueUrl = (key: string) => `${base}/values/${encodeURIComponent(key)}`;

  async function listPage(prefix: string | null, limit: number, cursor?: string): Promise<CfEnvelope> {
    const params = new URLSearchParams({ limit: String(limit) });
    if (prefix) params.set("prefix", prefix);
    if (cursor) params.set("cursor", cursor);
    const res = await fetchFn(`${base}/keys?${params}`, { headers: auth });
    if (!res.ok) {
      throw new Error(`KV REST list (prefix "${prefix ?? ""}") falhou: HTTP ${res.status} — ${await errorDetail(res)}`);
    }
    const json = (await res.json()) as CfEnvelope;
    if (json.success === false || !Array.isArray(json.result)) {
      throw new Error(`KV REST list (prefix "${prefix ?? ""}") devolveu envelope inválido: ${JSON.stringify(json.errors ?? [])}`);
    }
    return json;
  }

  return {
    async list(prefix) {
      const names: string[] = [];
      let cursor: string | undefined;
      const seen = new Set<string>();
      do {
        const page = await listPage(prefix, LIST_PAGE_LIMIT, cursor);
        for (const k of page.result!) names.push(k.name);
        cursor = page.result_info?.cursor || undefined;
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
      // limit mínimo aceito pela API de keys é 10.
      await listPage(null, 10);
    },
  };
}
