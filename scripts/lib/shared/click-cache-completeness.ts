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
 * Heurística (opção 2 da issue + opção 1, combinadas — recalibração #4493
 * 260802, achado 1 do fleet review #4383): soma os cliques por-link
 * (verified email + web) de todas as linhas do cache e compara contra o
 * agregado de email **verified** do post (preferencialmente
 * `stats.email.verified_clicks`/`unique_verified_clicks` — os call sites
 * fazem fallback pro agregado bruto `clicks` só quando o campo verified não
 * existe no cache). Se a soma cobrir menos que
 * `CLICK_CACHE_COMPLETENESS_THRESHOLD` do agregado E o cache tiver menos de
 * `CLICK_CACHE_ROW_COUNT_FLOOR` linhas, é considerado incompleto — precisa
 * re-fetch.
 *
 * **Duas fontes de imprecisão, nenhuma prova de completude a 100%:**
 *   1. Verified vs. total: mesmo usando `verified_clicks` como
 *      denominador, a soma por-link ainda pode ficar abaixo por diferenças
 *      de metodologia de dedup entre o agregado e o per-link.
 *   2. `web.total_clicked`/`total_unique_clicked` (clique via preview web do
 *      e-mail) é ADITIVO à soma por-link mas não faz parte de NENHUM
 *      agregado de email (nem `clicks` nem `verified_clicks`) — é sinal de
 *      `stats.web`, uma métrica separada. Isso folga a margem a favor da
 *      soma (infla o numerador), então não é o que causa razão baixa — mas
 *      significa que a soma por-link não é diretamente comparável ao
 *      agregado de email em nenhuma leitura "pura".
 *
 * **Por que o limiar de razão sozinho não bastava (validado contra os 226
 * posts confirmados reais de `data/beehiiv-cache/posts/*.json` em 260802):**
 * usando `email.clicks` bruto como denominador, 39/226 posts (17,3%) ficam
 * abaixo de 50% — e 13 desses têm 6-10 linhas por-link, dentro do range que
 * a própria issue #4493 chama de "saudável" (o bug original era
 * especificamente cache de 1 LINHA). Exemplos reais confirmados: post
 * "Novo curso de IA do Google" (8 linhas, `email.clicks` 87,
 * `verified_clicks` 56, soma 40 — 40/87=0,46 no denominador bruto, mas
 * 40/56=0,71 no verified); "Claude Opus 3 se aposenta e vira blogueiro" (10
 * linhas, clicks 40, verified 28, soma 17 — 17/40=0,425 bruto, 17/28=0,61
 * verified); "Anthropic lança Claude Opus 4.7" (7 linhas, clicks 32,
 * verified 24, soma 9 — 9/32=0,28 bruto, 9/24=0,375 verified: **só o troco
 * de denominador não resolve este**, precisa do piso de linhas). Trocar só o
 * denominador (verified) reduz os falsos-positivos pra 31/226 (13,7%) — dos
 * quais TODOS os que restam têm <6 linhas, ou seja, o piso de linhas
 * (`rows.length >= CLICK_CACHE_ROW_COUNT_FLOOR`, opção 1 da issue original)
 * resolve o resto: com as duas heurísticas combinadas (OR — qualquer uma
 * bastando pra completo), os 13 posts de 6-10 linhas E o post nomeado acima
 * (7 linhas) passam a ser corretamente marcados completos, enquanto o
 * padrão do bug original (26w31: 1 linha cobrindo ~2-5% do agregado) segue
 * corretamente incompleto — 1 linha nunca cruza o piso de 6 nem a razão de
 * 50%.
 */

/** Linha de click do cache local — shape usado tanto por `apply-mcp-clicks.ts` quanto pelo cache lido daqui. */
export interface ClickCacheRow {
  email?: { verified_clicks?: number; unique_verified_clicks?: number };
  web?: { total_clicked?: number; total_unique_clicked?: number };
}

/** Fração mínima da soma por-link sobre o agregado de email pra considerar o cache completo (quando abaixo do piso de linhas — ver `CLICK_CACHE_ROW_COUNT_FLOOR`). */
export const CLICK_CACHE_COMPLETENESS_THRESHOLD = 0.5;

/**
 * Piso de linhas do cache que por si só basta pra considerar completo,
 * independente da razão de soma (#4493 recalibração 260802 — opção 1 da
 * issue original). Calibrado contra os 226 posts confirmados reais: cobre
 * os 13 posts de 6-10 linhas que ficavam presos abaixo do limiar de razão
 * mesmo com denominador verified (ver docstring do arquivo). O padrão do
 * bug original (26w31, 1 linha) fica bem abaixo deste piso.
 */
export const CLICK_CACHE_ROW_COUNT_FLOOR = 6;

/** Pure: soma verified email clicks + web clicks de todas as linhas do cache. */
export function sumCachedClicks(rows: ClickCacheRow[] | undefined): number {
  if (!Array.isArray(rows) || rows.length === 0) return 0;
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
 * `emailClicks` é o agregado de email do post contra o qual a soma por-link
 * é comparada — os call sites devem preferir `stats.email.verified_clicks`
 * (fallback `unique_verified_clicks`, fallback `clicks` bruto só quando
 * nenhum campo verified existe no cache; ver docstring do arquivo pro porquê
 * do denominador verified). `rows` é `stats.clicks`. Sem clique agregado
 * (`emailClicks <= 0`) não há nada pra buscar — considerado vacuamente
 * completo (os call sites já fazem esse corte separadamente com o agregado
 * BRUTO antes de chegar aqui — a função fica correta mesmo chamada isolada
 * com qualquer valor ≤0).
 *
 * `rows` que não é array (objeto, string, número — cache corrompido; `Array.isArray`
 * em vez de `!rows`, #4493 achado 2 do fleet review #4383) é tratado como
 * incompleto em vez de lançar `TypeError` no `.reduce()` de `sumCachedClicks`.
 */
export function isClickCacheComplete(emailClicks: number, rows: ClickCacheRow[] | undefined): boolean {
  if (emailClicks <= 0) return true;
  if (!Array.isArray(rows) || rows.length === 0) return false;
  if (rows.length >= CLICK_CACHE_ROW_COUNT_FLOOR) return true;
  return sumCachedClicks(rows) >= emailClicks * CLICK_CACHE_COMPLETENESS_THRESHOLD;
}
