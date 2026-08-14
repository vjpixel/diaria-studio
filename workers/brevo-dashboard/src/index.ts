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
 *   GET  /                     → HTML dashboard (pública)
 *   GET  /api/campaigns        → JSON com campaigns + stats (pública). Só
 *                                `status=sent` por default (#4786) —
 *                                `?includeScheduled=1` anexa também as
 *                                `status=queued` (sem stats, ver
 *                                `buildCampaignsResponse`).
 *   GET  /api/postmaster-spam  → JSON { entry: PostmasterSpamEntry | null } (pública, #4131 finding 4)
 *   GET  /healthz              → liveness probe
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

import type { Env } from "./types.ts";
export * from "./types.ts";
export * from "./render-links.ts";
export * from "./billing-cycle.ts";
export * from "./staleness.ts";
export * from "./sections-kv.ts";
export * from "./brevo-api.ts";
export * from "./sections-core.ts";
export * from "./weekly-plan.ts";
// #3884: painel de avaliação de experimentos A/B + registro "Experimento vigente".
export * from "./experiment-cta.ts";
// #4515: aba brevo_diaria (canal Brevo PRÓPRIO do editor, conta SEPARADA da Clarice).
export * from "./brevo-diaria.ts";
// #3078: DEFAULT_HEALTH_THRESHOLDS/HealthThresholds já chegam via weekly-plan.ts
// (reexportados lá) — export nomeado aqui evita ambiguidade de `export *` duplicado.
export { isBounceBreach } from "./thresholds.ts";
// #3092: tokens do DS — loginPage() usava cores Cloudflare hardcoded
// (#f6821f/#f5f6f7/#dc2626) que nenhuma outra superfície do dashboard usa.
import { DS, DS_FONTS as DSF } from "./render-links.ts";

import {
  fetchRecentCampaigns,
  fetchScheduledCampaigns,
  getCouponUsage,
  readKvTabs,
  readLinkSectionsByCycle, // #4184
  readLinkTitlesByCycle, // #4198
  buildRateLimitFallback,
  rateLimitResponse,
  BrevoRateLimitError,
  BrevoUpstreamError, // #4251
  isBrevoOutageStatus, // #4251
  isNetworkOrTimeoutError, // #4533
  buildUpstreamErrorFallback, // #4251
  buildUpstreamErrorCampaignsJsonFallback, // #4251
  upstreamErrorResponse, // #4251
  LASTGOOD_CAMPAIGNS_KEY,
  CAMPAIGNS_FETCH_LIMIT,
  fetchPlanCredits,
  tryAcquireRefreshLock,
  releaseRefreshLock,
  buildInflightCoalescedFallback,
  buildInflightCoalescedCampaignsJson,
  coalesceRefresh,
  normalizePostmasterSpamEntry,
  buildFatalErrorFallback,
  type LastGoodCampaignsPayload,
} from "./brevo-api.ts";
import { LASTGOOD_TTL, POSTMASTER_SPAM_KV_KEY } from "./types.ts";
import { renderDashboardHtml, escHtml, collectMonthlyLinkCycles } from "./sections-core.ts"; // #4184: collectMonthlyLinkCycles
import { refreshEiaEngagement } from "./eia-refresh.ts";
export * from "./eia-refresh.ts";
// #4515: aba brevo_diaria — fetch fail-soft (nunca lança), ver docstring em brevo-diaria.ts.
import { fetchBrevoDiariaTabData } from "./brevo-diaria.ts";

const AUTH_COOKIE = 'cf-dash-auth'

/**
 * #3081: comparação timing-safe entre 2 strings — Workers-compatible (o
 * runtime de Cloudflare Workers não expõe `crypto.subtle.timingSafeEqual`,
 * que é uma API Node-only, não parte da SubtleCrypto padrão). Estratégia:
 * hash SHA-256 de ambos os valores (normaliza pra um tamanho FIXO de 32 bytes,
 * removendo a dependência de tamanho de string original) e compara os
 * digests com um loop XOR de tempo constante — sem early-return no primeiro
 * byte diferente (`indexOf`/`===` de string vazam timing proporcional ao
 * prefixo em comum, permitindo um ataque de timing byte-a-byte contra o
 * token). Endurecimento leve (#3081) — o vetor prático é de baixo risco (rede
 * já introduz jitter maior que a diferença de timing), mas a defesa é barata.
 */
async function timingSafeEqualStr(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [digestA, digestB] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const viewA = new Uint8Array(digestA);
  const viewB = new Uint8Array(digestB);
  let diff = 0;
  for (let i = 0; i < viewA.length; i++) diff |= viewA[i] ^ viewB[i];
  return diff === 0;
}

export async function isAuthenticated(request: Request, env: Env): Promise<boolean> {
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
  // #3081: comparação timing-safe (era `===`, timing-leaky) — ver timingSafeEqualStr.
  if (val === undefined) return false
  return timingSafeEqualStr(val, env.AUTH_TOKEN)
}

/**
 * #3653 achado 1: resolve `?limit=` da rota `/api/campaigns` sem descartar um
 * `0` explícito. O padrão antigo (`Number(raw ?? "20") || 20`) colapsava
 * `Number("0")` (falsy) pro fallback 20 -- um `?limit=0` explícito nunca
 * chegava a `fetchRecentCampaigns` como `0`, retornando 20 campanhas mesmo
 * assim. Espelha `resolveDashboardLimit` de `scripts/clarice-schedule-ramp.ts`
 * (#3643 minor 2), que corrigiu o mesmo bug do lado do CLIENTE (a URL montada
 * pro fetch) -- mas sem este fix o Worker, do lado SERVIDOR, ainda ignorava o
 * `limit=0` que chegava na querystring, então o fix do cliente não tinha
 * efeito observável fim-a-fim pra esse valor específico. `raw` ausente ou
 * não-numérico → `fallback`. Clamp de 50 (`DASHBOARD_WORKER_CLAMP`, ver
 * `scripts/clarice-schedule-ramp.ts`) continua aplicado pelo caller.
 */
// #3659: `?limit=` com valor VAZIO explícito (`raw === ""`) precisa do mesmo
// guard que `null` -- `Number("")` é `0` (não `NaN`), e `Number.isFinite(0)`
// é `true`, então sem este guard `resolveCampaignsLimitParam("")` resolvia
// pra `0` em vez do fallback, silenciosamente diferente de `?limit=0`
// (0 explícito, intencional) que o #3653 corrigiu para ser respeitado.
export function resolveCampaignsLimitParam(raw: string | null, fallback = 20): number {
  if (raw === null || raw.trim().length === 0) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export function loginPage(error = false): Response {
  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>clarice dashboard — login</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:${DSF.sans};display:flex;height:100dvh;align-items:center;justify-content:center;background:${DS.paper}}
form{background:${DS.paperEmail};padding:2rem;border-radius:8px;box-shadow:0 2px 12px rgba(0,0,0,.12);display:flex;flex-direction:column;gap:.75rem;width:min(340px,90vw)}
h1{font-size:1.1rem;font-weight:600;color:${DS.ink}}
input[type=password]{padding:.5rem .75rem;border:1px solid ${DS.rule};border-radius:6px;font-size:.9rem;width:100%}
input[type=password]:focus{outline:2px solid ${DS.brand};outline-offset:1px;border-color:${DS.brand}}
button{padding:.5rem 1rem;background:${DS.brand};color:#fff;border:none;border-radius:6px;font-size:.9rem;cursor:pointer;font-weight:500}
button:hover{filter:brightness(0.9)}
.err{color:${DS.alert};font-size:.82rem}
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

/**
 * #3644: corpo da rota `/api/campaigns`, extraído pra função própria — nunca
 * lança (BrevoRateLimitError e erros genéricos viram Response aqui dentro),
 * pra poder ser compartilhada como uma ÚNICA promise entre requests
 * concorrentes via `coalesceRefresh` (ver call site em `fetch()`). O lock KV
 * (`tryAcquireRefreshLock`) continua como 2ª linha de defesa pra requests
 * concorrentes que caem em isolates/colos diferentes, fora do alcance do
 * coalescing em memória.
 *
 * `includeScheduled` (#4786): `/api/campaigns` filtra `status=sent` por
 * design -- `fetchRecentCampaigns` busca stats por campanha (globalStats/
 * linksStats), que só existem PÓS-disparo. Mudar o DEFAULT quebraria essa
 * forma sem aviso pra quem já lê esta rota (ver o motivo real logo abaixo, no
 * bloco `#3081` do call site em `handleFetch`: automação EXTERNA que depende
 * do shape atual -- a aba Rampa NÃO é consumidora desta rota: ela é servida
 * por `buildDashboardResponse`/rota `/`, que chama `fetchRecentCampaigns`
 * diretamente, um caminho totalmente desacoplado de `/api/campaigns`, #4792).
 * `includeScheduled=true` anexa `fetchScheduledCampaigns` (campanhas
 * `status=queued`, sem stats — já usada pela rota `/` pra seção "Agendadas")
 * ao array de resposta, sem tocar o comportamento default. Consumidores que
 * dependem de enxergar campanha agendada (ex: `scripts/clarice-plan-wave.ts`
 * → `state.scheduledCount`, #4786) passam o parâmetro; automação que já lê
 * esta rota sem o parâmetro continua vendo só enviadas, byte a byte como antes.
 */
async function buildCampaignsResponse(
  request: Request,
  env: Env,
  isFresh: boolean,
  limit: number,
  includeScheduled: boolean,
): Promise<Response> {
  const cache = caches.default;
  // #4792 (fleet review): sufixo `:scheduled` -- espelha `coalesceKey` (ver
  // call site em `handleFetch`, `GET:${path}:${limit}${includeScheduled ?
  // ":scheduled" : ""}`), que já distingue as duas variantes de shape
  // (`?includeScheduled=1` anexa campanhas `queued`, sem stats, ao array).
  // Sem o sufixo aqui, o lock KV cross-colo (`tryAcquireRefreshLock`, 2ª
  // linha de defesa pra requests concorrentes em isolates/colos diferentes,
  // fora do alcance do coalescing em memória) usava a MESMA chave
  // `dash:refresh:inflight:/api/campaigns` pras duas variantes -- não
  // corrompe dado (fail-open: lock ocupado só faz a request seguir sem
  // segunda linha de defesa), mas reabria parcialmente o duplicate-fetch
  // cross-colo que o #3644 existia pra evitar.
  const path = `/api/campaigns${includeScheduled ? ":scheduled" : ""}`;
  let lockAcquired = false;
  try {
    if (!isFresh) {
      lockAcquired = await tryAcquireRefreshLock(env, path);
      if (!lockAcquired) {
        const coalesced = await buildInflightCoalescedCampaignsJson(env, limit, includeScheduled);
        if (coalesced) return coalesced;
        // Sem stale bom pra servir: prossegue com o live-fetch mesmo com o
        // lock ocupado (fail-open — pior caso é igual ao pré-#3644).
      }
    }
    const campaigns = await fetchRecentCampaigns(env, limit, isFresh);
    // #4786: agendadas são OPT-IN -- fetch separado (mesma função que a rota
    // `/` já usa pra seção "Agendadas") só quando pedido, fail-soft (uma
    // falha aqui nunca derruba a resposta principal de enviadas).
    // #4792 (fleet review): `scheduledFetchFailed` espelha o padrão `scheduledOk`
    // de `buildDashboardResponse` acima -- sem ele, rate limit/erro upstream/rede
    // vira silenciosamente `[]`, e a resposta final sai 200 normal, indistinguível
    // de "genuinamente zero campanhas agendadas". Isso reintroduzia exatamente o
    // sintoma que o #4786 existe pra resolver: `state.scheduledCount` de
    // `clarice-plan-wave.ts` ficava 0 numa falha transitória, sem sinal.
    let scheduledFetchFailed = false;
    const scheduled = includeScheduled
      ? await fetchScheduledCampaigns(env, 50, isFresh).catch((e) => {
          scheduledFetchFailed = true;
          console.error(
            "[#4786] /api/campaigns?includeScheduled=1: fetchScheduledCampaigns falhou — respondendo só enviadas:",
            e instanceof Error ? e.message : e,
          );
          return [];
        })
      : [];
    const merged = includeScheduled ? [...campaigns, ...scheduled] : campaigns;
    const response = new Response(JSON.stringify(merged, null, 2), {
      headers: {
        "Content-Type": "application/json",
        // Cache-Control: private impede proxies compartilhados de cachear metricas
        // de negocio. CDN-Cache-Control (CF-especifico) permite cache no edge do
        // proprio Worker. fresh=1 retorna no-store para o browser nao cachear o "fresh".
        "Cache-Control": isFresh ? "no-store" : "private, max-age=300",
        ...(isFresh ? {} : { "CDN-Cache-Control": "public, max-age=300" }),
        // #4792: só setado quando o fetch de agendadas de fato falhou -- permite
        // ao consumidor (`clarice-plan-wave.ts`) diferenciar zero-real de
        // falha-mascarada sem inspecionar o corpo (que tem o mesmo shape nos dois
        // casos: array de só enviadas).
        ...(scheduledFetchFailed ? { "X-Dashboard-Scheduled-Fetch": "failed" } : {}),
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
    // #4251: 403/5xx da Brevo (ex: incidente 260728 -- token-manager.brevo.com
    // fora do ar derrubando toda chamada autenticada com 403) tenta servir o
    // último array de campanhas bom conhecido em vez de simplesmente falhar --
    // consumidores de automação (ex: lookup de próxima wave Clarice, CLAUDE.md
    // #1172) dependem desta rota pra decisão, não só o painel humano.
    if (e instanceof BrevoUpstreamError && isBrevoOutageStatus(e.status)) {
      const fallback = await buildUpstreamErrorCampaignsJsonFallback(env, limit, e.status, includeScheduled);
      if (fallback) return fallback;
      return upstreamErrorResponse(e.status, false);
    }
    // #4533: erro de rede/timeout CRU do fetch() nativo pra api.brevo.com
    // (TypeError com mensagem de rede conhecida -- falha de conexão/DNS/TLS
    // -- ou AbortError/TimeoutError de um timeout) NUNCA carrega `.status`
    // HTTP (nenhuma Response chegou a existir), então nunca é (nem pode ser)
    // BrevoUpstreamError/BrevoRateLimitError -- antes deste guard caía
    // direto no 502 genérico abaixo, mesmo com um stale bom disponível no
    // KV. Mesma categoria "não sabemos se é nosso bug, serve o stale se
    // tiver" que 403/5xx estruturado já cobre acima (#4251). Ver issue
    // #4533: `clarice-check-semaphore.ts` (guard D4 de
    // `/diaria-clarice-novos`) viu ~90% de 502 nesta rota numa janela em que
    // `curl` direto pro mesmo endpoint respondia 200 o tempo todo --
    // consistente com esta lacuna (não confirmado por log direto ainda -- ver
    // console.error abaixo, adicionado por este PR pra confirmar em
    // produção).
    if (isNetworkOrTimeoutError(e)) {
      // Achado do fleet review pré-merge (PR #4540, CRITICAL): logar SEMPRE
      // que este guard disparar, com ou sem stale disponível -- antes, o log
      // só rodava no caminho SEM fallback (mais raro). No caminho comum
      // (stale disponível), a request voltava 200 silenciosamente, então um
      // bug de programação sem relação com rede que por acaso lançasse
      // TypeError (mascarado por engano como "erro de rede" se
      // `isNetworkOrTimeoutError` não fosse estreito -- ver docstring dela)
      // ficaria com ZERO log até o KV expirar (`LASTGOOD_TTL`, até 24h) ou o
      // bug ser corrigido por outro motivo.
      console.error(
        "[#4533] /api/campaigns: erro de rede/timeout no fetch pra Brevo:",
        e instanceof Error ? (e.stack ?? e.message) : String(e),
      );
      const fallback = await buildUpstreamErrorCampaignsJsonFallback(env, limit, "network_error", includeScheduled);
      if (fallback) return fallback;
      // Sem stale bom pra servir: cai no 502 genérico abaixo -- fail-honesto,
      // não há dado bom pra mascarar a falha. Critério de aceite (#4533,
      // "Sugestão de investigação" itens 1-2): logar o erro cru + servir o
      // fallback stale quando disponível; sem stale, nunca inventar dado.
    }
    // #4187: `e` nem sempre é um Error (fetch nativo/dependência externa pode
    // lançar qualquer valor) -- (e as Error).message em cima de um não-Error
    // é `undefined`, e o `${...}` template literal aceita isso sem lançar
    // (interpola a string "undefined"). Mantido defensivo mesmo assim para
    // consistência com o guard equivalente abaixo (buildDashboardResponse),
    // onde o mesmo padrão ALIMENTA escHtml() e lá sim pode lançar.
    console.error(
      "[#4533] /api/campaigns: sem fallback estruturado pra este erro -- servindo 502:",
      e instanceof Error ? (e.stack ?? e.message) : String(e),
    );
    return new Response(`Brevo fetch error: ${e instanceof Error ? e.message : String(e)}`, { status: 502 });
  } finally {
    if (lockAcquired) await releaseRefreshLock(env, path);
  }
}

/**
 * #3644: corpo da rota `/`, extraído pra função própria pelo mesmo motivo de
 * `buildCampaignsResponse` acima — nunca lança, compartilhável via
 * `coalesceRefresh`.
 */
async function buildDashboardResponse(request: Request, env: Env, isFresh: boolean): Promise<Response> {
  const cache = caches.default;
  const path = "/";
  let lockAcquired = false;
  // Créditos do plano declarados FORA do try: buscados ANTES das campanhas
  // (janela de rate-limit fresca) e reusados pelo fallback de 429 em memória.
  // Sem isso o fallback lia "kv-only" e o KV nunca era populado (o fetch que o
  // populava rodava DEPOIS das campanhas, pulado pelo 429) → "indisponível".
  let planCredits: number | null = null;
  try {
    // #3644: lock de coalescing cross-isolate (2ª linha de defesa) — antes de
    // disparar o live-fetch (~150 chamadas Brevo), tenta adquirir o lock desta
    // rota. Se outra request (outro isolate/colo) já está com ele, serve o
    // fallback stale-mas-recente em vez de duplicar o fetch inteiro.
    // #3653 achado 2: movido pra DENTRO do try (era antes/fora dele) — espelha
    // a estrutura de `buildCampaignsResponse` acima, onde o mesmo bloco já
    // vive dentro do try/finally. `buildInflightCoalescedFallback` chama
    // `readKvTabs` antes do próprio try dela começar; hoje toda leitura que
    // ela toca já é defensivamente blindada (não lança na prática), mas manter
    // o bloco fora do try aqui era uma assimetria estrutural desnecessária —
    // uma exceção genuína aqui escaparia do catch/finally desta função e
    // vazaria sem tratamento pelo call site (`coalesceRefresh`), cujo
    // `.finally()` só limpa a entrada do Map, não converte a rejection em
    // Response.
    if (!isFresh) {
      lockAcquired = await tryAcquireRefreshLock(env, path);
      if (!lockAcquired) {
        const coalesced = await buildInflightCoalescedFallback(env);
        if (coalesced) return coalesced;
        // Sem stale bom pra servir: prossegue com o live-fetch mesmo com o lock
        // ocupado (fail-open — pior caso é igual ao comportamento pré-#3644).
      }
    }
    type CampaignRow = Awaited<ReturnType<typeof fetchRecentCampaigns>>[number];
    let campaigns: CampaignRow[];
    let scheduled: CampaignRow[];
    let dataGeneratedAt: string;
    // #3080: limite de campanhas pedido pra `campaigns` neste render — usado
    // pra decidir se a janela está "cheia" (defesa em profundidade nas
    // agregações de "Totais por mês"/"Volume no ciclo", ver sections-core.ts).
    let campaignsWindowLimit: number | null = null;

    // #3553 (parte B): Cron Trigger removido — toda request faz fetch ao
    // vivo na Brevo (o cache de borda 5min via Cache API, checado acima,
    // já limita isso a 1 fetch real a cada 5min mesmo com múltiplos
    // visitantes; `?fresh=1` bypassa esse cache de borda também). O KV
    // `dash:lastgood:campaigns` deixou de ser lido aqui como fonte
    // primária — só é lido em buildRateLimitFallback (brevo-api.ts),
    // quando o fetch abaixo lança BrevoRateLimitError.
    //
    // #2910: créditos do plano Brevo PRIMEIRO — 1 chamada barata a
    // /v3/account com a janela de rate-limit fresca, antes do fetch
    // pesado de campanhas (~100 GETs). Fail-soft: cai pro KV/null se
    // falhar, nunca lança.
    planCredits = await fetchPlanCredits(env, isFresh ? "fresh" : "cached").catch(() => null);
    // #2268: agendadas PRIMEIRO — a listagem `queued` (1 chamada barata) pega a
    // janela de rate-limit fresca, antes do fetch pesado de enviadas (que após
    // o #2260 faz 2 GETs/campanha). Falha degrada pra [] (seção oculta) mas
    // NÃO silenciosa — loga, pra não esconder regressão. fetchScheduledCampaigns
    // já retenta a listagem em 429 internamente (#2268).
    let scheduledOk = true;
    scheduled = await fetchScheduledCampaigns(env, 50, isFresh).catch((e) => {
      scheduledOk = false; // #2733: render degradado não vira o cache de campanhas
      console.error("[#2268] fetchScheduledCampaigns falhou — seção de agendadas oculta:", e instanceof Error ? e.message : e);
      return [];
    });
    // #3080: janela subida de 50 → CAMPAIGNS_FETCH_LIMIT (100, teto real da
    // Brevo — ver docstring da constante, incidente 260710).
    campaigns = await fetchRecentCampaigns(env, CAMPAIGNS_FETCH_LIMIT, isFresh); // #2142 review: rota / hardcodava 20 e ignorava o default novo
    dataGeneratedAt = new Date().toISOString();
    campaignsWindowLimit = CAMPAIGNS_FETCH_LIMIT;
    // #3553: write-through — persiste em dash:lastgood:campaigns a cada
    // fetch bem-sucedido fora de ?fresh=1 (mesmo guard de sempre), pra
    // buildRateLimitFallback ter um valor recente quando o Brevo entrar
    // em rate-limit numa request futura. `?fresh=1` nunca escreve
    // (comportamento preservado do #3079).
    if (scheduledOk && env.STATS_CACHE && !isFresh) {
      const payload: LastGoodCampaignsPayload = {
        campaigns,
        scheduled,
        generatedAt: dataGeneratedAt,
        campaignsLimit: CAMPAIGNS_FETCH_LIMIT, // #3080
      };
      await env.STATS_CACHE
        .put(LASTGOOD_CAMPAIGNS_KEY, JSON.stringify(payload), { expirationTtl: LASTGOOD_TTL })
        .catch(() => { /* erro de KV nunca bloqueia o render */ });
    }

    // #2733: seções KV-independentes (coortes, MV, contatos, cupons) — sempre
    // frescas do KV, tanto aqui quanto no fallback de rate-limit do Brevo.
    const { cohorts, mvStatus, contactsSummary, couponUsage, eiaEngagement, postmasterSpam, hourTestState } = await readKvTabs(env, isFresh ? "fresh" : "cached"); // #5189: hourTestState
    // #4184: só ciclos MENSAIS (naming "Clarice News AAMM-MM — X", ver
    // parseClariceCampaignKey) têm prioritized.md/mapa de seção — campanhas
    // diárias não entram aqui e caem no fallback "—" sem custo extra.
    const monthlyCycles = collectMonthlyLinkCycles([...campaigns, ...scheduled]);
    // #4515: aba brevo_diaria (canal Brevo SEPARADO da Clarice) roda em
    // PARALELO com as 2 leituras de link-section acima — nenhuma depende do
    // resultado das outras, e serializar adicionaria latência a TODO load do
    // dashboard principal da Clarice só por causa de uma aba secundária.
    // `fetchBrevoDiariaTabData` já é fail-soft por construção (nunca lança —
    // ver docstring em brevo-diaria.ts); o `.catch` aqui é defesa em
    // profundidade (mesmo padrão do resto desta função) — uma falha
    // inesperada neste canal SECUNDÁRIO nunca pode derrubar o dashboard
    // principal da Clarice.
    const [linkSectionsByCycle, linkTitlesByCycle, brevoDiaria] = await Promise.all([
      readLinkSectionsByCycle(env, monthlyCycles),
      readLinkTitlesByCycle(env, monthlyCycles), // #4198
      fetchBrevoDiariaTabData(env, isFresh).catch((e) => {
        console.error("[#4515] brevo_diaria tab: falha inesperada fora do fail-soft interno:", e instanceof Error ? e.message : e);
        return null;
      }),
    ]);
    const html = renderDashboardHtml(campaigns, scheduled, cohorts, mvStatus, contactsSummary, couponUsage, eiaEngagement, planCredits, dataGeneratedAt, campaignsWindowLimit, postmasterSpam, { linkSectionsByCycle, linkTitlesByCycle, brevoDiaria, hourTestState }); // #5189
    const response = new Response(html, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": isFresh ? "no-store" : "private, max-age=300",
        ...(isFresh ? {} : { "CDN-Cache-Control": "public, max-age=300" }),
      },
    });
    if (!isFresh) {
      await cache.put(request, response.clone());
    }
    return response;
  } catch (e) {
    if (e instanceof BrevoRateLimitError) {
      // #2733: em vez de servir o HTML inteiro congelado (#2280), re-renderiza
      // com campanhas Brevo STALE (do KV) + abas de KV FRESCAS. Assim uma janela
      // de rate-limit do Brevo nunca esconde dado KV recém-publicado (o bug
      // original: aba de Cupons pós-deploy oculta). Throw-safe: degrada p/ 503.
      return buildRateLimitFallback(env, e.retryAfterSecs, planCredits);
    }
    // #4251: mesmo caminho do 429 acima, mas pra 403/5xx da Brevo (ex:
    // incidente 260728 -- token-manager.brevo.com fora do ar, Brevo devolvendo
    // 403 pra qualquer chamada autenticada). Antes disto o painel só falhava
    // com 502 cru -- agora serve o último dado bom com aviso de defasagem.
    if (e instanceof BrevoUpstreamError && isBrevoOutageStatus(e.status)) {
      return buildUpstreamErrorFallback(env, e.status, planCredits);
    }
    // #4187 (achado do diagnóstico do 1101): `e` nem sempre é um Error --
    // `(e as Error).message` num valor não-Error é `undefined`, e
    // `escHtml(undefined)` lança (`.replace` em `undefined`) DENTRO deste
    // catch, sem nenhum try em volta -- exatamente o tipo de exceção que
    // escapa até o `fetch()` handler e vira Error 1101 no Cloudflare. Guard
    // torna este catch genuinamente never-throw, fechando essa lacuna
    // independente de qualquer causa raiz específica.
    return new Response(
      `<!DOCTYPE html><html><body><h1>Dashboard error</h1><p>${escHtml(e instanceof Error ? e.message : String(e))}</p></body></html>`,
      { status: 502, headers: { "Content-Type": "text/html; charset=utf-8" } },
    );
  } finally {
    // #3644: libera o lock assim que o live-fetch termina (sucesso ou falha) —
    // não deixa a próxima request esperar o TTL inteiro à toa. O TTL continua
    // como rede de segurança (worker morto no meio da request, etc).
    if (lockAcquired) await releaseRefreshLock(env, path);
  }
}

/**
 * #4187: corpo original do handler `fetch()` -- extraído pra função própria
 * pra poder ser envolvido por um catch de última instância abaixo (`export
 * default.fetch`). Toda a lógica de roteamento já existente permanece
 * INALTERADA aqui; a mudança real é só a camada de segurança que a envolve.
 */
async function handleFetch(request: Request, env: Env): Promise<Response> {
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
          // 403 genérico (não 500 nomeando a causa exata): um scanner externo
          // não deve conseguir distinguir "AUTH_TOKEN nunca configurado" (mais
          // interessante de tentar de novo) de "configurado, token errado" —
          // e 500 sugeriria erro de servidor pra monitoramento externo, quando
          // é uma negação de acesso deliberada.
          if (!env.AUTH_TOKEN) return new Response('Acesso negado.', { status: 403 })
          if (/[;\r\n]/.test(env.AUTH_TOKEN)) return new Response('Invalid AUTH_TOKEN configuration', { status: 500 })
          // #3081 (achado no /code-review max): comparação timing-safe aqui
          // também — antes só o cookie-check (isAuthenticated) tinha sido
          // endurecido, deixando este outro comparador do MESMO segredo
          // (AUTH_TOKEN) exposto ao mesmo timing leak que a PR se propôs a
          // eliminar. `/login` é o alvo mais natural de brute-force (aceita
          // tentativas repetidas não-autenticadas), então esta era a lacuna
          // mais importante a fechar, não a menos.
          if (token && (await timingSafeEqualStr(token, env.AUTH_TOKEN))) {
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

      if (!(await isAuthenticated(request, env))) {
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

    // #3081: decisão explícita, registrada aqui — `/api/campaigns` permanece
    // PÚBLICA (sem auth), por design, não por descuido. Motivo: consumidores de
    // automação interna (ex: lookup de próxima lista da migração Clarice, ver
    // CLAUDE.md — `fetch https://clarice-dashboard.diaria.workers.dev/api/campaigns?limit=5`
    // chamado pelo orchestrator/skills SEM cookie de sessão) dependem deste
    // endpoint hoje. Adicionar auth aqui quebraria essa automação sem aviso.
    // O payload já é considerado aceitável sem PII (stats agregadas de
    // campanha — não confundir com `/api/coupons`, que EXIGE auth por conter
    // e-mail de clientes, ver bloco abaixo). Se blindar esta rota no futuro,
    // precisa vir acompanhado de migração dos consumidores internos pra um
    // método de auth compatível com automação (ex: header de service token).
    if (path === "/api/campaigns") {
      // #3080: clamp mantido em 50 (não CAMPAIGNS_FETCH_LIMIT) — esta rota, ao
      // contrário de "/", ainda faz o fetch SÍNCRONO em request-time (não passou
      // pelo #3079/Cron Trigger). Subir o clamp aqui reintroduziria a latência
      // que o #2144 já havia mitigado. Consumidores desta rota (ex: dashboard
      // Clarice migration lookup, ver CLAUDE.md) pedem poucas campanhas recentes
      // (`?limit=5`), não o histórico completo — não precisam da janela maior.
      const limit = Math.min(50, resolveCampaignsLimitParam(url.searchParams.get("limit")));
      // #4786: opt-in -- anexa campanhas AGENDADAS (status=queued, sem stats)
      // ao array de resposta. Default (ausente) preserva o shape de sempre
      // (só enviadas) -- ver docstring de buildCampaignsResponse pro porquê
      // do filtro `status=sent` ser deliberado e não um bug a corrigir.
      const includeScheduled = url.searchParams.get("includeScheduled") === "1";
      // #3644: buildCampaignsResponse roda o live-fetch (+ o lock KV cross-colo,
      // internamente) e SEMPRE resolve pra uma Response (nunca lança) — é o que
      // permite compartilhar a MESMA promise entre requests concorrentes via
      // coalesceRefresh (defesa primária, same-isolate). `?fresh=1` nunca
      // coalesce (bypassa cache/lock por design já existente).
      const buildOnce = () => buildCampaignsResponse(request, env, isFresh, limit, includeScheduled);
      // #4786: sufixo SÓ quando includeScheduled=1 -- preserva a chave exata
      // `GET:/api/campaigns:{limit}` do caso default (travada em teste,
      // brevo-dashboard-thundering-herd-3644.test.ts), evitando coalescer
      // junto 2 variantes de resposta com shape diferente.
      const coalesceKey = `GET:${path}:${limit}${includeScheduled ? ":scheduled" : ""}`;
      const shared = isFresh ? await buildOnce() : await coalesceRefresh(coalesceKey, buildOnce);
      // Response compartilhada entre N callers concorrentes -- cada um recebe seu
      // próprio clone (o corpo original nunca é lido diretamente, então pode ser
      // clonado múltiplas vezes com segurança).
      return shared.clone();
    }

    // #4131 finding 4: expõe a leitura do Postmaster (`postmaster:spam`,
    // gravada automaticamente por scripts/postmaster-spam-sync.ts a cada 12h
    // desde #4154, ou manualmente por scripts/postmaster-spam-entry.ts como
    // fallback) pra automação externa — sem isso, `scripts/clarice-schedule-ramp.ts`
    // (que roda fora do Worker, sem acesso ao binding STATS_CACHE) nunca
    // enxergava a leitura e o semáforo do auto-cálculo de volume ficava
    // travado em "yellow" pra sempre (nunca escalonava, mesmo com uma leitura
    // fresca registrada — ver `deriveRampVolumes`/`fetchPostmasterSpamEntry`).
    // Pública como `/api/campaigns` (mesmo racional: automação interna sem
    // cookie de sessão) — payload é só um %, um timestamp e a origem, sem PII.
    if (path === "/api/postmaster-spam") {
      const raw = env.STATS_CACHE ? await env.STATS_CACHE.get(POSTMASTER_SPAM_KV_KEY, "json").catch(() => null) : null;
      const entry = normalizePostmasterSpamEntry(raw);
      return new Response(JSON.stringify({ entry }), {
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      });
    }

    // #2718: rota de cupons — requer auth explícita (PII: emails de clientes).
    // Não está inclusa na isenção /api/* (que é para automação interna sem cookie).
    if (path === "/api/coupons") {
      if (!(await isAuthenticated(request, env))) return loginPage();
      const data = await getCouponUsage(env, isFresh ? "fresh" : "cached");
      if (!data) return new Response("Not found", { status: 404 });
      return new Response(JSON.stringify(data, null, 2), {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": isFresh ? "no-store" : "private, max-age=300",
        },
      });
    }

    // #3257: botão "Atualizar" da aba Engajamento (É IA?/"Por edição") — dispara
    // o mesmo pipeline de `scripts/build-poll-eia-data.ts --push` (ramo mensal),
    // mas rodando DENTRO do worker (fetch em GET /editions + /stats do worker
    // `poll`, grava direto no KV local STATS_CACHE — sem depender de
    // `data/monthly/` local nem de credenciais Cloudflare cross-worker). Requer
    // auth explícita (mutação de KV) — igual ao padrão de /api/coupons acima,
    // não a isenção geral de /api/* (essa é só pra leitura pública de automação).
    if (path === "/api/eia/refresh" && request.method === "POST") {
      if (!(await isAuthenticated(request, env))) return loginPage();
      const result = await refreshEiaEngagement(env);
      if (result.ok) {
        // Redireciona de volta pro dashboard com bypass de cache (?fresh=1) e
        // já na aba Engajamento (#panel-engajamento — mesmo id que o JS de
        // deep-link/#2622 reconhece) pra o editor ver o dado atualizado na hora.
        return new Response(null, {
          status: 302,
          headers: { Location: "/?fresh=1#panel-engajamento", "Cache-Control": "no-store" },
        });
      }
      return new Response(
        `<!DOCTYPE html><html><body><h1>Refresh do É IA? falhou</h1><p>${escHtml(result.error)}</p><p><a href="/#panel-engajamento">← Voltar pro dashboard</a></p></body></html>`,
        { status: 502, headers: { "Content-Type": "text/html; charset=utf-8" } },
      );
    }

    if (path === "/" || path === "/index.html") {
      // #3644: buildDashboardResponse roda o live-fetch (+ lock KV cross-colo,
      // internamente) e SEMPRE resolve pra uma Response (nunca lança) — permite
      // compartilhar a MESMA promise entre requests concorrentes via
      // coalesceRefresh (defesa primária, same-isolate — ver docstring da função
      // em brevo-api.ts). `?fresh=1` nunca coalesce (bypassa cache/lock por
      // design já existente). Chave normaliza "/" e "/index.html" pro mesmo
      // slot -- são a mesma rota efetivamente.
      const buildOnce = () => buildDashboardResponse(request, env, isFresh);
      const shared = isFresh ? await buildOnce() : await coalesceRefresh("GET:/", buildOnce);
      return shared.clone();
    }

    return new Response("Not found", { status: 404 });
}

export default {
  /**
   * #4187: catch de última instância -- `Error 1101` do Cloudflare é sempre
   * uma exceção JS não-tratada escapando deste handler, independente da
   * causa raiz (Brevo, KV, bug de render ainda não catalogado). Todo o
   * roteamento real (auth, cache de borda, rotas) já é feito por
   * `handleFetch`, cujas rotas individuais já têm seus próprios catches
   * específicos (BrevoRateLimitError → fallback stale, erro genérico → 502)
   * -- este é o piso: se ALGO mesmo assim escapar de todos eles, nunca deixa
   * a exceção subir pro runtime. `buildFatalErrorFallback` por si só já não
   * lança (degrada internamente pro estado mínimo em qualquer falha), mas o
   * `try/catch` extra aqui é defesa em profundidade -- o mesmo tipo de
   * promessa que várias funções já faziam antes deste incidente.
   */
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await handleFetch(request, env);
    } catch (e) {
      try {
        return await buildFatalErrorFallback(env, e);
      } catch {
        return new Response("Dashboard indisponível. Tente novamente em instantes.", {
          status: 500,
          headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
        });
      }
    }
  },
  // #3553 (parte B): scheduled() (Cron Trigger) removido — sem `[triggers]`
  // em wrangler.toml, nenhuma atualização automática roda mais neste Worker.
  // O refresh de campanhas passou a ser em request-time (ver rota `/` acima).
};
