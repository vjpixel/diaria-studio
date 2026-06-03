/**
 * editorial-blocklist.ts (#1760)
 *
 * Blacklist EDITORIAL de fontes — domínios que o editor decidiu **não** incluir
 * na newsletter por preferência editorial. Distinta da blocklist de AGREGADORES
 * (`aggregators.ts`), que é sobre roundups / falta de fonte primária. Aqui o
 * domínio pode ter fonte primária perfeitamente válida — o editor só não quer.
 *
 * Aplicada no `dedup.ts` (pass 0), descartando os itens do pool ANTES do
 * scoring/categorização.
 *
 * MANTER CURADA — uma entrada por linha, com motivo + data da decisão.
 */
export const EDITORIAL_BLOCKLIST: ReadonlySet<string> = new Set<string>([
  "simonwillison.net", // editor 260603 (#1760) — não incluir conteúdo do Simon Willison
]);

/**
 * #1760: true se a URL é de uma fonte na blacklist editorial. Match por host
 * exato ou subdomínio (`blog.simonwillison.net` → bloqueado). URL inválida →
 * false (defensivo — caller decide).
 */
export function isEditoriallyBlocked(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return false;
  }
  for (const domain of EDITORIAL_BLOCKLIST) {
    if (host === domain || host.endsWith("." + domain)) return true;
  }
  return false;
}
