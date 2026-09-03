/**
 * brevo-subscribers-ingest.ts (#6464 fatia 4 — #6587)
 *
 * Miolo PURO da ingestão Brevo → store unificado `diaria-subscribers-db.ts`,
 * pra conta `brevo_diaria` (canal de reativação da diária — ver docstring de
 * `PLATFORMS` em `diaria-subscribers-db.ts`; `brevo_clarice` NUNCA entra
 * aqui, #7196). Copia o PADRÃO já provado por
 * `clarice-sync-brevo.ts`/`brevo-stats.ts` (parsing puro de um contato Brevo
 * v3 → colunas) — não o destino: aqui o alvo é o `event` genérico do épico
 * #6464, não `clarice_users`.
 *
 * `extractContactEvents` (`brevo-stats.ts`) decompõe `contact.statistics` em
 * eventos crus por categoria; este módulo mapeia pro vocabulário `EventType`
 * do store e grava via `ensureSubscriber`/`upsertSubscription`/`recordEvent`
 * — tudo testável sem rede (o fetch real, `GET /contacts/{id}` via
 * `brevoGet`, fica no CLI `diaria-subscribers-ingest-brevo.ts`).
 */

import type { DatabaseSync } from "node:sqlite";
import {
  ensureSubscriber,
  upsertSubscription,
  recordEvent,
  upsertAttribute,
  coerceAttributeValue,
  type EventType,
  type Platform,
} from "./diaria-subscribers-db.ts";
import { extractContactEvents, type BrevoContactEvent, type BrevoStatCategory } from "./brevo-stats.ts";

/**
 * Extrai `(key, value)` de `contact.attributes` — o bloco de custom
 * attributes da Brevo (apoio_nivel, survey, o que estiver configurado na
 * conta `brevo_diaria`; #7202). A Brevo tipicamente devolve TODO atributo
 * CONFIGURADO por contato, com `null` pra quem nunca preencheu — é
 * exatamente o caso que `coerceAttributeValue` trata como "ausente" (entry
 * omitida, nunca gravada como resposta em branco). `attributes` ausente/não
 *-objeto devolve `[]` (defensivo — contato malformado).
 */
export function extractBrevoContactAttributes(
  contact: Record<string, any>,
): Array<{ key: string; value: string }> {
  const attrs = contact?.attributes;
  if (!attrs || typeof attrs !== "object" || Array.isArray(attrs)) return [];
  const out: Array<{ key: string; value: string }> = [];
  for (const [key, raw] of Object.entries(attrs)) {
    if (!key) continue;
    const value = coerceAttributeValue(raw);
    if (value === null) continue;
    out.push({ key, value });
  }
  return out;
}

/** Único valor válido pra este builder (#7196: `brevo_clarice` nunca ingere
 *  no store da diária — mantido como alias de `Platform` em vez de literal
 *  solto pra deixar explícito que é um SUBCONJUNTO de `PLATFORMS`, não um
 *  tipo desconectado). */
export type BrevoAccountPlatform = Extract<Platform, "brevo_diaria">;

/** Categoria de `contact.statistics` → tipo de evento do store. `hardBounces`/
 *  `softBounces` colapsam em `"bounce"` — o store não distingue dureza do
 *  bounce (`EventType` não tem esse eixo; quem precisar da distinção volta a
 *  `clarice_users.mv_result`/similar, fora de escopo aqui). */
export function mapStatCategoryToEventType(category: BrevoStatCategory): EventType {
  const map: Record<BrevoStatCategory, EventType> = {
    messagesSent: "sent",
    opened: "open",
    clicked: "click",
    hardBounces: "bounce",
    softBounces: "bounce",
    unsubscriptions: "unsub",
    complaints: "complaint",
  };
  return map[category];
}

/**
 * Chave natural determinística do evento. Precisa incorporar `ts` (não só
 * email+campaignId) porque `statistics.{categoria}` pode ter MAIS DE UMA
 * entrada com o mesmo `campaignId` (ex: abriu a mesma campanha 2x em
 * momentos diferentes) — sem o `ts` na chave, a 2ª abertura seria descartada
 * como "evento já conhecido" (`INSERT OR IGNORE`) em vez de gravada como
 * evento distinto. `click` também incorpora `url` — cliques em links
 * diferentes da MESMA campanha não podem colidir na mesma chave.
 */
export function buildBrevoEventExternalId(
  email: string,
  category: BrevoStatCategory,
  campaignId: number | string | null,
  ts: string,
  url?: string | null,
): string {
  const parts = [email.trim().toLowerCase(), category, String(campaignId ?? "no-campaign"), ts];
  if (category === "clicked") parts.push(url ?? "no-url");
  return parts.join(":");
}

export interface BrevoContactIngestResult {
  newEvents: number;
  alreadyKnown: number;
  /** Entradas descartadas por não terem `ts` parseável — contadas, nunca
   *  inventadas (ver docstring de `BrevoContactEvent.ts` em brevo-stats.ts). */
  skippedNoTimestamp: number;
  attributesWritten: number;
}

/**
 * Ingerir 1 contato Brevo cru (corpo de `GET /contacts/{id}`) — resolve/cria
 * o `subscriber` (identidade `platform` + `external_id` = id numérico Brevo
 * como string + `email`), upserta a `subscription` (status derivado de
 * unsub/blacklist, `entered_at`/`source` da própria Brevo), grava 1 `event`
 * `subscribe` a partir de `contact.createdAt` (#7201 — Kit e Beehiiv já
 * emitiam; a Brevo upsertava `subscription.entered_at` mas nunca gravava o
 * evento datado, achado de review deste dispatch), grava 1 `event` por
 * entrada de `contact.statistics` com timestamp parseável, e grava
 * `subscriber_attribute` a partir de `contact.attributes` (#7202).
 *
 * `contactId` é o `id` numérico da Brevo — passado à parte porque o corpo cru
 * do contato TEM esse campo (`contact.id`), mas o caller já o conhece de
 * antemão (veio da enumeração/paginação) e não deveria confiar cegamente
 * num campo que pode faltar num payload malformado.
 */
export function ingestBrevoContact(
  db: DatabaseSync,
  platform: BrevoAccountPlatform,
  contactId: number,
  contact: Record<string, any>,
  now: string = new Date().toISOString(),
): BrevoContactIngestResult {
  const email = String(contact?.email ?? "").trim().toLowerCase();
  if (!email) {
    // Contato sem e-mail utilizável — `ensureSubscriber` exige externalId
    // OU email; aqui usamos o id Brevo como externalId, então isso nunca
    // lança, mas gravar um subscriber sem NENHUM jeito de reidentificar
    // pelo e-mail (o caminho de busca mais comum, `findSubscriberIdsByEmail`)
    // não ajudaria ninguém — melhor pular e contar como 0 eventos.
    return { newEvents: 0, alreadyKnown: 0, skippedNoTimestamp: 0, attributesWritten: 0 };
  }

  const subscriberId = ensureSubscriber(db, platform, String(contactId), email, now);

  const blacklisted = !!contact?.emailBlacklisted;
  const listUnsubscribed = Array.isArray(contact?.listUnsubscribed) && contact.listUnsubscribed.length > 0;
  const unsubscribed = blacklisted || listUnsubscribed;
  const listIds: unknown[] = Array.isArray(contact?.listIds) ? contact.listIds : [];

  upsertSubscription(
    db,
    subscriberId,
    platform,
    {
      status: unsubscribed ? "unsubscribed" : "active",
      enteredAt: typeof contact?.createdAt === "string" ? contact.createdAt : null,
      exitedAt: unsubscribed && typeof contact?.modifiedAt === "string" ? contact.modifiedAt : null,
      source: listIds.length > 0 ? `brevo_list:${listIds[0]}` : null,
    },
    now,
  );

  let newEvents = 0;
  let alreadyKnown = 0;
  let skippedNoTimestamp = 0;

  // #7201: emitir `subscribe` com a data de entrada, mesma disciplina do
  // Kit/Beehiiv (`ingestKitRoster`/`ingestBeehiivRoster`) — `createdAt` é a
  // data REAL do cadastro na Brevo (não `now` da captura), então a chave
  // natural nunca precisa de guard de transição (diferente do `unsub` de
  // roster do Kit/Beehiiv, que usa o dia da captura porque a fonte não
  // expõe timestamp real): reingerir o mesmo contato sempre produz a MESMA
  // chave, `INSERT OR IGNORE` já garante idempotência.
  if (typeof contact?.createdAt === "string" && contact.createdAt) {
    const { inserted } = recordEvent(db, {
      subscriberId,
      platform,
      type: "subscribe",
      externalEventId: `${email}:subscribe:${contact.createdAt}`,
      ts: contact.createdAt,
    });
    if (inserted) newEvents++;
    else alreadyKnown++;
  }

  const events: BrevoContactEvent[] = extractContactEvents(contact);

  for (const ev of events) {
    if (!ev.ts) {
      skippedNoTimestamp++;
      continue;
    }
    const { inserted } = recordEvent(db, {
      subscriberId,
      platform,
      type: mapStatCategoryToEventType(ev.category),
      externalEventId: buildBrevoEventExternalId(email, ev.category, ev.campaignId, ev.ts, ev.url ?? null),
      url: ev.category === "clicked" ? ev.url ?? null : null,
      // #6591: `edicao` = a campanha Brevo. Diferente do Kit, a chave
      // natural de "clicked" aqui INCLUI `url` — um assinante clicando 2
      // links da MESMA campanha grava 2 eventos "click" distintos. Sem
      // `edicao`, `leitor-store.ts` não teria como colapsar isso de volta
      // pra "1 edição clicada" (só `COUNT(*)` inflaria o CTR real, o mesmo
      // viés que `leitor-v1` existe pra evitar) — `campaignId` já estava
      // disponível aqui (`ev.campaignId`), só não persistido até agora.
      edicao: ev.campaignId != null ? String(ev.campaignId) : null,
      ts: ev.ts,
    });
    if (inserted) newEvents++;
    else alreadyKnown++;
  }

  let attributesWritten = 0;
  for (const attr of extractBrevoContactAttributes(contact)) {
    upsertAttribute(db, subscriberId, platform, attr.key, attr.value, now);
    attributesWritten++;
  }

  return { newEvents, alreadyKnown, skippedNoTimestamp, attributesWritten };
}
