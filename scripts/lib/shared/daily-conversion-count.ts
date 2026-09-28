/**
 * scripts/lib/shared/daily-conversion-count.ts (#8930 item 2)
 *
 * `DailyConversionCount` era declarado verbatim em `scripts/lib/google-ads-ingest.ts`
 * (contagem diária de conversões do Google Ads) e em
 * `scripts/lib/ads-campaign-economics-fetch.ts` (idem, Meta Ads) — mesmo
 * shape (`{date: string; count: number}`), sem import compartilhado, e
 * consumidos pelo MESMO caller (`scripts/aquisicao-conversions-ingest.ts`,
 * via `resolveDailyCount`). Risco apontado pelo review automatizado da PR
 * #8929: as duas declarações podiam divergir silenciosamente se uma
 * ganhasse um campo que a outra não ganhasse — `resolveDailyCount` aceita
 * hoje `DailyConversionCount[]` vindo tanto de
 * `aggregateGoogleAdsConversionsByDayWithDiscards` (Google) quanto de
 * `extractMetaCompleteRegistrationDaily`/`fetchMetaAdsCompleteRegistrationDaily`
 * (Meta) só porque o TypeScript é estrutural — um campo extra em um dos
 * dois shapes pararia de compilar ali sem nenhum sinal claro do motivo.
 *
 * Fonte única em `lib/shared/` (mesma disciplina de `test/lib-boundary.test.ts`
 * — este arquivo não importa de `diaria/`/`mensal/`, é genérico de verdade:
 * o shape não tem nada específico de canal). `google-ads-ingest.ts` e
 * `ads-campaign-economics-fetch.ts` re-exportam o mesmo símbolo pra não
 * quebrar nenhum import existente.
 *
 * @pure
 */
export interface DailyConversionCount {
  date: string;
  count: number;
}
