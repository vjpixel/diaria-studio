export interface Env {
  BREVO_API_KEY: string;
  /**
   * #4515: API key da conta Brevo PRÓPRIA do editor (canal `brevo_diaria` —
   * `platform.config.json > brevo_diaria.api_key_env`), conta SEPARADA da
   * Clarice (`BREVO_API_KEY` acima) — IP/domínio isolados, ver #4266/#4476.
   * Secret opcional: ausente → a aba "brevo_diaria" fica oculta (mesmo padrão
   * de STRIPE_API_KEY/COUPONS_TAB_ENABLED — nunca lança, nunca derruba o
   * resto do dashboard). Setup: `wrangler secret put BREVO_DIARIA_API_KEY`.
   */
  BREVO_DIARIA_API_KEY?: string;
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
   * Tipo estrutural (não o `Fetcher` ambiente do @cloudflare/workers-types)
   * porque este arquivo é importado por scripts/ (tsconfig raiz, sem esse
   * global) além do próprio Worker.
   */
  POLL_WORKER?: { fetch: typeof fetch };
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
  PostmasterSpamEntry,
  PostmasterProducer,
  PostmasterCampaignSpamRecord, // #4970
  LinkSectionName, // #4184
  LinkSectionMap, // #4184
  ClariceHourTestKvState, // #5189
} from "../../../scripts/lib/dashboard-kv-types.ts";
// #2609: status MillionVerifier por grupo de contatos (tipo em dashboard-kv-types.ts).

// ─── #2144: helpers de controle de concorrência e cache ──────────────────────

/**
 * mapLimit: executa `fn` sobre cada item de `arr` com no máximo `n`
 * chamadas simultâneas. Preserva a ordem do input no output.
 * Implementação local — sem dependência nova, ~15 linhas.
 */

export const RECENT_STATS_TTL = 1800; // segundos (30min) — #2282

/**
 * #6720 Fatia C: TTL da faixa INTERMEDIÁRIA (48h–7d) do cache `stats:{id}`.
 * Antes desta unidade, `isImmutableCampaign` (7d) era o único corte —
 * qualquer campanha <7d caía sempre em `RECENT_STATS_TTL` (30min), e como o
 * `Diaria-Clarice-Dashboard-Precompute` roda `interval 1h`, o TTL de 30min
 * expira sempre ANTES do próximo render — na prática "sempre ao vivo" pra
 * toda a janela de 7 dias inteira (medido em 01/09/2026: ~28 campanhas
 * nessa janela × 2 GETs/campanha = 57% do orçamento horário da Brevo NUM
 * ÚNICO render — ver #6720/#7007).
 *
 * Campanha de 2-7 dias já quase não muda mais (opens/clicks praticamente
 * pararam de acumular) — não precisa do mesmo frescor de <48h, que segue em
 * `RECENT_STATS_TTL`. 4h sobrevive a 3-4 execuções horárias do precompute
 * antes de re-buscar, cortando a maior parte do custo dessa faixa sem virar
 * imutável de fato (ainda refresca 6×/dia — decisão do editor foi NÃO tocar
 * no corte de 7 dias do `isImmutableCampaign`, só adicionar uma faixa nova).
 *
 * NÃO se aplica a entradas poison/ls-fetch-falho (essas continuam com
 * `RECENT_STATS_TTL` para auto-cura rápida — ver `resolveRecentStatsTtl` e o
 * call site em `fetchRecentCampaigns`, brevo-api.ts).
 */
export const MID_RANGE_STATS_TTL = 4 * 3600; // segundos (4h) — #6720 Fatia C

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
// que já busca os endpoints públicos de eia.diar.ia.br — domínio de marca,
// #3904 — pro OUTRO dashboard — workers/diaria-dashboard). Payload SLIM (só o
// necessário pra esta tabela) — sem PII (nicknames/leaderboard ficam só no
// diaria-dashboard).
export const EIA_ENGAGEMENT_KV_KEY = "eia:engagement";

// #4063/#4154: spamRate diário do Postmaster Tools (clarice.ai), gravado
// automaticamente via API por scripts/postmaster-spam-sync.ts (a cada 12h) ou
// manualmente por scripts/postmaster-spam-entry.ts (fallback). Ver
// PostmasterSpamEntry acima (re-exportada de scripts/lib/dashboard-kv-types.ts)
// e resolveSpamSignal em thresholds.ts (precedência sobre complaints da Brevo).
export const POSTMASTER_SPAM_KV_KEY = "postmaster:spam";

// #4184: mapa de seção editorial (Destaques/Use Melhor/Radar) por ciclo
// mensal, gravado por scripts/push-link-sections-kv.ts. Diferente das
// constantes acima, não é uma chave singleton — 1 chave POR ciclo — então o
// helper formata a partir do ciclo em vez de exportar uma string fixa. Ver
// LinkSectionMap (re-exportada acima) e resolveLinkSection (link-section.ts).
export function linkSectionsKvKey(cycle: string): string {
  return `secao:${cycle}`;
}

// #4198: mapa CONTEÚDO→TÍTULO editorial por ciclo mensal, gravado por
// scripts/push-link-titles-kv.ts — sibling de linkSectionsKvKey acima (mesmo
// racional: 1 chave POR ciclo, não singleton). Ver Record<string,string>
// (título) em vez de LinkSectionMap (array de seção), e normalizeLinkTitleMap
// (link-section.ts).
export function linkTitlesKvKey(cycle: string): string {
  return `titulo:${cycle}`;
}

// #5189: chave KV do estado (janela ativa) do teste de HORÁRIO da onda
// ramp-warm, gravada por scripts/push-clarice-hour-test-kv.ts. Singleton
// (não por ciclo, ao contrário de linkSectionsKvKey/linkTitlesKvKey acima) —
// só existe UM teste de horário ativo/mais recente por vez (mesmo desenho de
// MV_STATUS_KV_KEY/POSTMASTER_SPAM_KV_KEY acima).
export const HOUR_TEST_KV_KEY = "clarice:hourtest:state";

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
