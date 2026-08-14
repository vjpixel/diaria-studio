/**
 * beehiiv-origem-original.ts (#5231)
 *
 * `promoteBeehiivSubscription` (`scripts/evaluate-brevo-diaria.ts`, via score)
 * e `activateSubscription` (`workers/reativar/src/index.ts`, via clique) fazem
 * `GET .../subscriptions/by_email/{email}` seguido de DELETE+CREATE pra
 * reativar um contato Pending — e o CREATE sobrescreve `utm_source`/
 * `utm_medium`/`utm_campaign`/`referring_site`/`created` com os valores do
 * PRÓPRIO evento de reativação, perdendo a origem de aquisição original do
 * contato (ver `scripts/build-origem-map.ts` pra reconstrução offline do
 * histórico já perdido).
 *
 * Este módulo lê o corpo do GET que os dois call sites já fazem (hoje só
 * extraem `data.id`) e monta o `custom_fields` do CREATE pra preservar essa
 * origem IN-BAND — sem exigir um round-trip extra à API.
 *
 * **Fronteira `lib/shared/` (#2747):** consumido por um script Node
 * (`scripts/evaluate-brevo-diaria.ts`) E por um Worker Cloudflare
 * (`workers/reativar/src/index.ts`, que já importa de `lib/shared/` pro
 * registry de UTM) — zero I/O, zero dependência de runtime Node, só tipos e
 * funções puras.
 *
 * **Dependência cruzada com #5231 item 1 (fora do escopo desta unidade):** o
 * `custom_fields` só tem efeito real na Beehiiv depois que o custom field
 * `origem_original` existir na publicação (criado via dashboard/MCP, ação do
 * editor — guard de publicação da rodada overnight não permite chamada real
 * de API aqui). Até lá, o `POST /subscriptions` provavelmente ignora ou
 * rejeita um custom field inexistente — este código fica pronto e sem efeito
 * observável até a criação do campo acontecer.
 *
 * **Fail-soft (#5231 item 4):** toda extração aqui é best-effort. Corpo
 * ausente/malformado, ou sem nenhum dos 5 campos de origem, nunca lança —
 * retorna `null`/`undefined` e o caller cai pro comportamento atual (UTM
 * constante do evento de reativação, sem custom field extra). Telemetria de
 * origem nunca bloqueia a promoção.
 */

/** Nome do custom field na Beehiiv onde a origem original é gravada.
 *  Precisa existir na publicação (#5231 item 1, fora do escopo desta
 *  unidade) — até lá, gravável mas sem efeito observável. */
export const ORIGEM_ORIGINAL_FIELD_NAME = "origem_original";

/** Os 5 campos de atribuição que uma subscription da Beehiiv carrega no
 *  corpo do `GET .../subscriptions/by_email/{email}` (`data.*`) — mesmo
 *  shape de `BeehiivBackupSubscriber` (`scripts/lib/beehiiv-backup-snapshots.ts`)
 *  e `OrigemEntry` (`scripts/build-origem-map.ts`), aqui como `Partial<>`
 *  porque a extração é best-effort sobre uma resposta HTTP não confiável. */
export interface BeehiivSubscriptionOrigin {
  utm_source: string;
  utm_medium: string;
  utm_campaign: string;
  referring_site: string;
  created: number;
}

/** Formato mínimo do corpo de `GET .../subscriptions/by_email/{email}` que
 *  este módulo consome — só os campos relevantes pra extração de origem
 *  (o corpo real tem bem mais campos, ignorados aqui). */
export type BeehiivSubscriptionGetBody = {
  data?: {
    utm_source?: unknown;
    utm_medium?: unknown;
    utm_campaign?: unknown;
    referring_site?: unknown;
    created?: unknown;
  };
} | null | undefined;

/**
 * Extrai os campos de origem do corpo do GET, best-effort. Nunca lança.
 * Retorna `null` se o corpo não tem `data` (404, corpo malformado, etc) ou
 * se NENHUM dos 5 campos está presente com o tipo esperado — nesse caso não
 * há nada de origem pra preservar, o caller deve cair pro comportamento
 * atual.
 *
 * Campos individuais ausentes/com tipo errado são simplesmente omitidos do
 * resultado (extração parcial é aceitável — preservar 3 de 5 campos é melhor
 * que preservar 0).
 */
export function extractSubscriptionOrigin(
  body: BeehiivSubscriptionGetBody,
): Partial<BeehiivSubscriptionOrigin> | null {
  const data = body?.data;
  if (!data || typeof data !== "object") return null;

  const origin: Partial<BeehiivSubscriptionOrigin> = {};
  if (typeof data.utm_source === "string" && data.utm_source) origin.utm_source = data.utm_source;
  if (typeof data.utm_medium === "string" && data.utm_medium) origin.utm_medium = data.utm_medium;
  if (typeof data.utm_campaign === "string" && data.utm_campaign) origin.utm_campaign = data.utm_campaign;
  if (typeof data.referring_site === "string" && data.referring_site) origin.referring_site = data.referring_site;
  if (typeof data.created === "number" && Number.isFinite(data.created)) origin.created = data.created;

  return Object.keys(origin).length > 0 ? origin : null;
}

/**
 * Serializa a origem extraída num único valor de custom field — JSON
 * compacto com chaves em ordem estável (facilita diff/leitura manual no
 * dashboard da Beehiiv). `null` se `origin` for `null`/vazio.
 */
export function formatOrigemOriginalValue(origin: Partial<BeehiivSubscriptionOrigin> | null): string | null {
  if (!origin || Object.keys(origin).length === 0) return null;
  const ordered: Partial<BeehiivSubscriptionOrigin> = {};
  if (origin.utm_source !== undefined) ordered.utm_source = origin.utm_source;
  if (origin.utm_medium !== undefined) ordered.utm_medium = origin.utm_medium;
  if (origin.utm_campaign !== undefined) ordered.utm_campaign = origin.utm_campaign;
  if (origin.referring_site !== undefined) ordered.referring_site = origin.referring_site;
  if (origin.created !== undefined) ordered.created = origin.created;
  return JSON.stringify(ordered);
}

/** Um item de `custom_fields` no formato que a API da Beehiiv espera no
 *  `POST /subscriptions` (mesmo shape usado por `subscribeToBeehiiv` em
 *  `workers/poll/src/subscribe.ts` e `sync-apoio-nivel-beehiiv.ts`). */
export interface BeehiivCustomFieldWrite {
  name: string;
  value: string;
}

/**
 * Monta o array `custom_fields` pra preservar a origem original no CREATE,
 * a partir do corpo bruto do GET. `undefined` (não `[]`) quando não há nada
 * pra preservar — o caller faz `...(customFields ? { custom_fields: customFields } : {})`
 * em vez de sempre incluir a chave, mantendo o comportamento atual (sem
 * custom field algum) intacto no caso fail-soft.
 */
export function buildOrigemOriginalCustomFields(
  body: BeehiivSubscriptionGetBody,
): BeehiivCustomFieldWrite[] | undefined {
  const origin = extractSubscriptionOrigin(body);
  const value = formatOrigemOriginalValue(origin);
  if (value === null) return undefined;
  return [{ name: ORIGEM_ORIGINAL_FIELD_NAME, value }];
}
