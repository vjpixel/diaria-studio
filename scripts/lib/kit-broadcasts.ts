/**
 * kit-broadcasts.ts (#464 — reescrever publish-newsletter para Kit API, #461)
 *
 * Operações de ESCRITA sobre broadcasts do Kit — `kit-client.ts` cobria só
 * leitura (fundação do #463). Este módulo é o que `publish-newsletter-kit.ts`
 * chama pra criar/atualizar/agendar/apagar broadcasts.
 *
 * ## Schema confirmado ao vivo (24/08/2026, contra `POST /v4/broadcasts` real)
 *
 * Campos aceitos: `subject`, `content` (HTML), `description`, `public`,
 * `published_at`, `send_at` (`null` = rascunho, timestamp ISO8601 = agenda),
 * `preview_text`, `thumbnail_url`, `thumbnail_alt`, `email_template_id`,
 * `email_address`, `subscriber_filter`. Doc oficial:
 * https://developers.kit.com/api-reference/broadcasts/create-a-broadcast.md
 *
 * ## Update é PATCH parcial, não PUT integral (doc oficial está errada)
 *
 * A doc de `update-a-broadcast` diz `PUT` com corpo integral obrigatório
 * (todos os campos no schema OpenAPI marcados `required`). **Testado ao
 * vivo e é falso**: tanto `PATCH` quanto `PUT` aceitam corpo PARCIAL contra
 * um draft real (`{"preview_text": "..."}` sozinho atualiza só esse campo,
 * confirmado via `PATCH` e via `PUT`, ambos HTTP 200, ambos preservando os
 * demais campos intocados). Consistente com o achado independente do #6047
 * (`PATCH` com só `subject`/`preview_text`/`thumbnail_url`/`thumbnail_alt`).
 * `updateBroadcast` usa `PATCH` — semântica correta pra atualização parcial,
 * e é o verbo que o #6047 já tinha validado em produção.
 *
 * ## Sem test-send nativo (achado ao vivo, #464)
 *
 * Ao contrário da Beehiiv, a API do Kit **não tem endpoint de test email**.
 * O substituto adotado (`buildTestSendFilter` abaixo): uma tag dedicada
 * (`KIT_TEST_SEND_TAG_NAME`, resolvida em runtime via `resolveTestSendTagId`
 * — nunca hardcoded, porque o id da tag é por-conta) com só o(s) e-mail(s)
 * do editor, e um broadcast REAL (não uma prévia) escopado só a essa tag via
 * `subscriber_filter`. Confirmado ao vivo: entrega em segundos, cai na
 * caixa de entrada (não spam), 1 destinatário exato.
 *
 * **Isso é um envio de verdade, não reversível.** `deleteBroadcast` só
 * funciona em `draft`/`scheduled` — confirmado ao vivo que um broadcast
 * `completed` devolve 422 `"Broadcast has already been sent."` ao tentar
 * apagar. O escopo estreito (1 destinatário, a tag de teste) é a mitigação:
 * errar o conteúdo de um test-send é barato (1 e-mail a mais na caixa do
 * editor), nunca um envio de verdade pra base.
 *
 * ## Merge tag de personalização (achado ao vivo, #464)
 *
 * Sintaxe Liquid, `{{ subscriber.email_address }}` — confirmado ao vivo
 * expandindo pro e-mail real do destinatário (não deixa `{{...}}` literal,
 * não quebra em torno de `{{`/`}}` como o achado do #4692 na Brevo). É essa
 * a tag que `Esp: "kit"` usa em `newsletter-render-html.ts` pro link de
 * voto do É IA? — ver docstring de `buildVoteUrl` lá.
 */

import { kitFetch } from "./kit-client.ts";
import type { KitConfig } from "./kit-config.ts";
import type { KitBroadcastDetail, KitPagination } from "./kit-client.ts";

/** Nome da tag reservada pra test-send — criada 1x por conta (achado #464:
 *  não existe endpoint idempotente "get or create" no Kit, então
 *  `resolveTestSendTagId` lista e cria só se ausente). */
export const KIT_TEST_SEND_TAG_NAME = "diaria-test-email";

/**
 * Shape de `subscriber_filter` — achado do review (PR #6080, type-design-analyzer):
 * campo de MAIOR blast radius do módulo (decide QUEM recebe um envio real e
 * irreversível), tipado antes como `unknown[]` — zero proteção do compilador
 * bem no ponto onde `buildTestSendFilter`/`buildAllSubscribersFilter` existem
 * justamente pra evitar a troca dos dois por engano. Cobre só as 2 variantes
 * que os builders deste módulo produzem hoje — não uma enumeração completa
 * do que a API do Kit aceita (não documentado publicamente).
 */
export type KitFilterCondition = { type: "tag"; ids: number[] } | { type: "all_subscribers" };
export type KitSubscriberFilter = { all: KitFilterCondition[] }[];

export interface CreateBroadcastInput {
  subject: string;
  content: string;
  description?: string;
  public?: boolean;
  published_at?: string;
  /** `null`/ausente = rascunho. Timestamp ISO8601 = agenda o envio. */
  send_at?: string | null;
  preview_text?: string;
  thumbnail_url?: string | null;
  thumbnail_alt?: string | null;
  email_template_id?: number;
  email_address?: string;
  subscriber_filter?: KitSubscriberFilter;
}

export async function createBroadcast(
  input: CreateBroadcastInput,
  config?: KitConfig,
): Promise<KitBroadcastDetail> {
  const data = await kitFetch<{ broadcast: KitBroadcastDetail } | undefined>("/broadcasts", {
    method: "POST",
    body: input,
    config,
  });
  if (!data?.broadcast) {
    throw new Error("[kit-broadcasts] createBroadcast: resposta 2xx sem o envelope \"broadcast\" esperado");
  }
  return data.broadcast;
}

export type UpdateBroadcastInput = Partial<CreateBroadcastInput>;

export async function updateBroadcast(
  id: number,
  input: UpdateBroadcastInput,
  config?: KitConfig,
): Promise<KitBroadcastDetail> {
  const data = await kitFetch<{ broadcast: KitBroadcastDetail } | undefined>(`/broadcasts/${id}`, {
    method: "PATCH",
    body: input,
    config,
  });
  if (!data?.broadcast) {
    throw new Error(`[kit-broadcasts] updateBroadcast(${id}): resposta 2xx sem o envelope "broadcast" esperado`);
  }
  return data.broadcast;
}

/**
 * Apaga um broadcast — só funciona em `draft`/`scheduled` (ver docstring do
 * módulo). Lança `KitApiError` (via `kitFetch`) com status 422 se o
 * broadcast já foi enviado — o caller decide se isso é fatal ou um warning
 * (ex: cleanup de teste que já disparou não é erro de verdade).
 */
export async function deleteBroadcast(id: number, config?: KitConfig): Promise<void> {
  await kitFetch<undefined>(`/broadcasts/${id}`, { method: "DELETE", config });
}

// ---------------------------------------------------------------------------
// Tags — usadas pelo mecanismo de test-send (ver docstring do módulo)
// ---------------------------------------------------------------------------

export interface KitTag {
  id: number;
  name: string;
  created_at: string;
}

export async function listTags(
  opts: { perPage?: number; after?: string; config?: KitConfig } = {},
): Promise<{ tags: KitTag[]; pagination: KitPagination }> {
  const params = new URLSearchParams();
  if (opts.perPage) params.set("per_page", String(opts.perPage));
  if (opts.after) params.set("after", opts.after);
  const qs = params.toString();
  const data = await kitFetch<{ tags: KitTag[]; pagination: KitPagination }>(`/tags${qs ? `?${qs}` : ""}`, {
    config: opts.config,
  });
  return data;
}

export async function createTag(name: string, config?: KitConfig): Promise<KitTag> {
  const data = await kitFetch<{ tag: KitTag } | undefined>("/tags", { method: "POST", body: { name }, config });
  if (!data?.tag) {
    throw new Error("[kit-broadcasts] createTag: resposta 2xx sem o envelope \"tag\" esperado");
  }
  return data.tag;
}

export async function tagSubscriber(tagId: number, subscriberId: number, config?: KitConfig): Promise<void> {
  await kitFetch<undefined>(`/tags/${tagId}/subscribers/${subscriberId}`, { method: "POST", config });
}

/**
 * Resolve o id da tag de test-send, criando-a se ainda não existir. Sem
 * cache — cada chamador paga 1 `listTags` (barato, endpoint singular já
 * coberto pelo retry padrão de `kitFetch`).
 *
 * **Não é atômico** (achado do review, #6080): 2 chamadas CONCORRENTES na
 * 1ª execução (conta nova, tag ainda não existe) podem criar 2 tags com o
 * mesmo nome — o Kit não impõe unicidade de nome de tag, e não há
 * find-or-create atômico no lado da API. Risco aceito, mitigado só pelo
 * fato de a tag ser criada 1x por conta, manualmente, não em chamadas
 * paralelas — nunca aconteceu em prática, mas não é uma garantia estrutural.
 */
export async function resolveTestSendTagId(config?: KitConfig): Promise<number> {
  let after: string | undefined;
  for (;;) {
    const { tags, pagination } = await listTags({ after, config });
    const found = tags.find((t) => t.name === KIT_TEST_SEND_TAG_NAME);
    if (found) return found.id;
    if (!pagination.has_next_page || !pagination.end_cursor) break;
    after = pagination.end_cursor;
  }
  const created = await createTag(KIT_TEST_SEND_TAG_NAME, config);
  return created.id;
}

/**
 * `subscriber_filter` escopado a UMA tag.
 *
 * **Cuidado (#6126):** um `subscriber_filter` ausente/vazio no Kit significa
 * **audiência INTEIRA**, não audiência nenhuma — o modo de falha é enviar pra
 * base toda, não pra ninguém. Por isso nenhum caller deve montar filtro de tag
 * à mão nem passar `[]`: use este helper, e valide que o `tagId` foi resolvido
 * ANTES de criar o broadcast.
 */
export function buildTagFilter(tagId: number): KitSubscriberFilter {
  return [{ all: [{ type: "tag", ids: [tagId] }] }];
}

/** `subscriber_filter` escopado só à tag de test-send — ver docstring do
 *  módulo sobre por que isso substitui o test-send nativo que o Kit não
 *  tem. */
export function buildTestSendFilter(tagId: number): KitSubscriberFilter {
  return buildTagFilter(tagId);
}

/**
 * Resolve o id de uma tag pelo NOME, sem criá-la se faltar (#6126).
 *
 * Difere de `resolveTestSendTagId` de propósito: aquele CRIA a tag de teste
 * quando ausente, porque uma tag de teste vazia é inofensiva. Aqui não — a tag
 * de audiência (`kit-nativo`) ausente significa que o marcador de cadastro
 * nativo (#6048/PR #6127) ainda não rodou, e criar uma tag vazia produziria um
 * filtro que casa com ninguém *ou*, se o caller tratar o erro mal, um filtro
 * vazio que casa com TODO MUNDO. Devolver `null` força o caller a decidir
 * explicitamente.
 */
export async function findTagIdByName(name: string, config?: KitConfig): Promise<number | null> {
  // Pagina até o fim de propósito: uma conta com muitas tags poderia ter a
  // procurada fora da 1ª página, e "não achei" aqui significa "não envie" —
  // um falso negativo por paginação incompleta viraria canal silenciosamente
  // pulado, sem erro visível.
  let after: string | undefined;
  for (;;) {
    const page = await listTags({ perPage: 500, after, config });
    const match = page.tags.find((t) => t.name === name);
    if (match) return match.id;
    if (!page.pagination?.has_next_page || !page.pagination.end_cursor) return null;
    after = page.pagination.end_cursor;
  }
}

/** `subscriber_filter` pra audiência completa — equivalente ao "enviar pra
 *  todo mundo" da Beehiiv. */
export function buildAllSubscribersFilter(): KitSubscriberFilter {
  return [{ all: [{ type: "all_subscribers" }] }];
}
