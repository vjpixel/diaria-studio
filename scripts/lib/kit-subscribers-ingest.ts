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
import { ensureSubscriber, recordEvent, type EventType } from "./diaria-subscribers-db.ts";

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
      ts,
    });
    if (inserted) newEvents++;
    else alreadyKnown++;
  }

  return { newEvents, alreadyKnown, subscribersTouched };
}
