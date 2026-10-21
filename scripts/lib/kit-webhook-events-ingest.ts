/**
 * kit-webhook-events-ingest.ts (#10648)
 *
 * Lado LOCAL dos eventos de webhook do Kit: lê `GET /api/eventos` do Worker
 * `kit-events` e grava em `kit_webhook_event` no `diaria-subscribers-db`.
 * Só leitura do NOSSO Worker — nunca chama o Kit. Contrato compartilhado em
 * `kit-webhook-events-contract.ts`.
 */

import type { DatabaseSync } from "node:sqlite";
import {
  isKitWebhookEventRecord,
  sortKitWebhookEvents,
  type KitWebhookEventRecord,
  type KitWebhookEventsPayload,
} from "./kit-webhook-events-contract.ts";
import {
  getLatestKitWebhookEventReceivedAt,
  hasKitWebhookEventKey,
  hasKitWebhookEventNear,
  recordKitWebhookEvent,
} from "./diaria-subscribers-db.ts";

/**
 * Margem subtraída do último `received_at` ingerido antes de pedir os
 * eventos novos. A listagem do KV é eventualmente consistente (até ~60s): um
 * evento gravado um pouco ANTES do último já visto pode ainda não aparecer na
 * listagem anterior. Releitura da janela é inofensiva (ingestão idempotente
 * pela chave), perder o evento não.
 */
export const KIT_WEBHOOK_SINCE_SAFETY_MS = 10 * 60 * 1000;

/** `since` da próxima leitura: null (tudo) com a tabela vazia — o que também
 *  repovoa a tabela depois de um `--reset` do store, já que o KV não expira. */
export function computeIncrementalSince(latestIngested: string | null): string | null {
  if (!latestIngested) return null;
  const t = Date.parse(latestIngested);
  if (Number.isNaN(t)) return null;
  return new Date(t - KIT_WEBHOOK_SINCE_SAFETY_MS).toISOString();
}

export type FetchKitEventsResult =
  | { ok: true; events: KitWebhookEventRecord[]; malformed: number }
  | { ok: false; error: string };

export async function fetchKitWebhookEvents(
  baseUrl: string,
  token: string,
  since: string | null,
  fetchImpl: typeof fetch = fetch,
): Promise<FetchKitEventsResult> {
  const url = new URL("/api/eventos", baseUrl);
  if (since) url.searchParams.set("since", since);
  let res: Response;
  try {
    res = await fetchImpl(url.toString(), { headers: { authorization: `Bearer ${token}` } });
  } catch (e) {
    return { ok: false, error: `fetch falhou: ${(e as Error).message}` };
  }
  if (!res.ok) return { ok: false, error: `HTTP ${res.status} em ${url.pathname}` };
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { ok: false, error: "resposta não é JSON" };
  }
  // Corpo não confiável: as chaves do contrato, mas com valor `unknown` até o
  // filtro item a item abaixo.
  const list = (body as { [K in keyof KitWebhookEventsPayload]?: unknown } | null)?.events;
  if (!Array.isArray(list)) return { ok: false, error: "resposta sem lista `events`" };
  const events = list.filter(isKitWebhookEventRecord);
  return { ok: true, events, malformed: list.length - events.length };
}

/**
 * Janela de deduplicação de retries do webhook do Kit (#10722).
 *
 * O corpo do webhook do Kit não traz id de evento nem de entrega (só o
 * `subscriber`, ver `kit-webhook-events-contract.ts`), e o Worker grava cada
 * tentativa com chave própria (horário de recebimento + sufixo aleatório).
 * Um retry de uma entrega que o Worker já gravou (resposta perdida, timeout
 * do lado do Kit) vira 2 chaves no KV. Sem id estável, a única forma de
 * reconhecer o retry é aproximada: mesmo assinante, mesmo tipo, mesma URL,
 * a no máximo esta distância de um evento já ingerido.
 *
 * Política declarada (premissa da #10722, revisável aqui):
 *  - O KV continua guardando TODAS as tentativas, sem perda: a dedup é só na
 *    ingestão, então mudar a janela e reingerir (`--reset` + `--all`) refaz
 *    a contagem sem depender de nada que já tenha sido apagado.
 *  - Custo aceito: dois cliques legítimos do mesmo assinante no MESMO link
 *    dentro da janela viram 1 registro (o payload é idêntico ao de um
 *    retry, não há como separar). Para cancelamento/bounce/reclamação/
 *    ativação, repetir o mesmo fato em 30 min não acrescenta informação.
 *  - Eventos de tipo, URL ou assinante diferentes nunca são agrupados.
 *  - Evento de OUTRO tipo do mesmo assinante entre os dois desfaz o retry
 *    (#10747): `activate` → `unsubscribe` → `activate` dentro da janela são 3
 *    registros. Mesmo tipo com URL diferente no meio (clique em A, em B, em A)
 *    NÃO desfaz — segue o custo aceito acima para cliques.
 */
export const KIT_WEBHOOK_RETRY_DEDUPE_MS = 30 * 60 * 1000;

export interface KitWebhookIngestResult {
  newEvents: number;
  /** Mesma chave já no store (releitura da margem incremental). */
  alreadyKnown: number;
  /** Chave nova, mas é retry de um evento já ingerido (#10722). */
  retryDuplicates: number;
}

export function ingestKitWebhookEvents(
  db: DatabaseSync,
  events: readonly KitWebhookEventRecord[],
  now: string = new Date().toISOString(),
): KitWebhookIngestResult {
  let newEvents = 0;
  let alreadyKnown = 0;
  let retryDuplicates = 0;
  // Ordem cronológica: dentro de um lote, a 1ª tentativa é a que fica.
  const sorted = sortKitWebhookEvents([...events]);
  // Eventos do lote por assinante: um evento de outro tipo ainda não gravado
  // (vem depois na ordem) também desfaz o casamento de retry (#10747).
  const bySubscriber = new Map<string, KitWebhookEventRecord[]>();
  for (const ev of sorted) {
    const list = bySubscriber.get(ev.kit_subscriber_id);
    if (list) list.push(ev);
    else bySubscriber.set(ev.kit_subscriber_id, [ev]);
  }
  for (const ev of sorted) {
    if (hasKitWebhookEventKey(db, ev.key)) {
      alreadyKnown++;
      continue;
    }
    if (hasKitWebhookEventNear(db, ev, KIT_WEBHOOK_RETRY_DEDUPE_MS, bySubscriber.get(ev.kit_subscriber_id))) {
      retryDuplicates++;
      continue;
    }
    const { inserted } = recordKitWebhookEvent(db, ev, now);
    if (inserted) newEvents++;
    else alreadyKnown++;
  }
  return { newEvents, alreadyKnown, retryDuplicates };
}

/** Atalho: `since` incremental a partir do que o store já tem. */
export function incrementalSinceFromDb(db: DatabaseSync): string | null {
  return computeIncrementalSince(getLatestKitWebhookEventReceivedAt(db));
}
