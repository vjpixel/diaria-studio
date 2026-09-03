/**
 * scripts/lib/metrics/acquisition-store-deps.ts (#7295)
 *
 * A ligação que a #7295 encontrou ausente: `getStoreCounts()`
 * (`scripts/lib/diaria-subscribers-db.ts`) roda em produção e já calcula
 * `subscriptions_coverage_low`, mas nada alimentava
 * `AcquisitionMetricDeps.subscriptionCoverageLow` com esse sinal — o único
 * destino dele era um `console.warn` inline, que não vira `indeterminado` em
 * `aggregateAcquisition()` (`registry.ts`) nem chega a nenhum humano fora de
 * quem está lendo stdout na hora.
 *
 * Este módulo é a camada de TRADUÇÃO entre o store (I/O real, schema do
 * #6464) e o contrato puro do registry (`AcquisitionMetricDeps`) — mesmo par
 * "puro × I/O" documentado no topo de `registry.ts` (`buildCacReport` ×
 * `cac-report.ts`), só que para este domínio específico. `registry.ts`
 * continua SEM I/O; quem lê o SQLite é este arquivo, consumido por
 * `scripts/metrics-cli.ts` (o 1º script de PRODUÇÃO a importar
 * `lib/metrics/registry`, fechando o gap descrito na #7295).
 */

import type { DatabaseSync } from "node:sqlite";
import { getStoreCounts } from "../diaria-subscribers-db.ts";
import type { AcquisitionMetricDeps, AcquisitionRecordInput, Janela } from "./registry.ts";

/**
 * Mesma fórmula de `brtDayKey` (`scripts/lib/clarice-envio-policy.ts`) —
 * reimplementada aqui, não importada, pelo mesmo motivo documentado lá:
 * evitar acoplar o domínio `metrics/` a um módulo de outro domínio só para
 * reusar uma conversão de fuso de 3 linhas. `test/acquisition-store-deps.test.ts`
 * cobre casos de fronteira de dia BRT diretamente, sem depender de paridade
 * com a outra implementação.
 */
export function brtDayKey(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
}

/**
 * Deriva `subscriptionCoverageLow`/`subscriptionCoverageMotivo` diretamente
 * de `getStoreCounts(db)` — a ponta que faltava. Quando a cobertura está
 * baixa, `aggregateAcquisition()` devolve `indeterminado` para as 4 métricas
 * de aquisição ANTES de chamar `registros()` (`registry.ts`), então o motivo
 * aqui é o que efetivamente chega ao consumidor final. @pure em relação ao
 * `db` que recebe pronto (I/O já aconteceu na leitura de `getStoreCounts`).
 */
export function resolveSubscriptionCoverage(
  db: DatabaseSync,
): Pick<AcquisitionMetricDeps, "subscriptionCoverageLow" | "subscriptionCoverageMotivo"> {
  const counts = getStoreCounts(db);
  if (!counts.subscriptions_coverage_low) {
    return { subscriptionCoverageLow: false };
  }
  return {
    subscriptionCoverageLow: true,
    subscriptionCoverageMotivo:
      `dimensão subscription do store pouco populada (${counts.subscriptions} linha(s) de subscription ` +
      `para ${counts.subscribers} subscriber(s), abaixo do piso de confiança) — cadastros não confiáveis ` +
      "(subscriptions_coverage_low, #7229/#7295).",
  };
}

interface SubscriptionAttributionRow {
  email: string | null;
  entered_at: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_channel: string | null;
  referring_site: string | null;
}

/**
 * Implementação real de `AcquisitionMetricDeps.registros` a partir do store
 * — join `subscription` (fato de cadastro, `entered_at`/atribuição) com
 * `identity_alias` (e-mail, exigido por `filterInternalAndTestSubscribers`
 * dentro de `aggregateAcquisition`). `s.source` é o `utm_source` — é assim
 * que `upsertSubscription` grava (`fields.source`, ver docstring dela).
 *
 * Nunca chamada quando `subscriptionCoverageLow` é `true` — `aggregateAcquisition`
 * curto-circuita antes (ver docstring de `AcquisitionMetricDeps` em
 * `registry.ts`) — mas precisa estar CORRETA mesmo assim: no dia em que a
 * cobertura subir (reingestão real do #7229), é esta função que passa a
 * alimentar o placar de verdade, sem trabalho adicional.
 */
export function registrosFromStore(db: DatabaseSync, janela: Janela): AcquisitionRecordInput[] {
  const rows = db
    .prepare(
      `SELECT ia.email AS email, s.entered_at AS entered_at, s.source AS utm_source,
              s.utm_medium AS utm_medium, s.utm_channel AS utm_channel, s.referring_site AS referring_site
       FROM subscription s
       LEFT JOIN identity_alias ia
         ON ia.subscriber_id = s.subscriber_id AND ia.email IS NOT NULL
       WHERE s.entered_at IS NOT NULL`,
    )
    .all() as unknown as SubscriptionAttributionRow[];

  const out: AcquisitionRecordInput[] = [];
  for (const row of rows) {
    // Sem e-mail não há como `filterInternalAndTestSubscribers` decidir —
    // registro fica de fora em vez de entrar sem filtro de exclusão.
    if (!row.email || !row.entered_at) continue;
    const dia = brtDayKey(row.entered_at);
    if (!dia || dia < janela.de || dia > janela.ate) continue;
    const created = Math.floor(new Date(row.entered_at).getTime() / 1000);
    if (Number.isNaN(created)) continue;
    out.push({
      email: row.email,
      dia,
      utm_source: row.utm_source,
      utm_medium: row.utm_medium,
      utm_channel: row.utm_channel,
      referring_site: row.referring_site,
      created,
    });
  }
  return out;
}

/**
 * Monta `AcquisitionMetricDeps` completo a partir do store real — o par
 * `resolveSubscriptionCoverage` + `registrosFromStore` prontos para injetar
 * em `MetricDef.computar`. `capturaLog` continua responsabilidade do
 * chamador (lido de `data/metrics/captura-log.jsonl`, fora deste módulo —
 * mesma fronteira que `captura-log.ts` já declara: leitor de disco fica no
 * CLI, não na camada de glue).
 */
export function buildAcquisitionDepsFromStore(
  db: DatabaseSync,
  capturaLog: AcquisitionMetricDeps["capturaLog"],
): AcquisitionMetricDeps {
  return {
    registros: (janela) => registrosFromStore(db, janela),
    capturaLog,
    ...resolveSubscriptionCoverage(db),
  };
}
