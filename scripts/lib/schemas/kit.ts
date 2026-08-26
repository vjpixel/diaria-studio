/**
 * kit.ts — Schemas Zod para responses da API Kit (#6362, item 7)
 *
 * Bug-driver: análogo ao #326 que motivou `beehiiv.ts` — `kit-client.ts`
 * (`listBroadcasts`/`getBroadcast`) faz `JSON.parse` com cast direto pra
 * interface TS, sem checagem de runtime. Se o Kit renomear/omitir
 * `published_at`, `pagination.has_next_page` ou `pagination.end_cursor`,
 * `extractPublishedDate` (via `beehiiv-timestamp.ts`, reusado pro Kit) vê
 * `undefined`, devolve `null`, e o broadcast é descartado em silêncio —
 * indistinguível de "não há edições novas". Estes schemas fazem `.parse()`
 * lançar loud em vez disso.
 *
 * Escopo deliberadamente estreito: só os campos que
 * `scripts/lib/shared/newsletter-read-source.ts` de fato consome
 * (listagem + detalhe de broadcast). `.passthrough()` preserva campos
 * extras sem exigir espelhar `KitBroadcastSummary`/`KitBroadcastDetail`
 * (`kit-client.ts`) campo a campo — mudança de shape em campo NÃO usado
 * aqui não quebra o parse.
 */

import { z } from "zod";

export const KitPaginationSchema = z
  .object({
    has_next_page: z.boolean(),
    end_cursor: z.string().nullable(),
  })
  .passthrough();

export const KitBroadcastSummarySchema = z
  .object({
    id: z.number(),
    subject: z.string(),
    send_at: z.string().nullable(),
    status: z.enum(["draft", "scheduled", "sending", "completed", "aborted"]),
    public: z.boolean(),
    published_at: z.string().nullable(),
  })
  .passthrough();

export const ListBroadcastsResponseSchema = z
  .object({
    broadcasts: z.array(KitBroadcastSummarySchema),
    pagination: KitPaginationSchema,
  })
  .passthrough();

export type ParsedListBroadcastsResponse = z.infer<typeof ListBroadcastsResponseSchema>;

/** `public_url` continua opcional/ausente (#6096) — nunca confirmado que o
 *  Kit sempre popula. `content` é nullable (rascunho sem conteúdo ainda). */
export const KitBroadcastDetailSchema = KitBroadcastSummarySchema.extend({
  content: z.string().nullable(),
  public_url: z.string().optional(),
}).passthrough();

export type ParsedKitBroadcastDetail = z.infer<typeof KitBroadcastDetailSchema>;

/** Parse + valida `{ broadcasts, pagination }` de `listBroadcasts`. Lança
 *  `ZodError` se o shape crítico (id/subject/status/public/published_at,
 *  pagination.has_next_page/end_cursor) não bater. */
export function parseListBroadcastsResponse(raw: unknown): ParsedListBroadcastsResponse {
  return ListBroadcastsResponseSchema.parse(raw);
}

/** Parse + valida o `broadcast` de `getBroadcast`. */
export function parseKitBroadcastDetail(raw: unknown): ParsedKitBroadcastDetail {
  return KitBroadcastDetailSchema.parse(raw);
}
