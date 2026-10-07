/**
 * scripts/lib/metrics/channel-cohort-funnel-store.ts (#7918)
 *
 * Camada de TRADUÇÃO store (#6464, `diaria-subscribers.db`) → insumo puro de
 * `channel-cohort-funnel.ts` (`FunnelPersonInput[]` + `FunnelSources`). Mesmo
 * par "puro × I/O" de `acquisition-store-deps.ts`: toda a regra de negócio
 * fica no módulo puro; aqui só leitura e mapeamento.
 *
 * ## De onde sai cada campo (reuso da base do #7916)
 *
 * - Pessoa: 1 entrada por `subscriber_id` (identidade já resolvida e
 *   deduplicada entre plataformas pelo #6589/#8236) — nunca por
 *   `subscription`.
 * - Cadastro: `entered_at` MAIS ANTIGO entre as `subscription` da pessoa
 *   (troca de provedor não vira aquisição nova).
 * - Origem/campanha: `resolveSubscriberAttribution` (precedência fixa
 *   kit > beehiiv > brevo_diaria, bundle inteiro). Destino: `origem_cadastro`
 *   da mesma plataforma vencedora, senão o 1º não-nulo.
 * - Reativação: `subscription.reativado` (pegajoso, #8235).
 * - Confirmação: evento `confirm` (instante conhecido) ou estado NATIVO do
 *   Kit — `active` = confirmado, `inactive` = DOI pendente. Sem
 *   `subscription` Kit, ou com estado de saída (`cancelled`/`bounced`/
 *   `complained` — não diz se a pessoa chegou a confirmar), a confirmação é
 *   NÃO OBSERVÁVEL para ela, nunca `false` fabricado.
 * - Entrega e leitor: `computeStoreLeitorInputCanonicalDedupBatched` — a
 *   MESMA derivação que `leitor-v1` cross-plataforma usa (recebidas por
 *   edição canônica, `delivered` ou `sent − bounce`).
 * - 1º clique: `MIN(ts)` dos eventos `click`. Os broadcasts de onboarding do
 *   Kit já são excluídos na ingestão (#7916/#7922, PR #9747), então clique
 *   em onboarding não chega aqui como clique em edição.
 */

import type { DatabaseSync } from "node:sqlite";
import {
  PLATFORMS,
  getAllAliasesBySubscriber,
  getAllEventsBySubscriber,
  getAllSubscriberPlatforms,
  getAllSubscriptionsBySubscriber,
  getSubscriptionAsOf,
  resolveSubscriberAttribution,
  type SubscriptionRecord,
} from "../diaria-subscribers-db.ts";
import { buildCanonicalEdicaoMapFromEvents } from "../diaria-subscribers-edicao-canonica.ts";
import { computeStoreLeitorInputCanonicalDedupBatched, detectPlatformCapabilities } from "../leitor-store.ts";
import type { FunnelConfirmacaoInput, FunnelPersonInput, FunnelSources } from "./channel-cohort-funnel.ts";

export const STORE_FONTE = "data/diaria-subscribers/diaria-subscribers.db";

/** Confirmação a partir das `subscription` + instante do evento `confirm`
 *  (se houver). @pure */
export function resolveConfirmacaoFromStore(
  subs: readonly Pick<SubscriptionRecord, "platform" | "status">[],
  confirmTs: string | null,
): FunnelConfirmacaoInput {
  if (confirmTs) return { observavel: true, confirmado: true, confirmadoEm: confirmTs };
  const kit = subs.find((s) => s.platform === "kit");
  if (!kit) return { observavel: false, motivo: "sem subscription no Kit — DOI não observável" };
  if (kit.status === "active") return { observavel: true, confirmado: true, confirmadoEm: null };
  if (kit.status === "inactive") return { observavel: true, confirmado: false, confirmadoEm: null };
  return { observavel: false, motivo: `estado Kit "${kit.status ?? "null"}" não diz se a pessoa confirmou` };
}

function earliestIso(values: readonly (string | null)[]): string | null {
  let best: string | null = null;
  let bestMs = Infinity;
  for (const v of values) {
    if (!v) continue;
    const ms = Date.parse(v);
    if (Number.isFinite(ms) && ms < bestMs) {
      bestMs = ms;
      best = v;
    }
  }
  return best;
}

function firstTsByType(db: DatabaseSync, type: string): Map<number, string> {
  const rows = db
    .prepare(`SELECT subscriber_id, MIN(ts) AS ts FROM event WHERE subscriber_id IS NOT NULL AND type = ? GROUP BY subscriber_id`)
    .all(type) as unknown as Array<{ subscriber_id: number; ts: string }>;
  return new Map(rows.map((r) => [r.subscriber_id, r.ts]));
}

function maxEventTs(db: DatabaseSync, types: readonly string[]): string | null {
  const ph = types.map(() => "?").join(", ");
  const row = db.prepare(`SELECT MAX(ts) AS ts FROM event WHERE type IN (${ph})`).get(...types) as { ts: string | null };
  return row.ts ?? null;
}

export interface FunnelStoreInput {
  people: FunnelPersonInput[];
  fontes: FunnelSources;
}

/** Lê o store inteiro (1 scan por tabela) e devolve o insumo do relatório. */
export function loadFunnelInputFromStore(db: DatabaseSync): FunnelStoreInput {
  const caps = detectPlatformCapabilities(db, PLATFORMS);
  const canonicalMap = buildCanonicalEdicaoMapFromEvents(db);
  const platformsBySub = getAllSubscriberPlatforms(db);
  const subsBySub = getAllSubscriptionsBySubscriber(db);
  const aliasesBySub = getAllAliasesBySubscriber(db);
  const eventsBySub = getAllEventsBySubscriber(db);
  const firstClick = firstTsByType(db, "click");
  const firstConfirm = firstTsByType(db, "confirm");

  const people: FunnelPersonInput[] = [];
  for (const subscriberId of platformsBySub.keys()) {
    const aliases = aliasesBySub.get(subscriberId) ?? [];
    const subs = subsBySub.get(subscriberId) ?? [];
    const attribution = resolveSubscriberAttribution(subs);
    const winner = attribution.platform ? subs.find((s) => s.platform === attribution.platform) : undefined;
    const destino = winner?.origem_cadastro ?? subs.find((s) => s.origem_cadastro)?.origem_cadastro ?? null;
    const leitor = computeStoreLeitorInputCanonicalDedupBatched(
      eventsBySub.get(subscriberId) ?? [],
      aliases,
      subs,
      caps,
      canonicalMap,
      PLATFORMS,
    );
    people.push({
      personKey: String(subscriberId),
      email: aliases.find((a) => a.email)?.email ?? "",
      enteredAt: earliestIso(subs.map((s) => s.entered_at)),
      utmSource: attribution.utmSource,
      utmMedium: attribution.utmMedium,
      utmCampaign: attribution.utmCampaign,
      utmChannel: attribution.utmChannel,
      referringSite: attribution.referringSite,
      destino,
      reativado: subs.some((s) => s.reativado === 1),
      confirmacao: resolveConfirmacaoFromStore(subs, firstConfirm.get(subscriberId) ?? null),
      entrega: { observavel: true, edicoesRecebidas: leitor.totalReceived },
      engajamento: { observavel: true, primeiroCliqueEm: firstClick.get(subscriberId) ?? null, leitor },
    });
  }

  const subsAsOf = getSubscriptionAsOf(db, PLATFORMS);
  const deliveryAsOf = maxEventTs(db, ["delivered", "sent"]);
  const engagementAsOf = maxEventTs(db, ["click", "open"]);
  const hasSubs = subsAsOf != null;
  const fontes: FunnelSources = {
    cadastro: {
      fonte: `${STORE_FONTE} (subscription)`,
      frescor: subsAsOf,
      disponivel: hasSubs,
      ...(hasSubs ? {} : { motivo: "store sem nenhuma subscription — ingestão não rodou" }),
    },
    confirmacao: {
      fonte: `${STORE_FONTE} (subscription.status Kit + event confirm)`,
      frescor: subsAsOf,
      disponivel: hasSubs,
      ...(hasSubs ? {} : { motivo: "store sem nenhuma subscription — estado DOI não coletado" }),
    },
    entrega: {
      fonte: `${STORE_FONTE} (event delivered/sent, edição canônica)`,
      frescor: deliveryAsOf,
      disponivel: deliveryAsOf != null,
      ...(deliveryAsOf != null ? {} : { motivo: "store sem eventos delivered/sent — entrega não coletada" }),
    },
    engajamento: {
      fonte: `${STORE_FONTE} (event click, leitor-store.ts)`,
      frescor: engagementAsOf ?? deliveryAsOf,
      disponivel: deliveryAsOf != null,
      ...(deliveryAsOf != null ? {} : { motivo: "store sem eventos de envio — engajamento não tem denominador coletado" }),
    },
  };
  return { people, fontes };
}
