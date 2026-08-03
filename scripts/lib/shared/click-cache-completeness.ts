/**
 * click-cache-completeness.ts (#4493)
 *
 * Heurística de completude do cache local de per-link clicks do Beehiiv
 * (`data/beehiiv-cache/posts/{id}.json`, campo `stats.clicks` — populado via
 * MCP `list_post_clicks` + `scripts/apply-mcp-clicks.ts`, ver docstring de
 * `scripts/beehiiv-sync.ts`).
 *
 * Extraído como módulo compartilhado — SEM imports com efeito colateral (nem
 * `dotenv/config`, nem nada de `beehiiv-sync.ts`) — pra ser importável tanto
 * por `scripts/beehiiv-sync.ts` (`identifyPostsNeedingClicks`) quanto por
 * `scripts/lib/weekly-linkedin-clicks.ts` (`identifyWeeklyPostsNeedingClicks`)
 * sem acoplar os dois módulos entre si (ver docstring de
 * `weekly-linkedin-clicks.ts` sobre por que este segundo não importa direto
 * de `beehiiv-sync.ts`).
 *
 * Motivação (#4493): os dois call sites usavam o mesmo gate
 * `(p.stats?.clicks?.length ?? 0) > 0` pra decidir se um post já tinha per-link
 * click data suficiente — tratando QUALQUER contagem ≥1 como "completo". Um
 * post real com múltiplos links (destaques+radar+use_melhor+lançamentos+
 * vídeos+CTAs) deveria trazer 10-40 linhas; 5 posts confirmados da 26w31
 * tinham exatamente 1 linha (cache parcial — bootstrap antigo, timeout no
 * meio da paginação, falha silenciosa do agent, etc.) apesar de
 * `stats.email.clicks` agregado de 34-51. Como o gate nunca detectava a
 * incompletude, o cache parcial nunca era corrigido — distorcendo
 * diretamente a seleção de cliques da newsletter semanal do LinkedIn.
 *
 * Heurística (opção 2 da issue): soma os cliques por-link (verified email +
 * web) de todas as linhas do cache e compara contra o agregado
 * `stats.email.clicks` do post. Se a soma cobrir menos que
 * `CLICK_CACHE_COMPLETENESS_THRESHOLD` do agregado, o cache é considerado
 * incompleto — precisa re-fetch. **Não é prova de completude**: o agregado
 * `email.clicks` conta todo clique (inclusive não-verificado/bot), enquanto a
 * soma por-link usa só `verified_clicks` — mesmo um cache saudável não bate
 * 100% contra o agregado. O limiar de 50% dá margem generosa pra essa
 * diferença de metodologia (verified vs. total) enquanto ainda captura com
 * folga o padrão observado do bug (1 linha cobrindo ~0-5% de um agregado de
 * 34-51 — ordens de magnitude abaixo de qualquer cache real saudável).
 */

/** Linha de click do cache local — shape usado tanto por `apply-mcp-clicks.ts` quanto pelo cache lido daqui. */
export interface ClickCacheRow {
  email?: { verified_clicks?: number; unique_verified_clicks?: number };
  web?: { total_clicked?: number; total_unique_clicked?: number };
}

/** Fração mínima da soma por-link sobre o agregado `email.clicks` pra considerar o cache completo. */
export const CLICK_CACHE_COMPLETENESS_THRESHOLD = 0.5;

/** Pure: soma verified email clicks + web clicks de todas as linhas do cache. */
export function sumCachedClicks(rows: ClickCacheRow[] | undefined): number {
  if (!rows || rows.length === 0) return 0;
  return rows.reduce((sum, r) => {
    const email = r.email?.verified_clicks ?? r.email?.unique_verified_clicks ?? 0;
    const web = r.web?.total_clicked ?? r.web?.total_unique_clicked ?? 0;
    return sum + email + web;
  }, 0);
}

/**
 * Pure: decide se o cache de per-link clicks de um post está completo o
 * suficiente pra não precisar de re-fetch via MCP.
 *
 * `emailClicks` é o agregado `stats.email.clicks` do post; `rows` é
 * `stats.clicks`. Sem clique agregado (`emailClicks <= 0`) não há nada pra
 * buscar — considerado vacuamente completo (os call sites já fazem esse
 * corte separadamente antes de chegar aqui, mas a função fica correta mesmo
 * chamada isolada).
 */
export function isClickCacheComplete(emailClicks: number, rows: ClickCacheRow[] | undefined): boolean {
  if (emailClicks <= 0) return true;
  if (!rows || rows.length === 0) return false;
  return sumCachedClicks(rows) >= emailClicks * CLICK_CACHE_COMPLETENESS_THRESHOLD;
}
