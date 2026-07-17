import type { Env, BrevoCampaign, BrevoGlobalStats, BrevoCampaignStats, BrevoList, BrevoLinksStats, EngagementCohorts, MvStatus, MvGroupStatus, ContactsSummary, EiaEngagementSummary, EiaEngagementEdition, CohortStatsRow } from "./types.ts";
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
 * `LASTGOOD_CAMPAIGNS_KEY`. `null` quando não há fetch bem-sucedido NEM
 * cache KV — o render degrada pra "créditos indisponíveis", nunca inventa
 * um número.
 *
 * #3081 (review): `mode` agora segue a MESMA semântica documentada em
 * `CouponUsageMode`/`getCouponUsage` — "cached" honra o KV como fonte
 * PRIMÁRIA (só busca ao vivo em MISS). Antes, "cached" se comportava
 * IDÊNTICO a "fresh" (sempre buscava ao vivo primeiro); o KV só entrava
 * como fallback de ERRO, nunca como cache de fato — nome e comportamento
 * divergiam. `mode="fresh"` continua buscando ao vivo primeiro (bypassa o
 * KV quando o Brevo está disponível); `mode="kv-only"` continua nunca
 * buscando ao vivo.
 */
/** Lê `PLAN_CREDITS_KV_KEY` — hoisted pra `fetchPlanCredits` nunca ler a MESMA
 * chave duas vezes na mesma chamada (ex: mode="cached" com miss + fetch ao
 * vivo também falho caía no fallback final, que re-lia o KV — miss garantido
 * na 2ª leitura, já que nada escreveu nele entre as duas). */
async function readPlanCreditsKv(kv: KVNamespace): Promise<number | null> {
  const cached = (await kv.get(PLAN_CREDITS_KV_KEY, "json").catch(() => null)) as { credits?: number } | null;
  return typeof cached?.credits === "number" ? cached.credits : null;
}

export async function fetchPlanCredits(
  env: Pick<Env, "BREVO_API_KEY" | "STATS_CACHE">,
  mode: CouponUsageMode = "cached",
): Promise<number | null> {
  const kv = env.STATS_CACHE;
  // #3081 (review): lido no máximo 1x por chamada — sem isto, mode="cached"
  // com KV miss + fetch ao vivo também falho caía no fallback final, que
  // re-lia a MESMA chave (miss garantido, nada escreveu nela entre as duas
  // leituras) — 2 KV reads exatamente no caminho degradado (Brevo fora do
  // ar + cache frio), quando cada operação já custa mais.
  let cached: number | null = null;
  let checkedCache = false;

  if (mode === "cached" && kv) {
    cached = await readPlanCreditsKv(kv);
    checkedCache = true;
    if (cached !== null) return cached;
  }

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
  return checkedCache ? cached : readPlanCreditsKv(kv);
}

// #2733: chave KV com as campanhas Brevo cruas do último render saudável
// (`{ campaigns, scheduled }`). Serve de fallback quando o Brevo entra em
// rate-limit: o dashboard re-renderiza com essas campanhas stale + as abas de
// KV (Cupons/Contatos) ATUALIZADAS — em vez de servir o HTML inteiro congelado.
export const LASTGOOD_CAMPAIGNS_KEY = "dash:lastgood:campaigns";

/**
 * #3644: coalescing de requests concorrentes DENTRO do mesmo isolate — a
 * defesa PRIMÁRIA e determinística contra o thundering-herd. Cloudflare
 * Workers processam múltiplas requests concorrentes na MESMA instância de
 * isolate via event loop cooperativo dentro de um colo (isolates são
 * reaproveitados entre requests, especialmente sob carga sustentada) — então
 * isto cobre o caso mais comum: 2+ requests em cache-miss chegando "ao mesmo
 * tempo" no mesmo colo.
 *
 * `Map.get`/`Map.set` são SÍNCRONOS — sem `await` entre o check e o set,
 * não existe janela de corrida possível dentro de um isolate (JS é
 * single-threaded: nenhuma outra continuação pode intercalar entre essas
 * duas linhas). Diferente de um lock via KV (get+put são operações
 * assíncronas separadas — ver `tryAcquireRefreshLock` abaixo —, então
 * SEMPRE existe uma janela TOCTOU entre elas, mesmo com truques de
 * write-then-readback: validado empiricamente durante o self-review desta
 * PR, uma tentativa anterior de fechar essa janela via token+readback no KV
 * NÃO resolvia a corrida de forma confiável sob o scheduling real de
 * microtasks do V8/Node — só o Map em memória dá a garantia real).
 *
 * Limitação honesta: isolates DIFERENTES (cross-colo, ou uma instância nova
 * subindo no mesmo colo) não compartilham este Map. Para esse caso mais raro
 * (mas real — é o cenário principal descrito na issue: "colos diferentes"),
 * o lock via KV (`tryAcquireRefreshLock`/`buildInflightCoalescedFallback`)
 * é a segunda linha de defesa — best-effort, reduz a chance sem eliminá-la
 * (fechar isso por completo exigiria um Durable Object; decisão explícita
 * de não introduzir infra nova pra isso, ver "zero custo recorrente" em
 * CLAUDE.md).
 */
const inflightRefreshes = new Map<string, Promise<unknown>>();

// #3644: contador de OBSERVABILIDADE PRA TESTE, incrementado a cada chamada de
// `coalesceRefresh` (hit ou miss) por routeKey. Nunca lido por lógica de
// produção -- existe só pra testes de corrida conseguirem esperar
// deterministicamente por "a 2ª chamada concorrente já chegou no checkpoint de
// coalescing" (`getCoalesceCallCount`) em vez de estimar quantos ticks isso
// leva. Achado em CI (não reproduzido localmente): o caminho até este
// checkpoint na rota `/` passa por `isAuthenticated` (2x
// `crypto.subtle.digest`, despacho real via WebCrypto/threadpool -- timing
// não-determinístico o bastante entre ambientes pra quebrar suposições de
// "N ticks bastam").
const coalesceCallCounts = new Map<string, number>();
/** Exported for tests only -- ver comentário de `coalesceCallCounts` acima. */
export function getCoalesceCallCount(routeKey: string): number {
  return coalesceCallCounts.get(routeKey) ?? 0;
}

/**
 * Compartilha UMA única execução de `run()` entre todas as chamadas
 * concorrentes com a mesma `routeKey` (enquanto a 1ª ainda não resolveu).
 * A 2ª chamada em diante recebe a MESMA promise da 1ª — não dispara `run()`
 * de novo. Remove a entrada do Map assim que `run()` resolve/rejeita
 * (sucesso ou erro), pra não segurar chamadas futuras além da janela real
 * de execução.
 */
export function coalesceRefresh<T>(routeKey: string, run: () => Promise<T>): Promise<T> {
  coalesceCallCounts.set(routeKey, (coalesceCallCounts.get(routeKey) ?? 0) + 1);
  const existing = inflightRefreshes.get(routeKey);
  if (existing) return existing as Promise<T>;
  const promise = run().finally(() => {
    inflightRefreshes.delete(routeKey);
  });
  inflightRefreshes.set(routeKey, promise);
  return promise;
}

/**
 * #3644: lock de coalescing via KV, por rota cacheável ("/" ou
 * "/api/campaigns") — SEGUNDA linha de defesa, pra requests concorrentes que
 * batem em isolates/colos DIFERENTES (fora do alcance de `coalesceRefresh`,
 * que só coalesce dentro do mesmo isolate). `caches.default` é PER-COLO (não
 * global) — duas requests em colos diferentes veem cache-miss independente e
 * cada uma dispara a sequência completa (~150 chamadas Brevo).
 *
 * IMPORTANTE (honestidade do trade-off): KV não tem compare-and-swap — isto
 * NÃO é uma trava atômica cross-colo. Duas requests ainda podem, em teoria,
 * passar pelo `get()` (ambas veem "sem lock") antes que qualquer uma tenha
 * concluído o `put()` — a mesma limitação que motivou a sugestão da issue de
 * que só Durable Object fecharia essa janela de verdade. Decisão explícita
 * (PR #3644, alinhada com "zero custo recorrente" do CLAUDE.md): não
 * introduzir infra nova (DO) pra fechar uma janela residual de dezenas de ms
 * quando esta trava já reduz a janela de "duração inteira do live-fetch"
 * (segundos, ~150 chamadas) pra "duração de 1 KV get+put" — cobrindo o
 * padrão mais comum na prática (2ª request chega enquanto a 1ª já está em
 * voo há algum tempo, não literalmente no mesmo instante).
 */
export const REFRESH_LOCK_KEY_PREFIX = "dash:refresh:inflight:";
export const REFRESH_LOCK_TTL_SECS = 30;

/**
 * Tenta adquirir o lock de refresh pra `routeKey`. `true` = lock adquirido
 * (caller deve prosseguir com o live-fetch e, ao final, chamar
 * `releaseRefreshLock`); `false` = outra request já está com o lock — caller
 * deve tentar servir um fallback stale (`buildInflightCoalescedFallback`/
 * `buildInflightCoalescedCampaignsJson`) em vez de fazer o live-fetch.
 *
 * Fail-open em qualquer instabilidade do KV (sem binding, erro de leitura,
 * erro de escrita) — nunca bloqueia um fetch por causa do lock em si; o pior
 * caso degrada pro comportamento pré-#3644 (sem coalescing cross-colo, mas
 * `coalesceRefresh` acima continua protegendo o caso same-isolate).
 */
export async function tryAcquireRefreshLock(
  env: Pick<Env, "STATS_CACHE">,
  routeKey: string,
): Promise<boolean> {
  const kv = env.STATS_CACHE;
  if (!kv) return true;
  const key = REFRESH_LOCK_KEY_PREFIX + routeKey;
  try {
    const existing = await kv.get(key);
    if (existing) return false;
  } catch {
    return true; // KV instável na leitura -- fail-open
  }
  await kv.put(key, String(Date.now()), { expirationTtl: REFRESH_LOCK_TTL_SECS }).catch(() => {
    /* falha de escrita do lock nunca bloqueia -- best-effort */
  });
  return true;
}

/**
 * Libera o lock adquirido por `tryAcquireRefreshLock` (chamar só quando o
 * caller de fato adquiriu). Best-effort: se falhar, o TTL de
 * `REFRESH_LOCK_TTL_SECS` garante que o lock expira sozinho de qualquer jeito.
 */
export async function releaseRefreshLock(
  env: Pick<Env, "STATS_CACHE">,
  routeKey: string,
): Promise<void> {
  const kv = env.STATS_CACHE;
  if (!kv) return;
  await kv.delete(REFRESH_LOCK_KEY_PREFIX + routeKey).catch(() => {
    /* best-effort -- TTL cobre o resto */
  });
}

/**
 * #3080: janela de campanhas ENVIADAS buscada nas agregações do dashboard
 * ("Totais por mês", "Volume no ciclo", "Open rate por dia da semana", saúde
 * da Rampa). Pré-#3079 este fetch era SÍNCRONO na rota `/` — 50 mantinha a
 * latência do request baixa. #3079 moveu o fetch pesado pro Cron Trigger
 * (fora do request-time — #3256 subiu a cadência de 10min pra 3h): o custo
 * de uma janela maior agora é absorvido pelo cron, não pelo usuário que
 * carrega a página.
 *
 * Subimos de 50 → 100 (INCIDENTE 260710: #3080 originalmente subiu pra 150,
 * mas a API da Brevo rejeita `limit` acima de 100 em `/v3/emailCampaigns`
 * — `{"code":"out_of_range","message":"Limit exceeds max value"}`. Esse bug
 * nunca tinha rodado em produção (o commit do #3080 foi mergeado ~21min
 * DEPOIS do último deploy real do worker, então só foi exposto quando o
 * deploy defasado de #3268 foi corrigido nesta mesma madrugada — derrubou a
 * dashboard inteira, sem fallback pro KV stale porque o erro 400 não é
 * `BrevoRateLimitError`). 100 é o teto real da Brevo — não dá pra subir mais
 * sem paginar múltiplas chamadas, o que reintroduziria o custo de latência
 * que #3079 mitigou.
 *
 * Com cadência de até 3 campanhas/dia (células A/B/C em teste), 100 ainda
 * cobre ~1 ciclo de cobrança completo (~30 dias) na maioria dos meses,
 * reduzindo bastante a chance de "Totais por mês"/"Volume no ciclo" ficarem
 * parciais silenciosamente (#3080). Campanhas imutáveis (>7d) ficam
 * cacheadas no KV SEM TTL (`isImmutableCampaign`) — o custo extra de GETs só
 * se paga 1x por campanha nova que entra na janela, não a cada tick.
 *
 * NÃO usado pelo clamp de `/api/campaigns` (`index.ts`) — essa rota ainda
 * busca SÍNCRONO em request-time (não passou pelo #3079), então seu limite
 * permanece conservador (50) para não reintroduzir a latência que o #2144
 * já havia mitigado. Ver defesa em profundidade complementar (aviso de
 * "janela parcial") em `renderMonthlyTotalsSection`/`renderVolumeSection`.
 */
export const CAMPAIGNS_FETCH_LIMIT = 100;

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

  // #3164: anotação explícita `Record<string, unknown>` é NECESSÁRIA aqui — sem ela,
  // o TS infere o tipo do ternário via union-reduction (sem contextual type) e, como
  // `{}` (tipo objeto vazio) é estruturalmente supertype de QUALQUER tipo, a redução
  // por subtipo descarta o branch verdadeiro inteiro (`isObj(s.x) ? s.x : {}` inferia
  // só `{}`, mesmo com `isObj` corretamente estreitando pra `Record<string, unknown>`
  // no branch truthy). Quirk conhecido do TS com ternários que têm `{}` como fallback
  // (não é exclusivo de type predicates — `typeof v === "object" ? v : {}` colapsa
  // igual); puramente compile-time — o JS emitido roda idêntico com ou sem a
  // anotação, já que `as`/anotações de tipo não geram código. Sem isto o `tsc`
  // reportava 16 falsos-positivos TS2339 nos acessos abaixo. Ver #3164.
  const rawBrevo: Record<string, unknown> = isObj(s.brevo) ? s.brevo : {};
  const rawElig: Record<string, unknown> = isObj(s.eligibility) ? s.eligibility : {};
  const rawPp: Record<string, unknown> = isObj(s.priority_points) ? s.priority_points : {};
  const rawEng: Record<string, unknown> = isObj(s.engagement) ? s.engagement : {};

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
      // #3081 (review): opcional por SCHEMA EVOLUTION (mesmo critério de
      // `cycle_start` acima) — OMITIDO quando ausente no KV cru (payload
      // pré-#3081), nunca defaultado a 0 (0 excluídos e "dado ausente" não
      // são a mesma coisa). Sem este passthrough, o campo nunca chegava ao
      // render em produção — este normalizador reconstrói `priority_points`
      // como literal fixo e descartava qualquer chave extra do KV cru.
      ...(typeof rawPp.internal_excluded === "number" ? { internal_excluded: numOr0(rawPp.internal_excluded) } : {}),
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
 * #3077: normaliza o payload de `EngagementCohorts` (chave KV `cohorts:engagement`)
 * NO BOUNDARY — mesmo choke point/critério de `normalizeContactsSummary` (#2875).
 * `renderEngagementCohortsSection` acessa `cohorts.universe.toLocaleString(...)` e
 * `cohorts.exitsBreakdown.bounced.toLocaleString(...)` SEM guard — um payload
 * parcial/corrompido (ex: `{}`) fazia esses acessos lançar TypeError → 502 no
 * dashboard inteiro, não só na seção. Retorna `null` (shape mínimo ausente) quando
 * `universe` não é number — mesmo critério que o render já usava implicitamente
 * (precisa de `universe` pra tudo). Campos numéricos ausentes/não-finitos degradam
 * pra 0 (mesmo padrão de `sanitizeNumRecord`); `generatedAt` ausente vira "".
 */
export function normalizeEngagementCohorts(raw: unknown): EngagementCohorts | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Partial<EngagementCohorts> & Record<string, unknown>;
  if (typeof s.universe !== "number") return null;

  const numOr0 = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const rawExits = (s.exitsBreakdown && typeof s.exitsBreakdown === "object" ? s.exitsBreakdown : {}) as Record<
    string,
    unknown
  >;

  return {
    generatedAt: typeof s.generatedAt === "string" ? s.generatedAt : "",
    universe: numOr0(s.universe),
    opened2plus: numOr0(s.opened2plus),
    opened1: numOr0(s.opened1),
    received1_opened0: numOr0(s.received1_opened0),
    received2_opened0: numOr0(s.received2_opened0),
    exits: numOr0(s.exits),
    exitsBreakdown: {
      bounced: numOr0(rawExits.bounced),
      optedOut: numOr0(rawExits.optedOut),
    },
    maxReceived: numOr0(s.maxReceived),
  };
}

/**
 * #3077: normaliza o payload de `MvStatus` (chave KV `mv:status`) NO BOUNDARY —
 * mesmo padrão de `normalizeContactsSummary`/`normalizeEngagementCohorts`.
 * `renderMvStatusSection` acessa `mvStatus.groups.length` e depois
 * `.map((g) => ...)` — um payload sem `groups` (ou com `groups` não-array)
 * lançava TypeError → 502. Retorna `null` quando `groups` não é um array (shape
 * mínimo ausente); cada grupo dentro do array é sanitizado campo-a-campo (o
 * render já trata `groups: []` como "dados ainda não gerados", então uma vez
 * que o array existe, filtrar entradas totalmente inválidas é suficiente —
 * não precisa rejeitar o payload inteiro por causa de UM grupo malformado).
 */
export function normalizeMvStatus(raw: unknown): MvStatus | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Partial<MvStatus> & Record<string, unknown>;
  if (!Array.isArray(s.groups)) return null;

  const numOr0 = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const validStatuses = new Set(["verified", "t01", "pending"]);

  // #3164: `Array.isArray(s.groups)` acima estreita `s.groups` pro tipo CONCRETO
  // `MvGroupStatus[]` (herdado de `Partial<MvStatus>`), não `unknown[]` — o cast
  // `raw as Partial<MvStatus> & Record<string, unknown>` empresta os tipos
  // confiáveis de `MvStatus` pra um payload que, na verdade, é JSON não-validado
  // do KV. Por isso `.filter((g): g is Record<string, unknown> => ...)` falhava
  // com TS2677: o predicado afirma que `g` (tipado como `MvGroupStatus`, com
  // `group`/`cycle`/etc. obrigatórios) É um `Record<string, unknown>` mais
  // genérico — TS recusa por não ser um estreitamento válido. O cast pra
  // `unknown[]` aqui restaura o tipo real do dado (KV cru, não confiável),
  // deixando o predicado seguinte fazer a validação de runtime como já fazia.
  const groups: MvGroupStatus[] = (s.groups as unknown[])
    .filter((g): g is Record<string, unknown> => !!g && typeof g === "object")
    .map((g) => ({
      group: typeof g.group === "string" ? g.group : "",
      cycle: typeof g.cycle === "string" ? g.cycle : "",
      status: (typeof g.status === "string" && validStatuses.has(g.status) ? g.status : "pending") as MvGroupStatus["status"],
      verifiedAt: typeof g.verifiedAt === "string" ? g.verifiedAt : null,
      verified: numOr0(g.verified),
      rejected: numOr0(g.rejected),
      unknown: numOr0(g.unknown),
    }));

  return {
    generatedAt: typeof s.generatedAt === "string" ? s.generatedAt : "",
    groups,
  };
}

/**
 * #3077: normaliza o payload de `EiaEngagementSummary` (chave KV `eia:engagement`)
 * NO BOUNDARY — mesmo padrão dos demais normalizadores desta seção. Diferente
 * de `cohort_stats`/`priority_points_histogram*` (guards por CAMPO já presentes
 * em `renderEiaEngagementSection` via `countOrDash`/`pctOrDash`), o problema aqui
 * é estrutural: `.filter(...)` em `eiaEngagement.editions` pressupõe array —
 * um payload com `editions` ausente/não-array lançava TypeError → 502 antes de
 * qualquer guard por campo entrar em ação. Retorna `null` quando `editions` não
 * é um array; entradas sem `edition` (string) são descartadas (o render já
 * filtra por regex de formato, mas essa filtragem roda DEPOIS — sem o guard
 * aqui, uma entrada com `edition` não-string quebraria o `.test()` do regex).
 */
export function normalizeEiaEngagement(raw: unknown): EiaEngagementSummary | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Partial<EiaEngagementSummary> & Record<string, unknown>;
  if (!Array.isArray(s.editions)) return null;

  const numOr0 = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

  // #3164: mesmo quirk de `normalizeMvStatus` acima — `Array.isArray(s.editions)`
  // estreita pro tipo concreto `EiaEngagementEdition[]` (herdado de
  // `Partial<EiaEngagementSummary>`), então o predicado `e is Record<string,
  // unknown>` falhava com TS2677 (Record<string,unknown> não é um estreitamento
  // válido de um tipo já concreto com campos obrigatórios). Cast pra `unknown[]`
  // restaura o tipo real (KV cru, não validado) antes da checagem de runtime.
  const editions: EiaEngagementEdition[] = (s.editions as unknown[])
    .filter(
      (e): e is Record<string, unknown> =>
        !!e && typeof e === "object" && typeof (e as Record<string, unknown>).edition === "string",
    )
    .map((e) => ({
      edition: e.edition as string,
      total_votes: numOr0(e.total_votes),
      voted_a: numOr0(e.voted_a),
      voted_b: numOr0(e.voted_b),
      pct_correct: typeof e.pct_correct === "number" && Number.isFinite(e.pct_correct) ? e.pct_correct : null,
      correct_choice: typeof e.correct_choice === "string" ? e.correct_choice : null,
      ...(typeof e.correct_count === "number" && Number.isFinite(e.correct_count)
        ? { correct_count: e.correct_count }
        : {}),
    }));

  return {
    editions,
    updated_at: typeof s.updated_at === "string" ? s.updated_at : null,
  };
}

/**
 * #2733: lê as seções KV-independentes do dashboard (coortes, status MV, sumário
 * de contatos, cupons). Extraída para ser usada tanto no render saudável quanto
 * no fallback de rate-limit do Brevo — assim as abas de Cupons/Contatos, que vêm
 * do KV e não do Brevo, nunca congelam junto com a seção de campanhas.
 *
 * #2875 item 1 / #3077: `contactsSummary`/`cohorts`/`mvStatus`/`eiaEngagement`
 * passam por um normalizador dedicado aqui — o ÚNICO choke point de leitura do
 * KV — em vez de cada render defender campo-a-campo contra payload parcial/antigo.
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
  const [rawCohorts, rawMvStatus, rawContactsSummary, couponUsage, rawEiaEngagement] = await Promise.all([
    kv ? kv.get(COHORTS_KV_KEY, "json").catch(() => null) : Promise.resolve(null),
    kv ? kv.get(MV_STATUS_KV_KEY, "json").catch(() => null) : Promise.resolve(null),
    kv ? kv.get(CONTACTS_SUMMARY_KV_KEY, "json").catch(() => null) : Promise.resolve(null),
    getCouponUsage(env, mode),
    kv ? kv.get(EIA_ENGAGEMENT_KV_KEY, "json").catch(() => null) : Promise.resolve(null),
  ]);
  const cohorts = normalizeEngagementCohorts(rawCohorts);
  const mvStatus = normalizeMvStatus(rawMvStatus);
  const contactsSummary = normalizeContactsSummary(rawContactsSummary);
  const eiaEngagement = normalizeEiaEngagement(rawEiaEngagement);
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
  planCreditsOverride?: number | null,
): Promise<Response> {
  if (!env.STATS_CACHE) return rateLimitResponse(retryAfterSecs, true);
  const staleCampaignsRaw = (await env.STATS_CACHE
    .get(LASTGOOD_CAMPAIGNS_KEY, "json")
    .catch(() => null)) as { campaigns?: unknown[]; scheduled?: unknown[]; campaignsLimit?: unknown } | null;
  // #3080: repassa o limite gravado junto com o payload stale (self-describing,
  // ver LastGoodCampaignsPayload) — habilita o aviso de "janela parcial" mesmo
  // no render de fallback de rate-limit. Ausente (KV pré-#3080) → null (sem aviso).
  const staleCampaignsLimit =
    typeof staleCampaignsRaw?.campaignsLimit === "number" ? staleCampaignsRaw.campaignsLimit : null;
  const { cohorts, mvStatus, contactsSummary, couponUsage, eiaEngagement } = await readKvTabs(env, "kv-only");
  // Créditos do plano: o render principal busca /v3/account ANTES das campanhas
  // (janela de rate-limit fresca) e passa o valor em memória aqui. Sem isso o
  // fallback lia "kv-only" e o KV nunca era populado (a linha que populava rodava
  // DEPOIS das campanhas, e o 429 a pulava) → denominador sempre "indisponível".
  // `planCreditsOverride` numérico vence; null/ausente cai pro KV (último bom).
  const planCredits =
    typeof planCreditsOverride === "number"
      ? planCreditsOverride
      : await fetchPlanCredits(env, "kv-only").catch(() => null);
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
      null, // dataGeneratedAt: KV stale payload não tem timestamp de render fiável aqui
      staleCampaignsLimit, // #3080: limite gravado junto do payload (self-describing)
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

/**
 * #3644: banner de coalescing -- distinto do banner de rate-limit
 * (`injectStaleBanner`) porque a causa é diferente: não é a Brevo em 429, é
 * este próprio worker segurando uma 2ª request concorrente pra não duplicar
 * o live-fetch. Wording honesto evita alarmar o editor com "rate limit"
 * quando na verdade é uma otimização funcionando como esperado.
 */
export function injectInflightBanner(html: string): string {
  const banner =
    `<div style="background:#DCEEFB;color:#0b4a6f;padding:10px 16px;text-align:center;` +
    `font-family:system-ui,sans-serif;font-size:14px;border-bottom:1px solid #A9D6F5;">` +
    `🔄 Atualização já em andamento (outra visita concorrente) — mostrando o último dado bom conhecido. ` +
    `Recarregue em alguns segundos.</div>`;
  if (/<body[^>]*>/i.test(html)) {
    return html.replace(/<body[^>]*>/i, (m) => m + banner);
  }
  return banner + html;
}

/**
 * #3644: fallback servido pela rota `/` quando `tryAcquireRefreshLock` sinaliza
 * que outra request já está no meio do live-fetch. Reusa o mesmo payload STALE
 * (`dash:lastgood:campaigns`) + abas de KV frescas que `buildRateLimitFallback`
 * usa pro caso de 429 -- mas com banner honesto (não é rate-limit da Brevo) e
 * sem `Retry-After` (a janela é de segundos, não o reset da Brevo).
 *
 * Retorna `null` quando não há stale bom pra servir (KV ausente/vazio, ou o
 * re-render falhar) -- nesse caso o caller deve prosseguir com o live-fetch
 * mesmo sem o lock (fail-open: pior caso é idêntico ao comportamento
 * pré-#3644, nunca pior).
 */
export async function buildInflightCoalescedFallback(
  env: Env,
  planCreditsOverride?: number | null,
): Promise<Response | null> {
  if (!env.STATS_CACHE) return null;
  const staleCampaignsRaw = (await env.STATS_CACHE
    .get(LASTGOOD_CAMPAIGNS_KEY, "json")
    .catch(() => null)) as { campaigns?: unknown[]; scheduled?: unknown[]; campaignsLimit?: unknown } | null;
  if (!staleCampaignsRaw) return null;
  const staleCampaignsLimit =
    typeof staleCampaignsRaw.campaignsLimit === "number" ? staleCampaignsRaw.campaignsLimit : null;
  const { cohorts, mvStatus, contactsSummary, couponUsage, eiaEngagement } = await readKvTabs(env, "kv-only");
  const planCredits =
    typeof planCreditsOverride === "number"
      ? planCreditsOverride
      : await fetchPlanCredits(env, "kv-only").catch(() => null);
  const rawCampaigns = staleCampaignsRaw.campaigns;
  const rawScheduled = staleCampaignsRaw.scheduled;
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
      null,
      staleCampaignsLimit,
    );
    return new Response(injectInflightBanner(html), {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Dashboard-Stale": "inflight-coalesced",
      },
    });
  } catch (renderErr) {
    console.error(
      "[#3644] fallback de coalescing (/) falhou ao re-renderizar -- caller deve prosseguir com o live-fetch:",
      renderErr instanceof Error ? renderErr.message : renderErr,
    );
    return null;
  }
}

/**
 * #3644: equivalente ao fallback acima, mas pra `/api/campaigns` (resposta
 * JSON crua, não HTML renderizado). Reusa o mesmo `campaigns` gravado em
 * `dash:lastgood:campaigns` pela rota `/` -- mesmo shape (`CampaignRow[]`),
 * já que ambas as rotas chamam `fetchRecentCampaigns`. `null` quando não há
 * stale bom (caller deve prosseguir com o live-fetch, fail-open).
 */
export async function buildInflightCoalescedCampaignsJson(
  env: Pick<Env, "STATS_CACHE">,
  limit: number,
): Promise<Response | null> {
  if (!env.STATS_CACHE) return null;
  const staleCampaignsRaw = (await env.STATS_CACHE
    .get(LASTGOOD_CAMPAIGNS_KEY, "json")
    .catch(() => null)) as { campaigns?: unknown[] } | null;
  const rawCampaigns = staleCampaignsRaw?.campaigns;
  if (!Array.isArray(rawCampaigns) || rawCampaigns.length === 0) return null;
  return new Response(JSON.stringify(rawCampaigns.slice(0, limit), null, 2), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Dashboard-Stale": "inflight-coalesced",
    },
  });
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

/**
 * #3079/#2733: shape gravado em `dash:lastgood:campaigns`. `generatedAt` é o
 * timestamp de quando o payload foi de fato computado — "agora" em toda
 * escrita, já que #3553 (parte B) removeu o Cron Trigger: a rota `/` grava
 * este payload a cada fetch ao vivo bem-sucedido (write-through) e só o LÊ de
 * volta no fallback de rate-limit (buildRateLimitFallback abaixo), nunca mais
 * como fonte primária.
 */
export interface LastGoodCampaignsPayload {
  campaigns: Array<BrevoCampaign & { listName?: string; listSize?: number }>;
  scheduled: Array<BrevoCampaign & { listName?: string; listSize?: number }>;
  generatedAt: string;
  /**
   * #3080: limite pedido ao Brevo para `campaigns` (não `scheduled`) neste
   * tick — self-describing, pra não depender de `CAMPAIGNS_FETCH_LIMIT` ter
   * ficado idêntico entre o momento em que este payload foi gravado e o
   * momento em que é lido (o valor pode mudar entre deploys). Optional: KV
   * gravado por versões anteriores do worker (pré-#3080) não tem este campo
   * — os leitores tratam ausência como "desconhecido" (não afirmam janela
   * parcial sem essa informação).
   */
  campaignsLimit?: number;
}

// #3553 (parte B): `runCronRefresh` (rodava no Cron Trigger removido, #3079/
// #3256) foi removida — a rota `/` (index.ts) agora faz o próprio fetch ao
// vivo em request-time e escreve o write-through em `dash:lastgood:campaigns`
// inline, reusando a mesma sequência créditos→agendadas→enviadas que esta
// função tinha.
