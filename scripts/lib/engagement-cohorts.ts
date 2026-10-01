/**
 * Núcleo compartilhado das coortes de engajamento Clarice (#2426, #9330).
 *
 * Extraído do antigo crawl per-contato v1 (`clarice-engagement-cohorts.ts`,
 * removido no #9330 — decisão do editor de 01/10/2026: só o v2). Consumido por
 * `scripts/clarice-engagement-cohorts-v2.ts` (export por campanha) e testes.
 */
import { resolve } from "node:path";
import { CLARICE_BASE } from "./clarice-paths.ts";
import { DASHBOARD_KV_NAMESPACE_ID } from "./dashboard-kv.ts";
import type { EngagementCohorts } from "./dashboard-kv-types.ts";
export type { EngagementCohorts };
export { DASHBOARD_KV_NAMESPACE_ID };

/** Diretório de estado das coortes (cache do v2). data/ é gitignored. */
export const COHORTS_STATE_DIR = resolve(CLARICE_BASE, "cohorts");
/** Chave KV lida pelo worker no render (`env.STATS_CACHE.get(COHORTS_KV_KEY, "json")`). */
export const COHORTS_KV_KEY = "cohorts:engagement";

/**
 * Sinal de engajamento normalizado de um contato — entrada pura de computeCohorts.
 * Desacoplado do shape da Brevo p/ ser trivialmente testável.
 */
export interface ContactEngagement {
  /** nº de campanhas entregues ao contato (statistics.messagesSent.length) */
  received: number;
  /**
   * nº de campanhas abertas pelo contato — aberturas reais (trackable) per-contato.
   * Corresponde a `statistics.opened` da Brevo, que ≈ `trackableViews` da campanha
   * (aproximado, não idêntico): EXCLUI MPP/machine (Apple Mail Privacy Protection).
   *
   * A Brevo não atribui MPP a contatos individuais — `appleMppOpens` existe só
   * como agregado de campanha, sem atribuição per-contato. `statistics.machineOpened`
   * não existe na API Brevo. Portanto este campo representa o sinal humano mais limpo
   * disponível por contato.
   */
  opened: number;
  /** teve hard ou soft bounce em alguma campanha */
  bounced: boolean;
  /** descadastrou / está suprimido (blacklist), excluindo suppressão por bounce */
  optedOut: boolean;
}

/**
 * Classifica contatos em 5 coortes mutuamente exclusivas. Pura (testável).
 *
 * Precedência: saída (bounce/unsub) > abriu 2+ > abriu 1 > (não abriu: recebeu 1
 * | recebeu 2+). Contatos fora do universo (received=0 e sem saída) são ignorados.
 */
export function computeCohorts(
  contacts: ContactEngagement[],
  generatedAt: string,
): EngagementCohorts {
  const r: EngagementCohorts = {
    generatedAt,
    universe: 0,
    opened2plus: 0,
    opened1: 0,
    received1_opened0: 0,
    received2_opened0: 0,
    exits: 0,
    exitsBreakdown: { bounced: 0, optedOut: 0 },
    maxReceived: 0,
  };

  for (const c of contacts) {
    const isExit = c.bounced || c.optedOut;
    // Fora do universo: nunca recebeu, nunca abriu e não teve saída → não conta.
    // (opened>0 com received=0 é anomalia rara da Brevo — open de e-mail
    // encaminhado / campanha deletada do histórico. Contamos o engajamento em
    // vez de descartar silenciosamente.)
    if (c.received <= 0 && c.opened <= 0 && !isExit) continue;
    r.universe++;
    if (c.received > r.maxReceived) r.maxReceived = c.received;

    // Precedência absoluta da saída (regra do editor 2026-06-19).
    if (isExit) {
      r.exits++;
      // Breakdown disjunto: bounce tem prioridade sobre optedOut p/ somar exato.
      if (c.bounced) r.exitsBreakdown.bounced++;
      else r.exitsBreakdown.optedOut++;
      continue;
    }

    if (c.opened >= 2) r.opened2plus++;
    else if (c.opened === 1) r.opened1++;
    else if (c.received === 1) r.received1_opened0++;
    else r.received2_opened0++; // received >= 2, opened 0
  }

  return r;
}
