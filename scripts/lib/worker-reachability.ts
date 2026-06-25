/**
 * worker-reachability.ts (#2551)
 *
 * Helper resiliente a filtro de DNS local para checar se um Cloudflare Worker
 * está acessível. Distingue entre "Worker realmente down" e "DNS local filtrando
 * o hostname" — caso que causou falso-positivo de down na edição 260625.
 *
 * Algoritmo:
 * 1. Tenta `fetch(url)` nativo (fast path, funciona quando DNS UDP/53 OK).
 * 2. Se falhar por DNS/connect: resolve via DoH (Cloudflare/Google) para obter
 *    IP anycast.
 * 3. Se DoH resolve → conecta no IP via SNI para confirmar que o Worker serve.
 *    - UP: `{ up: true, local_dns_filtered: true, via: "doh_anycast" }`
 *    - DOWN (HTTP error): `{ up: false, local_dns_filtered: true, ... }`
 * 4. Se DoH também falhar → `{ up: false, local_dns_filtered: false, via: "doh_anycast" }`.
 * 5. Só declarar down se step 1 E step 3 ambos falharem (ou DoH falhar).
 *
 * Design para testabilidade: aceita `deps` injetáveis (DI) com os fetchers e
 * resolver — permite testes sem rede real (mock DNS timeout + DoH resolve + HTTP 200).
 *
 * Uso:
 *   import { isWorkerReachable } from "./lib/worker-reachability.ts";
 *   const r = await isWorkerReachable("https://poll.diaria.workers.dev/health");
 *   if (!r.up && r.local_dns_filtered) {
 *     console.warn("[worker] DNS local filtrando — Worker pode estar UP");
 *   }
 */

import { isDnsOrConnectError, resolveViaDoH, fetchViaIp } from "./doh-fetch.ts";

export interface WorkerReachabilityResult {
  up: boolean;
  /** true quando o resolver DNS local não resolveu mas DoH conseguiu */
  local_dns_filtered: boolean;
  /** como a confirmação foi feita */
  via: "direct" | "doh_anycast" | "none";
  /** HTTP status code quando disponível */
  status?: number;
  /** detalhe do erro quando down */
  error?: string;
}

/** Dependências injetáveis para testabilidade sem rede real */
export interface WorkerReachabilityDeps {
  /**
   * Fetch nativo (UDP/53). Deve lançar erro com isDnsOrConnectError quando DNS falha.
   * Default: window.fetch / global fetch.
   */
  nativeFetch?: (url: string) => Promise<{ ok: boolean; status: number }>;
  /**
   * Resolve hostname via DoH. Retorna IP ou lança Error se DoH também falhar.
   * Default: resolveViaDoH from doh-fetch.ts.
   */
  dohResolve?: (hostname: string) => Promise<string>;
  /**
   * Fetch via anycast IP (bypass DNS local). Recebe `url` com hostname original
   * e `resolvedIp` para conectar.
   * Default: dohFetch from doh-fetch.ts (já faz SNI correto).
   */
  anycastFetch?: (url: string, resolvedIp: string) => Promise<{ ok: boolean; status: number }>;
  /** Timeout para o fetch nativo em ms (default 10_000) */
  nativeFetchTimeoutMs?: number;
}

const NATIVE_TIMEOUT_MS = 10_000;

/**
 * Verifica se um Worker Cloudflare está acessível, com fallback resiliente
 * a filtro de DNS local. Retorna diagnóstico detalhado.
 *
 * @param url URL HTTPS do endpoint a checar (ex: "/health" ou "/stats?edition=...")
 * @param deps Dependências injetáveis (DI) para testes sem rede real
 */
export async function isWorkerReachable(
  url: string,
  deps: WorkerReachabilityDeps = {},
): Promise<WorkerReachabilityResult> {
  const timeoutMs = deps.nativeFetchTimeoutMs ?? NATIVE_TIMEOUT_MS;

  // Step 1: tentativa nativa (DNS local)
  const nativeFetchImpl =
    deps.nativeFetch ??
    (async (u: string) => {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(u, { signal: controller.signal });
        return { ok: res.ok, status: res.status };
      } finally {
        clearTimeout(t);
      }
    });

  try {
    const res = await nativeFetchImpl(url);
    return {
      up: res.ok,
      local_dns_filtered: false,
      via: "direct",
      status: res.status,
      ...(!res.ok ? { error: `HTTP ${res.status}` } : {}),
    };
  } catch (err) {
    // AbortError (name === 'AbortError') acontece quando o AbortController de timeout
    // acima dispara — causado por DNS filtrado por drop de pacotes UDP/53 (silent hang).
    // Esse cenário NÃO é reconhecido por isDnsOrConnectError (que só checa string codes
    // como ENOTFOUND/ETIMEDOUT), mas é igualmente candidato a filtro DNS local.
    // Tratar como DNS-filter candidate para acionar o retry via DoH (#2574).
    const isAbortError =
      err instanceof Error && (err.name === "AbortError" || (err as { code?: unknown }).code === 20);

    // Não é erro de DNS/connect nem AbortError — é outro problema (TLS, etc).
    // Tratar como down sem suspeita de filtro DNS.
    if (!isDnsOrConnectError(err) && !isAbortError) {
      return {
        up: false,
        local_dns_filtered: false,
        via: "none",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // Step 2: DNS local falhou — tentar resolver via DoH
  const parsed = new URL(url);
  const dohResolveImpl = deps.dohResolve ?? resolveViaDoH;

  let resolvedIp: string;
  try {
    resolvedIp = await dohResolveImpl(parsed.hostname);
  } catch (dohErr) {
    // DoH também falhou → certamente down (não só filtro local)
    return {
      up: false,
      local_dns_filtered: false,
      via: "doh_anycast",
      error: `local DNS failed + DoH failed: ${dohErr instanceof Error ? dohErr.message : String(dohErr)}`,
    };
  }

  // Step 3: DoH resolveu → confirmar via anycast IP
  const anycastFetchImpl =
    deps.anycastFetch ??
    (async (u: string, ip: string) => {
      // Usa o IP já resolvido no step 2 para conectar diretamente, sem 3ª tentativa
      // de DNS nativo. fetchViaIp preserva o hostname original no Host header + SNI (#2577).
      const res = await fetchViaIp(u, ip);
      return { ok: res.ok, status: res.status };
    });

  try {
    const res = await anycastFetchImpl(url, resolvedIp);
    return {
      up: res.ok,
      local_dns_filtered: true,
      via: "doh_anycast",
      status: res.status,
      ...(!res.ok ? { error: `HTTP ${res.status} via anycast` } : {}),
    };
  } catch (anycastErr) {
    return {
      up: false,
      local_dns_filtered: true,
      via: "doh_anycast",
      error: `local DNS filtered + anycast failed: ${anycastErr instanceof Error ? anycastErr.message : String(anycastErr)}`,
    };
  }
}
