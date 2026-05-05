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

/**
 * Remove pontuação de sentença no fim da URL extraída de prose/markdown (#626).
 *
 * Antes: `inject-inbox-urls.ts` e `inbox-drain.ts` tinham regex
 * `/[.,;:!?)]+$/` idêntica que strippava `)` de URLs Wikipedia balanceadas
 * (ex: `https://en.wikipedia.org/wiki/Häfeli_DH-5_(military)` virava
 * `..._(military` — quebrado).
 *
 * Strip:
 *   - `.,;:!?` no fim (sentence punctuation)
 *   - `)` no fim **só se desbalanceado** (mais `)` que `(` na URL — ex:
 *     prose tipo `(veja https://x.com)` → strip o `)` parens accidental)
 *
 * Preserva:
 *   - URLs Wikipedia balanceadas: `Foo_(bar)` mantém o `)`
 *   - Caminhos com parênteses balanceados em geral
 */
export function stripUrlTrailingPunct(url: string): string {
  let cleaned = url.replace(/[.,;:!?]+$/, "");
  while (cleaned.endsWith(")")) {
    const opens = (cleaned.match(/\(/g) || []).length;
    const closes = (cleaned.match(/\)/g) || []).length;
    if (closes > opens) {
      cleaned = cleaned.slice(0, -1);
    } else {
      break;
    }
  }
  return cleaned;
}

/**
 * Regex base pra extrair URLs de texto cru. Match: http(s):// + qualquer
 * non-whitespace exceto delimitadores fortes de markdown e prose
 * (`<>"]`).
 *
 * Inclui `()` no match (necessário pra URLs Wikipedia balanceadas tipo
 * `Foo_(bar)`). Pontuação acidental no fim (`)` desbalanceado, `.`, `,`, etc.)
 * é removida em pós-processamento via `stripUrlTrailingPunct`.
 */
export const URL_REGEX_RAW = /https?:\/\/[^\s<>"\]]+/g;

/**
 * Extrai todos os URLs de um texto, aplicando trim de pontuação trailing
 * de forma cautelosa (preserva parênteses balanceados de Wikipedia).
 *
 * Filter: descarta URLs com menos de 11 chars (provavelmente truncadas).
 */
export function extractUrls(text: string): string[] {
  const matches = text.match(URL_REGEX_RAW) ?? [];
  return matches
    .map(stripUrlTrailingPunct)
    .filter((u) => u.length > 10);
}
