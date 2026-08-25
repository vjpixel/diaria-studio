/**
 * kit-subscribers.ts (#6091 — sync recorrente Beehiiv → Kit, #461)
 *
 * Camada fina de leitura/escrita sobre `/v4/subscribers` — `kit-client.ts`
 * cobre broadcasts, `kit-broadcasts.ts` cobre escrita de broadcast/tag; este
 * módulo é o análogo pro recurso subscriber, que nenhum dos dois cobria
 * ainda (só o Worker `subscribeToKit`, `workers/poll/src/subscribe.ts`,
 * tinha o `POST /v4/subscribers` — mas é código de Worker, não reusável
 * num script Node).
 *
 * ## Idempotência confirmada ao vivo (#6048, 24/08/2026)
 *
 * `POST /v4/subscribers` é idempotente por e-mail: 1º POST com um e-mail
 * novo devolve 201; POST subsequente com o MESMO e-mail devolve 200 (mesmo
 * `id`, atualiza `first_name`/`fields` se enviados). `createOrUpdateSubscriber`
 * abaixo depende disso — nunca verifica antes se o e-mail já existe, sempre
 * chama `POST` direto.
 */

import { kitFetch } from "./kit-client.ts";
import type { KitConfig } from "./kit-config.ts";
import type { KitPagination } from "./kit-client.ts";

export interface KitSubscriberSummary {
  id: number;
  email_address: string;
  state: string;
  created_at: string;
}

export async function listKitSubscribersPage(
  opts: { perPage?: number; after?: string; config?: KitConfig } = {},
): Promise<{ subscribers: KitSubscriberSummary[]; pagination: KitPagination }> {
  const params = new URLSearchParams();
  if (opts.perPage) params.set("per_page", String(opts.perPage));
  if (opts.after) params.set("after", opts.after);
  const qs = params.toString();
  return kitFetch(`/subscribers${qs ? `?${qs}` : ""}`, { config: opts.config });
}

/**
 * Pagina `/v4/subscribers` inteiro. Volume esperado (algumas centenas a
 * ~2 mil, ver #6047) — sem checkpoint/resumo, roda do zero a cada chamada
 * (barato o bastante pra não precisar).
 */
export async function listAllKitSubscribers(config?: KitConfig): Promise<KitSubscriberSummary[]> {
  const all: KitSubscriberSummary[] = [];
  let after: string | undefined;
  for (;;) {
    const { subscribers, pagination } = await listKitSubscribersPage({ perPage: 500, after, config });
    all.push(...subscribers);
    if (!pagination.has_next_page || !pagination.end_cursor) break;
    after = pagination.end_cursor;
  }
  return all;
}

export interface CreateOrUpdateSubscriberInput {
  email_address: string;
  state?: "active" | "cancelled" | "bounced" | "complained" | "inactive";
  first_name?: string;
  fields?: Record<string, string>;
}

/**
 * `POST /v4/subscribers` — cria ou atualiza (idempotente por e-mail, ver
 * docstring do módulo). `state: "active"` bypassa qualquer confirmação
 * (achado do #6048).
 */
export async function createOrUpdateSubscriber(
  input: CreateOrUpdateSubscriberInput,
  config?: KitConfig,
): Promise<KitSubscriberSummary> {
  const data = await kitFetch<{ subscriber: KitSubscriberSummary } | undefined>("/subscribers", {
    method: "POST",
    body: input,
    config,
  });
  if (!data?.subscriber) {
    throw new Error("[kit-subscribers] createOrUpdateSubscriber: resposta 2xx sem o envelope \"subscriber\" esperado");
  }
  return data.subscriber;
}
