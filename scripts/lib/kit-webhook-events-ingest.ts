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
  type KitWebhookEventRecord,
} from "./kit-webhook-events-contract.ts";
import { getLatestKitWebhookEventReceivedAt, recordKitWebhookEvent } from "./diaria-subscribers-db.ts";

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
  const list = (body as { events?: unknown })?.events;
  if (!Array.isArray(list)) return { ok: false, error: "resposta sem lista `events`" };
  const events = list.filter(isKitWebhookEventRecord);
  return { ok: true, events, malformed: list.length - events.length };
}

export interface KitWebhookIngestResult {
  newEvents: number;
  alreadyKnown: number;
}

export function ingestKitWebhookEvents(
  db: DatabaseSync,
  events: readonly KitWebhookEventRecord[],
  now: string = new Date().toISOString(),
): KitWebhookIngestResult {
  let newEvents = 0;
  let alreadyKnown = 0;
  for (const ev of events) {
    const { inserted } = recordKitWebhookEvent(db, ev, now);
    if (inserted) newEvents++;
    else alreadyKnown++;
  }
  return { newEvents, alreadyKnown };
}

/** Atalho: `since` incremental a partir do que o store já tem. */
export function incrementalSinceFromDb(db: DatabaseSync): string | null {
  return computeIncrementalSince(getLatestKitWebhookEventReceivedAt(db));
}
