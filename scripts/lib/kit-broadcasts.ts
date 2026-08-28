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
 *
 * ## `email_template_id` — veredito da investigação de painel (#6181, 26/08/2026)
 *
 * Broadcast do piloto Patronos (`25609304`) saiu com `email_template_id:
 * undefined`, resolvendo pro template DEFAULT da conta. Confirmado via
 * `list_email_templates`: a conta tem exatamente 2, ambos categoria
 * `Classic` — `Text only` (id 5472839, `is_default: true`, é o que
 * renderizou o piloto) e `Copy of Modern for Cold Subscribers` (id
 * 5475525, resíduo da automação deletada em #6128).
 *
 * **Duas perguntas seguem sem resposta, e são PAREDE DE PLATAFORMA — não
 * pendência de trabalho, não reabrir sem uma capacidade nova do Kit:**
 *
 * 1. **O 2º template (`Copy of Modern for Cold Subscribers`) renderiza o
 *    rodapé centralizado?** Sem rota pra inspecionar: `/email_templates` e
 *    `/email_templates/{id}/edit` dão 404 no painel, e a API só devolve
 *    `content` pra templates da categoria `Starting point` — os dois desta
 *    conta são `Classic`, retornam `null`. Ver exigiria abrir o composer de
 *    um broadcast real, arriscando autosave num rascunho de produção — não
 *    feito de propósito.
 * 2. **Dá pra limpar o template órfão?** Não — mesma parede: sem rota de
 *    painel (mesmo 404 acima) e a API v4 não tem endpoint de delete de
 *    template (mesma limitação já documentada pras 3 tags órfãs do #6128,
 *    ver a docstring de `kitFetch` em `kit-client.ts`). Só via composer ou
 *    suporte do Kit, se algum dia importar.
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
 * justamente pra evitar a troca dos dois por engano. Cobre a única variante
 * que `buildTestSendFilter` produz hoje (`tag`) — não uma enumeração completa
 * do que a API do Kit aceita (não documentado publicamente). `all_subscribers`
 * NÃO é um `type` reconhecido pela API real (achado ao vivo #6323, 1º dispatch
 * via Kit: 422 "Only `segment` or `tag` filters allowed") — removido da união;
 * "todo mundo" é `subscriber_filter: []`, ver `buildAllSubscribersFilter`.
 */
export type KitFilterCondition = { type: "tag"; ids: number[] };
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
 * `GET /v4/subscribers/{id}/tags` — lista as tags de UM assinante.
 *
 * Único caminho de verificação pós-`tagSubscriber` sem o atraso de
 * propagação documentado em `kit-client.ts` (ver "Armadilhas da API v4" no
 * topo daquele módulo): a listagem `GET /tags/{id}/subscribers` (direção
 * tag→assinantes) mediu 180s de atraso e mentiu "lista completa" durante a
 * janela; esta rota (direção assinante→tags) não mostrou atraso na mesma
 * medição. Usada por `kit-gmail-warmup-ramp.ts` (#6504 item 2) pra confirmar
 * que cada `tagSubscriber` da onda de fato pegou antes de marcar o
 * endereço como "devolvido" no estado local — nunca confia só no 2xx da
 * mutação, mesma disciplina do resto do módulo.
 */
export async function listSubscriberTags(subscriberId: number, config?: KitConfig): Promise<KitTag[]> {
  const data = await kitFetch<{ tags: KitTag[] } | undefined>(`/subscribers/${subscriberId}/tags`, { config });
  return data?.tags ?? [];
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
 * ## ⚠️ A listagem do Kit tem ATRASO DE PROPAGAÇÃO (medido: ~1-2 min)
 *
 * Achado ao vivo em 25/08/2026: uma tag recém-criada (`POST /v4/tags` → 201)
 * NÃO aparece imediatamente em `GET /v4/tags`. Medido: invisível logo após a
 * criação, presente ~90s depois. O mesmo vale pra rename (`PUT`) — a listagem
 * mostra o nome antigo por um tempo.
 *
 * Consequência prática pra quem chama isto: logo depois de criar/renomear
 * uma tag de audiência, `findTagIdByName` pode devolver `null` mesmo com a
 * tag existindo. O caller então PULA o envio — falha na direção segura, que é
 * o desenho correto, mas produz um estado confuso: "canal ligado, tag criada,
 * e mesmo assim inativo".
 *
 * **Se isso acontecer: esperar e re-rodar, não debugar a tag.** Confirmar
 * existência por `GET /v4/subscribers/{id}/tags` (reflete na hora) em vez da
 * listagem.
 *
 * Nota relacionada: `DELETE /v4/tags/{id}` responde **204 sem remover** e
 * `GET /v4/tags/{id}` responde **404 pra qualquer id** (a rota não existe na
 * v4) — nenhum dos dois serve como verificação. A listagem é a única fonte,
 * respeitado o atraso acima.
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
    if (!page.pagination) {
      // #6138 finding 6: 2xx sem metadado de paginação. Degradar pra "fim da
      // lista" é a escolha SEGURA (o caller pula em vez de enviar), mas sem
      // este log o `null` resultante seria reportado como "a tag não existe" —
      // mandando quem investiga procurar no lugar errado.
      process.stderr.write(
        `[kit-broadcasts] aviso: listTags devolveu 2xx sem 'pagination' ao procurar "${name}" — ` +
          `tratando como fim da lista. Se a tag existir no painel, suspeite da resposta da API, não do marcador.\n`,
      );
      return null;
    }
    if (!page.pagination.has_next_page || !page.pagination.end_cursor) return null;
    after = page.pagination.end_cursor;
  }
}

/** `subscriber_filter` pra audiência completa — equivalente ao "enviar pra
 *  todo mundo" da Beehiiv. Array vazio, não um filtro com `type:
 *  "all_subscribers"` — a API do Kit não reconhece esse tipo (só aceita
 *  `segment`/`tag`, achado ao vivo #6323 no 1º dispatch real via Kit: 422
 *  "Only `segment` or `tag` filters allowed"). Confirmado na doc oficial
 *  (developers.kit.com/api-reference/broadcasts/create-a-broadcast): "If
 *  nothing is provided, will default to all of your subscribers" — e o
 *  próprio #6126 já documentava esse entendimento em `kit-diaria-channel.ts`,
 *  só o builder aqui divergia. */
export function buildAllSubscribersFilter(): KitSubscriberFilter {
  return [];
}

/**
 * `GET /v4/tags/{id}/subscribers` — lista quem tem uma tag (#6582).
 *
 * ⚠️ Ver "Armadilhas da API v4" no topo de `kit-client.ts`: esta listagem
 * mediu **180s de atraso de propagação** logo após um `tagSubscriber`, e no
 * intervalo devolveu `has_next_page: false` como se a lista já estivesse
 * completa — um falso negativo silencioso. A ressalva documentada lá é
 * específica de checar a tag **logo depois** de aplicá-la; usar esta rota
 * pra contar membros de uma tag **horas** depois da mutação (o caso de
 * `countKitTagMembers` abaixo, chamado no Stage 4/5, tipicamente bem depois
 * de qualquer `tagSubscriber`) não bateu nessa janela nas medições feitas —
 * mas não há confirmação ao vivo específica pra esse uso mais tardio. Não é
 * a rota recomendada pra confirmar *quem entrou* logo após taguear (use
 * `listSubscriberTags`, direção inversa, sem atraso observado); é a única
 * rota que existe pra "quantos membros esta tag tem HOJE", que é a pergunta
 * do guard de #6582.
 */
export async function listTagSubscribersPage(
  tagId: number,
  opts: { perPage?: number; after?: string; config?: KitConfig } = {},
): Promise<{ subscribers: { id: number; email_address: string }[]; pagination: KitPagination }> {
  const params = new URLSearchParams();
  if (opts.perPage) params.set("per_page", String(opts.perPage));
  if (opts.after) params.set("after", opts.after);
  const qs = params.toString();
  const data = await kitFetch<
    { subscribers: { id: number; email_address: string }[]; pagination: KitPagination } | undefined
  >(`/tags/${tagId}/subscribers${qs ? `?${qs}` : ""}`, { config: opts.config });
  return { subscribers: data?.subscribers ?? [], pagination: data?.pagination ?? {
    has_previous_page: false,
    has_next_page: false,
    start_cursor: null,
    end_cursor: null,
    per_page: opts.perPage ?? 500,
  } };
}

/**
 * Conta membros de uma tag, paginando até o fim. Usado pelo guard de
 * invariante do #6582 (`checkAudienceTagHasMembers`): tag resolvida (id
 * válido) mas com 0 membros deixou de ser normal desde a migração das ondas
 * 0/1 (#6504) — ver a docstring daquela função pro porquê.
 *
 * Volume esperado é pequeno (dezenas a poucas centenas, ver
 * `platform.config.json` → `kit_diaria.audience_tag_note`) — sem checkpoint,
 * paginação simples é suficiente.
 */
export async function countKitTagMembers(tagId: number, config?: KitConfig): Promise<number> {
  let count = 0;
  let after: string | undefined;
  for (;;) {
    const page = await listTagSubscribersPage(tagId, { perPage: 500, after, config });
    count += page.subscribers.length;
    if (!page.pagination.has_next_page || !page.pagination.end_cursor) break;
    after = page.pagination.end_cursor;
  }
  return count;
}
