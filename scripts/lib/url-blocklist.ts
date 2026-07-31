/**
 * url-blocklist.ts (#4340)
 *
 * Blacklist EDITORIAL por URL EXATA — para artigos específicos que o editor
 * decidiu não incluir, mas cuja fonte (domínio) continua legítima e deve
 * permanecer disponível para futuras edições. Distinta de
 * `editorial-blocklist.ts` (#1760), que bane o domínio INTEIRO — usar esta
 * lista quando o problema é o ARTIGO, não a fonte (ex: domínio oficial cujo
 * post específico não tem interesse editorial, mas outros posts do mesmo
 * domínio podem ter).
 *
 * Aplicada no `dedup.ts` (pass 0), descartando os itens do pool ANTES do
 * scoring/categorização — mesmo ponto de aplicação de `isEditoriallyBlocked`.
 *
 * MANTER CURADA — uma entrada por linha, com motivo + data da decisão.
 * Match por URL normalizada (sem query string, sem trailing slash, sem
 * protocolo/www) — query params de tracking não devem escapar o block.
 */
export const URL_BLOCKLIST: ReadonlySet<string> = new Set<string>([
  "cnnbrasil.com.br/inteligencia-artificial/entenda-como-um-comando-oculto-entregou-alunos-que-usaram-ia", // editor 260730 — artigo específico não serve, fonte continua válida
  "blog.google/innovation-and-ai/models-and-research/gemini-models/using-gemini-to-manage-farm", // editor 260730 — case-study de cliente, não interesse editorial; blog.google continua válido
]);

/** Normaliza uma URL pra comparação: remove protocolo, www, query string, trailing slash. */
function normalizeForBlocklist(url: string): string | null {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "").toLowerCase();
    const path = u.pathname.replace(/\/+$/, "");
    return `${host}${path}`.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * #4340: true se a URL exata está na blacklist por artigo. Diferente de
 * `isEditoriallyBlocked`, aqui o match é pelo par host+path normalizado —
 * outros artigos do mesmo domínio NÃO são afetados. URL inválida → false
 * (defensivo — caller decide).
 */
export function isUrlBlocked(url: string): boolean {
  const normalized = normalizeForBlocklist(url);
  if (!normalized) return false;
  return URL_BLOCKLIST.has(normalized);
}
