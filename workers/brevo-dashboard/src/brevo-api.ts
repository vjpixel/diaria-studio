import type { Env, BrevoCampaign, BrevoGlobalStats, BrevoCampaignStats, BrevoList, BrevoLinksStats, EngagementCohorts, MvStatus, ContactsSummary, EiaEngagementSummary, CohortStatsRow } from "./types.ts";
import { COHORTS_KV_KEY, MV_STATUS_KV_KEY, CONTACTS_SUMMARY_KV_KEY, EIA_ENGAGEMENT_KV_KEY, RECENT_STATS_TTL } from "./types.ts";
import { fetchCouponUsage, type CouponUsageReport } from "../../../scripts/lib/stripe-coupons.ts";
import { renderDashboardHtml, escHtml } from "./sections-core.ts";

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
export function rateLimitResponse(retryAfterSecs: number | null, isHtml: boolean): Response {
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


// #2718: chave KV do relatório de cupons Stripe (TTL 5min, mesma granularidade do dashboard).
export const COUPONS_KV_KEY = "coupons:usage";

/**
 * #2812 item 1: modo de leitura KV/Stripe pra `getCouponUsage`/`readKvTabs`.
 * Substitui o par `(isFresh, kvOnly)` — os dois booleans adjacentes idênticos
 * permitiam transposição silenciosa sem erro de compilação (risco concreto:
 * reintroduzir o #2779 por troca de argumento), e `kvOnly=true` tornava
 * `isFresh` morto (early-return antes de ele ser consultado) sem nenhuma
 * documentação no tipo. Um enum torna a combinação "fresh + nunca chame
 * Stripe" irrepresentável — ela nunca fez sentido de qualquer forma.
 *   "cached"  → KV primeiro; Stripe só em miss (render saudável, default).
 *   "fresh"   → bypassa KV quando Stripe está disponível (editor pediu ?fresh=1).
 *   "kv-only" → NUNCA chama Stripe, nem em miss — caminho de erro do #2779
 *               (fallback de rate-limit do Brevo não pode depender de
 *               nenhuma chamada externa).
 */
export type CouponUsageMode = "cached" | "fresh" | "kv-only";

/**
 * #2718: busca relatório de cupons com KV como fonte primária.
 *
 * Fluxo: KV (populado via MCP externo) → fallback Stripe API (só se
 * STRIPE_API_KEY configurada). Em KV-only (sem Stripe key), mode="fresh"
 * ainda serve KV — não há fonte mais fresca disponível. Retorna null quando
 * COUPONS_TAB_ENABLED !== "true", em KV miss sem STRIPE_API_KEY, ou em erro.
 *
 * `mode="kv-only"` (#2779): o caminho de erro (fallback de rate-limit do
 * Brevo) exige ZERO chamadas externas — o KV é a única fonte: hit retorna,
 * miss retorna null (tab oculta), nunca cai no fetch Stripe ao vivo.
 */
/** Exported for unit tests. */
export async function getCouponUsage(
  env: Pick<Env, "COUPONS_TAB_ENABLED" | "STRIPE_API_KEY" | "STATS_CACHE">,
  mode: CouponUsageMode = "cached",
): Promise<CouponUsageReport | null> {
  if (env.COUPONS_TAB_ENABLED !== "true") return null;
  try {
    if (env.STATS_CACHE) {
      const cached = await env.STATS_CACHE.get<CouponUsageReport>(COUPONS_KV_KEY, "json")
        .catch((e) => { console.error("[#2718] KV read error:", (e as Error).message); return null; });
      // #2779: mode="kv-only" honra o KV como fonte única — hit OU miss, nunca
      // segue pro Stripe (antes, um KV miss caía no fetch ao vivo mesmo no fallback).
      if (mode === "kv-only") return cached;
      // KV hit: retorna imediatamente, EXCETO quando mode="fresh" E Stripe disponível
      // (nesse caso Stripe tem dados mais frescos). Em KV-only (sem Stripe key), KV
      // é a fonte mais fresca mesmo com mode="fresh".
      if (cached !== null && (mode !== "fresh" || !env.STRIPE_API_KEY)) return cached;
    }
    // KV miss ou mode="fresh" com Stripe disponível: tenta Stripe API
    if (mode === "kv-only" || !env.STRIPE_API_KEY) return null;
    const report = await fetchCouponUsage(env.STRIPE_API_KEY);
    // Sempre grava de volta ao KV — inclusive em mode="fresh", para atualizar o
    // cache das sessões seguintes (não só do caller que pediu ?fresh=1).
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

// #2910: chave KV do último valor bom conhecido de créditos do plano Brevo
// (`GET /v3/account`) — cache 24h (muda raríssimo, só em troca de plano) +
// fallback pro fetch ao vivo falhar/rate-limit. Mesmo padrão de
// LASTGOOD_CAMPAIGNS_KEY (#2733) / getCouponUsage (#2718).
export const PLAN_CREDITS_KV_KEY = "brevo:plan-credits";
const PLAN_CREDITS_TTL_SECS = 24 * 60 * 60;

interface BrevoAccountPlan {
  type?: string;
  credits?: number;
  creditsType?: string;
}
interface BrevoAccountResponse {
  plan?: BrevoAccountPlan[];
}

/**
 * #2910: extrai o limite/crédito de envio do plano Brevo corrente da
 * resposta de `GET /v3/account`. Prioriza a entrada `creditsType ===
 * "sendLimit"` (planos de assinatura mensal, como o da Clarice — a API
 * Brevo documenta esse campo em `GetAccount`); cai pro primeiro item com
 * `credits` numérico se não achar (planos pay-as-you-go só têm `credits`
 * genérico). `null` quando o array vem vazio/ausente (shape inesperado) — o
 * caller trata como "indisponível", NUNCA cai pra um total hardcoded
 * (era o bug do #2910: 40.000 fixo da migração de junho). Pura — exportada
 * pra teste unitário sem precisar mockar `fetch`.
 */
export function extractPlanCredits(account: BrevoAccountResponse | null | undefined): number | null {
  const plans = account?.plan;
  if (!Array.isArray(plans) || plans.length === 0) return null;
  const sendLimit = plans.find((p) => p.creditsType === "sendLimit" && typeof p.credits === "number");
  if (sendLimit) return sendLimit.credits as number;
  const first = plans.find((p) => typeof p.credits === "number");
  return typeof first?.credits === "number" ? first.credits : null;
}

/**
 * #2910: créditos/limite de envio do plano Brevo — denominador DINÂMICO da
 * seção "Volume enviado no ciclo" (nunca hardcoded 40k). Fetch ao vivo
 * (`GET /v3/account`, cacheado 24h no KV) com fallback pro último valor bom
 * conhecido em erro/rate-limit — mesmo padrão de `getCouponUsage`/
 * `LASTGOOD_CAMPAIGNS_KEY`. `mode="kv-only"` pula o fetch ao vivo (caminho
 * de fallback de 429 do Brevo, que já evita chamadas extra). `null` quando
 * não há fetch bem-sucedido NEM cache KV — o render degrada pra "créditos
 * indisponíveis", nunca inventa um número.
 */
export async function fetchPlanCredits(
  env: Pick<Env, "BREVO_API_KEY" | "STATS_CACHE">,
  mode: CouponUsageMode = "cached",
): Promise<number | null> {
  const kv = env.STATS_CACHE;
  if (mode !== "kv-only") {
    try {
      // brevoFetch monta `https://api.brevo.com${path}` SEM prefixar /v3 — o path
      // precisa incluí-lo. Sem o /v3, `/account` dá 404 e o plano cai pra "indisponível"
      // (bug: #2910 nunca funcionou em prod — sempre 404 → denominador oculto).
      const account = await brevoFetch<BrevoAccountResponse>("/v3/account", env as Env);
      const credits = extractPlanCredits(account);
      if (credits !== null) {
        if (kv) {
          await kv
            .put(PLAN_CREDITS_KV_KEY, JSON.stringify({ credits, fetchedAt: new Date().toISOString() }), {
              expirationTtl: PLAN_CREDITS_TTL_SECS,
            })
            .catch(() => { /* KV write nunca bloqueia o render */ });
        }
        return credits;
      }
    } catch (e) {
      console.error("[#2910] fetchPlanCredits: fetch ao vivo falhou, caindo pro KV:", e instanceof Error ? e.message : e);
    }
  }
  if (!kv) return null;
  const cached = (await kv.get(PLAN_CREDITS_KV_KEY, "json").catch(() => null)) as { credits?: number } | null;
  return typeof cached?.credits === "number" ? cached.credits : null;
}

// #2733: chave KV com as campanhas Brevo cruas do último render saudável
// (`{ campaigns, scheduled }`). Serve de fallback quando o Brevo entra em
// rate-limit: o dashboard re-renderiza com essas campanhas stale + as abas de
// KV (Cupons/Contatos) ATUALIZADAS — em vez de servir o HTML inteiro congelado.
export const LASTGOOD_CAMPAIGNS_KEY = "dash:lastgood:campaigns";

/**
 * #2875 item 1: normaliza UMA linha de `cohort_stats` lida do KV. Payload
 * antigo/parcial pode ter os campos opcionais (`brevo`/`opened`/`clicked`/
 * `unsub`/`hard_bounce`) ausentes, ou (pré-#2880) o par legado `unsub_bounce`
 * no lugar de `unsub` — cada um degrada pra 0 (mesmo default que os renders
 * aplicavam localmente campo-a-campo). `contacts`/`eligible`/`received` também
 * ganham o guard: sem ele, um KV corrompido faltando um desses (contrato do
 * script os declara sempre presentes, mas o Worker não pode CONFIAR cegamente
 * num payload externo) produzia `undefined` e o render de contagem
 * (`toLocaleString`) lançava — TypeError → 502.
 *
 * #2909: `received_this_cycle` entra com o mesmo guard (degrada a 0 em KV
 * pré-#2909); `sends_sum`/`mv_verified` saíram do payload (colunas removidas).
 */
function normalizeCohortStatsRow(raw: unknown): CohortStatsRow | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<CohortStatsRow> & { unsub_bounce?: number };
  const numOr0 = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return {
    contacts: numOr0(r.contacts),
    eligible: numOr0(r.eligible),
    received: numOr0(r.received),
    received_this_cycle: numOr0(r.received_this_cycle),
    opened: numOr0(r.opened),
    clicked: numOr0(r.clicked),
    // #2880: degrada pro par legado unsub_bounce (pré-split) quando `unsub`
    // ausente — mesmo fallback que renderCohortsTabPanel aplicava inline.
    unsub: typeof r.unsub === "number" && Number.isFinite(r.unsub) ? r.unsub : numOr0(r.unsub_bounce),
    hard_bounce: numOr0(r.hard_bounce),
    brevo: numOr0(r.brevo),
  };
}

/**
 * #2875 item 1: normaliza o payload de `ContactsSummary` lido do KV NO
 * BOUNDARY (choke point único) — antes, `renderContactsSummarySection` e
 * `renderCohortsTabPanel` defendiam campo-a-campo contra payload KV parcial/
 * antigo, cada uma com sua própria cópia dos defaults. Retorna `null` quando
 * o payload não é minimamente válido (não é objeto, ou `total` não é um
 * number) — MESMO critério que `renderContactsSummarySection` usava antes
 * (`!s || typeof s.total !== "number"`), preservando o stub "dados ainda não
 * gerados" pro mesmo conjunto de payloads.
 *
 * Os guards locais nos renders permanecem (defesa em profundidade — também
 * são exercitados diretamente por testes unitários que chamam os renders sem
 * passar por este normalizador); a remoção deles é follow-up opcional, não
 * bloqueante (ver PR #2875).
 */
export function normalizeContactsSummary(raw: unknown): ContactsSummary | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Partial<ContactsSummary> & Record<string, unknown>;
  if (typeof s.total !== "number") return null;

  const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object";
  const numOr0 = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  // #2919: sanitiza os VALORES internos de um Record<string, number> lido do
  // KV — `isObj` só garante que o campo É um objeto, não que cada valor
  // dentro dele é um number finito. Um KV parcial/legado com
  // `{"ok":120,"invalid":null}` passava `null` direto pro render, que faz
  // `n.toLocaleString()` sem guard (`fmtCount`, sections-kv.ts, perdeu o
  // `?? 0` no #2907 na premissa de que o boundary já garantia números
  // definidos) → TypeError → 502 no dashboard inteiro. Aplicado a
  // `by_reason`, `mv` e os 4 `priority_points_histogram*` abaixo.
  const sanitizeNumRecord = (v: Record<string, unknown>): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const [k, val] of Object.entries(v)) out[k] = numOr0(val);
    return out;
  };

  const rawBrevo = isObj(s.brevo) ? s.brevo : {};
  const rawElig = isObj(s.eligibility) ? s.eligibility : {};
  const rawPp = isObj(s.priority_points) ? s.priority_points : {};
  const rawEng = isObj(s.engagement) ? s.engagement : {};

  let cohort_stats: Record<string, CohortStatsRow> | undefined;
  if (isObj(s.cohort_stats)) {
    cohort_stats = {};
    for (const [key, row] of Object.entries(s.cohort_stats)) {
      const normalized = normalizeCohortStatsRow(row);
      if (normalized) cohort_stats[key] = normalized;
    }
  }

  // priority_points_histogram* são opcionais por SCHEMA EVOLUTION (KV antigo
  // genuinamente não tem o campo — feature-gate, não corrupção) — passthrough
  // se vier um objeto, chave OMITIDA caso contrário (nunca `undefined`
  // explícito: preserva comparação estrutural exata com payloads que nunca
  // tiveram o campo). Não confundir com os defaults acima (que cobrem
  // corrupção de um payload que DEVERIA ter o campo).
  const histKeys = [
    "priority_points_histogram",
    "priority_points_histogram_verified",
    "priority_points_histogram_eligible",
    "priority_points_histogram_brevo",
  ] as const;
  const histFields: Partial<Record<(typeof histKeys)[number], Record<string, number>>> = {};
  for (const key of histKeys) {
    if (isObj(s[key])) histFields[key] = sanitizeNumRecord(s[key] as Record<string, unknown>);
  }

  return {
    generated_at: typeof s.generated_at === "string" ? s.generated_at : "",
    total: s.total,
    // #2909: cycle_start (string ISO) só é INCLUÍDO quando presente — OMITIDO
    // quando ausente OU null explícito (schema evolution, igual aos histogramas
    // opcionais). Render trata ausente/null como "sem ciclo" → colunas de ciclo "—".
    ...(typeof s.cycle_start === "string" ? { cycle_start: s.cycle_start } : {}),
    brevo: {
      synced_rows: numOr0(rawBrevo.synced_rows),
      has_signal: typeof rawBrevo.has_signal === "boolean" ? rawBrevo.has_signal : false,
    },
    eligibility: {
      eligible: numOr0(rawElig.eligible),
      ineligible: numOr0(rawElig.ineligible),
      by_reason: isObj(rawElig.by_reason) ? sanitizeNumRecord(rawElig.by_reason) : {},
    },
    priority_points: {
      lt0: numOr0(rawPp.lt0),
      eq0: numOr0(rawPp.eq0),
      p1_40: numOr0(rawPp.p1_40),
      p41_80: numOr0(rawPp.p41_80),
      gt80: numOr0(rawPp.gt80),
      optin: numOr0(rawPp.optin),
    },
    ...histFields,
    ...(cohort_stats ? { cohort_stats } : {}),
    mv: isObj(s.mv) ? sanitizeNumRecord(s.mv) : {},
    engagement: {
      with_opens: numOr0(rawEng.with_opens),
      with_clicks: numOr0(rawEng.with_clicks),
    },
  };
}

/**
 * #2733: lê as seções KV-independentes do dashboard (coortes, status MV, sumário
 * de contatos, cupons). Extraída para ser usada tanto no render saudável quanto
 * no fallback de rate-limit do Brevo — assim as abas de Cupons/Contatos, que vêm
 * do KV e não do Brevo, nunca congelam junto com a seção de campanhas.
 *
 * #2875 item 1: `contactsSummary` passa por `normalizeContactsSummary` aqui —
 * o ÚNICO choke point de leitura do KV — em vez de cada render defender
 * campo-a-campo contra payload parcial/antigo.
 *
 * Exported for unit tests (#2733).
 */
export async function readKvTabs(
  env: Env,
  mode: CouponUsageMode = "cached", // #2812: era (isFresh, kvOnly) — ver CouponUsageMode
): Promise<{
  cohorts: EngagementCohorts | null;
  mvStatus: MvStatus | null;
  contactsSummary: ContactsSummary | null;
  couponUsage: CouponUsageReport | null;
  eiaEngagement: EiaEngagementSummary | null;
}> {
  // As 5 leituras são independentes → paralelas (importa no fallback de 429,
  // que está no caminho crítico do render stale).
  // NOTA: `mode` só afeta a leitura de cupons (getCouponUsage) — as outras 4
  // seções sempre leem o KV direto, sem noção de fresh/kv-only.
  const kv = env.STATS_CACHE;
  const [cohorts, mvStatus, rawContactsSummary, couponUsage, eiaEngagement] = await Promise.all([
    kv ? (kv.get(COHORTS_KV_KEY, "json").catch(() => null) as Promise<EngagementCohorts | null>) : Promise.resolve(null),
    kv ? (kv.get(MV_STATUS_KV_KEY, "json").catch(() => null) as Promise<MvStatus | null>) : Promise.resolve(null),
    kv ? kv.get(CONTACTS_SUMMARY_KV_KEY, "json").catch(() => null) : Promise.resolve(null),
    getCouponUsage(env, mode),
    kv ? (kv.get(EIA_ENGAGEMENT_KV_KEY, "json").catch(() => null) as Promise<EiaEngagementSummary | null>) : Promise.resolve(null),
  ]);
  const contactsSummary = normalizeContactsSummary(rawContactsSummary);
  return { cohorts, mvStatus, contactsSummary, couponUsage, eiaEngagement };
}

/**
 * #2733: monta a resposta de fallback quando o Brevo está em rate-limit (429).
 * Serve o dashboard com campanhas STALE (do KV `dash:lastgood:campaigns`) + as
 * abas de KV FRESCAS (Cupons/Contatos/coortes/MV via readKvTabs) + banner — em
 * vez do HTML inteiro congelado, que escondia dado KV recém-publicado.
 *
 * `mode="kv-only"` sempre (#2779): no caminho de erro nunca fazemos chamada
 * externa ao vivo (getCouponUsage) — honramos o KV, e um KV miss de cupons
 * vira tab oculta em vez de fetch Stripe. `Array.isArray` guarda contra KV
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
  const { cohorts, mvStatus, contactsSummary, couponUsage, eiaEngagement } = await readKvTabs(env, "kv-only");
  // #2910: "kv-only" — mesmo racional do #2779 (readKvTabs acima): caminho de
  // erro de 429 do Brevo nunca faz chamada externa a mais; só lê o KV
  // (último crédito bom conhecido) ou degrada pra "indisponível".
  const planCredits = await fetchPlanCredits(env, "kv-only").catch(() => null);
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
      eiaEngagement,
      planCredits,
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
