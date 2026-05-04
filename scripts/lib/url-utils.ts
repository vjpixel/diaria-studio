/**
 * url-utils.ts
 *
 * Helpers de URL compartilhados por dedup.ts, verify-accessibility.ts,
 * apply-gate-edits.ts e expand-inbox-aggregators.ts.
 *
 * Centralizado para evitar implementacoes divergentes (#523).
 */

// Parametros de tracking removidos na canonicalizacao
const TRACKING_PARAM_PREFIXES = ["utm_"];
const TRACKING_PARAMS_EXACT = new Set(["ref", "ref_src"]);

/**
 * Remove tracking params, hash e normaliza pathname (trailing slash).
 * Tambem lowercasa scheme e hostname (case-insensitive por spec RFC 3986),
 * e normaliza URLs do arxiv de /pdf/ para /abs/.
 *
 * Retorna a URL original se invalida (sem lancar excecao).
 */
export function canonicalize(url: string): string {
  try {
    const u = new URL(url);
    // lowercase scheme e host (case-insensitive por spec)
    u.protocol = u.protocol.toLowerCase();
    u.hostname = u.hostname.toLowerCase();
    // remove tracking params
    for (const key of [...u.searchParams.keys()]) {
      if (
        TRACKING_PARAM_PREFIXES.some((prefix) => key.startsWith(prefix)) ||
        TRACKING_PARAMS_EXACT.has(key)
      ) {
        u.searchParams.delete(key);
      }
    }
    // remove fragment
    u.hash = "";
    // remove trailing slash no pathname (exceto root "/")
    if (u.pathname.length > 1 && u.pathname.endsWith("/")) {
      u.pathname = u.pathname.slice(0, -1);
    }
    // normaliza arxiv: /pdf/ID.pdf para /abs/ID
    if (u.hostname === "arxiv.org" && u.pathname.startsWith("/pdf/")) {
      u.pathname = u.pathname.replace(/^\/pdf\//, "/abs/").replace(/\.pdf$/, "");
    }
    return u.toString();
  } catch {
    return url;
  }
}

/**
 * Extrai o hostname sem www.
 * Retorna null se a URL for invalida.
 */
export function extractHost(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

/**
 * Retorna true se as duas URLs sao equivalentes apos canonicalizacao.
 */
export function urlsMatch(a: string, b: string): boolean {
  return canonicalize(a) === canonicalize(b);
}
