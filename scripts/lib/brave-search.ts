/**
 * brave-search.ts (#1555 — P0 full)
 *
 * Wrapper para Brave Search API (https://api.search.brave.com/res/v1/web/search).
 * Plano Postpaid (pay-as-you-go, confirmado #7943): $5,00/1000 requests, com
 * $5,00 de crédito grátis por mês (~1000 requests) — NÃO é um free tier com
 * hard cap de queries, e o plano NUNCA bloqueia (só fatura acima do crédito
 * grátis). Rate limit da API é 1 query/segundo, independente de billing — ver
 * `scripts/lib/brave-credits.ts` para o modelo de alerta de custo.
 *
 * API key em env `BRAVE_API_KEY` (lida no caller, passada como arg pra manter
 * a função pura/testável). Quando ausente, caller deve fallback pros agents.
 *
 * (#7943, achado ao vivo 260915) Esta conta reporta `X-RateLimit-Limit: "50, 0"`
 * — janela mensal com LIMITE 0 (sentinela "sem cap", coerente com Postpaid).
 * `X-RateLimit-Remaining` correspondente vem sempre "49, 0": a janela mensal
 * fica travada em "0" porque não há cota mensal real pra decrescer, não porque
 * o uso é zero. Consequência: nenhum consumidor deste header (nem
 * `quota_remaining` nem `quota_limit_monthly`) tem sinal utilizável de uso
 * MENSAL nesta conta — só a janela por-segundo é informativa, e nada aqui a
 * expõe (não é o que o alerta/reconcile de `brave-credits.ts` precisam). Ver
 * `computeBraveCreditStats`/`reconcile-brave-path-b.ts` para como isso é
 * detectado e tratado como "sem sinal", não como "uso zero".
 *
 * Doc: https://api-dashboard.search.brave.com/app/documentation/web-search/responses
 * Doc rate-limit headers: https://api-dashboard.search.brave.com/documentation/guides/rate-limiting
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
  // (#2608 C, re-parsed #7943) quota header from Brave API — X-RateLimit-Remaining,
  // MONTHLY window (2nd comma-separated value — see parseRateLimitCsvHeader below).
  quota_remaining?: number;
  // (#7943) X-RateLimit-Limit, MONTHLY window — 0 means the account has no hard
  // monthly cap (Postpaid/pay-as-you-go), which makes `quota_remaining` above
  // permanently uninformative (Brave reports it as a flat "0" too, not a real
  // countdown). Consumers must check this before trusting `quota_remaining` for
  // reconciliation — see scripts/lib/brave-credits.ts.
  quota_limit_monthly?: number;
}

/**
 * Parses a Brave rate-limit header value and returns the value for a given
 * comma-separated window index. Brave documents these headers as CSV, one
 * value per rate-limit window — for this account, `"49, 0"` means "49 of 50
 * requests left in the current 1-second window, 0 of 0 in the monthly window"
 * (https://api-dashboard.search.brave.com/documentation/guides/rate-limiting).
 *
 * `parseInt(header, 10)` alone silently returns only the FIRST token — this
 * was the actual bug (#7943 residual, and the root cause the #3707 comment in
 * brave-credits.ts already suspected but never fixed at the source): it read
 * the near-constant per-second remaining (e.g. "49", refilling between calls)
 * as if it were the monthly counter, producing a `real_used` that never moved
 * (`HEADER_QUOTA_CYCLE_SIZE - 49` = a fixed 1951 — exactly the false "1951/2000"
 * alarm from edição 260708 documented in reconcile-brave-path-b.ts).
 *
 * `windowIndex`: 0 = per-second window (1st value), 1 = monthly window (2nd
 * value). Returns `undefined` when the requested index isn't present (header
 * absent, malformed, or — defensively — only one value, e.g. an older API
 * shape/a test mock) rather than falling back to the wrong window.
 */
export function parseRateLimitCsvHeader(raw: string, windowIndex: 0 | 1): number | undefined {
  const parts = raw.split(",").map((p) => Number.parseInt(p.trim(), 10));
  const value = parts[windowIndex];
  return typeof value === "number" && !Number.isNaN(value) ? value : undefined;
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

    // (#2608 C, re-parsed #7943) capture quota headers to enable delta reconciliation
    // (defensive: mock/test may lack headers). Both are CSV "<per-second>, <monthly>" —
    // see parseRateLimitCsvHeader above for why windowIndex=1 (monthly) matters.
    const remainingHeader = res.headers?.get?.("X-RateLimit-Remaining") ?? res.headers?.get?.("X-Ratelimit-Remaining") ?? null;
    const limitHeader = res.headers?.get?.("X-RateLimit-Limit") ?? res.headers?.get?.("X-Ratelimit-Limit") ?? null;
    const quota_remaining = remainingHeader !== null ? parseRateLimitCsvHeader(remainingHeader, 1) : undefined;
    const quota_limit_monthly = limitHeader !== null ? parseRateLimitCsvHeader(limitHeader, 1) : undefined;
    const quotaField = {
      ...(typeof quota_remaining === "number" ? { quota_remaining } : {}),
      ...(typeof quota_limit_monthly === "number" ? { quota_limit_monthly } : {}),
    };

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
