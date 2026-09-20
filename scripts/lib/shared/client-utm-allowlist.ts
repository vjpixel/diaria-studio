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

/**
 * #8553: mapeia o PREFIXO de `click_id` (#8003 — `gclid:`/`fbclid:`/
 * `msclkid:`, antes do `:`) pro `utm_source` CANÔNICO da mesma plataforma —
 * mesmos 3 valores pagos de `CLIENT_UTM_SOURCE_ALLOWED_PREFIXES` (exceto
 * `"clarice"`, que não tem click_id de ads).
 */
const CLICK_ID_PREFIX_TO_ORIGEM_PAGA: Readonly<Record<string, string>> = {
  gclid: "google-ads",
  fbclid: "meta-ads",
  msclkid: "microsoft-ads",
};

/**
 * #8553: fallback de `origemPaga`/`utm_source` quando o `click_id` (#8003)
 * prova que o cadastro veio de um clique de anúncio pago, mas a atribuição
 * derivada só do `utm_source` que o cliente mandou (`origemPaga`, ver
 * `resolveSubscribeUtm` em `workers/poll/src/subscribe.ts`/`workers/cursos/
 * src/subscribe.ts`) ficou vazia ou aponta pra uma plataforma DIFERENTE da
 * que o prefixo do `click_id` indica.
 *
 * Causa raiz confirmada (#8553, medição de 20/09/2026): 9 cadastros em 7
 * dias tinham `fbclid` na URL (prova de clique num anúncio Meta — o
 * Facebook injeta esse parâmetro automaticamente em QUALQUER link clicado a
 * partir de um anúncio/post) mas foram atribuídos a `diaria-apex`/`livros`/
 * `arquivo` (orgânico) porque a URL de destino do anúncio não carregava
 * `utm_source=meta-ads` — o click_id e a query string de UTM são
 * preenchidos por mecanismos INDEPENDENTES (ver docstring de
 * `clientOriginSignalPayloadFieldsJs`, `client-utm-payload.ts`, #8003: até
 * aqui o campo era "puramente informativo... nunca consumido por lógica de
 * negócio" — decisão revista por esta issue). O prefixo do `click_id`
 * identifica a plataforma sem ambiguidade — precedente de inferência por
 * prefixo: `scripts/backfill-kit-attribution.ts` (esse é backfill
 * retroativo; esta função cobre o caminho de captura NOVO, em tempo real).
 *
 * `origemPaga` já preenchido com a MESMA plataforma que o `click_id` indica
 * passa direto (nunca reescreve um valor que já concorda — evita normalizar
 * um sufixo de campanha legítimo, ex: `"meta-ads-260901"`, pro valor curto).
 * Vazio, ou de plataforma DIFERENTE do `click_id`, é SUBSTITUÍDO pelo valor
 * derivado — o `click_id` é o sinal mais confiável quando os dois divergem
 * (o `utm_source` pode faltar por configuração incompleta do anúncio; o
 * `click_id` só existe porque um clique de ads de fato aconteceu).
 * `click_id` sem prefixo reconhecido (formato inesperado, ou vazio) →
 * `origemPaga` original intacto.
 *
 * @pure
 */
export function resolveOrigemPagaWithClickIdFallback(origemPaga: string, clickId: string): string {
  const prefix = clickId.split(":", 1)[0]?.trim().toLowerCase() ?? "";
  const derived = CLICK_ID_PREFIX_TO_ORIGEM_PAGA[prefix];
  if (!derived) return origemPaga;
  const atual = origemPaga.trim().toLowerCase();
  if (atual === derived || atual.startsWith(`${derived}-`)) return origemPaga;
  return derived;
}
