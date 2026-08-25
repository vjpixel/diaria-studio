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
 *
 * ## `updateSubscriberFields`/`getSubscriberById` (#6049)
 *
 * `PATCH /v4/subscribers/{id}` grava custom fields por ID — mecanismo
 * confirmado ao vivo no #6047 (usado pra popular `apoio_nivel` nos 22
 * apoiadores importados), agora versionado aqui como função reusável em vez
 * de chamada ad-hoc. `getSubscriberById` é a releitura pós-escrita —
 * `sync-apoio-nivel-kit.ts` NUNCA confia só no status 2xx do PATCH pra
 * confirmar a mutação (mesma disciplina de `applyApoioTagEntry` na Beehiiv,
 * motivada pelo endpoint de tags que respondia 200 e silenciosamente não
 * fazia nada — ver `sync-apoio-nivel-beehiiv.ts`).
 *
 * `fields` no envelope de LEITURA (`KitSubscriberSummary.fields`) **não foi
 * confirmado ao vivo** — o #6047/#6091 só exercitaram `fields` no corpo de
 * ESCRITA (`POST`/`PATCH`). Assumido presente por simetria com a resposta de
 * escrita (que ecoa `fields`), mas reverificar contra uma listagem real
 * antes do 1º `--push` de `sync-apoio-nivel-kit.ts`.
 */

import { kitFetch } from "./kit-client.ts";
import type { KitConfig } from "./kit-config.ts";
import type { KitPagination } from "./kit-client.ts";

export interface KitSubscriberSummary {
  id: number;
  email_address: string;
  state: string;
  created_at: string;
  /** Custom fields do assinante (`{apoio_nivel: "mantenedor", ...}`) — ver
   *  ressalva "não confirmado ao vivo" na docstring do módulo. */
  fields?: Record<string, string>;
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

/** `GET /v4/subscribers/{id}` — releitura pós-escrita (ver docstring do
 *  módulo). Lança se o envelope `subscriber` não vier, mesma disciplina dos
 *  demais helpers deste módulo/`kit-client.ts`. */
export async function getSubscriberById(id: number, config?: KitConfig): Promise<KitSubscriberSummary> {
  const data = await kitFetch<{ subscriber: KitSubscriberSummary } | undefined>(`/subscribers/${id}`, { config });
  if (!data?.subscriber) {
    throw new Error(`[kit-subscribers] getSubscriberById(${id}): resposta 2xx sem o envelope "subscriber" esperado`);
  }
  return data.subscriber;
}

/**
 * `PATCH /v4/subscribers/{id}` — grava/atualiza custom fields de um
 * assinante já existente (ver docstring do módulo). `fields` é sempre um
 * merge parcial do lado da API (mesma semântica PATCH documentada em
 * `kit-broadcasts.ts`) — passar `{apoio_nivel: ""}` para LIMPAR o valor
 * (o Kit não tem um `delete: true` equivalente ao da Beehiiv; string vazia é
 * o análogo — não confirmado ao vivo, reverificar antes do 1º `--push`).
 */
export async function updateSubscriberFields(
  id: number,
  fields: Record<string, string>,
  config?: KitConfig,
): Promise<KitSubscriberSummary> {
  const data = await kitFetch<{ subscriber: KitSubscriberSummary } | undefined>(`/subscribers/${id}`, {
    method: "PATCH",
    body: { fields },
    config,
  });
  if (!data?.subscriber) {
    throw new Error(`[kit-subscribers] updateSubscriberFields(${id}): resposta 2xx sem o envelope "subscriber" esperado`);
  }
  return data.subscriber;
}
