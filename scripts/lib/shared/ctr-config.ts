/**
 * ctr-config.ts (#3146)
 *
 * Constante de estabilização de CTR compartilhada entre scripts que buscam/
 * agregam clicks (`beehiiv-sync.ts`, `build-link-ctr.ts`) e o Worker
 * diaria-dashboard (`renderUseMelhorSection`, tabela "Por edição"). Extraída
 * pra não duplicar o número mágico 7 em múltiplos lugares — antes desta
 * extração cada consumidor tinha sua própria cópia inline (`MIN_AGE_DAYS_FOR_CLICKS`
 * em beehiiv-sync.ts, `MIN_AGE_DAYS` em build-link-ctr.ts), sem garantia de
 * ficarem em sync.
 *
 * O Worker diaria-dashboard não importa `scripts/lib/` diretamente no bundle
 * (mesmo padrão já estabelecido por `isAprofundeAnchor`, espelhado de
 * `scripts/lib/ctr-utils.ts` em `workers/diaria-dashboard/src/index.ts`) —
 * o valor é espelhado lá manualmente e o drift é coberto por teste em
 * `test/diaria-dashboard-use-melhor-age.test.ts`.
 */

/**
 * Posts/edições mais novos que isso (em dias) ainda têm CTR não-estabilizado:
 * clicks ainda não foram buscados da Beehiiv (ver `scripts/beehiiv-sync.ts`)
 * e/ou o CTR seria enganoso — 1 clique na 1ª hora de uma edição recém-publicada
 * lê como "100%".
 */
export const MIN_AGE_DAYS_FOR_CLICKS = 7;
