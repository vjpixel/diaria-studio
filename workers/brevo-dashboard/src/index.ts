/**
 * diaria-brevo-dashboard (#1141 follow-up — request 2026-05-12)
 *
 * Worker que serve dashboard HTML pra acompanhar campaigns Brevo (Clarice
 * monthly digest). Live fetch contra Brevo API com cache de 5min via
 * Cache API.
 *
 * **Página pública** — sem auth (preferência do editor 2026-05-12). Brevo
 * API key fica server-side como secret; stats per-campaign expostas pra
 * qualquer visitante. Pode rotacionar pra Basic Auth no futuro sem
 * mudança breaking — endpoint mantém shape.
 *
 * Endpoints:
 *   GET  /                 → HTML dashboard (pública)
 *   GET  /api/campaigns    → JSON com campaigns + stats (pública)
 *   GET  /healthz          → liveness probe
 *
 * Secrets:
 *   BREVO_API_KEY          → xkeysib-... da conta Clarice
 *
 * KV bindings:
 *   STATS_CACHE            → cache de stats imutáveis (campanhas > 7d)
 *
 * Cache de borda 5min via Cache API (#2144): rotas / e /api/campaigns
 * são cacheadas por 5min. Bypass: ?fresh=1. Isso reduz drasticamente
 * o número de chamadas à Brevo (de ~27/load para ~3-5 com KV quente,
 * e 0 chamadas adicionais nos 4min seguintes ao primeiro load).
 *
 * #2086 Fase 2 mínima:
 *   - Resumo A/B/C da S1 (checkpoint 17/jun)
 *   - trackableViewsRate por campanha (coluna na tabela)
 *   - Volume cumulativo vs plano 40k
 *   - Tabela de totais por mês (#2369)
 */

/**
 * Design System tokens (#2107) — importados de `ds-tokens.generated.ts`,
 * gerado automaticamente por `scripts/generate-worker-tokens.ts` a partir
 * da fonte canônica `scripts/lib/design-tokens.ts`.
 *
 * O Worker tem bundle Cloudflare separado e não pode importar de
 * `scripts/lib/` em runtime. O arquivo gerado resolve isso: é produzido
 * antes do deploy (via `[build]` no wrangler.toml) e antes dos testes
 * (via `pretest` no package.json raiz).
 *
 * Para atualizar tokens: editar `scripts/lib/design-tokens.ts` e rodar
 * `npx tsx scripts/generate-worker-tokens.ts` (ou qualquer path que
 * acione o build step).
 *
 * `DS.alert` permanece local — é uma cor semântica de ferramenta interna
 * (circuit breaker threshold), sem token canônico no DS de marca.
 */
import { DS_COLORS, DS_FONTS as DSF } from "./ds-tokens.generated.ts";
import {
  fetchCouponUsage,
  commissionCents,
  type CouponUsageReport,
  type CouponCodeReport,
} from "../../../scripts/lib/stripe-coupons.ts";

const DS = {
  ...DS_COLORS,
  // Alerta de circuit breaker: sem cor canônica no DS — red semântico de
  // ferramenta interna. Não é uma cor de marca, portanto não entra no DS.
  // Valor mantido como constante local explícita para evitar magic string.
  alert:    "#C00000",  // vermelho de alerta (circuit breaker threshold)
} as const;


/** Exportado para o teste de drift (test/brevo-dashboard-ds-drift.test.ts). */
export const DS_TOKENS = DS_COLORS;
export const DS_FONTS = DSF;

const AUTH_COOKIE = 'cf-dash-auth'

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

interface BrevoCampaignStats {
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

interface BrevoGlobalStats {
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

interface BrevoCampaign {
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

interface BrevoList {
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
export async function mapLimit<T, R>(
  arr: T[],
  n: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(arr.length);
  let idx = 0;
  let aborted = false;

  async function worker(): Promise<void> {
    while (idx < arr.length && !aborted) {
      const i = idx++;
      try {
        results[i] = await fn(arr[i]);
      } catch (err) {
        aborted = true; // Para todos os workers ao primeiro erro fatal
        throw err;
      }
    }
  }

  const workers = Array.from({ length: Math.min(n, arr.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

/**
 * #2273: detecta se um `linksStats` cacheado é "envenenado" — todos os clicks
 * são 0 enquanto `globalStats.clickers > 0`. Isso indica que o cache foi
 * gravado durante a era do bug #2177 (param combinado zera linksStats).
 *
 * A função retorna true (poison) quando:
 *  (a) linksStats tem ao menos 1 URL (não é vazio/nenhum link rastreado), E
 *  (b) a soma de todos os clicks é 0, E
 *  (c) globalStats.clickers > 0 (campanha teve cliques reais na Brevo).
 *
 * Retorna false (seguro) quando:
 *  - linksStats é null/undefined (ausente → não-poison, simplesmente não buscado).
 *  - linksStats é {} (vazio → campanha sem links rastreados, legítimo).
 *  - globalStats é null/undefined (não temos confirmação de cliques → não podemos afirmar poison).
 *  - os clicks não-zero existem (dados reais).
 *
 * Exportado para testes de regressão.
 */
export function isLinksStatsPoisoned(
  ls: BrevoLinksStats | null | undefined,
  gs: { clickers?: number } | null | undefined,
): boolean {
  if (!ls) return false; // ausente → não poison
  const urls = Object.keys(ls);
  if (urls.length === 0) return false; // {} → campanha sem links, legítimo
  if (!gs || !gs.clickers || gs.clickers <= 0) return false; // sem confirmação de cliques reais
  const totalClicks = Object.values(ls).reduce((s, v) => s + (Number.isFinite(v) ? v : 0), 0);
  return totalClicks === 0; // todos-zeros + clickers>0 → poison
}

/**
 * isImmutableCampaign: campanha com `sentDate` há mais de 7 dias tem
 * stats imutáveis — não muda mais no Brevo. Usada para decidir se devemos
 * tentar ler/escrever no KV.
 *
 * @param sentDate - ISO string da data de envio (null = campanha recente)
 * @param nowMs    - timestamp de referência (mockável em testes)
 */
export function isImmutableCampaign(sentDate: string | null, nowMs = Date.now()): boolean {
  if (!sentDate) return false;
  const sent = Date.parse(sentDate);
  if (isNaN(sent)) return false;
  const sevenDaysMs = 7 * 24 * 3600 * 1000;
  return nowMs - sent > sevenDaysMs;
}

/**
 * #2270: TTL do cache KV de stats de campanhas RECENTES (<7d, ciclo ativo).
 * Imutáveis (>7d) ficam sem TTL (stats não mudam). Recentes mudam devagar
 * (opens/clicks acumulando) → stale de 30min é aceitável p/ dashboard e
 * reduz writes/dia em ~6× vs. 300s anterior.
 *
 * #2282: subindo de 300s → 1800s (30min) como alavanca principal de redução
 * de writes/dia no KV free-tier (shared com o poll worker). ~13 campanhas
 * recentes × 2 chaves × (86400/1800) renders/dia = ~1248 → ~208 writes/dia
 * (6× menor). TTL de 30min ainda é bem abaixo do staleness de decisão (o
 * editor consulta a dashboard para ver padrão de envios passados, não stats
 * ao segundo). Justificativa: free-tier = 1000 writes/dia shared; queremos
 * margem confortável para o poll worker (votos em produção são P0).
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
  by_tier: Record<string, number>;
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
  mv: Record<string, number>;
  engagement: { with_opens: number; with_clicks: number };
}

// #2733: TTL do cache de campanhas cruas (LASTGOOD_CAMPAIGNS_KEY). 1h — a janela
// de rate-limit da Brevo cabe folgada.
export const LASTGOOD_TTL = 3600;

// #2718: chave KV do relatório de cupons Stripe (TTL 5min, mesma granularidade do dashboard).
export const COUPONS_KV_KEY = "coupons:usage";

/**
 * #2718: busca relatório de cupons com KV como fonte primária.
 *
 * Fluxo: KV (populado via MCP externo) → fallback Stripe API (só se
 * STRIPE_API_KEY configurada). Em KV-only (sem Stripe key), isFresh=true
 * ainda serve KV — não há fonte mais fresca disponível. Retorna null quando
 * COUPONS_TAB_ENABLED !== "true", em KV miss sem STRIPE_API_KEY, ou em erro.
 */
/** Exported for unit tests. */
export async function getCouponUsage(
  env: Pick<Env, "COUPONS_TAB_ENABLED" | "STRIPE_API_KEY" | "STATS_CACHE">,
  isFresh: boolean,
): Promise<CouponUsageReport | null> {
  if (env.COUPONS_TAB_ENABLED !== "true") return null;
  try {
    if (env.STATS_CACHE) {
      const cached = await env.STATS_CACHE.get<CouponUsageReport>(COUPONS_KV_KEY, "json")
        .catch((e) => { console.error("[#2718] KV read error:", (e as Error).message); return null; });
      // KV hit: retorna imediatamente, EXCETO quando isFresh=true E Stripe disponível
      // (nesse caso Stripe tem dados mais frescos). Em KV-only (sem Stripe key), KV
      // é a fonte mais fresca mesmo com isFresh=true.
      if (cached !== null && (!isFresh || !env.STRIPE_API_KEY)) return cached;
    }
    // KV miss ou isFresh com Stripe disponível: tenta Stripe API
    if (!env.STRIPE_API_KEY) return null;
    const report = await fetchCouponUsage(env.STRIPE_API_KEY);
    // Sempre grava de volta ao KV — inclusive em isFresh, para atualizar o cache
    // das sessões seguintes (não só do caller que pediu ?fresh=1).
    // Design: STRIPE_API_KEY e MCP-sourced data são mutuamente exclusivos.
    // Com STRIPE_API_KEY configurado, o TTL passa a ser 300s (Worker-managed);
    // sem ela, o KV é populado via MCP externo sem TTL (populate-once design).
    if (env.STATS_CACHE) {
      await env.STATS_CACHE.put(COUPONS_KV_KEY, JSON.stringify(report), {
        expirationTtl: 300,
      }).catch(() => { /* KV erro nunca bloqueia o render */ });
    }
    return report;
  } catch (e) {
    console.error("[#2718] getCouponUsage falhou — tab de cupons oculta:", e instanceof Error ? e.message : e);
    return null;
  }
}

// #2733: chave KV com as campanhas Brevo cruas do último render saudável
// (`{ campaigns, scheduled }`). Serve de fallback quando o Brevo entra em
// rate-limit: o dashboard re-renderiza com essas campanhas stale + as abas de
// KV (Cupons/Contatos) ATUALIZADAS — em vez de servir o HTML inteiro congelado.
export const LASTGOOD_CAMPAIGNS_KEY = "dash:lastgood:campaigns";

/**
 * #2733: lê as seções KV-independentes do dashboard (coortes, status MV, sumário
 * de contatos, cupons). Extraída para ser usada tanto no render saudável quanto
 * no fallback de rate-limit do Brevo — assim as abas de Cupons/Contatos, que vêm
 * do KV e não do Brevo, nunca congelam junto com a seção de campanhas.
 *
 * Exported for unit tests (#2733).
 */
export async function readKvTabs(
  env: Env,
  isFresh: boolean,
): Promise<{
  cohorts: EngagementCohorts | null;
  mvStatus: MvStatus | null;
  contactsSummary: ContactsSummary | null;
  couponUsage: CouponUsageReport | null;
}> {
  // As 4 leituras são independentes → paralelas (importa no fallback de 429,
  // que está no caminho crítico do render stale).
  const kv = env.STATS_CACHE;
  const [cohorts, mvStatus, contactsSummary, couponUsage] = await Promise.all([
    kv ? (kv.get(COHORTS_KV_KEY, "json").catch(() => null) as Promise<EngagementCohorts | null>) : Promise.resolve(null),
    kv ? (kv.get(MV_STATUS_KV_KEY, "json").catch(() => null) as Promise<MvStatus | null>) : Promise.resolve(null),
    kv ? (kv.get(CONTACTS_SUMMARY_KV_KEY, "json").catch(() => null) as Promise<ContactsSummary | null>) : Promise.resolve(null),
    getCouponUsage(env, isFresh),
  ]);
  return { cohorts, mvStatus, contactsSummary, couponUsage };
}

/**
 * #2733: monta a resposta de fallback quando o Brevo está em rate-limit (429).
 * Serve o dashboard com campanhas STALE (do KV `dash:lastgood:campaigns`) + as
 * abas de KV FRESCAS (Cupons/Contatos/coortes/MV via readKvTabs) + banner — em
 * vez do HTML inteiro congelado, que escondia dado KV recém-publicado.
 *
 * `isFresh=false` sempre: no caminho de erro nunca fazemos chamada externa ao
 * vivo (getCouponUsage) — honramos o KV. `Array.isArray` guarda contra KV
 * corrompido. Se o re-render lançar, degrada pro 503 amigável (nunca 500).
 *
 * Exported for unit tests (#2733).
 */
export async function buildRateLimitFallback(
  env: Env,
  retryAfterSecs: number | null,
): Promise<Response> {
  if (!env.STATS_CACHE) return rateLimitResponse(retryAfterSecs, true);
  const staleCampaignsRaw = (await env.STATS_CACHE
    .get(LASTGOOD_CAMPAIGNS_KEY, "json")
    .catch(() => null)) as { campaigns?: unknown[]; scheduled?: unknown[] } | null;
  const { cohorts, mvStatus, contactsSummary, couponUsage } = await readKvTabs(env, false);
  const rawCampaigns = staleCampaignsRaw?.campaigns;
  const rawScheduled = staleCampaignsRaw?.scheduled;
  const staleCampaigns = (Array.isArray(rawCampaigns) ? rawCampaigns : []) as Parameters<
    typeof renderDashboardHtml
  >[0];
  const staleScheduled = (Array.isArray(rawScheduled) ? rawScheduled : []) as Parameters<
    typeof renderDashboardHtml
  >[1];
  try {
    const html = renderDashboardHtml(
      staleCampaigns,
      staleScheduled,
      cohorts,
      mvStatus,
      contactsSummary,
      couponUsage,
    );
    // buildStaleResponse injeta o banner "Brevo em rate-limit" (só as seções de
    // campanha estão atrasadas; Cupons/Contatos estão frescos).
    return buildStaleResponse(html, retryAfterSecs);
  } catch (renderErr) {
    // O re-render no fallback NUNCA pode virar 500: se lançar (ex: campanha stale
    // malformada no KV), degrada pro 503 amigável (comportamento pré-#2733).
    console.error(
      "[#2733] re-render no fallback de 429 falhou — degradando p/ 503:",
      renderErr instanceof Error ? renderErr.message : renderErr,
    );
    return rateLimitResponse(retryAfterSecs, true);
  }
}

/** Erro especial para 429 — carrega o header Retry-After da Brevo. */
export class BrevoRateLimitError extends Error {
  /**
   * @param retryAfterSecs valor inteiro (segundos) honrado pelo cliente E
   *   ecoado no header HTTP `Retry-After` (RFC 7231: precisa ser inteiro).
   * @param floorMs #2337 fix 1: piso opcional (em ms) aplicado SÓ ao backoff de
   *   retry interno (computeRetryDelayMs), nunca ao header HTTP. Usado quando o
   *   `x-sib-ratelimit-reset` é um epoch já expirado (delta→0): o header reporta
   *   0s (janela esgotada), mas o backoff interno usa ≥250ms pra não disparar as
   *   3 re-tentativas em microsegundos. Distinto de `retry-after: 0` literal
   *   (RFC 7231 retry imediato), que não recebe piso.
   */
  constructor(
    public readonly retryAfterSecs: number | null,
    public readonly floorMs = 0,
  ) {
    super(`Brevo rate limit (retry-after: ${retryAfterSecs ?? "?"}s)`);
    this.name = "BrevoRateLimitError";
  }
}

// #2337 fix 1: exportado para teste direto do parse de headers de rate-limit
// (epoch-elapsed → retryAfterSecs inteiro 0 + floorMs 250).
export async function brevoFetch<T>(path: string, env: Env): Promise<T> {
  const res = await fetch(`https://api.brevo.com${path}`, {
    headers: { "api-key": env.BREVO_API_KEY, accept: "application/json" },
  });
  if (res.status === 429) {
    // Semantica observada 2026-06-10 em chamada real: x-sib-ratelimit-reset
    // retornou "256" -- um DELTA em segundos, nao epoch Unix. Aplicamos clamp
    // defensivo: se o valor for < 1e9 (< 31 anos), tratamos como delta direto;
    // se for formato epoch (>= 1e9), convertemos via Math.ceil(v - Date.now()/1000).
    // Standard retry-after (RFC 7231) e lido como delta direto quando presente.
    let retryAfter: number | null = null;
    // #2337 fix 1: piso aplicado SÓ ao backoff interno (não ao header HTTP),
    // quando o epoch-reset já expirou (delta arredonda a 0). 0 = sem piso.
    let floorMs = 0;
    const retryAfterHeader = res.headers.get("retry-after");
    const resetHeader = res.headers.get("x-sib-ratelimit-reset");
    if (retryAfterHeader != null) {
      const v = Number(retryAfterHeader);
      if (!isNaN(v) && v >= 0) retryAfter = v; // F3 fix: v>=0 aceita retry-after:0 (RFC 7231: retry imediato)
    } else if (resetHeader != null) {
      const v = Number(resetHeader);
      if (!isNaN(v)) {
        // Delta direto (ex: 256s) ou epoch Unix (ex: ~1.7e9)?
        // #2337 fix 1: épocas já expiradas (Math.ceil → 0) recebem floor de 250ms
        // NO BACKOFF INTERNO (não no header). Um epoch-reset já passado indica que a
        // janela se esgotou neste segundo, não que Brevo pediu retry imediato. Sem o
        // floor, `computeRetryDelayMs(0) = 0ms` e as 3 re-tentativas disparam em
        // microsegundos, pressionando a janela seguinte. O header continua reportando
        // 0s (inteiro, RFC 7231-válido). Distinto de `retry-after: 0` literal (acima),
        // que é retry imediato e não recebe floor.
        if (v >= 1e9) {
          retryAfter = Math.max(0, Math.ceil(v - Date.now() / 1000));
          if (retryAfter === 0) floorMs = 250; // elapsed epoch → piso só no backoff
        } else {
          retryAfter = v >= 0 ? v : null;
        }
      }
    }
    throw new BrevoRateLimitError(retryAfter, floorMs);
  }
  if (!res.ok) {
    throw new Error(`Brevo API ${path} failed (${res.status}): ${await res.text()}`);
  }
  return res.json() as Promise<T>;
}

/**
 * Lista as últimas N campaigns enviadas + enriquece com nome da lista + globalStats
 * (#1141 fix: o listing default retorna `campaignStats[0]` por lista, mas
 * **não popula `globalStats`** — vem todo zerado. Pra ter contagem que bate
 * com a Brevo Web UI (que inclui Apple MPP opens), tem que fazer GET
 * individual por campanha com `?statistics=globalStats`.)
 *
 * #2144: usa mapLimit(5) em vez de Promise.all ilimitado pra não disparar
 * todos os GETs de uma vez e estourar a janela de 100 reqs/min da Brevo.
 * Stats de campanhas com sentDate > 7d são consideradas imutáveis e
 * cacheadas no KV STATS_CACHE sem TTL. Nomes de lista: KV com TTL 7d.
 */
export async function fetchRecentCampaigns(
  env: Env,
  limit = 50, // #2134 follow-up: weekday agrega todos os envios — cobrir ciclos anteriores
  isFresh = false, // #2144: fresh=1 bypassa tanto edge cache quanto KV de stats imutaveis
  // _fetchFn: injetavel em testes para mockar chamadas Brevo (padrao: brevoFetch)
  _fetchFn: typeof brevoFetch = brevoFetch,
): Promise<Array<BrevoCampaign & { listName?: string; listSize?: number }>> {
  // #2280: a listagem NÃO era re-tentada — um único 429 aqui derrubava a página
  // inteira (503). withRateLimitRetry honra x-sib-ratelimit-reset com backoff curto.
  const data = await withRateLimitRetry(() =>
    _fetchFn<{ campaigns: BrevoCampaign[] }>(
      `/v3/emailCampaigns?status=sent&limit=${limit}&sort=desc`,
      env,
    ),
  );
  const campaigns = data.campaigns ?? [];

  // Coleta lista IDs únicas pra fetch em batch (max 1 chamada extra por lista)
  const listIds = [...new Set(campaigns.flatMap((c) => c.recipients?.lists ?? []))];

  const listMap = new Map<number, BrevoList>();
  const globalStatsMap = new Map<number, BrevoGlobalStats>();
  const linksStatsMap = new Map<number, BrevoLinksStats>();

  // Fetch listas e globalStats em paralelo -- os dois batches sao independentes.
  // mapLimit(5) por batch => concorrencia total <= 10 (bem abaixo de 100 reqs/min da Brevo).
  // Fetch listas e globalStats em paralelo -- os dois batches sao independentes.
  // mapLimit(5) por batch: concorrencia total <= 10, bem abaixo de 100 reqs/min da Brevo.
  await Promise.all([
    // Batch 1: nomes de lista com KV cache (TTL 7d)
    mapLimit(listIds, 5, async (id) => {
      try {
        // Tentar KV primeiro (isFresh=1 bypassa -- operador quer dados direto da Brevo)
        const kvKey = `list:${id}`;
        const cached = (!isFresh && env.STATS_CACHE) ? await env.STATS_CACHE.get(kvKey, "json").catch(() => null) : null;
        if (cached) {
          listMap.set(id, cached as BrevoList);
          return;
        }
        const list = await _fetchFn<BrevoList>(`/v3/contacts/lists/${id}`, env);
        listMap.set(id, list);
        // Gravar no KV com TTL 7 dias (lista pode mudar de nome ou tamanho)
        if (env.STATS_CACHE) {
          await env.STATS_CACHE.put(kvKey, JSON.stringify(list), {
            expirationTtl: 7 * 24 * 3600,
          }).catch(() => { /* erro de KV nunca bloqueia */ });
        }
      } catch {
        // Lista pode ter sido apagada -- skip
      }
    }),
    // Batch 2: globalStats + linksStats com KV cache para campanhas imutaveis (> 7d).
    // #2177: ambas as stats vêm de GETs separados por id.
    // linksStats: url → clicks (unique-clicks por link não está disponível na API Brevo v3).
    //
    // #2314: chave unificada `stats:{id}` → 1 KV write por campanha (era 2: gstats: + lstats:).
    // Leitura retrocompatível: tenta `stats:{id}` primeiro; se ausente, cai nos legados
    // `gstats:{id}` + `lstats:{id}` (migração transparente sem wrangler kv delete).
    mapLimit(campaigns, 5, async (c) => {
      try {
        const kvStatsKey = `stats:${c.id}`;
        // Chaves legadas mantidas apenas para LEITURA de migração (não mais gravadas).
        const kvGsKey = `gstats:${c.id}`;
        const kvLsKey = `lstats:${c.id}`;
        const immutable = isImmutableCampaign(c.sentDate);

        // #2270/#2314: tentar KV pra TODAS as campanhas (não só imutáveis). Recentes
        // têm TTL curto (RECENT_STATS_TTL) e expiram sozinhas; imutáveis ficam sem TTL.
        // Render dentro do TTL → hit no KV → 0 GETs à Brevo → sem 503/flicker.
        // `?fresh=1` continua bypassando (`!isFresh`).
        // F4: cachedGs e cachedLs são hoistados para o escopo deste callback para
        // que a lógica de skip-gs-fetch abaixo consiga checar se gs já está válido.
        let cachedGs: unknown = null;
        let cachedLs: unknown = null;
        // Finding #2 (#2323): hoistado para que o guard do ls-fetch abaixo consiga
        // verificar se cachedLs está envenenado (e portanto deve ser re-fetchado).
        let cachedLsIsPoison = false;
        // #2337 fix 2: sinal de que ls-fetch já foi tentado mas falhou no ciclo anterior.
        // Impede que `ls === undefined` no JSON → `cachedLs = null` → re-fetch+re-write em
        // toda render dentro do TTL (KV-write churn). Quando true, o ls-fetch é pulado e
        // o resultado é idêntico ao caso "ls fetch falhou" — links section fica sem dados
        // até a entrada TTL expirar (RECENT_STATS_TTL = 30min) e uma nova tentativa ocorrer.
        let cachedLsWasPending = false;
        if (!isFresh && env.STATS_CACHE) {
          // #2314: tenta chave unificada primeiro; fallback retrocompatível para as legadas.
          const unified = await env.STATS_CACHE.get(kvStatsKey, "json").catch(() => null) as
            { gs: BrevoGlobalStats; ls?: BrevoLinksStats; lsPending?: true } | null;
          if (unified) {
            cachedGs = unified.gs ?? null;
            cachedLs = unified.ls ?? null;
            // #2337 fix 2: detecta entrada gravada com lsPending:true (ls-fetch falhou
            // na carga anterior). Seta o flag para pular o fetch neste render — sem isso,
            // ls=null → re-fetch → nova escrita → loop de churn até o TTL expirar.
            if (unified.lsPending === true) cachedLsWasPending = true;
          } else {
            // Migração: lê chaves legadas (gravadas por versões anteriores do worker).
            // Este path é READ-ONLY / aging-out: nada mais escreve `gstats:{id}` ou
            // `lstats:{id}` — o writer sempre usa `stats:{id}` desde #2314. Entradas
            // legadas expiram pelo TTL original ou ficam permanentes até serem
            // sobrescritas quando `stats:{id}` for gravado numa próxima render ativa.
            // NÃO aplica a sentinela lsPending aqui: o path legado é read-only e as
            // entradas envelhecem sem nova escrita; adicionar churn-guard num path
            // que nunca escreve seria maquinário morto.
            [cachedGs, cachedLs] = await Promise.all([
              env.STATS_CACHE.get(kvGsKey, "json").catch(() => null),
              env.STATS_CACHE.get(kvLsKey, "json").catch(() => null),
            ]);
          }
          if (cachedGs) globalStatsMap.set(c.id, cachedGs as BrevoGlobalStats);
          // #2273: guard de sanidade contra linksStats envenenado (bug #2177).
          // Um lstats onde TODOS os clicks são 0 mas globalStats.clickers > 0
          // é inconsistente — indica entrada de cache envenenada. Nesse caso,
          // NÃO confiamos no cache: forçamos re-fetch do lstats. Isso auto-cura
          // entries gravadas durante a era #2177 sem precisar de `wrangler kv put`.
          // Também adiciona TTL a imutáveis com lstats suspeito, para que a entrada
          // se auto-destrua mesmo se o re-fetch falhar (limpa poison permanente).
          const lsIsPoison = isLinksStatsPoisoned(
            cachedLs as BrevoLinksStats | null,
            cachedGs as BrevoGlobalStats | null,
          );
          cachedLsIsPoison = lsIsPoison; // hoist para escopo do callback (#2323 finding #2)
          if (cachedLs && !lsIsPoison) linksStatsMap.set(c.id, cachedLs as BrevoLinksStats);
          // Se ambos estavam em cache (e lstats não-poison), skip o fetch da API.
          // Bug fix (#2183): antes o `if (cachedGs) return` pulava o fetch
          // mesmo quando lstats não estava em cache — campanhas pré-#2177 com
          // gstats cacheado nunca recebiam lstats. Agora só retorna se ambos
          // estiverem em cache (e lstats não-poison).
          // #2337 fix 2: cachedLsWasPending (lsPending:true no KV) também satisfaz a
          // condição — gs está disponível e ls-fetch não deve ser tentado neste render.
          if (cachedGs && ((!lsIsPoison && cachedLs) || cachedLsWasPending)) return;
        }

        // #2249 (verificado 2026-06-14 contra a API Brevo): o param COMBINADO
        // `?statistics=globalStats,linksStats` retorna `linksStats` ZERADO (todos
        // os links com 0 clicks), enquanto `?statistics=linksStats` sozinho
        // retorna os cliques reais. Ex #41: combined links>0=0; single links>0=4
        // (8 clicks). Por isso buscamos em DOIS GETs (custa 1 chamada extra por
        // campanha — reverte a otimização #2177, que era a causa da seção de
        // links agregados vir sempre vazia). globalStats no combinado está OK,
        // mas pedimos só globalStats pra deixar a intenção explícita.
        // #2275c: os GETs de stats por campanha também retentam em 429.
        // withRateLimitRetry honra x-sib-ratelimit-reset com backoff capped
        // (idêntico ao comportamento da listagem, acima). Isso evita que um
        // 429 transitório durante o fetch de 50 campanhas zere os stats.
        // F4 fix: se cachedGs já estava válido (mas lstats era poison/ausente),
        // não re-fetchar globalStats — só buscar o lstats que falta. Economiza
        // 1 GET/campanha no path "lstats poison, gs ok", reduzindo pressão de 429.
        let gs: BrevoGlobalStats | undefined;
        if (!cachedGs) {
          const detail = await withRateLimitRetry(() =>
            _fetchFn<BrevoCampaign>(
              `/v3/emailCampaigns/${c.id}?statistics=globalStats`,
              env,
            ),
          );
          gs = detail.statistics?.globalStats;
        } else {
          gs = cachedGs as BrevoGlobalStats;
        }
        // #2249: o GET de linksStats fica num try/catch PRÓPRIO — uma falha (429)
        // aqui NÃO pode descartar o globalStats já obtido acima. Sem esse
        // isolamento, um 429 no 2º GET cairia no catch externo e pularia o
        // `globalStatsMap.set` lá embaixo, perdendo o gs que veio OK no 1º GET
        // (regressão da divisão em 2 chamadas). ls fica undefined → fallback normal.
        // #2249: guard `if (!cachedLs || cachedLsIsPoison)` espelha o guard do gs
        // path acima (`if (!cachedGs)`). Finding #2 (#2323): sem esse guard, cachedLs
        // populado via legado `lstats:{id}` era ignorado e o fetch da API sobrescrevia
        // — se o fetch falhasse, ls ficava undefined e o write subsequente descartava
        // o dado legado válido. Poison continua re-fetchado (cachedLsIsPoison=true).
        // #2337 fix 2: cachedLsWasPending (lsPending:true no KV) suprime o ls-fetch
        // neste render — a entrada já registrou que ls falhou; não tentar de novo até
        // o TTL expirar. Sem isso: ls=undefined → write → ls=null na leitura → re-fetch
        // → re-write em toda render dentro do TTL (churn exato que #2314 tentou evitar).
        let ls: BrevoLinksStats | undefined;
        if (!cachedLsWasPending && (!cachedLs || cachedLsIsPoison)) {
          try {
            // #2275c: linksStats também retenta em 429 (wrapper próprio — isolado do gs).
            const linksDetail = await withRateLimitRetry(() =>
              _fetchFn<BrevoCampaign>(
                `/v3/emailCampaigns/${c.id}?statistics=linksStats`,
                env,
              ),
            );
            ls = linksDetail.statistics?.linksStats;
          } catch {
            // linksStats indisponível (429/erro após retry) — gs segue válido; seção de links degrada
          }
        } else if (!cachedLsWasPending) {
          // cachedLs is present and not poison — reuse it
          ls = cachedLs as BrevoLinksStats;
        }
        // #2355 fix 3: when cachedLsWasPending=true (ls-fetch failed in prior cycle),
        // leave ls === undefined so the KV write below keeps lsPending:true sentinel
        // (payload = { gs, lsPending:true }). Previously: ls = cachedLs (null) →
        // null !== undefined → writes { gs, ls:null } → sentinel destroyed → 2-cycle
        // churn resumes. The fix: cachedLsWasPending falls through WITHOUT setting ls,
        // preserving undefined. The linksStatsMap does not get set (ls still undefined),
        // which is correct — links section degrades until TTL expires and a fresh attempt
        // succeeds. The `ls !== undefined` guard on linksStatsMap.set below handles this.

        // So gravar stats REAIS (gs.sent > 0) -- Brevo pode retornar objeto
        // zerado em certas condicoes; persistir zerado sem TTL criaria entrada
        // permanente impossivel de recuperar sem `wrangler kv:key delete`.
        //
        // #2314: coalesce — grava 1 `stats:{id}` em vez de `gstats:{id}` + `lstats:{id}`.
        // gs pode ser undefined se o fetch falhou ou retornou zerado; ls pode ser undefined
        // se o GET separado falhou. Só grava quando ao menos gs é real (sent>0).
        // Poison-check de ls: idêntico ao original — TTL curto mesmo em imutável.
        const gsReal = gs && gs.sent > 0;
        if (gsReal) {
          globalStatsMap.set(c.id, gs!);
        }
        if (ls !== undefined) {
          linksStatsMap.set(c.id, ls);
        }

        if (gsReal && env.STATS_CACHE) {
          const gsFetched = globalStatsMap.get(c.id) ?? gs ?? null;
          const lsPoison = ls !== undefined ? isLinksStatsPoisoned(ls, gsFetched) : false;
          // Poison → TTL curto mesmo em imutável (auto-cura); real → TTL normal.
          // Finding #1 (#2323): só grava sem TTL (permanente) quando ls está presente E
          // não-poison. Se ls === undefined (fetch falhou), a entrada TTL'd auto-cura na
          // próxima cache-miss → re-fetcha ls. Sem esse guard, a entrada permanente ficaria
          // para sempre sem ls (exigiria `wrangler kv:key delete` para recuperar).
          const opts = (immutable && !lsPoison && ls !== undefined) ? {} : { expirationTtl: RECENT_STATS_TTL };
          // #2314: 1 write por campanha (era 2).
          // #2337 fix 2: quando ls === undefined (fetch falhou), gravar `lsPending: true`
          // em vez de omitir o campo ls. JSON.stringify({ ls: undefined }) omite o campo →
          // próxima leitura: unified.ls = undefined → ?? null = null → !cachedLs true →
          // novo fetch+write em toda render dentro do TTL (churn). Com lsPending:true o
          // próximo render detecta `unified.lsPending === true`, seta cachedLsWasPending e
          // pula o fetch — sem novo write até o TTL expirar e uma tentativa fresca ocorrer.
          const payload = ls !== undefined
            ? { gs: gs!, ls }
            : { gs: gs!, lsPending: true };
          await env.STATS_CACHE.put(
            kvStatsKey, JSON.stringify(payload),
            opts,
          ).catch(() => { /* nunca bloqueia */ });
        }
      } catch {
        // Falha individual nao bloqueia o resto -- campaignStats fica como fallback
      }
    }),
  ]); // fim Promise.all([listas, stats])

  return campaigns.map((c) => {
    const listId = c.recipients?.lists?.[0];
    const list = listId ? listMap.get(listId) : undefined;
    const globalStats = globalStatsMap.get(c.id);
    const linksStats = linksStatsMap.get(c.id);
    // #1141 fix: o listing retorna `globalStats: { sent: 0, ... }` (zeroed,
    // não undefined) — verificado 2026-05-12. Por isso NÃO podemos fazer
    // `...c.statistics` cego: se nosso fetch individual falhar (globalStats
    // local = undefined), o zeroed do listing persistiria e mascara o
    // fallback pra campaignStats no render. Só incluir globalStats final
    // se o fetch individual teve sucesso.
    // #2199.3: linksStats consolidado em statistics.linksStats (fonte única).
    // A propriedade top-level `linksStats` foi removida — era double-write
    // desnecessário. Leitores usam c.statistics?.linksStats.
    return {
      ...c,
      listName: list?.name,
      listSize: list?.totalSubscribers,
      statistics: {
        campaignStats: c.statistics?.campaignStats,
        ...(globalStats && { globalStats }),
        ...(linksStats !== undefined && { linksStats }),
      },
    };
  });
}

/**
 * #2307: helper puro que converte `retryAfterSecs` (campo de BrevoRateLimitError)
 * em milissegundos de espera. Extraído de withRateLimitRetry para:
 *   (a) ser testável isoladamente;
 *   (b) uniformizar a semântica: retryAfterSecs=0 → 0ms (retry imediato,
 *       RFC 7231), não mais clampeado para 1s (regressão anterior).
 *
 * Lógica: cap máximo de 5s (protege dashboard contra throttle sustentado).
 * Mínimo: 0ms (aceita retry imediato quando Brevo sinaliza reset:0).
 * Fallback: 2s quando retryAfterSecs é null (header ausente).
 *
 * #2337 fix 1: `floorMs` é um piso opcional aplicado ao RESULTADO (não ao header).
 * Usado quando o `x-sib-ratelimit-reset` é um epoch já expirado (retryAfterSecs=0
 * mas a janela se esgotou neste segundo): o backoff interno usa ≥floorMs pra não
 * disparar as 3 re-tentativas em microsegundos. Default 0 (sem piso) preserva o
 * comportamento de `retry-after: 0` literal (RFC 7231 retry imediato).
 */
export function computeRetryDelayMs(retryAfterSecs: number | null, floorMs = 0): number {
  const s = retryAfterSecs ?? 2; // null = header ausente = fallback 2s
  // Finding #3 (#2323): Math.max(0, ...) garante mínimo 0ms para inputs negativos
  // (ex: Brevo enviando header negativo por bug). Math.min cap de 5s protege
  // contra throttle sustentado (Brevo pode mandar Retry-After: 256s — clampamos).
  const baseMs = Math.max(0, Math.min(s, 5)) * 1000;
  return Math.max(baseMs, floorMs); // #2337: piso de epoch-elapsed (não afeta header)
}

/**
 * #2268: retry com backoff em chamada que pode 429. O fetch de enviadas tolera
 * 429 por-campanha (fallback campaignStats), mas a listagem de agendadas não tem
 * fallback — sem retry, um 429 some com a seção inteira. Retenta respeitando o
 * `Retry-After`, até `attempts`. `_sleep` injetável p/ teste.
 *
 * Cap 5s por chamada: cobre o caso comum (429 de BURST no início do fetch pesado
 * de enviadas). NÃO sobrevive a um throttle SUSTENTADO (a Brevo já mandou
 * Retry-After de 256s — clampamos pra não pendurar o request da dashboard 4min);
 * nesse caso esgota as tentativas → o chamador cai no `.catch` (seção oculta + log).
 * A mitigação primária do caso comum é o REORDER (buscar agendadas ANTES das
 * enviadas, com a janela de rate-limit fresca) — ver a rota `/`.
 *
 * #2307: retryAfterSecs=0 → retry imediato (sem clamp inferior). Usa computeRetryDelayMs.
 * #2337 fix 1: honra `floorMs` da BrevoRateLimitError (piso de epoch-elapsed) no sleep.
 */
export async function withRateLimitRetry<T>(
  fn: () => Promise<T>,
  attempts = 3,
  _sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= attempts - 1 || !(e instanceof BrevoRateLimitError)) throw e;
      await _sleep(computeRetryDelayMs(e.retryAfterSecs, e.floorMs));
    }
  }
}

/**
 * #2251: busca campanhas AGENDADAS (status=queued) + enriquece com nome/tamanho
 * da lista. Função separada de fetchRecentCampaigns de propósito: campanhas
 * agendadas não têm stats (globalStats/linksStats), então pulamos todo o batch
 * de enrich de stats — e mantemos `status=sent` intocado pra não poluir os
 * agregadores de enviadas. `sort=asc`: próximo envio primeiro.
 * #2268: a listagem `queued` retenta em 429 (withRateLimitRetry) — sem isso a
 * seção sumia silenciosamente sob pressão de rate-limit.
 */
export async function fetchScheduledCampaigns(
  env: Env,
  limit = 50,
  isFresh = false,
  _fetchFn: typeof brevoFetch = brevoFetch,
): Promise<Array<BrevoCampaign & { listName?: string; listSize?: number }>> {
  const data = await withRateLimitRetry(() =>
    _fetchFn<{ campaigns: BrevoCampaign[] }>(
      `/v3/emailCampaigns?status=queued&limit=${limit}&sort=asc`,
      env,
    ),
  );
  const campaigns = data.campaigns ?? [];
  const listIds = [...new Set(campaigns.flatMap((c) => c.recipients?.lists ?? []))];
  const listMap = new Map<number, BrevoList>();
  // Reusa o MESMO KV cache de nomes de lista (`list:{id}`, TTL 7d) que
  // fetchRecentCampaigns popula — agendadas e enviadas compartilham listas.
  await mapLimit(listIds, 5, async (id) => {
    try {
      const kvKey = `list:${id}`;
      const cached = (!isFresh && env.STATS_CACHE)
        ? await env.STATS_CACHE.get(kvKey, "json").catch(() => null)
        : null;
      if (cached) {
        listMap.set(id, cached as BrevoList);
        return;
      }
      const list = await _fetchFn<BrevoList>(`/v3/contacts/lists/${id}`, env);
      listMap.set(id, list);
      if (env.STATS_CACHE) {
        await env.STATS_CACHE.put(kvKey, JSON.stringify(list), {
          expirationTtl: 7 * 24 * 3600,
        }).catch(() => { /* erro de KV nunca bloqueia */ });
      }
    } catch {
      // lista apagada / fetch falhou — segue sem nome
    }
  });
  return campaigns.map((c) => {
    const listId = c.recipients?.lists?.[0];
    const list = listId ? listMap.get(listId) : undefined;
    return { ...c, listName: list?.name, listSize: list?.totalSubscribers };
  });
}

function pct(n: number, total: number): string {
  if (!total) return "0.0%";
  return ((n / total) * 100).toFixed(1) + "%";
}

/**
 * Gera o atributo `class="..."` a partir de N classes. Strings vazias /
 * null / false são filtradas. Retorna string vazia (sem atributo) se
 * sobrar zero classes. Uso: `<td${cellClass("metric", maybeAlert)}>...`.
 */
function cellClass(...names: Array<string | false | null | undefined>): string {
  const valid = names.filter((n): n is string => Boolean(n));
  return valid.length === 0 ? "" : ` class="${valid.join(" ")}"`;
}

// ─── #2177: CTR por link ──────────────────────────────────────────────────────

/**
 * URLs de tracking/sistema a filtrar do linksStats: unsubscribe, preferências,
 * links de tracking Brevo e Mailgun. Filtro conservador — só remove o que é
 * claramente sistema, não editorial.
 *
 * NOTA: UTMs (utm_source, utm_campaign, etc.) NÃO são filtrados — são parâmetros
 * de tracking editorial legítimos que devem aparecer no relatório de links.
 */
const SYSTEM_URL_PATTERNS = [
  /unsubscribe/i,        // também cobre r.brevo.com/links/unsubscribe — regex específico removido (#2183)
  /optout/i,
  /opt-out/i,
  /preferences/i,
  /preferencias/i,
  /manage.*subscription/i,
  /email\.mg\./i,        // Mailgun tracking
];

/**
 * Retorna true se a URL deve ser filtrada do report de links (sistema/rodapé).
 */
export function isSystemLink(url: string): boolean {
  return SYSTEM_URL_PATTERNS.some((p) => p.test(url));
}

/**
 * Trunca uma URL para exibição (max 70 chars).
 * Helper compartilhado entre parseLinksStats e aggregateLinksAcrossCampaigns
 * para evitar duplicação (#2216 cleanup, finding #2).
 */
export function truncateUrl(url: string): string {
  return url.length > 70 ? url.slice(0, 67) + "…" : url;
}

/**
 * Retorna linksStats de uma campanha — fonte canônica: statistics.linksStats,
 * com fallback pra top-level linksStats (backward compat com fixtures/testes legados).
 * Helper compartilhado (#2216 cleanup, finding #4 — elimina dual-source duplicado).
 */
export function getCampaignLinksStats(
  c: BrevoCampaign & { listName?: string; listSize?: number; linksStats?: BrevoLinksStats },
): BrevoLinksStats | undefined {
  return c.statistics?.linksStats ?? c.linksStats;
}

/**
 * Estrutura de um link processado para exibição no dashboard.
 */
export interface LinkStatRow {
  url: string;
  /** URL truncada para exibição (max 70 chars) */
  displayUrl: string;
  clicks: number;
  /** Participação percentual em relação ao total de clicks editoriais da campanha (links de sistema excluídos) */
  pctOfTotal: string;
}

/**
 * Parseia `linksStats` (mapa url→clicks) da Brevo, filtra links de sistema,
 * ordena por clicks DESC e retorna array de LinkStatRow com participação %.
 *
 * Nota sobre unique-clicks: a API Brevo v3 (`GET /v3/emailCampaigns/{id}?statistics=linksStats`)
 * expõe apenas clicks totais por URL — sem unique-clicks por link. Unique-clicks
 * só existem agregados no nível da campanha (`globalStats.uniqueClicks`).
 * Portanto, a tabela exibe apenas "Clicks" (total) e omite coluna unique graciosamente.
 *
 * @param linksStats - mapa url→clicks da Brevo (pode ser undefined/null)
 * @returns array de LinkStatRow ordenado por clicks DESC, vazio se sem dados
 */
export function parseLinksStats(linksStats: BrevoLinksStats | undefined | null): LinkStatRow[] {
  if (!linksStats) return [];

  const entries = Object.entries(linksStats)
    .filter(([url]) => !isSystemLink(url))
    // #2216 finding #3: Number.isFinite guard — `clicks > 0` is NaN-transparent
    // (NaN > 0 is false, but NaN can still propagate if checked differently elsewhere).
    // isFinite covers NaN, Infinity, and -Infinity. Consistent with #2207 NaN class.
    .filter(([, clicks]) => Number.isFinite(clicks) && clicks > 0)
    .sort(([, a], [, b]) => b - a);

  if (entries.length === 0) return [];

  const totalClicks = entries.reduce((sum, [, clicks]) => sum + clicks, 0);

  return entries.map(([url, clicks]) => ({
    url,
    displayUrl: truncateUrl(url), // #2216 finding #2: extraído helper truncateUrl
    clicks,
    pctOfTotal: pct(clicks, totalClicks), // reusa helper pct() (#2183)
  }));
}

/**
 * Renderiza a tabela de CTR por link como HTML colapsável (<details>/<summary>).
 * Graceful quando linksStats ausente ou sem links editoriais: retorna stub vazio.
 *
 * @param campaignId - usado no id do <details> para unicidade
 * @param linksStats - mapa url→clicks (pode ser undefined)
 * @param totalClicks - uniqueClicks da campanha (pra contexto no summary)
 */
export function renderLinksSection(
  campaignId: number,
  linksStats: BrevoLinksStats | undefined | null,
  totalClicks?: number,
): string {
  const rows = parseLinksStats(linksStats);

  // Stub graceful: sem linksStats ou sem links editoriais → seção oculta mas presente
  if (rows.length === 0) {
    let reason: string;
    if (linksStats == null) {
      reason = "dados de links não disponíveis";
    } else if (Object.keys(linksStats).length === 0) {
      reason = "nenhum link rastreado";
    } else {
      // Distingue "editorial com 0 clicks" de "só links de sistema" (#2183):
      // filtra só sistema; se sobrar algo → havia links editoriais, mas todos com 0 clicks.
      const editorialEntries = Object.entries(linksStats).filter(([url]) => !isSystemLink(url));
      reason = editorialEntries.length > 0
        ? "links editoriais presentes, mas com 0 cliques registrados"
        : "nenhum link editorial (apenas links de sistema)";
    }
    return `<details class="links-ctr" id="links-${campaignId}">
  <summary class="links-summary">Links clicados <span class="links-count-badge">—</span></summary>
  <p class="links-empty">${escHtml(reason)}</p>
</details>`;
  }

  // Nota: totalClicks é o uniqueClicks agregado da campanha (inclui links de sistema),
  // enquanto a coluna "% do total" usa como denominador apenas os clicks editoriais.
  // Os dois denominadores diferem intencionalmente — totalClicks é contexto global,
  // % do total é participação relativa dentro dos links editoriais.
  const clicksSuffix = totalClicks !== undefined ? ` de ${totalClicks} únicos (campanha)` : "";
  const tableRows = rows.map((r) => {
    // Defensive XSS guard: neutralize javascript: and other dangerous schemes (#2183).
    // Only allow http:// and https:// as href values.
    const safeHref = /^https?:\/\//i.test(r.url) ? escHtml(r.url) : "";
    const linkContent = safeHref
      ? `<a href="${safeHref}" target="_blank" rel="noopener noreferrer" title="${escHtml(r.url)}">${escHtml(r.displayUrl)}</a>`
      : escHtml(r.displayUrl);
    return `<tr>
      <td class="link-url">${linkContent}</td>
      <td class="link-clicks metric">${r.clicks}</td>
      <td class="link-pct">${r.pctOfTotal}</td>
    </tr>`;
  }).join("\n");

  return `<details class="links-ctr" id="links-${campaignId}">
  <summary class="links-summary">Links clicados <span class="links-count-badge">${rows.length}</span>${clicksSuffix}</summary>
  <div class="links-table-wrap">
  <table class="links-table">
    <thead>
      <tr>
        <th class="link-url-th" title="URL do link clicado (links de sistema e descadastramento excluídos)">Link</th>
        <th title="Total de cliques neste link (unique-clicks por link não disponível na API Brevo v3)">Clicks</th>
        <th title="Participação deste link no total de clicks editoriais (links de sistema excluídos). Denominador = soma dos clicks editoriais desta seção — difere do total da campanha exibido no summary acima.">% do total</th>
      </tr>
    </thead>
    <tbody>${tableRows}</tbody>
  </table>
  </div>
  <p class="links-note">Clicks totais por link — unique-clicks por link não disponível na API Brevo v3 (apenas agregado em Clicks 🖱️ acima).</p>
</details>`;
}

// ─── #2212: seção de links agregados do período ──────────────────────────────

/**
 * Linha de link agregado (across campanhas).
 */
export interface AggregatedLinkRow {
  url: string;
  /** URL truncada para exibição (max 70 chars) */
  displayUrl: string;
  /** Soma de clicks deste link entre todas as campanhas do período */
  totalClicks: number;
  /** Número de campanhas onde este link apareceu */
  campaignCount: number;
}

/**
 * Agrega links de TODAS as campanhas do período, somando o mesmo URL entre campanhas.
 * Filtra links de sistema usando `isSystemLink` (reutilizado — sem duplicação).
 * Retorna array ordenado por totalClicks DESC.
 * Graceful: sem dados de links → retorna [].
 *
 * @param campaigns - lista de campanhas (todas, com statistics.linksStats populado)
 * @returns array de AggregatedLinkRow ordenado por totalClicks DESC
 */
/**
 * #2263: extrai o ORIGIN (`scheme://host`, i.e. domínio+subdomínio) de uma URL,
 * descartando path/query/UTM. Ex: `https://clarice.ai/?via=diaria&utm_...` →
 * `https://clarice.ai`; `poll.diaria.workers.dev/vote?email={{ contact.EMAIL }}`
 * → `https://poll.diaria.workers.dev`. Fallback (URL não-parseável) → a string
 * original, pra não perder o link nem quebrar o render.
 */
export function urlOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

export function aggregateLinksAcrossCampaigns(
  campaigns: Array<BrevoCampaign & { listName?: string; listSize?: number; linksStats?: BrevoLinksStats }>,
): AggregatedLinkRow[] {
  // #2263: agrupado por ORIGIN (domínio+subdomínio), não URL completa. Detalhe
  // por página fica no drill-down por campanha (#2177).
  const originMap = new Map<string, { totalClicks: number; campaignCount: number }>();

  for (const c of campaigns) {
    // #2216 finding #4: getCampaignLinksStats helper elimina dual-source duplicado
    const linksStats = getCampaignLinksStats(c);
    if (!linksStats) continue;

    // Soma por origin DENTRO desta campanha primeiro, pra contar a campanha UMA
    // vez por origin (mesmo que ela tenha vários links do mesmo domínio).
    const perOrigin = new Map<string, number>();
    for (const [url, clicks] of Object.entries(linksStats)) {
      // Filtro de sistema sobre a URL COMPLETA (antes de reduzir a origin).
      if (isSystemLink(url)) continue;
      // #2216 finding #3: Number.isFinite guard — `clicks <= 0` é NaN-transparente
      // (NaN <= 0 é false, então NaN passaria o guard e acumularia em totalClicks).
      if (!Number.isFinite(clicks) || clicks <= 0) continue;
      const origin = urlOrigin(url);
      perOrigin.set(origin, (perOrigin.get(origin) ?? 0) + clicks);
    }

    for (const [origin, clicks] of perOrigin) {
      const existing = originMap.get(origin);
      if (existing) {
        existing.totalClicks += clicks;
        existing.campaignCount += 1;
      } else {
        originMap.set(origin, { totalClicks: clicks, campaignCount: 1 });
      }
    }
  }

  if (originMap.size === 0) return [];

  return Array.from(originMap.entries())
    .map(([origin, { totalClicks, campaignCount }]) => ({
      url: origin,
      displayUrl: origin, // #2263: origin já é curto — sem truncateUrl
      totalClicks,
      campaignCount,
    }))
    .sort((a, b) => b.totalClicks - a.totalClicks);
}

/**
 * #2421: Deriva o label da edição para o título da seção de links.
 * Formato: `${cycle}-${sendMonthBRT}` (ex: "2605-06").
 * - cycle: de parseClariceCampaignKey(nome) da campanha enviada mais recente.
 * - sendMonthBRT: mês de sentDate em BRT (zero-padded), via monthKeyBRT.
 * Retorna null quando: lista vazia, nenhuma campanha enviada, ou nome não parseável.
 * Exportado pra teste unitário.
 */
export function deriveLinksSectionTitle(
  campaigns: Array<Pick<BrevoCampaign, "name" | "sentDate">>,
): string | null {
  // Filtrar campanhas enviadas (sentDate não-nulo) e ordenar desc por sentDate.
  const sent = campaigns
    .filter(
      (c): c is typeof c & { sentDate: string } =>
        Boolean(c.sentDate) && parseClariceCampaignKey(c.name) !== null,
    )
    .sort((a, b) => Date.parse(b.sentDate) - Date.parse(a.sentDate));
  if (sent.length === 0) return null;

  const latest = sent[0];
  const parsed = parseClariceCampaignKey(latest.name);
  if (!parsed || !parsed.cycle) return null;

  const sendMonthKey = monthKeyBRT(latest.sentDate); // "YYYY-MM" em BRT
  if (!sendMonthKey) return null;

  const sendMonthBRT = sendMonthKey.slice(5); // "MM" (últimos 2 chars de "YYYY-MM")
  return `${parsed.cycle}-${sendMonthBRT}`; // ex: "2605-06"
}

/**
 * Renderiza a seção "Links mais clicados do período/da edição" com links agregados de TODAS as campanhas.
 * Sempre visível (seção presente mesmo sem dados — graceful stub).
 * Exportado pra teste unitário.
 *
 * @param rows - resultado de aggregateLinksAcrossCampaigns()
 * @param edicaoLabel - label da edição ex: "2605-06"; se null, usa "do período"
 */
export function renderAggregatedLinksSection(rows: AggregatedLinkRow[], edicaoLabel?: string | null): string {
  const sectionTitle = edicaoLabel
    ? `Links mais clicados da edição ${edicaoLabel}`
    : "Links mais clicados do período";

  if (rows.length === 0) {
    return `
<section class="phase2-section" id="links-agregados">
  <h2 class="section-title">${sectionTitle}</h2>
  <p class="section-note">Sem dados de links disponíveis para o período.</p>
</section>`;
  }

  const totalClicks = rows.reduce((sum, r) => sum + r.totalClicks, 0);

  const tableRows = rows.map((r) => {
    const safeHref = /^https?:\/\//i.test(r.url) ? escHtml(r.url) : "";
    const linkContent = safeHref
      ? `<a href="${safeHref}" target="_blank" rel="noopener noreferrer" title="${escHtml(r.url)}">${escHtml(r.displayUrl)}</a>`
      : escHtml(r.displayUrl);
    const pctShare = pct(r.totalClicks, totalClicks);
    return `<tr>
      <td class="link-url">${linkContent}</td>
      <td class="link-clicks metric">${r.totalClicks}</td>
      <td class="link-pct">${pctShare}</td>
      <td>${r.campaignCount}</td>
    </tr>`;
  }).join("\n");

  return `
<section class="phase2-section" id="links-agregados">
  <h2 class="section-title">${sectionTitle}</h2>
  <p class="section-note">${rows.length} links editoriais · ${totalClicks} clicks totais (soma across envios). Links de sistema excluídos.</p>
  <div class="table-wrap">
  <table class="links-table">
    <thead>
      <tr>
        <th class="link-url-th" title="URL do link (links de sistema e descadastramento excluídos)">Link</th>
        <th title="Total de cliques somados entre todos os envios do período">Clicks</th>
        <th title="Participação percentual no total de clicks editoriais do período">%</th>
        <th title="Número de envios onde este link apareceu">Envios</th>
      </tr>
    </thead>
    <tbody>${tableRows}</tbody>
  </table>
  </div>
  <p class="links-note">Clicks totais por link — unique-clicks por link não disponível na API Brevo v3.</p>
</section>`;
}

function hoursSince(iso: string | null): string {
  if (!iso) return "—";
  const elapsed = Date.now() - Date.parse(iso);
  if (isNaN(elapsed)) return "—";
  const hours = elapsed / 3600000;
  if (hours < 1) return `${Math.round(hours * 60)}min`;
  if (hours < 48) return `${hours.toFixed(1)}h`;
  return `${(hours / 24).toFixed(1)}d`;
}

function fmtTimeBRT(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  // #2085: weekday:"short" acrescenta dia da semana (ex: "qua., 11/06 06:00")
  // pra facilitar leitura de padrões de engajamento por dia.
  return d.toLocaleString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// NOTE (#2207): `linksStats?` no shape abaixo é mantido SOMENTE para fixtures de teste
// (backward compat: testes que passam linksStats top-level diretamente). Em produção,
// `fetchRecentCampaigns` nunca produz top-level `linksStats` desde #2199.3 — a propriedade
// canônica é sempre `statistics.linksStats`. Produção não usa o campo top-level.
export function renderDashboardHtml(
  campaigns: Array<BrevoCampaign & { listName?: string; listSize?: number; linksStats?: BrevoLinksStats }>,
  scheduled: Array<BrevoCampaign & { listName?: string; listSize?: number }> = [], // #2251
  cohorts: EngagementCohorts | null = null, // #2426: pré-computado via KV
  mvStatus: MvStatus | null = null, // #2609: status MV por grupo
  contactsSummary: ContactsSummary | null = null, // #2653: sumário do store
  couponUsage: CouponUsageReport | null = null, // #2718: tab de cupons Stripe (PII-gated)
): string {
  const rows = campaigns
    .map((c) => {
      // #1141: prioriza globalStats (com Apple MPP, bate com Brevo Web UI).
      // Fallback pra campaignStats[0] se globalStats fetch falhou OU veio
      // zeroed (o listing retorna globalStats com todos os campos = 0 —
      // verificado 2026-05-12. fetchRecentCampaigns filtra esse caso, mas
      // o render é defensive-in-depth: trata sent=0 como "stats indisponível").
      const gs = c.statistics?.globalStats;
      const cs = c.statistics?.campaignStats?.[0];
      const gsIsReal = gs && gs.sent > 0;
      const s = gsIsReal ? gs : cs;
      // #2199.5: hoist canonical linksStats to single variable (one source of truth).
      // c.statistics?.linksStats is canonical (set by fetchRecentCampaigns #2199.3).
      // c.linksStats fallback preserved for backward compat (tests/mocks that pass top-level).
      const linksStats = c.statistics?.linksStats ?? c.linksStats;
      if (!s) {
        // #2198 Bug 1: passa linksStats real mesmo quando stats ausente, evitando
        // "dados não disponíveis" para campanha que tem linksStats mas não globalStats/campaignStats.
        const linksHtmlNoStats = renderLinksSection(c.id, linksStats);
        return `<tr><td>${c.id}</td><td>${escHtml(c.listName ?? "?")}</td><td>${fmtTimeBRT(c.sentDate)}</td><td>—</td><td colspan="7" style="color:${DS.ink};opacity:0.6;font-style:italic;">sem stats</td></tr>
      <tr class="links-row"><td colspan="11" class="links-cell">${linksHtmlNoStats}</td></tr>`;
      }
      const openRate = pct(s.uniqueViews, s.delivered);
      const ctr = pct(s.uniqueClicks, s.delivered);
      const bounceRate = pct(s.hardBounces + s.softBounces, s.sent);
      // Per circuit breakers doc 2026-05-12: unsub e spam sobre `sent`
      // (não `delivered`). Pequena diferença na prática (sent ≈ delivered +
      // bounces), mas mantém consistência com a doc operacional.
      const unsubRate = pct(s.unsubscriptions, s.sent);
      const spamRate = pct(s.complaints, s.sent);

      // Numeric versions pra comparar contra thresholds dos circuit breakers
      // (CLAUDE.md: doc operacional 2026-05-12). Alerta visual quando crossado.
      const openRateNum = s.delivered > 0 ? (s.uniqueViews / s.delivered) * 100 : 0;
      const bounceRateNum = s.sent > 0 ? ((s.hardBounces + s.softBounces) / s.sent) * 100 : 0;
      const unsubRateNum = s.sent > 0 ? (s.unsubscriptions / s.sent) * 100 : 0;
      const spamRateNum = s.sent > 0 ? (s.complaints / s.sent) * 100 : 0;
      // Thresholds dos circuit breakers.
      // openAlert exige `openRateNum > 0` pra não acionar quando o dado ainda
      // tá propagando (campanha recém-enviada, opens ainda chegando — Brevo
      // tipicamente registra MPP nos primeiros minutos). Trade-off: campanha
      // genuinamente com 0% engajamento permanente NÃO alerta. Em prática raro
      // (Brevo sempre tem MPP). Se virar problema, condicionar a `delivered >= 50`.
      const openAlert = openRateNum > 0 && openRateNum < 15;
      const bounceAlert = bounceRateNum >= 3;
      const unsubAlert = unsubRateNum >= 3;
      const spamAlert = spamRateNum >= 0.1;
      const mppOpens = gsIsReal ? (gs?.appleMppOpens ?? 0) : 0;
      const opensNoMpp = s.uniqueViews - mppOpens;
      const openRateNoMpp = pct(opensNoMpp, s.delivered);

      // Opens cell tem layout duplo quando há MPP (#1153): top mostra
      // "taxa-com-MPP (taxa-sem-MPP)" e bottom mostra "count-total (count-sem-MPP)".
      // Sem MPP: layout simples (taxa única + count único).
      const opensTopLine = mppOpens > 0
        ? `${openRate} <span class="rate-inline">(${openRateNoMpp})</span>`
        : openRate;
      const opensBottomLine = mppOpens > 0
        ? `${s.uniqueViews} (${opensNoMpp})`
        : `${s.uniqueViews}`;

      // #2086 B2: trackableViewsRate = trackableViews / delivered
      // Indica emails com rastreamento real (exclui MPP/bots que não carregam pixel).
      // ?? 0 defensivo: campo pode estar ausente no shape real da Brevo (latente em campaignStats).
      const trackableRate = pct(s.trackableViews ?? 0, s.delivered);

      // #1132/dashboard: strip parênteses do nome da lista pra display
      // (Brevo nomes têm "(150 contatos)" hardcoded). O size real vem do
      // `totalSubscribers` da API, mais fiel + atualizado.
      const cleanListName = (c.listName ?? "?").replace(/\s*\([^)]*\)\s*/g, "").trim();
      // #2177: links section colapsável por campanha
      const linksHtml = renderLinksSection(
        c.id,
        linksStats,
        s.uniqueClicks,
      );
      return `<tr>
        <td>${c.id}</td>
        <td><strong>${escHtml(cleanListName)}</strong></td>
        <td>${fmtTimeBRT(c.sentDate)}<br><small>${hoursSince(c.sentDate)} atrás</small></td>
        <td>${s.sent}</td>
        <td>${pct(s.delivered, s.sent)}<br><small>${s.delivered}</small></td>
        <td${cellClass("metric", openAlert && "alert")}>${opensTopLine}<br><small>${opensBottomLine}</small></td>
        <td class="metric trackable">${trackableRate}<br><small>${s.trackableViews ?? 0}</small></td>
        <td${cellClass("metric")}>${ctr}<br><small>${s.uniqueClicks}</small></td>
        <td${cellClass(bounceAlert && "alert")}>${bounceRate}<br><small>${s.hardBounces + s.softBounces}</small></td>
        <td${cellClass(unsubAlert && "alert")}>${unsubRate}<br><small>${s.unsubscriptions}</small></td>
        <td${cellClass(spamAlert && "alert")}>${spamRate}<br><small>${s.complaints}</small></td>
      </tr>
      <tr class="links-row"><td colspan="11" class="links-cell">${linksHtml}</td></tr>`;
    })
    .join("\n");

  const now = new Date().toLocaleString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  // #2086 Fase 2: seções adicionais
  const activeCycle = detectActiveCycle(campaigns);
  const cumSent = activeCycle ? calcCumulativeSent(campaigns, activeCycle) : 0;
  const volumeSection = activeCycle ? renderVolumeSection(cumSent) : "";
  // #2600: restaura Resumo A/B/C como seção principal (revertendo #2492 que havia substituído).
  // D1–D5 mantido como seção SEPARADA logo após.
  const abcRows = activeCycle ? aggregateAbcSummary(campaigns, activeCycle) : [];
  const abcSection = activeCycle ? renderAbcSection(abcRows) : "";
  // #2736: "Resumo D1–D5 — S1" removida da aba Engajamento (ruído, decisão do
  // editor). renderDaySummarySection/aggregateDaySummary permanecem exportadas
  // e testadas (reuso futuro), só não são mais chamadas aqui.
  // #2134: tabela de open rate por dia da semana (ciclo ativo).
  // Escopo: ciclo ativo quando detectado; fallback "todas as campanhas" quando
  // não há campanha Clarice News (activeCycle=null). Linha all-time separada
  // não implementada — custo de render zero pois os dados já estão em memória,
  // mas optamos por manter UI simples: 1 tabela por view. Revisitar se editor
  // pedir comparação cross-ciclo explícita.
  const weekdayScopeLabel = "todos os envios"; // #2134 follow-up: editor pediu histórico completo, não só o ciclo ativo
  const weekdayNow = new Date(); // #2611: injetável nos testes via parâmetro; produção usa Date atual
  const { rows: weekdayRows, excluded: weekdayExcluded } = aggregateByWeekday(campaigns, null, weekdayNow);
  const weekdaySection = weekdayRows.length > 0 || weekdayExcluded.length > 0
    ? renderWeekdaySection(weekdayRows, weekdayScopeLabel, weekdayExcluded)
    : "";
  // #2212: seção de links agregados do período
  // #2421: título inclui label da edição (cycle-sendMonth) quando detectável.
  const aggregatedLinks = aggregateLinksAcrossCampaigns(campaigns);
  const edicaoLabel = deriveLinksSectionTitle(campaigns);
  const aggregatedLinksSection = renderAggregatedLinksSection(aggregatedLinks, edicaoLabel);
  // #2251: seção de campanhas agendadas (status queued) — só sobre `scheduled`,
  // nunca polui os agregadores de enviadas (A/B/C, volume, weekday).
  const scheduledSection = renderScheduledSection(scheduled);
  // #2369: tabela de totais por mês — à parte da lista detalhada de campanhas.
  const monthlyTotalsRows = aggregateByMonth(campaigns);
  const monthlyTotalsSection = renderMonthlyTotalsSection(monthlyTotalsRows);
  // #2426: coortes de engajamento por contato (pré-computadas via KV, lidas na rota).
  const cohortsSection = renderEngagementCohortsSection(cohorts);
  // #2736: "Status MillionVerifier por grupo" removida da aba Engajamento
  // (ruído, decisão do editor). renderMvStatusSection permanece exportada e
  // testada (reuso futuro); a leitura do KV mv:status em readKvTabs também
  // fica (custo desprezível, já paralela às outras — reverter é maior cirurgia
  // do que o pedido pede; ver corpo do PR).
  // #2653: sumário do store único de contatos (pré-computado via KV).
  const contactsSummarySection = renderContactsSummarySection(contactsSummary);
  // #2718: tab de cupons Stripe (apenas quando couponUsage não é null — PII-gated).
  const couponTabHtml = couponUsage ? renderCouponTabPanel(couponUsage) : "";

  // #2084: CSS usa tokens do DS (DS.*/DSF.*). Vars --muted e --rule-header
  // são derivadas do DS: --muted = ink com opacity 55% (ferramenta interna,
  // sem token canônico de cinza — DS só tem ink; usamos inline hex aproximado
  // #666 → substituído por DS.ink para uniformidade, com opacity via class).
  // --rule-header = DS.rule (bege #EBE5D0); --rule de linhas = DS.rule.
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Clarice News Dashboard</title>
<style>
  :root {
    --brand: ${DS.brand};
    --ink: ${DS.ink};
    --paper: ${DS.paper};
    --paper-alt: ${DS.paperAlt};
    --rule: ${DS.rule};
    --alert: ${DS.alert};
  }
  body { font-family: ${DSF.sans}; max-width: 1200px; margin: 30px auto; padding: 0 20px; background: var(--paper); color: var(--ink); }
  h1 { font-size: 1.6rem; margin: 0 0 4px 0; color: var(--ink); }
  .sub { color: var(--ink); opacity: 0.6; font-size: 0.9rem; margin: 0 0 24px 0; }
  .table-wrap { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
  th, td { padding: 8px; border-bottom: 1px solid var(--rule); text-align: left; vertical-align: top; }
  th { background: var(--paper-alt); font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.5px; color: var(--ink); position: sticky; top: 0; cursor: help; border-bottom: 2px solid rgba(23,20,17,0.18); }
  /* #2104: borda do th era --rule (#EBE5D0) sobre fundo --paper-alt (#EBE5D0) → invisível.
     Substituída por ink (#171411) com 18% opacity — visível no DS claro sem ser pesada. */
  td.metric { font-weight: 600; color: var(--brand); }
  td.trackable { font-size: 0.85em; opacity: 0.85; }
  td.alert { font-weight: 600; color: var(--alert); }
  td.alert small, td.alert .rate-inline { color: var(--alert); opacity: 1; }
  .alert-label { font-weight: 600; color: var(--alert); }
  td .rate-inline { font-weight: normal; color: var(--ink); }
  td small { color: var(--ink); opacity: 0.6; font-weight: normal; }
  .footer { color: var(--ink); opacity: 0.6; font-size: 0.75rem; margin-top: 24px; text-align: center; }
  .footer code { background: var(--paper-alt); padding: 1px 5px; border-radius: 3px; font-size: 0.95em; }
  /* #2086: seções de fase 2 */
  .phase2-section { margin: 32px 0 8px 0; }
  .section-title { font-size: 1.1rem; font-weight: 700; margin: 0 0 6px 0; color: var(--ink); border-bottom: 2px solid var(--rule); padding-bottom: 6px; }
  .section-note { font-size: 0.85rem; color: var(--ink); opacity: 0.75; margin: 0 0 12px 0; }
  .volume-note { font-size: 0.95rem; margin-top: 10px; } /* número no font do DS; só a spark-bar é monospace */
  .spark-bar { display: block; font-family: monospace; font-size: 0.8rem; line-height: 1.2; letter-spacing: -1px; color: var(--brand); margin-top: 4px; overflow: hidden; white-space: nowrap; }
  td.spark { font-family: monospace; letter-spacing: -1px; color: var(--brand); font-size: 0.8rem; white-space: nowrap; }
  /* #2177: CTR por link */
  tr.links-row td.links-cell { padding: 0; border-bottom: 2px solid var(--rule); background: var(--paper); }
  details.links-ctr { margin: 0; }
  summary.links-summary { padding: 5px 8px; font-size: 0.8rem; cursor: pointer; color: var(--ink); opacity: 0.75; user-select: none; list-style: none; }
  summary.links-summary::-webkit-details-marker { display: none; }
  summary.links-summary::before { content: "▶ "; font-size: 0.65rem; }
  details[open] > summary.links-summary::before { content: "▼ "; }
  .links-count-badge { background: var(--paper-alt); border-radius: 8px; padding: 1px 6px; font-size: 0.75rem; margin-left: 4px; }
  .links-empty { padding: 4px 12px 6px; font-size: 0.8rem; color: var(--ink); opacity: 0.5; margin: 0; }
  .links-table-wrap { overflow-x: auto; padding: 0 8px 8px; }
  .links-table { width: 100%; border-collapse: collapse; font-size: 0.82rem; }
  .links-table th, .links-table td { padding: 4px 6px; border-bottom: 1px solid var(--rule); text-align: left; vertical-align: top; }
  .links-table th { font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.4px; background: transparent; color: var(--ink); opacity: 0.7; }
  .links-table td.link-url { max-width: 420px; word-break: break-all; }
  .links-table td.link-url a { color: var(--brand); text-decoration: none; }
  .links-table td.link-url a:hover { text-decoration: underline; }
  .links-table td.link-clicks { font-weight: 600; color: var(--brand); }
  .links-table td.link-pct { opacity: 0.75; }
  .links-note { font-size: 0.72rem; color: var(--ink); opacity: 0.5; padding: 2px 12px 6px; margin: 0; }
  /* #2758: lista de pagamentos individuais na célula "Pagamentos" (detalhe por assinatura) */
  .payments-list { margin: 4px 0 6px; padding-left: 20px; font-size: 0.8rem; }
  .payments-list li { padding: 1px 0; }
  /* #2758: .links-ctr dentro de uma <td> normal (não numa <tr>/<td> full-bleed
     como o "Links clicados") — a <td> já tem padding próprio, então zeramos o
     do summary pra não dobrar o espaçamento. */
  details.payments-cell summary.links-summary { padding: 0; }
  /* #2758: separador entre os blocos de mês empilhados (sem tabela ao redor
     pra dar borda, diferente do "Resumo por cupom" removido). */
  details.coupon-month { border-bottom: 1px solid var(--rule); }
  details.coupon-month summary.links-summary { padding: 8px; }
  /* #2542: tab navigation — CSS-only via radio+label+:checked (sem JS externo) */
  /* Radios visualmente ocultos mas FOCÁVEIS via teclado (não display:none, que os
     removeria da ordem de tabulação — Tab/setas precisam alcançar as abas). */
  .tab-radios { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
  .tab-bar { display: flex; gap: 4px; margin: 16px 0 0 0; border-bottom: 2px solid var(--rule); padding-bottom: 0; }
  .tab-label {
    display: inline-block; padding: 8px 18px; font-size: 0.85rem; font-weight: 600;
    cursor: pointer; border: 1px solid transparent; border-bottom: 2px solid transparent;
    border-radius: 4px 4px 0 0; color: var(--ink); opacity: 0.65;
    margin-bottom: -2px; user-select: none;
    transition: opacity 0.1s;
  }
  .tab-label:hover { opacity: 1; background: var(--paper-alt); }
  #tab-visaogeral:checked ~ .tab-bar label[for="tab-visaogeral"],
  #tab-engajamento:checked ~ .tab-bar label[for="tab-engajamento"],
  #tab-links:checked ~ .tab-bar label[for="tab-links"],
  #tab-contatos:checked ~ .tab-bar label[for="tab-contatos"],
  #tab-cupons:checked ~ .tab-bar label[for="tab-cupons"] {
    background: var(--paper); border-color: var(--rule); opacity: 1;
    color: var(--brand); border-bottom-color: var(--paper);
  }
  /* Foco de teclado: o radio focado projeta um contorno no seu label irmão. */
  #tab-visaogeral:focus-visible ~ .tab-bar label[for="tab-visaogeral"],
  #tab-engajamento:focus-visible ~ .tab-bar label[for="tab-engajamento"],
  #tab-links:focus-visible ~ .tab-bar label[for="tab-links"],
  #tab-contatos:focus-visible ~ .tab-bar label[for="tab-contatos"],
  #tab-cupons:focus-visible ~ .tab-bar label[for="tab-cupons"] {
    outline: 2px solid var(--brand); outline-offset: 2px; opacity: 1;
  }
  .tab-panel { display: none; padding-top: 8px; }
  #tab-visaogeral:checked ~ .tab-panels #panel-visaogeral,
  #tab-engajamento:checked ~ .tab-panels #panel-engajamento,
  #tab-links:checked ~ .tab-panels #panel-links,
  #tab-contatos:checked ~ .tab-panels #panel-contatos,
  #tab-cupons:checked ~ .tab-panels #panel-cupons { display: block; }
  @media (max-width: 700px) {
    body { margin: 16px auto; padding: 0 12px; }
    table { font-size: 0.8rem; }
    th, td { padding: 6px 4px; }
    .tab-label { padding: 6px 10px; font-size: 0.8rem; }
  }
</style>
</head>
<body>
<h1>📧 Clarice News Dashboard</h1>
<p class="sub">Últimas ${campaigns.length} campaigns. Dados em tempo real — carregado às ${now} BRT.</p>

<!-- #2542: tab state inputs (hidden, CSS-only — sem JS externo) -->
<input type="radio" class="tab-radios" name="dash-tab" id="tab-visaogeral" checked>
<input type="radio" class="tab-radios" name="dash-tab" id="tab-engajamento">
<input type="radio" class="tab-radios" name="dash-tab" id="tab-links">
<input type="radio" class="tab-radios" name="dash-tab" id="tab-contatos">
${couponUsage ? '<input type="radio" class="tab-radios" name="dash-tab" id="tab-cupons">' : ''}

<!-- tab bar (labels referencing the radio inputs above; aria-controls liga aba↔painel) -->
<div class="tab-bar" role="tablist">
  <label class="tab-label" id="tablabel-visaogeral" for="tab-visaogeral" role="tab" aria-controls="panel-visaogeral">Visão geral</label>
  <label class="tab-label" id="tablabel-engajamento" for="tab-engajamento" role="tab" aria-controls="panel-engajamento">Engajamento</label>
  <label class="tab-label" id="tablabel-links" for="tab-links" role="tab" aria-controls="panel-links">Links / CTR</label>
  <label class="tab-label" id="tablabel-contatos" for="tab-contatos" role="tab" aria-controls="panel-contatos">Contatos</label>
  ${couponUsage ? '<label class="tab-label" id="tablabel-cupons" for="tab-cupons" role="tab" aria-controls="panel-cupons">Cupons</label>' : ''}
</div>

<!-- tab panels -->
<div class="tab-panels">

  <!-- Aba 1: Visão geral — totais mensais + volume + agendados + envios -->
  <div class="tab-panel" id="panel-visaogeral" role="tabpanel" aria-labelledby="tablabel-visaogeral">
${monthlyTotalsSection}
${volumeSection}
${scheduledSection}
<section class="phase2-section" id="campaigns-table">
  <h2 class="section-title">Envios</h2>
<div class="table-wrap">
<table id="envios-table">
<thead>
<tr>
<th title="ID do envio no Brevo.">ID</th>
<th title="Lista de destinatários no Brevo.">Lista</th>
<th title="Data e hora do envio (horário de Brasília).">Enviado</th>
<th title="${escHtml(ENVIOS_TOOLTIP)}">E-mails (eventos)</th>
<th title="Emails entregues nas caixas dos leitores.">Delivered</th>
<th title="Aberturas únicas. Inclui Apple MPP e bots/proxies. Bench: 15-25% B2C, 30-45% engajadas.">Opens 👁️</th>
<th title="trackableViews ÷ delivered: aperturas com pixel rastreável (exclui MPP/bots que não disparam pixel). Sinal mais limpo de engajamento real.">Trackable 📍</th>
<th title="Cliques únicos. Bench: 1.5-3% B2C.">Clicks 🖱️</th>
<th title="Hard bounces (inválido) + soft bounces (caixa cheia). Bench: <2% saudável. ≥3% pausa o ramp.">Bounces</th>
<th title="Descadastros. Esperado em baixo volume. Bench: <0.5%. ≥3% pausa o ramp.">Unsub</th>
<th title="Marcações de spam. Prejudica reputação do domínio. Bench: <0.1%. ≥0.1% pausa o ramp.">Spam</th>
</tr>
</thead>
<tbody id="envios-tbody">
${rows || `<tr><td colspan="11" style="text-align:center;color:${DS.ink};opacity:0.6;padding:24px;">Nenhuma campaign encontrada.</td></tr>`}
</tbody>
</table>
</div>
<div id="envios-pagination" style="display:none;margin-top:12px;align-items:center;gap:12px;font-size:0.85rem;color:var(--ink);">
  <button id="envios-prev" aria-label="Página anterior" disabled
    style="padding:4px 12px;border:1px solid var(--rule);border-radius:4px;background:var(--paper-alt);color:var(--ink);cursor:pointer;">‹ Anterior</button>
  <span id="envios-page-info" style="opacity:0.75;"></span>
  <button id="envios-next" aria-label="Próxima página"
    style="padding:4px 12px;border:1px solid var(--rule);border-radius:4px;background:var(--paper-alt);color:var(--ink);cursor:pointer;">Próxima ›</button>
</div>
<script>
(function() {
  var PER_PAGE = 10;
  var tbody = document.getElementById('envios-tbody');
  var pagination = document.getElementById('envios-pagination');
  var prevBtn = document.getElementById('envios-prev');
  var nextBtn = document.getElementById('envios-next');
  var pageInfo = document.getElementById('envios-page-info');
  if (!tbody || !pagination || !prevBtn || !nextBtn || !pageInfo) return;

  // Collect data rows only (exclude .links-row accordion TRs — each data row is
  // paired with an immediately-following .links-row sibling that must travel with it).
  var allRows = Array.prototype.filter.call(tbody.children, function(el) {
    return el.tagName === 'TR' && !el.classList.contains('links-row');
  });
  var totalRows = allRows.length;
  var totalPages = Math.max(1, Math.ceil(totalRows / PER_PAGE));

  if (totalRows <= PER_PAGE) {
    pagination.style.display = 'none';
    return; // hide controls — ≤ PER_PAGE campaigns
  }

  pagination.style.display = 'flex';
  var currentPage = 1;

  function showPage(page) {
    currentPage = page;
    var start = (page - 1) * PER_PAGE;
    var end = start + PER_PAGE;
    for (var i = 0; i < allRows.length; i++) {
      var visible = (i >= start && i < end);
      allRows[i].style.display = visible ? '' : 'none';
      // Also show/hide the paired .links-row sibling that follows each data row.
      var next = allRows[i].nextElementSibling;
      if (next && next.classList.contains('links-row')) {
        next.style.display = visible ? '' : 'none';
      }
    }
    pageInfo.textContent = 'Página ' + page + ' de ' + totalPages;
    prevBtn.disabled = page <= 1;
    prevBtn.setAttribute('aria-disabled', page <= 1 ? 'true' : 'false');
    nextBtn.disabled = page >= totalPages;
    nextBtn.setAttribute('aria-disabled', page >= totalPages ? 'true' : 'false');
  }

  prevBtn.addEventListener('click', function() { if (currentPage > 1) showPage(currentPage - 1); });
  nextBtn.addEventListener('click', function() { if (currentPage < totalPages) showPage(currentPage + 1); });

  showPage(1);
})();
</script>
</section>
  </div><!-- /panel-visaogeral -->

  <!-- Aba 2: Engajamento — coortes + weekday + resumo A/B/C + D1-D5 -->
  <div class="tab-panel" id="panel-engajamento" role="tabpanel" aria-labelledby="tablabel-engajamento">
${cohortsSection}
${weekdaySection}
${abcSection}
  </div><!-- /panel-engajamento -->

  <!-- Aba 3: Links / CTR — links agregados do período -->
  <div class="tab-panel" id="panel-links" role="tabpanel" aria-labelledby="tablabel-links">
${aggregatedLinksSection}
  </div><!-- /panel-links -->

  <!-- Aba 4: Contatos — sumário do store único (#2653) -->
  <div class="tab-panel" id="panel-contatos" role="tabpanel" aria-labelledby="tablabel-contatos">
${contactsSummarySection}
  </div><!-- /panel-contatos -->

${couponUsage ? `  <!-- Aba 5: Cupons — uso de cupons Stripe (#2718, PII-gated) -->
  <div class="tab-panel" id="panel-cupons" role="tabpanel" aria-labelledby="tablabel-cupons">
${couponTabHtml}
  </div><!-- /panel-cupons -->` : ''}

</div><!-- /tab-panels -->

<p class="footer">Dados com cache de até 5 min — <a href="?fresh=1" style="color:var(--brand)">?fresh=1</a> força atualização imediata.<br>
Open rate e CTR calculados sobre <em>delivered</em>; bounce, unsub e spam sobre <em>sent</em>. Em cada coluna de métrica, a linha de cima é a taxa e a linha de baixo é o count absoluto. Passe o mouse nos headers pra ver detalhes de cada coluna.<br>
Em Opens, a taxa à esquerda é o total (com Apple MPP e bots, como na Brevo Web UI); entre parênteses, a taxa sem Apple MPP (ainda pode incluir outros bots). Coluna Trackable 📍 mostra aberturas com pixel real (trackableViews ÷ delivered). Dados brutos em <code>/api/campaigns</code>.<br>
Cells em <span class="alert-label">vermelho</span> indicam que a métrica cruzou o threshold de circuit breaker (open <15%, bounce ≥3%, unsub ≥3%, spam ≥0.1%).</p>
<script>
/* #2622: progressive enhancement — deep-link (hash<->aba) + aria-selected. Sem JS, o CSS-only puro segue funcionando. */
(function () {
  var radios = Array.prototype.slice.call(document.querySelectorAll('.tab-radios'));
  if (!radios.length) return;
  var labels = Array.prototype.slice.call(document.querySelectorAll('.tab-label'));
  function panelOf(radio) {
    var lbl = document.querySelector('.tab-label[for="' + radio.id + '"]');
    return lbl ? lbl.getAttribute('aria-controls') : null;
  }
  function syncAria() {
    labels.forEach(function (lbl) {
      var r = document.getElementById(lbl.getAttribute('for'));
      lbl.setAttribute('aria-selected', r && r.checked ? 'true' : 'false');
    });
  }
  function applyHash() {
    var h = (location.hash || '').replace(/^#/, '');
    if (!h) return;
    var matched = radios.filter(function (r) { return r.id === h || panelOf(r) === h; })[0];
    if (matched) matched.checked = true;
  }
  radios.forEach(function (r) {
    r.addEventListener('change', function () {
      if (!r.checked) return;
      var pid = panelOf(r);
      if (pid && history.replaceState) history.replaceState(null, '', '#' + pid);
      syncAria();
    });
  });
  window.addEventListener('hashchange', function () { applyHash(); syncAria(); });
  applyHash();
  syncAria();
})();
</script>
</body>
</html>`;
}

function escHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ─── #2086 Fase 2: helpers de agregação ──────────────────────────────────────

/**
 * Volume total do plano S1/ciclo 2605-06 conforme clarice-build-edition-sends.ts.
 * S1 = d01–d07 A/B/C = 5.600. Total S1+S2+S3 = 40.000.
 * Exportado pra teste unitário.
 */
export const CLARICE_PLAN_TOTAL = 40_000;
export const CLARICE_PLAN_S1 = 5_600;

/**
 * Tooltip compartilhado para a coluna "Envios (eventos)" — usado na tabela
 * por-campanha, na tabela mensal e na seção Volume. DRY: alterar aqui propaga
 * para todos os pontos de uso. (#2429 self-review)
 */
export const ENVIOS_TOOLTIP =
  "Eventos de envio acumulados; uma pessoa em N campanhas conta N vezes; inclui bounces.";

/**
 * Extrai o ciclo e o número do dia de uma campanha Clarice News.
 * ex: "Clarice News 2605 d02-C (qui)" → { cycle: "2605", dayNum: 2, cell: "C" }
 * ex: "Clarice News 2605 d08 (qua)"  → { cycle: "2605", dayNum: 8, cell: null }
 * Retorna null para campanhas que não seguem o padrão.
 *
 * #2360: sufixo de célula (-A/-B/-C) é OPCIONAL. Envios únicos (sem A/B/C) têm
 * cell: null e são incluídos em calcCumulativeSent / detectActiveCycle. Não
 * participam do resumo A/B/C (aggregateAbcSummary filtra cell === null).
 */
export function parseClariceCampaignKey(campaignName: string): {
  cycle: string;
  dayNum: number;
  cell: "A" | "B" | "C" | null;
} | null {
  const m = campaignName.match(/Clarice News (\d{4}) d(\d{2})(?:-([ABC]))?(?=\s|$)/i);
  if (!m) return null;
  const cell = m[3] ? (m[3].toUpperCase() as "A" | "B" | "C") : null;
  return { cycle: m[1], dayNum: parseInt(m[2], 10), cell };
}

/**
 * #2254: fonte única da escolha de stats reais de uma campanha — globalStats
 * (primário, bate com a UI da Brevo) quando `sent > 0`, senão campaignStats[0].
 * Centraliza o padrão `gsIsReal ? gs : cs` que estava duplicado em vários lugares
 * (renderDashboardHtml, aggregateByWeekday, calcCumulativeSent, aggregateAbcSummary). Retorna `null` quando não há stats reais (sent>0).
 * `!(... .sent > 0)` cobre sent=0, undefined e null sem NaN.
 *
 * #2258 (semântica de MPP, verificada empiricamente 2026-06-14 contra a API
 * Brevo): TANTO `globalStats.uniqueViews` QUANTO `campaignStats.uniqueViews`
 * INCLUEM Apple MPP opens (cs.uv ≈ gs.uv, ~levemente menor por lag de snapshot;
 * NÃO é gs.uv − appleMppOpens). Logo `uniqueViews` é uma base homogênea
 * (MPP-inclusiva) entre as duas fontes — usar direto é consistente. O orgânico
 * (sem MPP) só é computável de globalStats, que expõe `appleMppOpens`; por isso
 * `isGlobal` é retornado: quem quiser orgânico subtrai SÓ quando isGlobal.
 */
export function pickStats(
  c: BrevoCampaign,
): { stats: BrevoGlobalStats | BrevoCampaignStats; isGlobal: boolean } | null {
  const gs = c.statistics?.globalStats;
  if (gs && gs.sent > 0) return { stats: gs, isGlobal: true };
  const cs = c.statistics?.campaignStats?.[0];
  if (cs && cs.sent > 0) return { stats: cs, isGlobal: false };
  return null;
}

export interface CellSummary {
  cell: "A" | "B" | "C";
  /** Soma de uniqueViews (MPP-inclusivo) das campanhas da célula */
  totalViews: number;
  /** Soma de delivered das campanhas da célula */
  totalDelivered: number;
  /** Open rate agregado MPP-inclusivo (totalViews / totalDelivered) — base do LÍDER */
  openRate: number;
  /** Número de campanhas contabilizadas (dias enviados) */
  campaignCount: number;
  /**
   * #2257: open rate ORGÂNICO (sem Apple MPP), secundário. `null` quando algum
   * dia da célula caiu no fallback campaignStats (sem `appleMppOpens` → orgânico
   * não computável e não-comparável). Só preenchido quando TODOS os dias têm
   * globalStats (mesma base entre as células).
   */
  organicOpenRate: number | null;
}

/**
 * Agrega resumo A/B/C das campanhas S1 (d01–d07) de um ciclo Clarice.
 * Usa apenas campanhas com status "sent" e stats reais (gs.sent > 0).
 * Exportado pra teste unitário.
 */
export function aggregateAbcSummary(
  campaigns: Array<BrevoCampaign & { listName?: string; listSize?: number }>,
  cycle: string,
): CellSummary[] {
  const cells: Record<
    "A" | "B" | "C",
    { views: number; delivered: number; count: number; organicViews: number; organicDays: number }
  > = {
    A: { views: 0, delivered: 0, count: 0, organicViews: 0, organicDays: 0 },
    B: { views: 0, delivered: 0, count: 0, organicViews: 0, organicDays: 0 },
    C: { views: 0, delivered: 0, count: 0, organicViews: 0, organicDays: 0 },
  };

  for (const c of campaigns) {
    const parsed = parseClariceCampaignKey(c.name);
    if (!parsed || parsed.cycle !== cycle) continue;
    // #2360: cell=null = envio único (sem sufixo A/B/C) — não participa do A/B/C.
    if (parsed.cell === null) continue;
    // S1 = d01–d07
    if (parsed.dayNum > 7) continue;

    // #2254: escolha de fonte centralizada. #2252: fallback p/ campaignStats
    // quando globalStats 429/zerado — sem ele a seção A/B/C INTEIRA sumia.
    const picked = pickStats(c);
    if (!picked) continue;
    const { stats: s, isGlobal } = picked;

    // #2258: base canônica = uniqueViews (MPP-INCLUSIVO). campaignStats.uniqueViews
    // TAMBÉM inclui MPP (verificado 2026-06-14) → usar direto é homogêneo entre as
    // fontes e bate com a UI da Brevo (#2257). O bug do #2253 era subtrair MPP só
    // do globalStats e não do campaignStats (que não expõe appleMppOpens) → no
    // fallback gerava número "orgânico" que na verdade era MPP-incl → impossível.
    cells[parsed.cell].views += s.uniqueViews ?? 0;
    cells[parsed.cell].delivered += s.delivered ?? 0;
    cells[parsed.cell].count += 1;

    // #2257: orgânico (sem MPP) só de globalStats (tem appleMppOpens). Contamos
    // organicDays p/ saber se TODOS os dias da célula têm orgânico — só então é
    // comparável entre as células (mesma base); senão organicOpenRate = null.
    if (isGlobal) {
      const gs = s as BrevoGlobalStats;
      cells[parsed.cell].organicViews += Math.max(0, (gs.uniqueViews ?? 0) - (gs.appleMppOpens ?? 0));
      cells[parsed.cell].organicDays += 1;
    }
  }

  return (["A", "B", "C"] as const).map((cell) => {
    const d = cells[cell];
    // organicOpenRate só quando TODOS os dias contados têm orgânico (base homogênea).
    const organicComplete = d.count > 0 && d.organicDays === d.count;
    return {
      cell,
      totalViews: d.views,
      totalDelivered: d.delivered,
      openRate: d.delivered > 0 ? (d.views / d.delivered) * 100 : 0,
      campaignCount: d.count,
      organicOpenRate: organicComplete && d.delivered > 0 ? (d.organicViews / d.delivered) * 100 : null,
    };
  });
}

/**
 * Calcula volume enviado cumulativo de campanhas Clarice News de um ciclo.
 * Soma "sent" de todas as campanhas do ciclo (todos os dias, todas as células).
 * Usa globalStats como primário (com Apple MPP, bate com Brevo UI); cai pra
 * campaignStats[0].sent se globalStats fetch falhou — evita subcontagem quando
 * o fetch individual de stats não funcionou pra alguma campanha.
 * Exportado pra teste unitário.
 */
export function calcCumulativeSent(
  campaigns: Array<BrevoCampaign & { listName?: string; listSize?: number }>,
  cycle: string,
): number {
  let total = 0;
  for (const c of campaigns) {
    const parsed = parseClariceCampaignKey(c.name);
    if (!parsed || parsed.cycle !== cycle) continue;
    const picked = pickStats(c); // #2254: fonte única (globalStats → campaignStats)
    if (!picked) continue;
    total += picked.stats.sent ?? 0;
  }
  return total;
}

/**
 * Detecta o ciclo ativo (mais recente) entre campanhas Clarice News.
 * Retorna o cycle string (ex: "2605") ou null se nenhuma encontrada.
 * Exportado pra teste unitário.
 */
export function detectActiveCycle(
  campaigns: Array<BrevoCampaign & { listName?: string; listSize?: number }>,
): string | null {
  let latest: string | null = null;
  for (const c of campaigns) {
    const parsed = parseClariceCampaignKey(c.name);
    if (!parsed) continue;
    if (!latest || parsed.cycle > latest) latest = parsed.cycle;
  }
  return latest;
}

// ─── #2134: tabela de open rate por dia da semana ────────────────────────────

/**
 * Ordem canônica seg→dom (índice 0=seg, 6=dom).
 * Corresponde a `new Date().getDay()` mapeado pra ordem BRT-friendly:
 * JS getDay(): 0=dom, 1=seg, ..., 6=sab.
 * Aqui usamos nossa própria chave 0–6 (seg–dom) — ver weekdayKey().
 */
export const WEEKDAY_LABELS: Record<number, string> = {
  0: "Seg",
  1: "Ter",
  2: "Qua",
  3: "Qui",
  4: "Sex",
  5: "Sáb",
  6: "Dom",
};

export interface WeekdaySummary {
  /** 0=Seg, 1=Ter, 2=Qua, 3=Qui, 4=Sex, 5=Sáb, 6=Dom */
  weekday: number;
  label: string;
  /** Número de campanhas enviadas neste dia */
  count: number;
  delivered: number;
  opens: number;
  /** open rate agregado = opens / delivered (0 quando delivered=0) */
  openRate: number;
  /** true quando count < 2 — amostra insuficiente para conclusão */
  smallSample: boolean;
}

/**
 * Retorna a chave do dia da semana em BRT (0=Seg, 1=Ter, ..., 6=Dom).
 * Converte o ISO string pra BRT antes de extrair o weekday — evita erro
 * de "envio às 21h BRT = dia UTC seguinte" (ex: 22:00 BRT = 01:00 UTC+1dia).
 *
 * Estratégia: usa Intl.DateTimeFormat com timeZone BRT pra extrair o dia
 * numérico (JS weekday: 0=dom..6=sab → mapeado pra nossa escala 0=seg..6=dom).
 */
export function weekdayKeyBRT(iso: string): number | null {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;

  // Extrai partes de data em BRT via formatToParts
  const parts = new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    weekday: "short",
  }).formatToParts(d);

  const weekdayShort = parts.find((p) => p.type === "weekday")?.value ?? "";

  // Mapeia abreviação pt-BR → índice 0=Seg..6=Dom
  // Browsers/Node retornam "seg.", "ter.", "qua.", "qui.", "sex.", "sáb.", "dom."
  // Fazemos lowercase + strip ponto pra normalizar.
  const normalized = weekdayShort.toLowerCase().replace(/\./g, "").trim();
  const map: Record<string, number> = {
    seg: 0, ter: 1, qua: 2, qui: 3, sex: 4, sáb: 5, sab: 5, dom: 6,
  };
  return map[normalized] ?? null;
}

/**
 * Retorna a chave "YYYY-MM" do sentDate em BRT (America/Sao_Paulo).
 * Exportado pra teste unitário.
 *
 * Necessário porque `sentDate.slice(0,7)` usa UTC — campanha enviada
 * 2026-07-01T00:00:00Z (= 30/jun 21:00 BRT) produziria "2026-07" via slice,
 * mas deve ser "2026-06" para ser consistente com fmtTimeBRT / weekdayKeyBRT.
 * (#2402)
 */
export function monthKeyBRT(iso: string): string | null {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(d);
  const year = parts.find((p) => p.type === "year")?.value ?? "";
  const month = parts.find((p) => p.type === "month")?.value ?? "";
  return `${year}-${month}`; // "2026-06"
}

// #2611: envios com menos de 48h têm open rate instável — excluí-los evita conclusões prematuras.
export const WEEKDAY_MIN_AGE_HOURS = 48;

/** Metadado de campanha excluída por <48h (para nota no render). */
export interface WeekdayExcluded {
  name: string;
  sentDate: string;
}

/**
 * Agrega open rate por dia da semana (seg–dom, BRT) para as campanhas do
 * ciclo ativo. Inclui apenas campanhas com stats reais (mesmo fallback do
 * render principal: globalStats primário, campaignStats[0] como fallback, ?? 0
 * defensivo para campos ausentes).
 *
 * #2611: exclui campanhas com sentDate < 48h antes de `now` (open rate instável).
 * `now` é injetável para testes; produção passa `new Date()`.
 *
 * Retorna apenas os weekdays que tiveram ao menos 1 campanha, ordenados seg→dom.
 * Weekdays com count < 2 são marcados com smallSample=true.
 *
 * @param campaigns - lista de campanhas (todas, filtradas internamente por ciclo)
 * @param cycle     - filtro por ciclo (ex: "2605"); produção passa SEMPRE null (todos os envios,
 *                    decisão do editor 2026-06-11) — o filtro vive pra testes/uso futuro
 * @param now       - instante de referência (injetável para testes)
 * @returns { rows: WeekdaySummary[], excluded: WeekdayExcluded[] }
 */
export function aggregateByWeekday(
  campaigns: Array<BrevoCampaign & { listName?: string; listSize?: number }>,
  cycle: string | null,
  now: Date = new Date(),
): { rows: WeekdaySummary[]; excluded: WeekdayExcluded[] } {
  type Acc = { count: number; delivered: number; opens: number };
  const acc: Record<number, Acc> = {};
  const excluded: WeekdayExcluded[] = [];
  const minAgeMs = WEEKDAY_MIN_AGE_HOURS * 3600 * 1000;

  for (const c of campaigns) {
    // Filtro por ciclo ativo (quando passado)
    if (cycle !== null) {
      const parsed = parseClariceCampaignKey(c.name);
      if (!parsed || parsed.cycle !== cycle) continue;
    }

    if (!c.sentDate) continue;

    // #2611: excluir envios com menos de 48h (open rate ainda estabilizando).
    const sentMs = new Date(c.sentDate).getTime();
    if (isNaN(sentMs)) continue;
    if (now.getTime() - sentMs < minAgeMs) {
      excluded.push({ name: c.name, sentDate: c.sentDate });
      continue;
    }

    // #2254: fonte única (globalStats → campaignStats). #2256: uniqueViews é
    // MPP-inclusivo nas DUAS fontes (verificado 2026-06-14) → não há mistura de
    // base; opens aqui são MPP-inclusivos, consistente com a tabela de campanhas.
    const picked = pickStats(c);
    if (!picked) continue;
    const s = picked.stats;

    const wk = weekdayKeyBRT(c.sentDate);
    if (wk === null) continue;

    if (!acc[wk]) acc[wk] = { count: 0, delivered: 0, opens: 0 };
    acc[wk].count += 1;
    acc[wk].delivered += s.delivered ?? 0;
    acc[wk].opens += s.uniqueViews ?? 0;
  }

  // Ordenar seg→dom (chave 0..6) e construir WeekdaySummary
  const rows = Object.keys(acc)
    .map(Number)
    .sort((a, b) => a - b)
    .map((wk) => {
      const d = acc[wk];
      return {
        weekday: wk,
        label: WEEKDAY_LABELS[wk] ?? `Dia ${wk}`,
        count: d.count,
        delivered: d.delivered,
        opens: d.opens,
        openRate: d.delivered > 0 ? (d.opens / d.delivered) * 100 : 0,
        smallSample: d.count < 2,
      };
    });

  return { rows, excluded };
}

/**
 * Renderiza a seção de open rate por dia da semana.
 * Melhor dia destacado com ▲ MELHOR DIA (mesmo padrão visual do LÍDER A/B/C).
 * Empate → mesmo tratamento do #2118/#2124 (nenhuma linha recebe tag).
 * Semana completa seg→dom; dias sem campanha são omitidos.
 * Exportado pra teste unitário.
 */
export function renderWeekdaySection(
  rows: WeekdaySummary[],
  scopeLabel: string,
  excluded: WeekdayExcluded[] = [],
): string {
  if (rows.length === 0 && excluded.length === 0) return "";
  if (rows.length === 0) {
    const excList = excluded.map((e) => escHtml(e.name)).join(", ");
    return `
<section class="phase2-section" id="weekday-openrate">
  <h2 class="section-title">Open rate por dia da semana — ${escHtml(scopeLabel)}</h2>
  <p class="section-note">Envios ainda não computados (open rate &lt; ${WEEKDAY_MIN_AGE_HOURS}h, estabilizando): ${excList}.</p>
</section>`;
  }

  // Calcula melhor dia (max openRate entre rows com count >= 1)
  // Empate: nenhuma linha recebe tag
  const validRows = rows.filter((r) => r.count > 0);
  const maxRate = validRows.reduce((m, r) => Math.max(m, r.openRate), 0);
  const tiedCount = validRows.filter((r) => r.openRate === maxRate).length;
  const isTied = validRows.length >= 2 && tiedCount > 1;
  const winnerWk = !isTied && validRows.length >= 2
    ? (validRows.find((r) => r.openRate === maxRate)?.weekday ?? null)
    : null;

  // #2134 follow-up (editor 2026-06-11): exibir do melhor open rate pro pior.
  const orderedRows = [...rows].sort((a, b) => {
    if (a.count === 0 && b.count === 0) return 0;
    if (a.count === 0) return 1;
    if (b.count === 0) return -1;
    return b.openRate - a.openRate;
  });

  const tableRows = orderedRows
    .map((r) => {
      const isWinner = r.weekday === winnerWk;
      const winnerTag = isWinner ? ` <strong style="color:${DS.brand}">▲ MELHOR DIA</strong>` : "";
      const smallSampleNote = r.smallSample
        ? ` <span style="color:${DS.ink};opacity:0.6;font-size:0.8em;">(amostra pequena)</span>`
        : "";
      const openRateFmt = r.openRate.toFixed(1) + "%";
      return `<tr>
        <td><strong>${escHtml(r.label)}</strong></td>
        <td>${r.count}</td>
        <td>${r.delivered.toLocaleString("pt-BR")}</td>
        <td>${r.opens.toLocaleString("pt-BR")}</td>
        <td class="metric">${openRateFmt}${winnerTag}${smallSampleNote}</td>
      </tr>`;
    })
    .join("\n");

  const allZero = isTied && maxRate === 0;
  const statusNote = allZero
    ? `Aguardando dados de abertura — primeiras horas pós-envio.`
    : isTied
    ? `Empate entre dias com ${maxRate.toFixed(1)}% — aguardar mais dados.`
    : validRows.length < 2
    ? `Dados insuficientes — aguardar mais dias de envio.`
    : winnerWk !== null
    ? `Melhor dia provisório: <strong style="color:${DS.brand}">${WEEKDAY_LABELS[winnerWk]}</strong> — aguardar mais dados para conclusão.`
    : `Dados insuficientes para comparação.`;

  const excludedNote =
    excluded.length > 0
      ? `\n  <p class="section-note"><small>Envios ainda não computados (open rate &lt; ${WEEKDAY_MIN_AGE_HOURS}h, estabilizando): ${excluded.map((e) => escHtml(e.name)).join(", ")}.</small></p>`
      : "";

  return `
<section class="phase2-section" id="weekday-openrate">
  <h2 class="section-title">Open rate por dia da semana — ${escHtml(scopeLabel)}</h2>
  <p class="section-note">${statusNote}</p>${excludedNote}
  <div class="table-wrap">
  <table>
    <thead>
      <tr>
        <th title="Dia da semana do envio (horário de Brasília)">Dia</th>
        <th title="Número de envios realizados neste dia">Envios</th>
        <th title="Total entregue">Delivered</th>
        <th title="Soma de aberturas únicas (uniqueViews) das campanhas enviadas neste dia.">Opens</th>
        <th title="Open rate agregado: opens ÷ delivered. Dias com < 2 campanhas = amostra pequena.">Open rate agr.</th>
      </tr>
    </thead>
    <tbody>${tableRows}</tbody>
  </table>
  </div>
</section>`;
}


/**
 * Renderiza a seção de resumo A/B/C da S1.
 * Exportado pra teste unitário.
 */
export function renderAbcSection(abcRows: CellSummary[]): string {
  if (abcRows.every((r) => r.campaignCount === 0)) return "";

  const sampledRows = abcRows.filter((r) => r.campaignCount > 0);
  const allSampled = sampledRows.length >= 2;

  // Winner: célula com maior open rate entre as que têm dados.
  // Em empate (taxa idêntica), nenhuma célula recebe tag LÍDER — exibir "EMPATE".
  const maxRate = sampledRows.reduce((m, r) => Math.max(m, r.openRate), 0);
  const tiedCount = sampledRows.filter((r) => r.openRate === maxRate).length;
  const isTied = allSampled && tiedCount > 1;
  const winnerCell = !isTied && allSampled
    ? sampledRows.find((r) => r.openRate === maxRate)?.cell ?? null
    : null;

  // #2134 follow-up (editor 2026-06-11): ordenar do melhor open rate pro pior;
  // células sem dados (campaignCount 0) vão pro fim.
  const orderedRows = [...abcRows].sort((a, b) => {
    if (a.campaignCount === 0 && b.campaignCount === 0) return 0;
    if (a.campaignCount === 0) return 1;
    if (b.campaignCount === 0) return -1;
    return b.openRate - a.openRate;
  });

  const cellRows = orderedRows
    .map((r) => {
      const isWinner = r.cell === winnerCell && r.campaignCount > 0;
      const winnerTag = isWinner ? ` <strong style="color:${DS.brand}">▲ LÍDER</strong>` : "";
      // #2257: taxa MPP-inclusiva (primária, bate com a Brevo UI) + orgânica em
      // parênteses quando disponível — mesmo padrão da tabela de campanhas (#1153).
      const organicInline =
        r.campaignCount > 0 && r.organicOpenRate != null
          ? ` <span class="rate-inline">(${r.organicOpenRate.toFixed(1)}% s/ MPP)</span>`
          : "";
      const openRateFmt = r.campaignCount > 0 ? r.openRate.toFixed(1) + "%" : "—";
      return `<tr>
        <td><strong>Célula ${r.cell}</strong></td>
        <td>${r.campaignCount > 0 ? r.totalDelivered : "—"}</td>
        <td>${r.campaignCount > 0 ? r.totalViews : "—"}</td>
        <td class="${r.campaignCount > 0 ? "metric" : ""}">${openRateFmt}${organicInline}${winnerTag}</td>
        <td>${r.campaignCount}</td>
      </tr>`;
    })
    .join("\n");

  // Quando todas as células amostradas têm openRate 0 (primeiras horas pós-envio,
  // antes de qualquer abertura registrada), evitar "Empate...0.0%" — informação enganosa.
  const allZero = isTied && maxRate === 0;
  const statusNote = allZero
    ? `Aguardando dados de abertura — primeiras horas pós-envio.`
    : isTied
    ? `Empate entre células com ${maxRate.toFixed(1)}% — aguardar mais dias de envio.`
    : allSampled && winnerCell
    ? `Vencedor provisório: <strong style="color:${DS.brand}">Célula ${winnerCell}</strong> — aguardar checkpoint de análise para decisão final.`
    : `Dados insuficientes para comparação — aguardar mais dias de envio.`;

  return `
<section class="phase2-section" id="abc-summary">
  <h2 class="section-title">Resumo A/B/C — S1 (d01–d07)</h2>
  <p class="section-note">${statusNote}</p>
  <p class="section-note"><small>Open rate <strong>com Apple MPP</strong> (igual à UI da Brevo) — base do vencedor. Entre parênteses, a taxa <strong>sem MPP</strong> (orgânica), exibida só quando todos os dias da célula têm esse dado.</small></p>
  <div class="table-wrap">
  <table>
    <thead>
      <tr>
        <th title="Célula do teste A/B/C">Célula</th>
        <th title="Soma de entregues dos dias enviados">Delivered (total)</th>
        <th title="Soma de aberturas únicas (com Apple MPP, como na UI da Brevo) dos dias enviados">Opens (total)</th>
        <th title="Open rate agregado com Apple MPP (opens ÷ delivered) — base do vencedor; entre parênteses, a taxa sem MPP quando disponível">Open rate agr.</th>
        <th title="Dias enviados contabilizados">Dias</th>
      </tr>
    </thead>
    <tbody>${cellRows}</tbody>
  </table>
  </div>
</section>`;
}

// ─── #2492: breakdown por dia (D1–D5) ────────────────────────────────────────

/**
 * Resumo de um dia de envio do ciclo Clarice (agrega todas as células A/B/C do dia).
 * Substituição do Resumo A/B/C (por célula) por um breakdown por dia.
 * Exportado pra teste unitário.
 */
export interface DaySummary {
  /** Número do dia (1–5, correspondente a d01–d05 da S1) */
  dayNum: number;
  /** Rótulo legível (ex: "D1") */
  label: string;
  /** Soma de uniqueViews (MPP-inclusivo) das campanhas do dia */
  totalViews: number;
  /** Soma de delivered das campanhas do dia */
  totalDelivered: number;
  /** Open rate agregado MPP-inclusivo (totalViews / totalDelivered) */
  openRate: number;
  /** Número de campanhas contabilizadas (células enviadas neste dia) */
  campaignCount: number;
  /**
   * Open rate ORGÂNICO (sem Apple MPP), secundário. `null` quando alguma
   * campanha do dia caiu no fallback campaignStats (sem `appleMppOpens`).
   * Só preenchido quando TODAS as campanhas do dia têm globalStats.
   */
  organicOpenRate: number | null;
}

/**
 * #2492: agrega resumo D1–D5 das campanhas S1 (d01–d05) de um ciclo Clarice.
 * Cada row representa UM DIA, somando todas as células (A/B/C) daquele dia.
 * Usa apenas campanhas com stats reais (gs.sent > 0 ou cs.sent > 0).
 * Exportado pra teste unitário.
 */
export function aggregateDaySummary(
  campaigns: Array<BrevoCampaign & { listName?: string; listSize?: number }>,
  cycle: string,
): DaySummary[] {
  // D1–D5 = dias 1 a 5 da S1
  const MAX_DAY = 5;
  const days: Record<
    number,
    { views: number; delivered: number; count: number; organicViews: number; organicDays: number }
  > = {};
  for (let d = 1; d <= MAX_DAY; d++) {
    days[d] = { views: 0, delivered: 0, count: 0, organicViews: 0, organicDays: 0 };
  }

  for (const c of campaigns) {
    const parsed = parseClariceCampaignKey(c.name);
    if (!parsed || parsed.cycle !== cycle) continue;
    if (parsed.dayNum < 1 || parsed.dayNum > MAX_DAY) continue;

    const picked = pickStats(c);
    if (!picked) continue;
    const { stats: s, isGlobal } = picked;

    const d = days[parsed.dayNum];
    d.views += s.uniqueViews ?? 0;
    d.delivered += s.delivered ?? 0;
    d.count += 1;

    if (isGlobal) {
      const gs = s as BrevoGlobalStats;
      d.organicViews += Math.max(0, (gs.uniqueViews ?? 0) - (gs.appleMppOpens ?? 0));
      d.organicDays += 1;
    }
  }

  return Array.from({ length: MAX_DAY }, (_, i) => {
    const dayNum = i + 1;
    const d = days[dayNum];
    const organicComplete = d.count > 0 && d.organicDays === d.count;
    return {
      dayNum,
      label: `D${dayNum}`,
      totalViews: d.views,
      totalDelivered: d.delivered,
      openRate: d.delivered > 0 ? (d.views / d.delivered) * 100 : 0,
      campaignCount: d.count,
      organicOpenRate:
        organicComplete && d.delivered > 0 ? (d.organicViews / d.delivered) * 100 : null,
    };
  });
}

/**
 * #2492: renderiza a seção de breakdown D1–D5 (um row por dia de envio da S1,
 * somando todas as células A/B/C). Oculta ("") quando nenhum dia tem dados.
 * Exportado pra teste unitário.
 */
export function renderDaySummarySection(rows: DaySummary[]): string {
  if (rows.every((r) => r.campaignCount === 0)) return "";

  // Melhor dia = maior open rate entre os que têm dados
  const sampledRows = rows.filter((r) => r.campaignCount > 0);
  const maxRate = sampledRows.reduce((m, r) => Math.max(m, r.openRate), 0);
  const tiedCount = sampledRows.filter((r) => r.openRate === maxRate).length;
  const isTied = sampledRows.length >= 2 && tiedCount > 1;
  const winnerDay = !isTied && sampledRows.length >= 2
    ? sampledRows.find((r) => r.openRate === maxRate)?.dayNum ?? null
    : null;

  const allZero = isTied && maxRate === 0;
  const statusNote = allZero
    ? `Aguardando dados de abertura — primeiras horas pós-envio.`
    : isTied
    ? `Empate entre dias com ${maxRate.toFixed(1)}% — aguardar mais dias de envio.`
    : sampledRows.length >= 2 && winnerDay
    ? `Melhor dia provisório: <strong style="color:${DS.brand}">D${winnerDay}</strong> — aguardar conclusão da S1 para decisão final.`
    : `Dados insuficientes para comparação — aguardar mais dias de envio.`;

  const tableRows = rows
    .map((r) => {
      const isWinner = r.dayNum === winnerDay && r.campaignCount > 0;
      const winnerTag = isWinner ? ` <strong style="color:${DS.brand}">▲ LÍDER</strong>` : "";
      const organicInline =
        r.campaignCount > 0 && r.organicOpenRate != null
          ? ` <span class="rate-inline">(${r.organicOpenRate.toFixed(1)}% s/ MPP)</span>`
          : "";
      const openRateFmt = r.campaignCount > 0 ? r.openRate.toFixed(1) + "%" : "—";
      return `<tr>
        <td><strong>${r.label}</strong></td>
        <td>${r.campaignCount > 0 ? r.totalDelivered : "—"}</td>
        <td>${r.campaignCount > 0 ? r.totalViews : "—"}</td>
        <td class="${r.campaignCount > 0 ? "metric" : ""}">${openRateFmt}${organicInline}${winnerTag}</td>
        <td>${r.campaignCount}</td>
      </tr>`;
    })
    .join("\n");

  return `
<section class="phase2-section" id="day-summary">
  <h2 class="section-title">Resumo D1–D5 — S1</h2>
  <p class="section-note">${statusNote}</p>
  <p class="section-note"><small>Open rate <strong>com Apple MPP</strong> (igual à UI da Brevo) — base do vencedor. Entre parênteses, a taxa <strong>sem MPP</strong> (orgânica), exibida só quando todos os envios do dia têm esse dado. Cada linha agrega todas as células (A/B/C) enviadas naquele dia.</small></p>
  <div class="table-wrap">
  <table>
    <thead>
      <tr>
        <th title="Dia da S1 (D1 = d01, D2 = d02, … D5 = d05)">Dia</th>
        <th title="Soma de entregues de todas as células enviadas no dia">Delivered (total)</th>
        <th title="Soma de aberturas únicas (com Apple MPP) de todas as células do dia">Opens (total)</th>
        <th title="Open rate agregado com Apple MPP — entre parênteses, taxa sem MPP quando disponível">Open rate agr.</th>
        <th title="Número de campanhas (células) enviadas neste dia">Campanhas</th>
      </tr>
    </thead>
    <tbody>${tableRows}</tbody>
  </table>
  </div>
</section>`;
}

/**
 * #2251: renderiza a seção "Campanhas agendadas" (status queued), ordenada por
 * horário (próximo envio primeiro). Mostra dia/célula (quando Clarice News),
 * horário BRT, lista e tamanho esperado do envio (snapshot). Oculta (`""`)
 * quando não há agendadas — mesmo contrato graceful das demais seções.
 * Exportado pra teste unitário.
 */
export function renderScheduledSection(
  scheduled: Array<BrevoCampaign & { listName?: string; listSize?: number }>,
): string {
  const withDate = scheduled.filter((c) => c.scheduledAt);
  if (withDate.length === 0) return "";

  // Date.parse de string malformada → NaN; comparador com NaN dá ordem
  // indeterminada. Tratamos NaN como 0 (vai pro início) — ordem determinística.
  const ts = (s: string | null): number => {
    const t = Date.parse(s ?? "");
    return Number.isNaN(t) ? 0 : t;
  };
  const ordered = [...withDate].sort((a, b) => ts(a.scheduledAt) - ts(b.scheduledAt));

  const rows = ordered
    .map((c) => {
      // #2249 follow-up (editor 2026-06-14): colunas Dia e Lista removidas.
      return `<tr>
        <td>${escHtml(c.name)}</td>
        <td>${fmtTimeBRT(c.scheduledAt)}</td>
        <td>${c.listSize != null ? c.listSize.toLocaleString("pt-BR") : "—"}</td>
      </tr>`;
    })
    .join("\n");

  return `
<section class="phase2-section" id="scheduled-campaigns">
  <h2 class="section-title">Envios agendados</h2>
  <p class="section-note">${ordered.length} agendado(s) — próximo envio primeiro. Tamanho = snapshot esperado da lista no envio.</p>
  <div class="table-wrap">
  <table>
    <thead>
      <tr>
        <th title="Nome do envio no Brevo">Envio</th>
        <th title="Horário agendado (horário de Brasília)">Agendado (BRT)</th>
        <th title="Tamanho atual da lista (destinatários esperados)">Tamanho</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
  </div>
</section>`;
}

/**
 * Renderiza a seção de Volume enviado no ciclo — primeira informação do dashboard
 * (decisão do editor 2026-06-11: volume vem ANTES do resumo A/B/C).
 * Exportado pra teste unitário.
 */
export function renderVolumeSection(cumulativeSent: number): string {
  const pctBar = Math.min(100, (cumulativeSent / CLARICE_PLAN_TOTAL) * 100);
  const pctLabel = pctBar.toFixed(1);
  const barFill = Math.round(pctBar * 0.3); // 30 chars = 100%
  const bar = "█".repeat(barFill) + "░".repeat(30 - barFill);
  // #2429: rótulo "E-mails (eventos)" (#2491: renomeado de "Envios (eventos)") deixa explícito
  // que este número conta eventos de envio (uma pessoa em 2 campanhas conta 2 vezes; inclui
  // bounces), não pessoas únicas.
  // Tooltip compartilhado via ENVIOS_TOOLTIP — mesma cópia usada na tabela por-campanha e mensal.
  return `
<section class="phase2-section" id="volume-ciclo">
  <h2 class="section-title">Volume enviado no ciclo</h2>
  <p class="section-note volume-note">
    <strong title="${escHtml(ENVIOS_TOOLTIP)}">${cumulativeSent.toLocaleString("pt-BR")} envios (eventos)</strong> de ${CLARICE_PLAN_TOTAL.toLocaleString("pt-BR")} (${pctLabel}%)<br>
    <span class="spark-bar" title="${pctLabel}% do plano total">${bar}</span>
  </p>
</section>`;
}


// ─── #2369: tabela de totais por mês ─────────────────────────────────────────

/**
 * Linha de totalização mensal de campanhas enviadas.
 * #2442: campos extras para espelhar formato da tabela Envios (Bounces/Unsub/Spam + range de datas).
 */
export interface MonthlyTotalRow {
  /** Mês no formato YYYY-MM (ex: "2026-06") */
  month: string;
  /** Rótulo legível (ex: "Jun/2026") */
  label: string;
  /** Número de campanhas enviadas no mês */
  campaignCount: number;
  /** Soma de enviados (sent) no mês */
  totalSent: number;
  /** Soma de entregues (delivered) no mês */
  totalDelivered: number;
  /** Soma de aberturas únicas (uniqueViews) no mês */
  totalViews: number;
  /** Soma de cliques únicos (uniqueClicks) no mês */
  totalClicks: number;
  /** Open rate agregado = totalViews / totalDelivered (0 quando delivered=0) */
  openRate: number;
  /** CTR agregado = totalClicks / totalDelivered (0 quando delivered=0) */
  ctr: number;
  /** #2442: Soma de hard+soft bounces no mês */
  totalBounces: number;
  /** #2442: Bounce rate agregado = totalBounces / totalSent (0 quando sent=0) */
  bounceRate: number;
  /** #2442: Soma de descadastros no mês */
  totalUnsub: number;
  /** #2442: Unsub rate = totalUnsub / totalSent (0 quando sent=0) */
  unsubRate: number;
  /** #2442: Soma de spam (complaints) no mês */
  totalSpam: number;
  /** #2442: Spam rate = totalSpam / totalSent (0 quando sent=0) */
  spamRate: number;
  /** #2442: ISO string do sentDate mais antigo do mês (1º envio) */
  firstSentDate: string | null;
  /** #2442: ISO string do sentDate mais recente do mês (último envio) */
  lastSentDate: string | null;
}

/**
 * Agrega campanhas por mês de envio (sentDate). Usa as mesmas stats que o
 * render principal (globalStats primário → campaignStats fallback via pickStats).
 * Só inclui campanhas com stats reais (sent > 0). Ordena do mês mais recente
 * para o mais antigo.
 * Exportado pra teste unitário.
 */
export function aggregateByMonth(
  campaigns: Array<BrevoCampaign & { listName?: string; listSize?: number }>,
): MonthlyTotalRow[] {
  type Acc = {
    campaignCount: number;
    totalSent: number;
    totalDelivered: number;
    totalViews: number;
    totalClicks: number;
    // #2442: novos campos para espelhar Envios
    totalBounces: number;
    totalUnsub: number;
    totalSpam: number;
    firstSentDate: string | null;
    lastSentDate: string | null;
  };
  const acc = new Map<string, Acc>();

  for (const c of campaigns) {
    if (!c.sentDate) continue;
    const picked = pickStats(c);
    if (!picked) continue;
    const s = picked.stats;

    // Extrair YYYY-MM em BRT (America/Sao_Paulo), consistente com fmtTimeBRT e
    // weekdayKeyBRT. Campanha enviada 2026-07-01T00:00:00Z = 30/jun 21:00 BRT
    // deve bucketizar em "2026-06", não "2026-07". (#2402)
    // monthKeyBRT retorna null para sentDate malformado — pular a campanha. (#2407)
    const month = monthKeyBRT(c.sentDate);
    if (month === null) continue;
    if (!acc.has(month)) {
      acc.set(month, {
        campaignCount: 0, totalSent: 0, totalDelivered: 0, totalViews: 0, totalClicks: 0,
        totalBounces: 0, totalUnsub: 0, totalSpam: 0,
        firstSentDate: null, lastSentDate: null,
      });
    }
    const row = acc.get(month)!;
    row.campaignCount += 1;
    row.totalSent += s.sent ?? 0;
    row.totalDelivered += s.delivered ?? 0;
    row.totalViews += s.uniqueViews ?? 0;
    row.totalClicks += s.uniqueClicks ?? 0;
    // #2442: bounces, unsub, spam
    row.totalBounces += (s.hardBounces ?? 0) + (s.softBounces ?? 0);
    row.totalUnsub += s.unsubscriptions ?? 0;
    row.totalSpam += s.complaints ?? 0;
    // #2442: rastrear min/max sentDate do mês (1º e último envio).
    // c.sentDate é garantido truthy pelo `if (!c.sentDate) continue` no topo do loop.
    if (row.firstSentDate === null || c.sentDate < row.firstSentDate) row.firstSentDate = c.sentDate;
    if (row.lastSentDate === null || c.sentDate > row.lastSentDate) row.lastSentDate = c.sentDate;
  }

  if (acc.size === 0) return [];

  return Array.from(acc.entries())
    .sort(([a], [b]) => b.localeCompare(a)) // mais recente primeiro
    .map(([month, d]) => {
      // "2026-06" → "Jun/2026"
      const [year, mon] = month.split("-");
      const monthNames = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];
      const label = `${monthNames[parseInt(mon, 10) - 1] ?? mon}/${year}`;
      return {
        month,
        label,
        campaignCount: d.campaignCount,
        totalSent: d.totalSent,
        totalDelivered: d.totalDelivered,
        totalViews: d.totalViews,
        totalClicks: d.totalClicks,
        openRate: d.totalDelivered > 0 ? (d.totalViews / d.totalDelivered) * 100 : 0,
        ctr: d.totalDelivered > 0 ? (d.totalClicks / d.totalDelivered) * 100 : 0,
        // #2442
        totalBounces: d.totalBounces,
        bounceRate: d.totalSent > 0 ? (d.totalBounces / d.totalSent) * 100 : 0,
        totalUnsub: d.totalUnsub,
        unsubRate: d.totalSent > 0 ? (d.totalUnsub / d.totalSent) * 100 : 0,
        totalSpam: d.totalSpam,
        spamRate: d.totalSent > 0 ? (d.totalSpam / d.totalSent) * 100 : 0,
        firstSentDate: d.firstSentDate,
        lastSentDate: d.lastSentDate,
      };
    });
}

/**
 * Renderiza a tabela de totais por mês — 1 linha por mês, agregando campanhas
 * enviadas naquele mês. Tabela À PARTE da lista detalhada de campanhas.
 * Oculta ("") quando sem dados.
 * #2442: espelha formato da tabela Envios (taxa+count, Bounces/Unsub/Spam, range de datas).
 * Exportado pra teste unitário.
 */
export function renderMonthlyTotalsSection(rows: MonthlyTotalRow[]): string {
  if (rows.length === 0) return "";

  // Formata célula com taxa em cima + contagem absoluta embaixo (igual ao row builder de Envios).
  function metricCell(rate: string, count: number, alertClass?: boolean): string {
    const cls = alertClass ? ' class="alert"' : ' class="metric"';
    return `<td${cls}>${rate}<br><small>${count.toLocaleString("pt-BR")}</small></td>`;
  }

  // #2442: range de datas "1º – último" do mês, formatado em BRT data-apenas.
  function fmtDateBRT(iso: string | null): string {
    if (!iso) return "—";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "—";
    return d.toLocaleDateString("pt-BR", {
      timeZone: "America/Sao_Paulo",
      day: "2-digit",
      month: "2-digit",
    });
  }

  const tableRows = rows.map((r) => {
    const openRateFmt = r.totalDelivered > 0 ? r.openRate.toFixed(1) + "%" : "—";
    const ctrFmt = r.totalDelivered > 0 ? r.ctr.toFixed(1) + "%" : "—";
    const bounceRateFmt = r.totalSent > 0 ? r.bounceRate.toFixed(1) + "%" : "—";
    const unsubRateFmt = r.totalSent > 0 ? r.unsubRate.toFixed(1) + "%" : "—";
    const spamRateFmt = r.totalSent > 0 ? r.spamRate.toFixed(1) + "%" : "—";
    // Circuit breaker alerts (mesmos thresholds da tabela Envios)
    const bounceAlert = r.totalSent > 0 && r.bounceRate >= 3;
    const unsubAlert = r.totalSent > 0 && r.unsubRate >= 3;
    const spamAlert = r.totalSent > 0 && r.spamRate >= 0.1;

    const firstDate = fmtDateBRT(r.firstSentDate);
    const lastDate = fmtDateBRT(r.lastSentDate);
    // Comparar as datas formatadas (não os ISO datetimes raw) para que campanhas
    // no mesmo dia-calendário BRT mas em horários distintos exibam data única.
    const sentRange = firstDate === lastDate || r.campaignCount <= 1
      ? firstDate
      : `${firstDate} – ${lastDate}`;

    return `<tr>
      <td><strong>${escHtml(r.label)}</strong></td>
      <td>${r.campaignCount}</td>
      <td>${sentRange}</td>
      <td>${r.totalSent.toLocaleString("pt-BR")}</td>
      <td>${pct(r.totalDelivered, r.totalSent)}<br><small>${r.totalDelivered.toLocaleString("pt-BR")}</small></td>
      ${metricCell(openRateFmt, r.totalViews)}
      ${metricCell(ctrFmt, r.totalClicks)}
      ${metricCell(bounceRateFmt, r.totalBounces, bounceAlert)}
      ${metricCell(unsubRateFmt, r.totalUnsub, unsubAlert)}
      ${metricCell(spamRateFmt, r.totalSpam, spamAlert)}
    </tr>`;
  }).join("\n");

  return `
<section class="phase2-section" id="monthly-totals">
  <h2 class="section-title">Totais por mês</h2>
  <p class="section-note">1 linha por mês — agrega todos os envios realizados naquele mês. Valores são <strong>eventos por envio</strong> (um contato que recebeu 3 campanhas conta 3×). Opens usa <code>uniqueViews</code> (MPP-inclusivo, igual à UI da Brevo) — não comparar diretamente com as Coortes de engajamento (que contam <strong>pessoas únicas</strong> com aberturas reais/trackable, EXCLUI MPP). Veja a lista detalhada na seção Envios abaixo.</p>
  <div class="table-wrap">
  <table>
    <thead>
      <tr>
        <th title="Mês do envio">Mês</th>
        <th title="Número de envios realizados no mês">Envios</th>
        <th title="Intervalo de datas: 1º envio – último envio do mês (horário de Brasília)">Enviado (1º – último)</th>
        <th title="${escHtml(ENVIOS_TOOLTIP)}">E-mails (eventos)</th>
        <th title="Emails entregues nas caixas dos leitores.">Delivered</th>
        <th title="Aberturas únicas (MPP-inclusivo). Bench: 15-25% B2C, 30-45% engajadas.">Opens 👁️</th>
        <th title="Cliques únicos. Bench: 1.5-3% B2C.">Clicks 🖱️</th>
        <th title="Hard bounces + soft bounces. Bench: &lt;2% saudável. ≥3% pausa o ramp.">Bounces</th>
        <th title="Descadastros. Bench: &lt;0.5%. ≥3% pausa o ramp.">Unsub</th>
        <th title="Marcações de spam. Bench: &lt;0.1%. ≥0.1% pausa o ramp.">Spam</th>
      </tr>
    </thead>
    <tbody>${tableRows}</tbody>
  </table>
  </div>
</section>`;
}

/**
 * #2426: renderiza a tabela de coortes de engajamento por contato.
 * Cada contato cai em EXATAMENTE uma coorte (partição mutuamente exclusiva);
 * "saídas" (bounce/descadastro) têm precedência sobre engajamento. O dado é
 * pré-computado por scripts/clarice-engagement-cohorts.ts → KV.
 *
 * Graceful: quando `cohorts` é null (KV ainda não populado), renderiza um stub
 * com a instrução de como gerar — seção presente, nunca quebra o render.
 * Exportado pra teste unitário.
 */
export function renderEngagementCohortsSection(cohorts: EngagementCohorts | null): string {
  if (!cohorts) {
    return `
<section class="phase2-section" id="engagement-cohorts">
  <h2 class="section-title">Coortes de engajamento</h2>
  <p class="section-note">Dados ainda não gerados. Rode <code>npx tsx scripts/clarice-engagement-cohorts.ts</code> para popular (faz os GETs per-contato e grava no KV).</p>
</section>`;
  }

  const u = cohorts.universe;
  const genBRT = fmtTimeBRT(cohorts.generatedAt);
  // Rótulo "2+" (#2426 review): os buckets são definidos como ≥2 (abriu ≥2 /
  // recebeu ≥2), então "2+" é sempre exato — não acoplar ao maxReceived, que
  // descreve o máximo recebido e podia rotular errado o bucket de OPENS (open
  // pode exceder received em anomalias de tracking da Brevo).

  const defs: Array<{ label: string; title: string; n: number }> = [
    { label: "Abriu 2+ e-mails", title: "Contatos que abriram 2 ou mais e-mails reais (e não saíram). Conta aberturas trackable per-contato — EXCLUI MPP/proxy Apple (sinal humano mais limpo). A Brevo não atribui MPP a contatos individuais.", n: cohorts.opened2plus },
    { label: "Abriu 1 e-mail", title: "Contatos que abriram exatamente 1 e-mail real (e não saíram). Conta aberturas trackable per-contato — EXCLUI MPP/proxy Apple (sinal humano mais limpo). A Brevo não atribui MPP a contatos individuais.", n: cohorts.opened1 },
    { label: "Recebeu 1, não abriu", title: "Recebeu 1 e-mail e não abriu nenhum (e não saiu).", n: cohorts.received1_opened0 },
    { label: "Recebeu 2+, não abriu", title: "Recebeu 2 ou mais e-mails e não abriu nenhum (e não saiu).", n: cohorts.received2_opened0 },
    {
      label: "Saídas (bounce/descadastro)",
      title: `Contatos com bounce ou descadastro — precedência sobre tudo (não importa se abriram). Bounce: ${cohorts.exitsBreakdown.bounced.toLocaleString("pt-BR")} · descadastro/suprimido: ${cohorts.exitsBreakdown.optedOut.toLocaleString("pt-BR")}.`,
      n: cohorts.exits,
    },
  ];

  const tableRows = defs.map((d) => `<tr>
      <td title="${escHtml(d.title)}"><strong>${escHtml(d.label)}</strong></td>
      <td class="metric">${d.n.toLocaleString("pt-BR")}</td>
      <td>${pct(d.n, u)}</td>
    </tr>`).join("\n");

  // #2441: validar que as 5 coortes somam o universo (partição completa).
  const cohorteSum = cohorts.opened2plus + cohorts.opened1 + cohorts.received1_opened0 + cohorts.received2_opened0 + cohorts.exits;
  const sumMismatch = cohorteSum !== u;
  // Linha de totalização em <tfoot> — soma coluna "Pessoas únicas" = universe.
  const sumMismatchTitle = sumMismatch
    ? escHtml(`Atenção: soma das coortes (${cohorteSum.toLocaleString("pt-BR")}) ≠ universo (${u.toLocaleString("pt-BR")}) — verifique dados`)
    : "";
  const tfootRow = `<tr style="font-weight:700;border-top:2px solid var(--rule);">
      <td>Total${sumMismatch ? ` <span style="color:var(--alert)" title="${sumMismatchTitle}">⚠️</span>` : ""}</td>
      <td class="metric">${u.toLocaleString("pt-BR")}</td>
      <td>100%</td>
    </tr>`;

  return `
<section class="phase2-section" id="engagement-cohorts">
  <h2 class="section-title">Coortes de engajamento</h2>
  <p class="section-note"><span title="Contatos únicos dedupados que receberam ao menos um envio (todas as campanhas).">${u.toLocaleString("pt-BR")} pessoas únicas alcançadas</span> (recebeu ≥1 e-mail ou saiu). Cada contato conta em <strong>exatamente uma</strong> coorte — quem deu bounce ou descadastrou entra só em "Saídas", independente de ter aberto. "Abriu" = aberturas reais (trackable) per-contato — <strong>EXCLUI MPP</strong> (a Brevo não atribui MPP a contatos individuais; <code>appleMppOpens</code> é só agregado de campanha). Por isso os números aqui diferem de "Totais por mês" (que usa <code>uniqueViews</code>, MPP-inclusivo) — não comparar 1:1. Escopo: toda a base Clarice (todas as edições). Pré-computado às ${genBRT} BRT.</p>
  <div class="table-wrap">
  <table>
    <thead>
      <tr>
        <th title="Coorte de engajamento (mutuamente exclusivas).">Coorte</th>
        <th title="Número de pessoas únicas nesta coorte.">Pessoas únicas</th>
        <th title="Participação no universo de pessoas únicas alcançadas.">% do universo</th>
      </tr>
    </thead>
    <tbody>${tableRows}</tbody>
    <tfoot>${tfootRow}</tfoot>
  </table>
  </div>
</section>`;
}

/**
 * #2653: renderiza o sumário do store único de contatos (#2647).
 * Stub gracioso quando `contactsSummary` é null (KV não populado ainda).
 * Exportado pra teste unitário.
 */
export function renderContactsSummarySection(
  s: ContactsSummary | null,
): string {
  // Stub quando a chave KV não existe (null) OU o payload está malformado (total
  // não-numérico). NÃO usa `!s.total`: um store legitimamente vazio (total=0) é
  // dado válido, não ausência de dado.
  if (!s || typeof s.total !== "number") {
    return `
<section class="phase2-section" id="contacts-summary">
  <h2 class="section-title">Banco de contatos (store)</h2>
  <p class="section-note">Dados ainda não gerados. Rode <code>npx tsx scripts/clarice-db-summary.ts</code> para popular.</p>
</section>`;
  }

  // Defaults defensivos: o handler casta o JSON do KV sem validar shape; um
  // payload de uma versão antiga do script (sem algum subobjeto) NÃO pode lançar
  // e derrubar o render do dashboard inteiro.
  const brevo = s.brevo ?? { synced_rows: 0, has_signal: false };
  const elig = s.eligibility ?? { eligible: 0, ineligible: 0, by_reason: {} };
  const pp = s.priority_points ?? { lt0: 0, eq0: 0, p1_40: 0, p41_80: 0, gt80: 0, optin: 0 };
  const eng = s.engagement ?? { with_opens: 0, with_clicks: 0 };

  const n = (v: number): string => (v ?? 0).toLocaleString("pt-BR");
  const genBRT = escHtml(fmtTimeBRT(s.generated_at));

  // tabelinha {rótulo → contagem}, ordenada por contagem desc.
  const kvTable = (
    title: string,
    map: Record<string, number> | undefined,
    relabel: (k: string) => string = (k) => k,
  ): string => {
    const rows = Object.entries(map ?? {})
      .sort((a, b) => b[1] - a[1])
      .map(
        ([k, v]) =>
          `<tr><td>${escHtml(relabel(k))}</td><td style="text-align:right">${n(v)}</td></tr>`,
      )
      .join("\n");
    return `<div class="table-wrap"><table>
      <thead><tr><th>${escHtml(title)}</th><th style="text-align:right">contatos</th></tr></thead>
      <tbody>${rows}</tbody></table></div>`;
  };

  const tierLabel = (k: string): string => (k === "null" ? "sem tier" : `T${k.padStart(2, "0")}`);
  const ppMap: Record<string, number> = {
    "negativo (<0)": pp.lt0,
    "zero (sem histórico)": pp.eq0,
    "1–40": pp.p1_40,
    "41–80": pp.p41_80,
    ">80": pp.gt80,
  };
  const brevoBadge = brevo.has_signal
    ? `<span style="color:${DS.brand}">${n(brevo.synced_rows)} sincronizados</span>`
    : `<span style="color:var(--alert)">sem sinal Brevo ainda — rode clarice-sync-brevo.ts</span>`;

  return `
<section class="phase2-section" id="contacts-summary">
  <h2 class="section-title">Banco de contatos (store)</h2>
  <p class="section-note">Sumário agregado do store único (#2647). Total: <strong>${n(s.total)}</strong> · elegíveis: <strong>${n(elig.eligible)}</strong> · inelegíveis: <strong>${n(elig.ineligible)}</strong> · optin: <strong>${n(pp.optin)}</strong> · Brevo: ${brevoBadge}. Gerado às ${genBRT} BRT.</p>
  ${kvTable("Por tier (1º envio)", s.by_tier, tierLabel)}
  ${kvTable("Inelegíveis por razão", elig.by_reason)}
  ${kvTable("priority_points (re-envio)", ppMap)}
  ${kvTable("MillionVerifier (bucket)", s.mv)}
  <p class="section-note">Engajamento Brevo: ${n(eng.with_opens)} com abertura · ${n(eng.with_clicks)} com clique.</p>
</section>`;
}

/**
 * #2609: renderiza seção de status MillionVerifier por grupo.
 * Stub gracioso quando `mvStatus` é null (KV não populado ainda).
 * Exportado pra teste unitário.
 */
export function renderMvStatusSection(mvStatus: MvStatus | null): string {
  // Trata payload vazio (groups:[]) como não-gerado: mesma orientação acionável, em vez
  // de renderizar uma <tbody> vazia sem contexto.
  if (!mvStatus || mvStatus.groups.length === 0) {
    return `
<section class="phase2-section" id="mv-status">
  <h2 class="section-title">Status MillionVerifier por grupo</h2>
  <p class="section-note">Dados ainda não gerados. Rode <code>npx tsx scripts/clarice-mv-status.ts</code> para popular.</p>
</section>`;
  }

  const genBRT = fmtTimeBRT(mvStatus.generatedAt);

  const tableRows = mvStatus.groups.map((g) => {
    let badge: string;
    if (g.status === "t01") {
      badge = `<span style="color:${DS.ink};opacity:0.6">N/A — validado por pagamento Stripe</span>`;
    } else if (g.status === "verified" && g.verifiedAt) {
      const dateFmt = new Date(g.verifiedAt).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" });
      badge = `<span style="color:${DS.brand}">✓ MV ${dateFmt} — ${g.verified.toLocaleString("pt-BR")} ok / ${g.rejected.toLocaleString("pt-BR")} excluídos / ${g.unknown.toLocaleString("pt-BR")} inconclusivos</span>`;
    } else {
      badge = `<span style="color:var(--alert)">MV pendente</span>`;
    }
    return `<tr>
      <td><strong>${escHtml(g.group)}</strong></td>
      <td>${escHtml(g.cycle)}</td>
      <td>${badge}</td>
    </tr>`;
  }).join("\n");

  return `
<section class="phase2-section" id="mv-status">
  <h2 class="section-title">Status MillionVerifier por grupo</h2>
  <p class="section-note">Verificação de e-mails (MillionVerifier) por grupo/tier. T01 pula verificação — pagamento Stripe valida implicitamente. Gerado às ${genBRT} BRT.</p>
  <div class="table-wrap">
  <table>
    <thead>
      <tr>
        <th title="Grupo de contatos (tier ou cohort)">Grupo</th>
        <th title="Ciclo do disparo (conteúdo-envio)">Ciclo</th>
        <th title="Status da verificação MillionVerifier">Status MV</th>
      </tr>
    </thead>
    <tbody>${tableRows}</tbody>
  </table>
  </div>
</section>`;
}

/**
 * #2718: renderiza o painel de cupons Stripe (Aba 5).
 * Chamada APENAS quando couponUsage != null (tab habilitada + flag ON + STRIPE_API_KEY presente).
 * Exportada para testes unitários de PII-off.
 */
/** #2758: um pagamento "achatado" com o contexto da assinatura, pra listagem/drill-down. */
interface FlatPayment {
  coupon_code: string;
  customer_email: string;
  interval: string;
  amount_cents: number;
  epoch: number;
}

export function renderCouponTabPanel(usage: CouponUsageReport): string {
  const fmtBRL = (cents: number): string => {
    const abs = Math.abs(cents);
    return `R$${Math.floor(abs / 100)},${String(abs % 100).padStart(2, "0")}`;
  };

  const codes = Object.keys(usage).sort();
  const allRows = codes.flatMap((code) => (usage[code] as CouponCodeReport).redemptions);

  // #2766: momento em que o report foi montado — mesmo valor em todos os
  // códigos (carimbado por fetchCouponUsage). Ausente em KV pré-#2766.
  const generatedAt = codes.map((code) => (usage[code] as CouponCodeReport).generatedAt).find((g) => g != null);
  const generatedAtNote = generatedAt
    ? `<p class="coupon-generated-at" style="opacity:0.6;font-size:13px;margin:0 0 12px 0;">Atualizado ${escHtml(fmtTimeBRT(generatedAt))} BRT.</p>`
    : `<p class="coupon-generated-at" style="opacity:0.6;font-size:13px;margin:0 0 12px 0;">Data de atualização indisponível (KV antigo — aguarde o próximo refresh, #2750).</p>`;

  // #2749: data em BRT (America/Sao_Paulo), consistente com fmtDateBRT do resto
  // do dashboard — sem timeZone o worker (UTC) mostraria o dia-calendário errado
  // perto da meia-noite pro editor no Brasil.
  const fmtDate = (epoch: number): string =>
    new Date(epoch * 1000).toLocaleDateString("pt-BR", {
      timeZone: "America/Sao_Paulo",
      day: "2-digit", month: "2-digit", year: "numeric",
    });
  // #2758: chave de mês-calendário em BRT ("AAAA-MM") pra agrupar pagamentos —
  // um pagamento nos últimos dias do mês em UTC pode cair no mês seguinte em BRT.
  const brtMonthKey = (epoch: number): string => {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit",
    }).formatToParts(new Date(epoch * 1000));
    const y = parts.find((p) => p.type === "year")!.value;
    const m = parts.find((p) => p.type === "month")!.value;
    return `${y}-${m}`;
  };
  const monthKeyToLabel = (key: string): string => {
    const [y, m] = key.split("-");
    return `${m}/${y}`;
  };

  // #2758: coluna "Pagamentos" — lista TODOS os pagamentos na janela (não só o
  // 1º), colapsável. Sem pagamentos ainda (trial) OU KV legado sem a lista →
  // degrada pra data do 1º pagamento/previsão (mesma semântica do #2749).
  const paymentsCell = (r: (typeof allRows)[number]): string => {
    const list = r.payments;
    if (list && list.length > 0) {
      const total = list.reduce((sum, p) => sum + p.amount_cents, 0);
      const items = list.map((p) =>
        `<li>${escHtml(fmtBRL(p.amount_cents))} em ${escHtml(fmtDate(p.epoch))}</li>`,
      ).join("");
      return `<details class="links-ctr payments-cell">
        <summary class="links-summary">${list.length} pagamento${list.length > 1 ? "s" : ""} <span class="links-count-badge">${escHtml(fmtBRL(total))}</span></summary>
        <ul class="payments-list">${items}</ul>
      </details>`;
    }
    const payEpoch = r.first_payment_epoch ?? r.created;
    const forecastMark = r.first_payment_is_forecast ? "*" : "";
    return escHtml(fmtDate(payEpoch) + forecastMark);
  };

  const detailRows = allRows.map((r) => {
    // #2743: pago (realizado, net, 12m desde o resgate) + comissão de 40%.
    return `<tr>
      <td>${escHtml(r.coupon_code)}</td>
      <td>${escHtml(r.customer_email)}</td>
      <td>${escHtml(r.interval)}</td>
      <td>${escHtml(fmtBRL(r.paid_cents ?? 0))}</td>
      <td><strong>${escHtml(fmtBRL(r.commission_cents ?? 0))}</strong></td>
      <td>${escHtml(r.status)}</td>
      <td>${paymentsCell(r)}</td>
    </tr>`;
  }).join("\n");
  // #2749: legenda do "*" só aparece se há ≥1 pagamento previsto (trial) SEM
  // lista de pagamentos (a lista, quando presente e vazia, já usa a previsão).
  const hasForecast = allRows.some((r) => (!r.payments || r.payments.length === 0) && r.first_payment_is_forecast);
  const forecastLegend = hasForecast
    ? `<p class="coupon-forecast-legend" style="margin-top:8px;font-size:13px;opacity:0.7;">* previsão do 1º pagamento (assinatura em trial — ainda não cobrada)</p>`
    : "";

  // #2758: total por mês-calendário (BRT), clicável — substitui o "Resumo por
  // cupom" (agora só existe "Detalhe por assinatura" + esta visão mensal). A
  // agregação roda inteiramente sobre os `payments` já carregados no KV — sem
  // nova chamada à Stripe. Redemptions sem `payments` (KV pré-#2758) não
  // contribuem — degradação graciosa até o próximo refresh (#2750) repopular.
  //
  // Dedup por charge id (`seenChargeIds`): `payments` é filtrado só por
  // cliente+janela (granularidade "por e-mail", #2743) — se o MESMO cliente
  // tem 2 redemptions cujas janelas se sobrepõem (ex.: 2 assinaturas com
  // cupom, ou resgate + reaplicação), o mesmo charge Stripe aparece na lista
  // de payments de AMBAS as rows. Sem dedup, essa agregação cross-redemption
  // contaria o pagamento 2×. O total por-código (`totalPaidCents`) já se
  // protege disso via max-por-cliente; aqui, mais granular (por charge
  // individual), usamos o id do charge — mais preciso que "max por cliente"
  // quando as janelas se sobrepõem só parcialmente.
  const monthly = new Map<string, { totalCents: number; items: FlatPayment[] }>();
  const seenChargeIds = new Set<string>();
  for (const r of allRows) {
    for (const p of r.payments ?? []) {
      if (seenChargeIds.has(p.id)) continue;
      seenChargeIds.add(p.id);
      const key = brtMonthKey(p.epoch);
      if (!monthly.has(key)) monthly.set(key, { totalCents: 0, items: [] });
      const bucket = monthly.get(key)!;
      bucket.totalCents += p.amount_cents;
      bucket.items.push({
        coupon_code: r.coupon_code, customer_email: r.customer_email,
        interval: r.interval, amount_cents: p.amount_cents, epoch: p.epoch,
      });
    }
  }
  const monthKeysDesc = [...monthly.keys()].sort().reverse();

  // #2758: redemptions do KV pré-#2758 têm `paid_cents` real mas NÃO têm a
  // lista `payments` (não sabemos em que mês cada pagamento caiu) — sem este
  // aviso, "Total por mês" pareceria mostrar R$0 de receita quando na verdade
  // há dinheiro real registrado (só sem quebra mensal ainda). Nota some
  // sozinha assim que o refresh diário (#2750) repopular o KV no formato novo.
  const legacyPaidCents = allRows
    .filter((r) => (!r.payments || r.payments.length === 0) && (r.paid_cents ?? 0) > 0)
    .reduce((sum, r) => sum + (r.paid_cents ?? 0), 0);
  const legacyNote = legacyPaidCents > 0
    ? `<p class="coupon-monthly-legacy-note" style="opacity:0.6;font-size:13px;margin-top:6px;">Há ${escHtml(fmtBRL(legacyPaidCents))} em pagamentos registrados no formato antigo (sem quebra por mês ainda) — some após o próximo refresh (#2750). Ver "Detalhe por assinatura" abaixo pro total real.</p>`
    : "";

  const monthlySectionBody = monthKeysDesc.length === 0
    ? `<p class="coupon-monthly-empty" style="opacity:0.6;font-size:14px;">Nenhum pagamento registrado ainda (assinaturas em trial, ou KV aguardando refresh — ver #2750).</p>`
    : monthKeysDesc.map((key) => {
        const bucket = monthly.get(key)!;
        const itemsSorted = [...bucket.items].sort((a, b) => a.epoch - b.epoch);
        const itemRows = itemsSorted.map((it) => `<tr>
          <td>${escHtml(it.coupon_code)}</td>
          <td>${escHtml(it.customer_email)}</td>
          <td>${escHtml(it.interval)}</td>
          <td>${escHtml(fmtBRL(it.amount_cents))}</td>
          <td>${escHtml(fmtBRL(commissionCents(it.amount_cents)))}</td>
          <td>${escHtml(fmtDate(it.epoch))}</td>
        </tr>`).join("\n");
        return `<details class="links-ctr coupon-month" id="coupon-month-${escHtml(key)}">
  <summary class="links-summary">${escHtml(monthKeyToLabel(key))} <span class="links-count-badge">${bucket.items.length}</span> — pago ${escHtml(fmtBRL(bucket.totalCents))} · comissão ${escHtml(fmtBRL(commissionCents(bucket.totalCents)))}</summary>
  <div class="links-table-wrap">
  <table class="links-table">
    <thead><tr><th>Cupom</th><th>Email</th><th>Plano</th><th>Valor</th><th>Comissão (40%)</th><th>Data</th></tr></thead>
    <tbody>${itemRows}</tbody>
  </table>
  </div>
</details>`;
      }).join("\n");

  return `
${generatedAtNote}
<section class="phase2-section" id="coupon-monthly">
  <h2 class="section-title">Total por mês</h2>
  ${monthlySectionBody}
  ${legacyNote}
</section>
<section class="phase2-section" id="coupon-detail">
  <h2 class="section-title">Detalhe por assinatura</h2>
  <div class="table-wrap">
  <table>
    <thead>
      <tr>
        <th>Cupom</th>
        <th>Email</th>
        <th>Plano</th>
        <th>Pago (12m)</th>
        <th>Comissão (40%)</th>
        <th>Status</th>
        <th>Pagamentos</th>
      </tr>
    </thead>
    <tbody>${detailRows}</tbody>
  </table>
  </div>
  ${forecastLegend}
</section>`;
}

/**
 * #2280: injeta um banner discreto de "dados podem estar atrasados" no topo de um
 * render bom servido como fallback durante 429. Pura/testável. Insere logo após a
 * tag <body ...>; se não houver <body> (HTML inesperado), prepende o banner.
 */
export function injectStaleBanner(html: string, retryAfterSecs: number | null): string {
  const retryMsg = retryAfterSecs != null ? `~${retryAfterSecs}s` : "alguns minutos";
  const banner =
    `<div style="background:#FBE9A8;color:#5c4a00;padding:10px 16px;text-align:center;` +
    `font-family:system-ui,sans-serif;font-size:14px;border-bottom:1px solid #E0C96A;">` +
    `⏳ Brevo em rate-limit — dados de campanhas podem estar atrasados; Cupons e Contatos estão atualizados. ` +
    `Atualiza em ${retryMsg}.</div>`;
  if (/<body[^>]*>/i.test(html)) {
    return html.replace(/<body[^>]*>/i, (m) => m + banner);
  }
  return banner + html;
}

/**
 * #2280: monta a resposta de fallback "último render bom" (200 + banner stale).
 * `X-Dashboard-Stale: rate-limit` permite que monitoria distinga render bom de
 * render stale (o HTTP é 200, então alertas de 5xx não pegam mais o rate-limit).
 * Exportada pra teste de regressão da rota.
 */
export function buildStaleResponse(lastGoodHtml: string, retryAfterSecs: number | null): Response {
  return new Response(injectStaleBanner(lastGoodHtml, retryAfterSecs), {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store", // não cachear a versão stale-banner
      "X-Dashboard-Stale": "rate-limit",
      ...(retryAfterSecs != null ? { "Retry-After": String(retryAfterSecs) } : {}),
    },
  });
}

/**
 * Renderiza resposta de rate limit amigável (#2144).
 * Retorna 503 + Retry-After quando o listing Brevo responde 429.
 */
function rateLimitResponse(retryAfterSecs: number | null, isHtml: boolean): Response {
  const retryMsg = retryAfterSecs != null ? `${retryAfterSecs}s` : "alguns minutos";
  const headers: Record<string, string> = {
    "Cache-Control": "no-store",
  };
  if (retryAfterSecs != null) headers["Retry-After"] = String(retryAfterSecs);

  if (isHtml) {
    const body = `<!DOCTYPE html>
<html lang="pt-BR">
<head><meta charset="utf-8"><title>Rate limit — Clarice News Dashboard</title>
<style>body{font-family:system-ui,sans-serif;max-width:600px;margin:60px auto;padding:0 20px;text-align:center;}</style>
</head>
<body>
<h1>⏳ Brevo rate limit</h1>
<p>A API da Brevo retornou 429 (too many requests).<br>
Aguarde <strong>${escHtml(retryMsg)}</strong> e tente novamente.<br>
<a href="?fresh=1">Tentar agora</a></p>
</body></html>`;
    return new Response(body, { status: 503, headers: { ...headers, "Content-Type": "text/html; charset=utf-8" } });
  }

  return new Response(
    JSON.stringify({ error: "brevo_rate_limit", retryAfterSecs }),
    { status: 503, headers: { ...headers, "Content-Type": "application/json" } },
  );
}

export function isAuthenticated(request: Request, env: Env): boolean {
  // #2748: fail-CLOSED — sem AUTH_TOKEN configurado, nega acesso (nunca libera
  // tudo). O dashboard está num URL público e carrega PII (e-mail de
  // assinantes nas abas Cupons/Contatos); um secret esquecido no deploy não
  // pode virar leak silencioso.
  if (!env.AUTH_TOKEN) return false
  const cookie = request.headers.get('Cookie') ?? ''
  const val = cookie.split(';')
    .map(c => c.trim())
    .find(c => c.startsWith(`${AUTH_COOKIE}=`))
    ?.slice(`${AUTH_COOKIE}=`.length)
  return val === env.AUTH_TOKEN
}

export function loginPage(error = false): Response {
  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>clarice dashboard — login</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;display:flex;height:100dvh;align-items:center;justify-content:center;background:#f5f6f7}
form{background:#fff;padding:2rem;border-radius:8px;box-shadow:0 2px 12px rgba(0,0,0,.12);display:flex;flex-direction:column;gap:.75rem;width:min(340px,90vw)}
h1{font-size:1.1rem;font-weight:600;color:#111}
input[type=password]{padding:.5rem .75rem;border:1px solid #d1d5db;border-radius:6px;font-size:.9rem;width:100%}
input[type=password]:focus{outline:none;border-color:#f6821f;box-shadow:0 0 0 3px rgba(246,130,31,.15)}
button{padding:.5rem 1rem;background:#f6821f;color:#fff;border:none;border-radius:6px;font-size:.9rem;cursor:pointer;font-weight:500}
button:hover{background:#e07010}
.err{color:#dc2626;font-size:.82rem}
</style></head>
<body>
<form method="POST" action="/login">
<h1>clarice dashboard</h1>
${error ? '<p class="err">Token inválido. Tente novamente.</p>' : ''}
<input type="password" name="token" placeholder="Token de acesso" required autofocus autocomplete="current-password">
<button type="submit">Entrar</button>
</form>
</body></html>`
  return new Response(html, {
    status: error ? 401 : 200,
    headers: { 'Content-Type': 'text/html;charset=UTF-8', 'Cache-Control': 'no-store' },
  })
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/healthz") {
      return new Response("ok", { headers: { "Content-Type": "text/plain" } });
    }

    // Auth gate — /api/* routes are exempt (internal automation, no cookie)
    if (!path.startsWith('/api/')) {
      if (path === '/login') {
        if (request.method === 'GET') return loginPage()
        if (request.method === 'POST') {
          const body = await request.formData()
          const rawToken = body.get('token')
          const token = typeof rawToken === 'string' ? rawToken : null
          // #2748: fail-CLOSED — sem AUTH_TOKEN, negar o login (não deixar
          // qualquer submissão entrar). Mesmo espírito de isAuthenticated().
          if (!env.AUTH_TOKEN) return new Response('AUTH_TOKEN não configurado no worker — acesso negado.', { status: 500 })
          if (/[;\r\n]/.test(env.AUTH_TOKEN)) return new Response('Invalid AUTH_TOKEN configuration', { status: 500 })
          if (token && token === env.AUTH_TOKEN) {
            const maxAge = 30 * 24 * 60 * 60  // 30 days
            return new Response(null, {
              status: 302,
              headers: {
                'Location': '/',
                'Set-Cookie': `${AUTH_COOKIE}=${env.AUTH_TOKEN}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`,
                'Cache-Control': 'no-store',
              },
            })
          }
          return loginPage(true)
        }
        return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'GET, POST' } })
      }

      if (!isAuthenticated(request, env)) {
        return loginPage()
      }
    }

    // #2144: edge cache 5min via Cache API pras rotas cacheáveis.
    // fresh=1 → bypass completo: nem edge cache nem KV de stats imutáveis.
    const isFresh = url.searchParams.get("fresh") === "1";
    const isCacheable = (path === "/" || path === "/index.html" || path === "/api/campaigns");
    const cache = caches.default;

    if (isCacheable && !isFresh) {
      const cached = await cache.match(request);
      if (cached) return cached;
    }

    if (path === "/api/campaigns") {
      try {
        const limit = Math.min(50, Number(url.searchParams.get("limit") ?? "20") || 20);
        const campaigns = await fetchRecentCampaigns(env, limit, isFresh);
        const response = new Response(JSON.stringify(campaigns, null, 2), {
          headers: {
            "Content-Type": "application/json",
            // Cache-Control: private impede proxies compartilhados de cachear metricas
            // de negocio. CDN-Cache-Control (CF-especifico) permite cache no edge do
            // proprio Worker. fresh=1 retorna no-store para o browser nao cachear o "fresh".
            "Cache-Control": isFresh ? "no-store" : "private, max-age=300",
            ...(isFresh ? {} : { "CDN-Cache-Control": "public, max-age=300" }),
          },
        });
        if (!isFresh) {
          // Clonar antes de armazenar — Response só pode ser lida uma vez
          await cache.put(request, response.clone());
        }
        return response;
      } catch (e) {
        if (e instanceof BrevoRateLimitError) {
          return rateLimitResponse(e.retryAfterSecs, false);
        }
        return new Response(`Brevo fetch error: ${(e as Error).message}`, { status: 502 });
      }
    }

    // #2718: rota de cupons — requer auth explícita (PII: emails de clientes).
    // Não está inclusa na isenção /api/* (que é para automação interna sem cookie).
    if (path === "/api/coupons") {
      if (!isAuthenticated(request, env)) return loginPage();
      const data = await getCouponUsage(env, isFresh);
      if (!data) return new Response("Not found", { status: 404 });
      return new Response(JSON.stringify(data, null, 2), {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": isFresh ? "no-store" : "private, max-age=300",
        },
      });
    }

    if (path === "/" || path === "/index.html") {
      try {
        // #2268: agendadas PRIMEIRO — a listagem `queued` (1 chamada barata) pega a
        // janela de rate-limit fresca, antes do fetch pesado de enviadas (que após
        // o #2260 faz 2 GETs/campanha). Falha degrada pra [] (seção oculta) mas
        // NÃO silenciosa — loga, pra não esconder regressão. fetchScheduledCampaigns
        // já retenta a listagem em 429 internamente (#2268).
        let scheduledOk = true;
        const scheduled = await fetchScheduledCampaigns(env, 50, isFresh).catch((e) => {
          scheduledOk = false; // #2733: render degradado não vira o cache de campanhas
          console.error("[#2268] fetchScheduledCampaigns falhou — seção de agendadas oculta:", e instanceof Error ? e.message : e);
          return [];
        });
        const campaigns = await fetchRecentCampaigns(env, 50, isFresh); // #2142 review: rota / hardcodava 20 e ignorava o default novo
        // #2733: seções KV-independentes (coortes, MV, contatos, cupons) — sempre
        // frescas do KV, tanto aqui quanto no fallback de rate-limit do Brevo.
        const { cohorts, mvStatus, contactsSummary, couponUsage } = await readKvTabs(env, isFresh);
        const html = renderDashboardHtml(campaigns, scheduled, cohorts, mvStatus, contactsSummary, couponUsage);
        const response = new Response(html, {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": isFresh ? "no-store" : "private, max-age=300",
            ...(isFresh ? {} : { "CDN-Cache-Control": "public, max-age=300" }),
          },
        });
        if (!isFresh) {
          await cache.put(request, response.clone());
          // #2733: cacheia as campanhas Brevo cruas do render saudável. No 429 do
          // Brevo, o fallback re-renderiza com estas campanhas stale + abas de KV
          // frescas — em vez de servir o HTML inteiro congelado (que esconderia
          // dado KV recém-publicado, ex: aba de Cupons pós-deploy). Só em render
          // NÃO-fresh: ?fresh=1 pode trazer stats parciais (429 interno por campanha)
          // e não deve poluir o fallback; e mantém o caminho ?fresh=1 sem write extra.
          // Depois do cache de edge — nunca bloqueia a resposta.
          if (scheduledOk && env.STATS_CACHE) {
            await env.STATS_CACHE
              .put(LASTGOOD_CAMPAIGNS_KEY, JSON.stringify({ campaigns, scheduled }), { expirationTtl: LASTGOOD_TTL })
              .catch(() => { /* erro de KV nunca bloqueia o render */ });
          }
        }
        return response;
      } catch (e) {
        if (e instanceof BrevoRateLimitError) {
          // #2733: em vez de servir o HTML inteiro congelado (#2280), re-renderiza
          // com campanhas Brevo STALE (do KV) + abas de KV FRESCAS. Assim uma janela
          // de rate-limit do Brevo nunca esconde dado KV recém-publicado (o bug
          // original: aba de Cupons pós-deploy oculta). Throw-safe: degrada p/ 503.
          return buildRateLimitFallback(env, e.retryAfterSecs);
        }
        return new Response(
          `<!DOCTYPE html><html><body><h1>Dashboard error</h1><p>${escHtml((e as Error).message)}</p></body></html>`,
          { status: 502, headers: { "Content-Type": "text/html; charset=utf-8" } },
        );
      }
    }

    return new Response("Not found", { status: 404 });
  },
};
