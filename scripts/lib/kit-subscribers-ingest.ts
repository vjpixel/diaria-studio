/**
 * kit-subscribers-ingest.ts (#6464 fatia 3 — #6586)
 *
 * Miolo PURO da ingestão Kit → store unificado `diaria-subscribers-db.ts`.
 * Mapeamento eixo→tipo de evento, construção da chave natural determinística
 * (`external_event_id`), o guard anti-fabricação (#6496) e a escrita
 * idempotente por eixo — tudo testável sem rede, injetando `DatabaseSync`
 * `:memory:` e listas de e-mail já resolvidas (o fetch real via
 * `fetchAudience`/`drainPages` — já endurecido, `scripts/kit-provider-split.ts`
 * — fica no CLI `diaria-subscribers-ingest-kit.ts`, que é a única camada com
 * I/O deste par).
 *
 * ## Por que "delivered" é eixo de 1ª classe (não detalhe)
 *
 * `sent − delivered` é o sinal que abertura sozinha esconde — achado #6504
 * (edição 260827: Gmail recusou 72% do 1º envio em massa, e a métrica
 * agregada de abertura, sozinha, não dizia por quê). Por isso o Kit ingere
 * os 4 eixos (`sent`/`delivered`/`opens`/`clicks`), nunca só engajamento.
 *
 * ## Bounce é DERIVADO, nunca gravado como evento sintético
 *
 * `/broadcasts/{id}/stats` do Kit não expõe bounce (ver docstring de
 * `scripts/kit-provider-split.ts`) — só a AUSÊNCIA em `delivered` de quem
 * está em `sent` prova bounce, e essa é uma pergunta de LEITURA sobre a
 * timeline (`sent` sem `delivered` correspondente pro mesmo broadcast),
 * nunca um evento `bounce` que a fonte nunca confirmou individualmente.
 */

import type { DatabaseSync } from "node:sqlite";
import type { BroadcastAudience } from "../kit-provider-split.ts";
import {
  ensureSubscriber,
  recordEvent,
  upsertSubscription,
  upsertAttribute,
  coerceAttributeValue,
  type EventType,
} from "./diaria-subscribers-db.ts";
import type { KitSubscriberSummary } from "./kit-subscribers.ts";

/** Eixo do Kit → tipo de evento do store. `opens`/`clicks` (plural, vocabulário
 *  da API) viram `open`/`click` (singular, vocabulário do store) de propósito
 *  — mesma distinção documentada em `kit-provider-split.ts` (evento vs pessoa). */
export function mapAudienceToEventType(axis: BroadcastAudience): EventType {
  const map: Record<BroadcastAudience, EventType> = {
    sent: "sent",
    delivered: "delivered",
    opens: "open",
    clicks: "click",
  };
  return map[axis];
}

/**
 * Chave natural determinística do evento — o Kit não expõe um id de evento
 * nativo por (assinante × broadcast × eixo), então construímos uma string
 * estável (mesmo padrão documentado em `SubscriberEvent.externalEventId`,
 * `diaria-subscribers-db.ts`). `platform` já escopa "kit" na chave natural
 * do `event` (UNIQUE(platform, type, external_event_id)), então não precisa
 * repetir aqui. E-mail normalizado (trim + lowercase) — mesma normalização
 * de `ensureSubscriber`, pra nunca divergir da chave de identidade.
 */
export function buildKitEventExternalId(email: string, broadcastId: number, axis: BroadcastAudience): string {
  return `${email.trim().toLowerCase()}:${broadcastId}:${axis}`;
}

export interface KitIngestionGuardResult {
  ok: boolean;
  reason?: string;
}

/**
 * Guard anti-fabricação (#6586 critério de pronto, lição #6496: um agente
 * reportou "ok, 0 registros" sem de fato ter chamado a API). Compara a
 * contagem ingerida no eixo `sent` contra `stats.recipients` do próprio Kit
 * — confirmado ao vivo (`kit-provider-split.ts`) que os dois batem
 * exatamente quando a coleta é completa (594 == 594, broadcast 25622689).
 * Divergência não aborta a ingestão (o que já foi coletado é gravado —
 * idempotente, uma re-rodada completa depois), só impede marcar o broadcast
 * como `ok` no manifest — ele volta em `pendingManifestEntries` até bater.
 */
export function verifyKitIngestion(sentCount: number, statsRecipients: number): KitIngestionGuardResult {
  if (sentCount === statsRecipients) return { ok: true };
  return {
    ok: false,
    reason:
      `eixo "sent" ingerido (${sentCount}) != stats.recipients do Kit (${statsRecipients}) — ` +
      `cobertura truncada ou resposta divergente; não marcando "ok" (guard anti-fabricação, #6496).`,
  };
}

export interface KitIngestAxisResult {
  newEvents: number;
  alreadyKnown: number;
  subscribersTouched: number;
}

/**
 * Ingerir 1 eixo (sent/delivered/opens/clicks) de 1 broadcast: para cada
 * e-mail, resolve/cria o `subscriber` (`ensureSubscriber`, platform "kit",
 * sem `external_id` nativo — o Kit não devolve id de assinante em
 * `/subscribers/filter`, só `email_address`) e grava 1 `event` idempotente.
 * Dedup de e-mails repetidos na MESMA página/eixo (defensivo — a API não
 * deveria repetir, mas `recordEvent` já é idempotente mesmo se repetir).
 *
 * `ts` é o timestamp do BROADCAST (`published_at`/`send_at`), não do evento
 * individual — `/subscribers/filter` não devolve timestamp por assinante,
 * só a lista de quem está no eixo. Precisão de "quando" fica no nível do
 * broadcast, não do evento — mesma granularidade que a fonte oferece.
 */
export function ingestBroadcastAudience(
  db: DatabaseSync,
  broadcastId: number,
  axis: BroadcastAudience,
  emails: string[],
  ts: string,
  now: string = new Date().toISOString(),
): KitIngestAxisResult {
  const type = mapAudienceToEventType(axis);
  const seen = new Set<string>();
  let newEvents = 0;
  let alreadyKnown = 0;
  let subscribersTouched = 0;

  for (const rawEmail of emails) {
    const email = rawEmail.trim().toLowerCase();
    if (!email || seen.has(email)) continue;
    seen.add(email);

    const subscriberId = ensureSubscriber(db, "kit", null, email, now);
    subscribersTouched++;
    const { inserted } = recordEvent(db, {
      subscriberId,
      platform: "kit",
      type,
      externalEventId: buildKitEventExternalId(email, broadcastId, axis),
      // #6591: `edicao` = o broadcast — o Kit já grava exatamente 1 evento
      // "click" por (assinante × broadcast) (a chave natural acima não tem
      // eixo de link), então `edicao` aqui é redundante com a chave natural
      // pra ESTE eixo, mas populá-lo sempre (não só em "click") é o que
      // permite `leitor-store.ts` contar "recebidas"/"únicas clicadas" por
      // `COUNT(DISTINCT edicao)` de forma simétrica entre plataformas, sem
      // um caso especial pro Kit.
      edicao: String(broadcastId),
      ts,
    });
    if (inserted) newEvents++;
    else alreadyKnown++;
  }

  return { newEvents, alreadyKnown, subscribersTouched };
}

// ---------------------------------------------------------------------------
// Ingestão de ROSTER (#7174, F2 do épico #7172) — 1º passo de
// diaria-subscribers-ingest-kit.ts, ao LADO da ingestão de audiência por
// broadcast acima (não no lugar dela). Popula a dimensão `subscription`,
// que a ingestão de audiência nunca tocava — só `ensureSubscriber`/
// `recordEvent`.
// ---------------------------------------------------------------------------

export interface KitRosterIngestResult {
  processed: number;
  subscriptionsWritten: number;
  subscribeEvents: { newEvents: number; alreadyKnown: number };
  unsubEvents: { newEvents: number; alreadyKnown: number };
  attributesWritten: number;
}

/**
 * Extrai `(key, value)` de `sub.fields` — TODO o custom field do assinante,
 * não só o subconjunto de UTM que `ingestKitRoster` já grava em
 * `subscription` (#7202). Inclui `apoio_nivel` (linha de receita) e
 * qualquer outro campo configurado na conta Kit. Chave/valor genérico, não
 * lista fixa — o conjunto de campos muda sem aviso (mesma decisão de
 * `extractBeehiivCustomFieldAttributes`). `value` passa por
 * `coerceAttributeValue` — string vazia/`null`/`undefined` viram "atributo
 * ausente" (entry omitida), nunca gravados como resposta em branco.
 */
export function extractKitFieldAttributes(
  sub: Pick<KitSubscriberSummary, "fields">,
): Array<{ key: string; value: string }> {
  const fields = sub.fields ?? {};
  const out: Array<{ key: string; value: string }> = [];
  for (const [key, raw] of Object.entries(fields)) {
    if (!key) continue;
    const value = coerceAttributeValue(raw);
    if (value === null) continue;
    out.push({ key, value });
  }
  return out;
}

/**
 * Estados do Kit que representam "não mais na base" — o CREATE do worker
 * `reativar`/`poll` nasce `active`, e a transição pra qualquer um destes é
 * quando `upsertSubscription` grava `exitedAt`. `active`/`inactive` (double
 * opt-in pendente) permanecem SEM `exitedAt` — `inactive` ainda é membro da
 * base, só não confirmou o opt-in.
 */
const KIT_EXITED_STATES: ReadonlySet<string> = new Set(["cancelled", "bounced", "complained"]);

/**
 * Ingerir o ROSTER completo do Kit — 1 `subscriber` + 1 `subscription` +
 * (no mínimo) 1 evento `subscribe` por assinante, gravados via
 * `upsertSubscription`/`recordEvent`. Não classifica (F1/F4 fazem isso na
 * leitura); grava a atribuição CRUA como veio do Kit.
 *
 * **De onde sai cada campo (contrato explícito, #7174):**
 * - `external_id` ← `id`; `status` ← `state`; `entered_at` ← `created_at`;
 *   identidade ← `email_address`.
 * - `utm_source`/`utm_medium`/`utm_campaign`/`utm_channel`/`referring_site`/
 *   `origem_cadastro` ← **`fields` (custom fields), NUNCA `attribution`**
 *   (o bloco `attribution` vem sempre mas com UTM nulo — ver a docstring
 *   corrigida de `KitSubscriberAttribution` em `kit-subscribers.ts`).
 *
 * Idempotente: `upsertSubscription` faz `ON CONFLICT DO UPDATE` (nunca
 * duplica linha), `recordEvent` faz `INSERT OR IGNORE` sobre a chave
 * natural `email:subscribe:{created_at}` (nunca duplica evento).
 *
 * Não classifica interno/teste — mesma disciplina do resto do épico: quem
 * agrega filtra (`filterInternalAndTestSubscribers`), a captura grava todo
 * mundo.
 */
export function ingestKitRoster(
  db: DatabaseSync,
  subscribers: readonly KitSubscriberSummary[],
  now: string = new Date().toISOString(),
): KitRosterIngestResult {
  let subscriptionsWritten = 0;
  let subscribeNew = 0;
  let subscribeKnown = 0;
  let unsubNew = 0;
  let unsubKnown = 0;
  let attributesWritten = 0;

  for (const sub of subscribers) {
    const email = sub.email_address.trim().toLowerCase();
    if (!email) continue;

    const subscriberId = ensureSubscriber(db, "kit", String(sub.id), email, now);
    const fields = sub.fields ?? {};
    const status = sub.state ?? null;
    const exited = status != null && KIT_EXITED_STATES.has(status);

    // #7222 finding 1: precisa ser lido ANTES do upsertSubscription abaixo
    // (que sobrescreve `exited_at`) — é o único jeito de distinguir
    // "já estava exited numa rodada anterior" de "está transicionando para
    // exited agora". Sem isso, todo dia em que o roster reporta o MESMO
    // `state` (Kit não expõe timestamp de cancelamento — ver docstring do
    // módulo) gera um `externalEventId` novo (chave inclui o dia da
    // captura) e o evento `unsub` seria reinserido para sempre.
    const previousSubscription = db
      .prepare("SELECT exited_at FROM subscription WHERE subscriber_id = ? AND platform = 'kit'")
      .get(subscriberId) as { exited_at: string | null } | undefined;
    const wasExitedBefore = previousSubscription != null && previousSubscription.exited_at != null;

    upsertSubscription(
      db,
      subscriberId,
      "kit",
      {
        status,
        enteredAt: sub.created_at ?? null,
        exitedAt: exited ? now : null,
        source: fields.utm_source ?? null,
        utmMedium: fields.utm_medium ?? null,
        utmCampaign: fields.utm_campaign ?? null,
        utmChannel: fields.utm_channel ?? null,
        referringSite: fields.referring_site ?? null,
        origemCadastro: fields.origem_cadastro ?? null,
      },
      now,
    );
    subscriptionsWritten++;

    if (sub.created_at) {
      const { inserted } = recordEvent(db, {
        subscriberId,
        platform: "kit",
        type: "subscribe",
        externalEventId: `${email}:subscribe:${sub.created_at}`,
        ts: sub.created_at,
      });
      if (inserted) subscribeNew++;
      else subscribeKnown++;
    }

    if (exited && !wasExitedBefore) {
      // O Kit não expõe timestamp de cancelamento — só o ESTADO ATUAL (ver
      // docstring do módulo/#7174), e o roster reporta o MESMO `state` em
      // TODA rodada enquanto o assinante seguir cancelado. Gravar só na
      // TRANSIÇÃO (`wasExitedBefore` checado acima, antes do upsert acima
      // sobrescrever `exited_at`) é o que impede reinserção sem limite
      // (#7222 finding 1) — o guard `INSERT OR IGNORE` de `recordEvent` só
      // dedupe pela CHAVE, e uma chave por dia de captura seria sempre nova.
      // A chave natural ainda usa o dia da captura (não `now` inteiro) por
      // segurança — se este `if` algum dia rodar 2x no mesmo dia pro mesmo
      // assinante antes do estado ter sido persistido em outra rodada, o
      // `INSERT OR IGNORE` segue sendo a rede de segurança, não a regra.
      const captureDay = now.slice(0, 10);
      const { inserted } = recordEvent(db, {
        subscriberId,
        platform: "kit",
        type: "unsub",
        externalEventId: `${email}:unsub:${status}:${captureDay}`,
        ts: now,
      });
      if (inserted) unsubNew++;
      else unsubKnown++;
    } else if (exited) {
      unsubKnown++;
    }

    for (const attr of extractKitFieldAttributes(sub)) {
      upsertAttribute(db, subscriberId, "kit", attr.key, attr.value, now);
      attributesWritten++;
    }
  }

  return {
    processed: subscribers.length,
    subscriptionsWritten,
    subscribeEvents: { newEvents: subscribeNew, alreadyKnown: subscribeKnown },
    unsubEvents: { newEvents: unsubNew, alreadyKnown: unsubKnown },
    attributesWritten,
  };
}
