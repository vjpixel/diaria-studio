export interface Env {
  BREVO_API_KEY: string;
  /** KV namespace para cache de stats imutáveis (#2144) */
  STATS_CACHE: KVNamespace;
  /** Chave Stripe restrita (read-only). Secret via `wrangler secret put STRIPE_API_KEY`. */
  STRIPE_API_KEY?: string;
  /** Tab de cupons habilitada? Deve ser "true" explicitamente. Default OFF. (#2718) */
  COUPONS_TAB_ENABLED?: string;
  /** Shared-token for cookie auth. Wrangler secret — if unset, auth is bypassed (dev mode). */
  AUTH_TOKEN?: string;
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
 * Mantido em sincronia com a interface homônima em
 * scripts/clarice-engagement-cohorts.ts (bundles separados não compartilham tipos).
 */
export interface EngagementCohorts {
  generatedAt: string;
  universe: number;
  opened2plus: number;
  opened1: number;
  received1_opened0: number;
  received2_opened0: number;
  exits: number;
  exitsBreakdown: { bounced: number; optedOut: number };
  maxReceived: number;
}


// #2609: status MillionVerifier por grupo de contatos.
export interface MvGroupStatus {
  /** Identificador do grupo (ex: "t01-assinantes-ativos", "t02-ex-assinantes"). */
  group: string;
  /** Ciclo em que a verificação foi feita (ex: "2605-06"). */
  cycle: string;
  /** "verified" = tem mv-export-*-verified.csv; "t01" = N/A por pagamento Stripe; "pending" = sem arquivo. */
  status: "verified" | "t01" | "pending";
  /** ISO date do mtime do arquivo verified.csv (ou null). */
  verifiedAt: string | null;
  verified: number;
  rejected: number;
  unknown: number;
}

export interface MvStatus {
  generatedAt: string;
  groups: MvGroupStatus[];
}

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
// scripts/clarice-db-summary.ts. Tipo DUPLICADO do script (mesmo padrão de
// MvStatus): não importado porque o script puxa node:sqlite, indisponível no
// runtime do Worker. MANTER EM SINCRONIA com StoreSummary do script (este = o
// payload do KV = StoreSummary + generated_at).
export const CONTACTS_SUMMARY_KV_KEY = "contacts:summary";

export interface ContactsSummary {
  generated_at: string;
  total: number;
  brevo: { synced_rows: number; has_signal: boolean };
  // #2857 fase B: `by_tier`/`by_tier_verified` NÃO são mais emitidos por
  // clarice-db-summary.ts (sucessor: `by_cohort_first_send`/
  // `by_cohort_first_send_verified`, abaixo) — mantidos aqui só OPCIONAIS pra
  // o render continuar lendo um KV cacheado gravado ANTES desta migração
  // (mesmo padrão de opcionalidade de `by_cohort`/#2817 logo abaixo).
  by_tier?: Record<string, number>;
  by_tier_verified?: Record<string, number>;
  // #2857 fase B: sucessor de by_tier/by_tier_verified (universo firstSend,
  // agrupado por cohort em vez de tier). Opcionais — KV pré-fase-B não tem;
  // o render degrada pro by_tier legado (ver sections-kv.ts).
  by_cohort_first_send?: Record<string, number>;
  by_cohort_first_send_verified?: Record<string, number>;
  eligibility: {
    eligible: number;
    ineligible: number;
    by_reason: Record<string, number>;
  };
  priority_points: {
    lt0: number;
    eq0: number;
    p1_40: number;
    p41_80: number;
    gt80: number;
    optin: number;
  };
  // #2731: distribuição por valor exato (opcional — KV pré-#2731 não tem).
  priority_points_histogram?: Record<string, number>;
  // 260702: coluna "verified" (mv_bucket='verified') por valor exato e por
  // tier firstSend (opcionais — KV antigo não tem; render degrada sem coluna).
  priority_points_histogram_verified?: Record<string, number>;
  // #2817: agregado por safra mensal (opcionais — KV antigo não tem os campos;
  // render degrada omitindo a tabela "Por safra (cohort)" inteira).
  by_cohort?: Record<string, number>;
  by_cohort_verified?: Record<string, number>;
  mv: Record<string, number>;
  engagement: { with_opens: number; with_clicks: number };
}

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
  /** Contagem bruta de acertos — permite agregação mensal exata (#2773) via
   *  Σ correct_count / Σ total_votes, em vez de aproximar por pct_correct
   *  (já arredondado na origem). Opcional (mesmo padrão de
   *  priority_points_histogram, #2731): KV escrito antes deste campo existir
   *  não o tem — aggregateEiaEngagementByMonth trata ausência como "sem
   *  gabarito confiável" (exclui do numerador/denominador), nunca NaN. */
  correct_count?: number;
}

export interface EiaEngagementSummary {
  editions: EiaEngagementEdition[];
  updated_at: string | null;
}

// #2733: TTL do cache de campanhas cruas (LASTGOOD_CAMPAIGNS_KEY). 1h — a janela
// de rate-limit da Brevo cabe folgada.
export const LASTGOOD_TTL = 3600;
