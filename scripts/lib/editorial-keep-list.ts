/**
 * editorial-keep-list.ts (#9787)
 *
 * Domínios que o editor decidiu EXPLICITAMENTE manter, mesmo aparecendo como
 * candidatos à blacklist editorial (retirados no gate 4 mais vezes do que
 * mantidos, com ≥ `MIN_CUT_OCCURRENCES` ocorrências — ver
 * `scripts/lib/editorial-domain-cuts.ts`). Contraparte de
 * `EDITORIAL_BLOCKLIST` (`editorial-blocklist.ts`): domínio aqui nunca mais é
 * proposto ao editor, mesmo se a razão retirado/mantido piorar.
 *
 * Não afeta a pesquisa, o scoring nem o dedup — só silencia a pergunta.
 *
 * MANTER CURADA — uma entrada por linha, com motivo + data da decisão (mesmo
 * padrão de `editorial-blocklist.ts`). `scripts/editorial-domain-cuts.ts
 * --apply-to-code` insere as decisões registradas no gate 4 aqui.
 */
export const EDITORIAL_KEEP_LIST: ReadonlySet<string> = new Set<string>([
]);

/**
 * true se o domínio (registrável, ex. `openai.com`) está na lista de mantidos.
 * Match por igualdade ou subdomínio, mesmo critério de `isEditoriallyBlocked`.
 */
export function isEditoriallyKept(domain: string): boolean {
  const d = domain.replace(/^www\./, "").toLowerCase();
  for (const kept of EDITORIAL_KEEP_LIST) {
    if (d === kept || d.endsWith("." + kept)) return true;
  }
  return false;
}
