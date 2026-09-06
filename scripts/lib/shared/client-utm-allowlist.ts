/**
 * scripts/lib/shared/client-utm-allowlist.ts (#7535)
 *
 * Extraído de `workers/poll/src/subscribe.ts` (#6427/#6980, onde a lógica
 * nasceu escopada só ao `source === "apex"`). A #7535 (Camada 1) passou a
 * consultar esta allowlist pra QUALQUER `SubscribeSource` — inclusive o
 * cadastro do worker `cursos` (`workers/cursos/src/subscribe.ts`), que é um
 * worker DISTINTO do `poll` (bundle separado, sem import cross-worker por
 * convenção deste repo — ver docstring de `workers/cursos/src/subscribe.ts`).
 * Vive em `lib/shared/` (não em `lib/diaria/`) porque os dois workers,
 * `scripts/build-livros-page.ts` e a diária de teste precisam da MESMA
 * lógica pura, sem I/O — mesmo racional de `scripts/lib/shared/utm-registry.ts`
 * (fronteira lint-enforced por `test/lib-boundary.test.ts`).
 *
 * `workers/poll/src/subscribe.ts` re-exporta os dois símbolos abaixo pra não
 * quebrar os imports existentes (`test/poll-subscribe-apex-utm-6427.test.ts`
 * e afins continuam importando de lá).
 */

/**
 * Prefixos de `utm_source` que o CLIENTE tem permissão de repassar cru pro
 * servidor — a exceção estreita ao design "o servidor resolve o UTM, nunca
 * aceita utm_* vindo do cliente diretamente" (evita spoofing de atribuição).
 * `"clarice"` cobre o `utm_source=clarice` fixo da parceria Clarice News;
 * `"google-ads"`/`"microsoft-ads"`/`"meta-ads"` cobrem os 3 canais pagos do
 * teste de atribuição (#5845/#5838) — valores CANÔNICOS de
 * `scripts/lib/shared/utm-registry.ts` (`EXTERNAL_UTM_SURFACES`).
 */
export const CLIENT_UTM_SOURCE_ALLOWED_PREFIXES = [
  "clarice",
  "google-ads",
  "microsoft-ads",
  "meta-ads",
] as const;

/**
 * Pure: `true` só quando `rawSource` é uma string não-vazia IGUAL a um
 * prefixo da allowlist, ou que começa com `"{prefixo}-"` (fronteira de
 * traço — `"googleadsxyz"` não casa `"google-ads"` por substring solta).
 */
export function isAllowedClientUtmSource(rawSource: unknown): boolean {
  const s = typeof rawSource === "string" ? rawSource.trim().toLowerCase() : "";
  if (!s) return false;
  return CLIENT_UTM_SOURCE_ALLOWED_PREFIXES.some((prefix) => s === prefix || s.startsWith(`${prefix}-`));
}
