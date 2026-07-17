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
// #3092: tokens do DS — loginPage() usava cores Cloudflare hardcoded
// (#f6821f/#f5f6f7/#dc2626) que nenhuma outra superfície do dashboard usa.
import { DS, DS_FONTS as DSF } from "./render-links.ts";

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
  type LastGoodCampaignsPayload,
} from "./brevo-api.ts";
import { LASTGOOD_TTL } from "./types.ts";
import { renderDashboardHtml, escHtml } from "./sections-core.ts";
import { refreshEiaEngagement } from "./eia-refresh.ts";
export * from "./eia-refresh.ts";

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
    // e-mail de clientes, ver bloco abaixo). Se blindar esta rota no futuro,
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
  // #3553 (parte B): scheduled() (Cron Trigger) removido — sem `[triggers]`
  // em wrangler.toml, nenhuma atualização automática roda mais neste Worker.
  // O refresh de campanhas passou a ser em request-time (ver rota `/` acima).
};
