export interface Env {
  BREVO_API_KEY: string;
  /** KV namespace para cache de stats imutáveis (#2144) */
  STATS_CACHE: KVNamespace;
  /** Chave Stripe restrita (read-only). Secret via `wrangler secret put STRIPE_API_KEY`. */
  STRIPE_API_KEY?: string;
  /** Tab de cupons habilitada? Deve ser "true" explicitamente. Default OFF. (#2718) */
  COUPONS_TAB_ENABLED?: string;
  /** Shared-token for cookie auth. Wrangler secret — if unset, fail-CLOSED: access is denied (#2748; never bypassed). */
  AUTH_TOKEN?: string;
  /**
   * Service binding pro worker `poll` (#3676). Chamadas worker-to-worker via
   * fetch() público a *.workers.dev do MESMO account não são confiáveis —
   * reproduzido em produção como 404 (GET /editions?brand=clarice), enquanto
   * a mesma URL respondia 200 normalmente de fora da rede da Cloudflare
   * (curl direto). Service binding evita esse round-trip via workers.dev
   * inteiramente. Opcional (`?`) pra não quebrar testes/dev local sem o
   * binding configurado — eia-refresh.ts cai em fetch() público nesse caso.
   */
  POLL_WORKER?: Fetcher;
}

export interface BrevoCampaignStats {
  listId: number;
  sent: number;
  delivered: number;
  hardBounces: number;
  softBounces: number;
  deferred: number;
  uniqueViews: number;
  viewed: number;
  trackableViews: number;
  uniqueClicks: number;
  clickers: number;
  unsubscriptions: number;
  complaints: number;
}

export interface BrevoGlobalStats {
  sent: number;
  delivered: number;
  hardBounces: number;
  softBounces: number;
  uniqueViews: number;
  viewed: number;
  trackableViews: number;
  uniqueClicks: number;
  clickers: number;
  unsubscriptions: number;
  complaints: number;
  appleMppOpens: number;
  opensRate?: number;
  estimatedViews?: number;
}

/**
 * Shape do `statistics.linksStats` da Brevo API.
 * Retornado via `GET /v3/emailCampaigns/{id}?statistics=linksStats`.
 * O endpoint expõe apenas clicks totais por URL — unique-clicks por link
 * não está disponível neste endpoint da API Brevo v3 (unique clicks só
 * existem no nível da campanha, em `globalStats.uniqueClicks`).
 * Referência: https://developers.brevo.com/reference/getemailcampaigns-1
 */
export type BrevoLinksStats = Record<string, number>; // url → clicks

export interface BrevoCampaign {
  id: number;
  name: string;
  subject: string;
  status: string;
  sentDate: string | null;
  scheduledAt: string | null;
  createdAt: string;
  recipients: { lists: number[] };
  statistics?: {
    campaignStats?: BrevoCampaignStats[];
    globalStats?: BrevoGlobalStats;
    linksStats?: BrevoLinksStats;
  };
}

export interface BrevoList {
  id: number;
  name: string;
  totalSubscribers: number;
}

/**
 * #2426: coortes de engajamento por contato. Pré-computadas pelo script
 * `scripts/clarice-engagement-cohorts.ts` (que faz os ~40k GETs per-contato
 * fora do Worker) e gravadas no KV sob `cohorts:engagement`. O Worker só lê e
 * renderiza — nunca recomputa no render. As 5 coortes são mutuamente exclusivas
 * (cada contato em exatamente uma); "saídas" (bounce/unsub) têm precedência.
 *
 * #3081: fonte única em `scripts/lib/dashboard-kv-types.ts` (dependency-free,
 * mesmo padrão de `CouponUsageReport` acima) — antes era uma cópia manualmente
 * sincronizada com a interface homônima em scripts/clarice-engagement-cohorts.ts.
 */
export type {
  EngagementCohorts,
  MvGroupStatus,
  MvStatus,
  ContactsSummary,
  CohortStatsRow,
} from "../../../scripts/lib/dashboard-kv-types.ts";
// #2609: status MillionVerifier por grupo de contatos (tipo em dashboard-kv-types.ts).

// ─── #2144: helpers de controle de concorrência e cache ──────────────────────

/**
 * mapLimit: executa `fn` sobre cada item de `arr` com no máximo `n`
 * chamadas simultâneas. Preserva a ordem do input no output.
 * Implementação local — sem dependência nova, ~15 linhas.
 */

export const RECENT_STATS_TTL = 1800; // segundos (30min) — #2282

// #2426: chave KV das coortes de engajamento, gravada por
// scripts/clarice-engagement-cohorts.ts. Mantida em sincronia com COHORTS_KV_KEY
// daquele script (bundles separados não compartilham constantes).
export const COHORTS_KV_KEY = "cohorts:engagement";
// #2609: chave KV do status MillionVerifier por grupo, gravada por scripts/clarice-mv-status.ts.
export const MV_STATUS_KV_KEY = "mv:status";

// #2653: sumário do store único de contatos (#2647), gravado por
// scripts/clarice-db-summary.ts. #3081: `ContactsSummary`/`CohortStatsRow`
// (tipos do payload) vêm de scripts/lib/dashboard-kv-types.ts (fonte única,
// ver re-export acima) — antes eram cópias manualmente sincronizadas com
// `StoreSummary` do script.
export const CONTACTS_SUMMARY_KV_KEY = "contacts:summary";

// #2738: engajamento do poll "É IA?" por edição, gravado por
// scripts/build-poll-eia-data.ts --push (reusa buildPollEiaSummaryFromApi,
// que já busca os endpoints públicos de poll.diaria.workers.dev pro OUTRO
// dashboard — workers/diaria-dashboard). Payload SLIM (só o necessário pra
// esta tabela) — sem PII (nicknames/leaderboard ficam só no diaria-dashboard).
export const EIA_ENGAGEMENT_KV_KEY = "eia:engagement";

export interface EiaEngagementEdition {
  /** AAMMDD */
  edition: string;
  total_votes: number;
  voted_a: number;
  voted_b: number;
  pct_correct: number | null;
  correct_choice: string | null;
  /** Contagem bruta de acertos (#2773) — Σ correct_count / Σ total_votes seria
   *  exato para agregação mensal, vs. aproximar por pct_correct (já arredondado
   *  na origem). Opcional (mesmo padrão de priority_points_histogram, #2731):
   *  KV escrito antes deste campo existir não o tem. (A agregação mensal que
   *  consumia este campo, aggregateEiaEngagementByMonth, foi revertida em favor
   *  de 1 linha por edição no #2860 e removida como dead code no #2875 — campo
   *  mantido no payload, sem consumidor atual.) */
  correct_count?: number;
}

export interface EiaEngagementSummary {
  editions: EiaEngagementEdition[];
  updated_at: string | null;
}

// #3553 (parte B): TTL do cache de campanhas cruas (LASTGOOD_CAMPAIGNS_KEY).
// Pré-#3553 este valor era derivado de CRON_INTERVAL_HOURS (cadência do Cron
// Trigger que pré-computava o KV — #3079/#3256, removido). Sem cron, o KV é
// write-through: gravado a cada fetch ao vivo bem-sucedido na rota `/` e lido
// só como FALLBACK em rate-limit (buildRateLimitFallback, brevo-api.ts) —
// nunca mais como fonte primária. 24h é uma folga generosa para o fallback
// continuar servível mesmo numa janela sem nenhum visitante (o write-through
// só acontece quando alguém carrega a página).
export const LASTGOOD_TTL = 24 * 3600;
