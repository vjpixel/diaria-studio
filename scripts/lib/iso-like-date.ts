/**
 * lib/iso-like-date.ts (#8033)
 *
 * Fonte única do regex "formato ISO-like esperado" (`AAAA-MM-DD`, opcional
 * `[ T]HH:MM:SS`, opcional `.SSS` de milissegundos, opcional `Z`/offset de
 * fuso) — extraído pra não duplicar entre `clarice-sync-brevo.ts`
 * (`collectDeliveredStats`, valida ANTES de aceitar um candidato de data da
 * Brevo — que vem como `AAAA-MM-DD HH:MM:SS`, sem milissegundos nem fuso) e
 * `repair-clarice-last-sent-at-format.ts` (detecta o que JÁ corrompeu — mas
 * também usa o regex pra reconhecer o que JÁ está correto, e a maioria do
 * store tem o formato completo `AAAA-MM-DDTHH:MM:SS.SSSZ` de
 * `latestEventTime`/`toISOString()`, `brevo-stats.ts`). Ancorado nas duas
 * pontas (`^`/`$`) — sem o `$`, uma string com prefixo válido e lixo depois
 * (`"2026-09-03 lixo"`) passava o guard antes de sequer chegar no
 * `Date.parse` que capturaria o erro (achado do review do #8043). O sufixo
 * de milissegundos/fuso é opcional mas TEM que ser reconhecido quando
 * presente — sem ele, o `$` sozinho rejeitaria incorretamente todo
 * `last_sent_at` já no formato correto do store (regressão pega em teste
 * antes deste arquivo ser commitado).
 */
export const ISO_LIKE_DATE_RE = /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/;
