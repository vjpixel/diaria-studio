/**
 * brave-search.ts (#1555 — P0 full)
 *
 * Wrapper para Brave Search API (https://api.search.brave.com/res/v1/web/search).
 * Free tier: 2000 queries/mês, 1 query/segundo.
 *
 * API key em env `BRAVE_API_KEY` (lida no caller, passada como arg pra manter
 * a função pura/testável). Quando ausente, caller deve fallback pros agents.
 *
 * Doc: https://api-dashboard.search.brave.com/app/documentation/web-search/responses
 */

export interface BraveSearchOptions {
  apiKey: string;
  count?: number; // max 20, default 10
  country?: string; // default "us"
  search_lang?: string; // default "en"
  freshness?: "pd" | "pw" | "pm" | "py" | string; // "pd"=past day, "pw"=past week, etc.
  fetchFn?: typeof fetch; // injectable para tests
}

export interface BraveWebResult {
  title: string;
  url: string;
  description: string;
  page_age?: string; // ISO datetime string
  age?: string; // human-readable like "1 week ago"
  meta_url?: {
    hostname?: string;
  };
}

export interface BraveSearchResponse {
  results: BraveWebResult[];
  query: string;
  status: "ok" | "rate_limited" | "error";
  error_message?: string;
  http_status?: number;
  // (#2608 C) quota header from Brave API — X-RateLimit-Remaining
  quota_remaining?: number;
}

/**
 * Pure (com I/O injectable): chama Brave Search API e retorna resultados normalizados.
 * Throws nunca — retorna `status: "error"` com `error_message`.
 */
export async function braveSearch(
  query: string,
  opts: BraveSearchOptions,
): Promise<BraveSearchResponse> {
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(opts.count ?? 10));
  url.searchParams.set("country", opts.country ?? "us");
  url.searchParams.set("search_lang", opts.search_lang ?? "en");
  if (opts.freshness) url.searchParams.set("freshness", opts.freshness);

  const fetchFn = opts.fetchFn ?? fetch;

  try {
    const res = await fetchFn(url.toString(), {
      headers: {
        "X-Subscription-Token": opts.apiKey,
        Accept: "application/json",
      },
    });

    // (#2608 C) capture quota header to enable delta reconciliation (defensive: mock/test may lack headers)
    const quotaHeader = res.headers?.get?.("X-RateLimit-Remaining") ?? res.headers?.get?.("X-Ratelimit-Remaining") ?? null;
    const quota_remaining = quotaHeader !== null ? parseInt(quotaHeader, 10) : undefined;
    const quotaField = typeof quota_remaining === "number" && !isNaN(quota_remaining)
      ? { quota_remaining }
      : {};

    if (res.status === 429) {
      return { results: [], query, status: "rate_limited", http_status: 429, ...quotaField };
    }

    if (res.status >= 400) {
      const body = await res.text();
      return {
        results: [],
        query,
        status: "error",
        http_status: res.status,
        error_message: body.slice(0, 200),
        ...quotaField,
      };
    }

    const data = (await res.json()) as {
      web?: { results?: BraveWebResult[] };
    };

    const results = data.web?.results ?? [];
    return { results, query, status: "ok", http_status: res.status, ...quotaField };
  } catch (e) {
    return {
      results: [],
      query,
      status: "error",
      error_message: (e as Error).message,
    };
  }
}

/**
 * Pure: deriva freshness param do windowDays.
 * Brave aceita: "pd" (past day), "pw" (past week), "pm" (past month), "py" (past year),
 * ou range YYYY-MM-DDtoYYYY-MM-DD.
 */
export function freshnessForWindow(windowDays: number): string {
  if (windowDays <= 1) return "pd";
  if (windowDays <= 7) return "pw";
  if (windowDays <= 31) return "pm";
  return "py";
}
