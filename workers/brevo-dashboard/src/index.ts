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

import type { Env } from "./types.ts";
export * from "./types.ts";
export * from "./render-links.ts";
export * from "./billing-cycle.ts";
export * from "./staleness.ts";
export * from "./sections-kv.ts";
export * from "./brevo-api.ts";
export * from "./sections-core.ts";
export * from "./weekly-plan.ts";
// #3078: DEFAULT_HEALTH_THRESHOLDS/HealthThresholds já chegam via weekly-plan.ts
// (reexportados lá) — export nomeado aqui evita ambiguidade de `export *` duplicado.
export { isBounceBreach } from "./thresholds.ts";

import {
  fetchRecentCampaigns,
  fetchScheduledCampaigns,
  getCouponUsage,
  readKvTabs,
  buildRateLimitFallback,
  rateLimitResponse,
  BrevoRateLimitError,
  LASTGOOD_CAMPAIGNS_KEY,
  CAMPAIGNS_FETCH_LIMIT,
  fetchPlanCredits,
  runCronRefresh,
  type LastGoodCampaignsPayload,
} from "./brevo-api.ts";
import { LASTGOOD_TTL } from "./types.ts";
import { renderDashboardHtml, escHtml } from "./sections-core.ts";

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
    // e-mail de clientes, ver bloco acima). Se blindar esta rota no futuro,
    // precisa vir acompanhado de migração dos consumidores internos pra um
    // método de auth compatível com automação (ex: header de service token).
    if (path === "/api/campaigns") {
      try {
        // #3080: clamp mantido em 50 (não CAMPAIGNS_FETCH_LIMIT) — esta rota, ao
        // contrário de "/", ainda faz o fetch SÍNCRONO em request-time (não passou
        // pelo #3079/Cron Trigger). Subir o clamp aqui reintroduziria a latência
        // que o #2144 já havia mitigado. Consumidores desta rota (ex: dashboard
        // Clarice migration lookup, ver CLAUDE.md) pedem poucas campanhas recentes
        // (`?limit=5`), não o histórico completo — não precisam da janela maior.
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

    if (path === "/" || path === "/index.html") {
      // Créditos do plano declarados FORA do try: buscados ANTES das campanhas
      // (janela de rate-limit fresca) e reusados pelo fallback de 429 em memória.
      // Sem isso o fallback lia "kv-only" e o KV nunca era populado (o fetch que o
      // populava rodava DEPOIS das campanhas, pulado pelo 429) → "indisponível".
      let planCredits: number | null = null;
      try {
        type CampaignRow = Awaited<ReturnType<typeof fetchRecentCampaigns>>[number];
        let campaigns: CampaignRow[];
        let scheduled: CampaignRow[];
        let dataGeneratedAt: string;
        // #3080: limite de campanhas pedido pra `campaigns` neste render — usado
        // pra decidir se a janela está "cheia" (defesa em profundidade nas
        // agregações de "Totais por mês"/"Volume no ciclo", ver sections-core.ts).
        // `null` = desconhecido (KV pré-#3080 sem o campo) → nenhum aviso exibido.
        let campaignsWindowLimit: number | null = null;

        // #3079: default (sem ?fresh=1) lê o payload PRÉ-COMPUTADO pelo Cron
        // Trigger (scheduled() abaixo, roda a cada ~10min) em `dash:lastgood:campaigns`
        // — zero chamadas Brevo em request-time. `?fresh=1` bypassa e mantém o
        // fetch ao vivo de sempre (debug/urgência, decisão do editor #3079).
        const lastGood = (!isFresh && env.STATS_CACHE)
          ? await env.STATS_CACHE.get(LASTGOOD_CAMPAIGNS_KEY, "json").catch(() => null) as LastGoodCampaignsPayload | null
          : null;

        if (lastGood && Array.isArray(lastGood.campaigns)) {
          // Caminho pré-computado (default, #3079): nenhuma chamada à Brevo aqui.
          campaigns = lastGood.campaigns;
          scheduled = Array.isArray(lastGood.scheduled) ? lastGood.scheduled : [];
          dataGeneratedAt = typeof lastGood.generatedAt === "string" ? lastGood.generatedAt : new Date().toISOString();
          // #3080: self-describing — usa o limite gravado JUNTO deste payload
          // (pode ter sido escrito por uma versão anterior do worker com um
          // CAMPAIGNS_FETCH_LIMIT diferente do atual).
          campaignsWindowLimit = typeof lastGood.campaignsLimit === "number" ? lastGood.campaignsLimit : null;
          // #2910: créditos também vêm só do KV neste caminho (kv-only) — nunca
          // fetch ao vivo fora de ?fresh=1/cold-start (o cron já os populou).
          planCredits = await fetchPlanCredits(env, "kv-only").catch(() => null);
        } else {
          // #3079: fetch ao vivo — usado em `?fresh=1` (debug intencional) OU no
          // cold-start antes do 1º tick do cron (KV ainda vazio pós-deploy). Sem
          // este fallback o dashboard ficaria quebrado/vazio até o cron rodar.
          if (!isFresh) {
            console.warn("[#3079] dash:lastgood:campaigns vazio — fallback pra fetch ao vivo (provável cold-start antes do 1º tick do cron)");
          }
          // #2910: créditos do plano Brevo PRIMEIRO — 1 chamada barata a /v3/account
          // com a janela de rate-limit fresca, antes do fetch pesado de campanhas
          // (~100 GETs). Fail-soft: cai pro KV/null se falhar, nunca lança.
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
          // #3080: janela subida de 50 → CAMPAIGNS_FETCH_LIMIT (150) — mesmo valor
          // usado pelo cron, pra manter o mesmo comportamento de "janela cheia"
          // entre o caminho pré-computado e este fallback ao vivo (cold-start/?fresh=1).
          campaigns = await fetchRecentCampaigns(env, CAMPAIGNS_FETCH_LIMIT, isFresh); // #2142 review: rota / hardcodava 20 e ignorava o default novo
          dataGeneratedAt = new Date().toISOString();
          campaignsWindowLimit = CAMPAIGNS_FETCH_LIMIT;
          // #3079: só persiste em dash:lastgood:campaigns fora de ?fresh=1 (mesmo
          // guard de sempre) — seeda o KV no cold-start, pra requests seguintes
          // já lerem do KV até o cron rodar; ?fresh=1 nunca escreve (preserva o
          // comportamento pré-#3079).
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
        }

        // #2733: seções KV-independentes (coortes, MV, contatos, cupons) — sempre
        // frescas do KV, tanto aqui quanto no fallback de rate-limit do Brevo.
        const { cohorts, mvStatus, contactsSummary, couponUsage, eiaEngagement } = await readKvTabs(env, isFresh ? "fresh" : "cached");
        const html = renderDashboardHtml(campaigns, scheduled, cohorts, mvStatus, contactsSummary, couponUsage, eiaEngagement, planCredits, dataGeneratedAt, campaignsWindowLimit);
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
        return new Response(
          `<!DOCTYPE html><html><body><h1>Dashboard error</h1><p>${escHtml((e as Error).message)}</p></body></html>`,
          { status: 502, headers: { "Content-Type": "text/html; charset=utf-8" } },
        );
      }
    }

    return new Response("Not found", { status: 404 });
  },

  /**
   * #3079: Cron Trigger (a cada 10min — `crons` em wrangler.toml) — pré-computa o fetch
   * pesado de campanhas Brevo fora do request-time e grava em
   * `dash:lastgood:campaigns`, que a rota `/` lê por padrão (ver acima).
   * `ctx.waitUntil` garante que o Worker não seja reciclado antes do fetch (que
   * pode levar vários segundos com ~100 GETs) terminar. Nunca lança — erros são
   * logados por `runCronRefresh` e o KV mantém o último valor bom.
   */
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      runCronRefresh(env).then((result) => {
        if (result.ok) {
          console.log(`[#3079 cron] dash:lastgood:campaigns atualizado — ${result.campaignCount} campanhas, ${result.scheduledCount} agendadas`);
        } else {
          console.error(`[#3079 cron] refresh falhou — KV mantém o último valor bom: ${result.error}`);
        }
      }),
    );
  },
};
