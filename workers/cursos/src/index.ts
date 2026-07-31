/**
 * workers/cursos — Cloudflare Worker (#4052, converte de static-assets-only
 * pra scripted worker + assets).
 *
 * Gate PARCIAL (decisão do editor, ver #4052 e o follow-up #4305): os cursos
 * ABERTOS são `openCourseCount()` do catálogo — 20% arredondado pra baixo,
 * hoje 6 de 31 —, com os marcados `teaser: true` no seed ocupando as vagas
 * primeiro (`selectOpenCourses`, em `scripts/build-cursos-page.ts`). Ficam
 * completos e indexáveis no HTML público (`workers/cursos/public/index.html`,
 * servido via `env.ASSETS`). Os demais NÃO são renderizados de forma alguma —
 * nem título, nem plataforma, nem tema/contagem nos filtros — até o leitor
 * verificar assinatura ativa OU se cadastrar; só a contagem agregada aparece
 * no banner de gate. A CTA é um convite, não uma parede — nunca 403.
 *
 * Dois caminhos de entrada:
 *   A. `?email=` na URL (merge-tag da newsletter, `{{email}}`/`{{ contact.EMAIL }}`
 *      já resolvidos pelo Beehiiv/Brevo antes de chegar aqui como query
 *      param) — verifica, seta cookie, serve o conteúdo COMPLETO direto,
 *      sem nunca mostrar a tela de gate.
 *   B. Sem `?email=` e sem cookie válido — serve o teaser normal (estático);
 *      o leitor clica no banner/CTA → `GET /gate` → `POST /gate/verify` (já
 *      assinante) ou `POST /gate/subscribe` (cadastro inline, #3580 reuse).
 *
 * Rotas:
 *   GET  /                → teaser (asset estático) OU full (dinâmico, se
 *                           `?email=` válido ou cookie válido)
 *   GET  /gate             → tela de gate (gate-page.ts)
 *   POST /gate/verify      → { email } → verifica assinante ativo, seta cookie
 *   POST /gate/subscribe   → cadastro inline (honeypot+opt-in, #3580 reuse)
 *   *                       → fallback pro asset estático (env.ASSETS)
 *
 * Secrets (via `wrangler secret put`, ver PR body pro passo-a-passo):
 *   BEEHIIV_API_KEY, BEEHIIV_PUBLICATION_ID — verificação secundária
 *     (by_email, NÃO confirmada ao vivo — ver subscriber-verify.ts) e
 *     cadastro inline (subscribe.ts).
 *   COOKIE_HMAC_SECRET — assina o cookie de sessão (cookie.ts).
 *
 * KV: `CURSOS_SUBSCRIBERS` — populado por `scripts/sync-cursos-subscribers-kv.ts`
 * (chave `subscriber:{sha256(email)}`, ver `lib/shared/subscriber-verify.ts`).
 */
import { CURSOS_FULL_HTML } from "./courses-full.generated.ts";
import { renderGatePage } from "./gate-page.ts";
import { checkGateRateLimit, checkGateSubscriber, shouldRecheckPendingSession } from "./gate.ts";
import { clearSessionCookieHeader, issueSessionCookie, readSession } from "./cookie.ts";
import { handleGateSubscribe, isValidEmailFormat } from "./subscribe.ts";
import { CURSOS_ALARM_COUNTER_KEYS, incrementKvCounter } from "../../../scripts/lib/shared/cursos-alarm-counters.ts";

export interface Env {
  ASSETS: Fetcher;
  /** #4052: KV do sync de assinantes ativos — chave `subscriber:{sha256(email)}`.
   * Criar via `wrangler kv namespace create CURSOS_SUBSCRIBERS` (ver PR body). */
  CURSOS_SUBSCRIBERS: KVNamespace;
  /** Secret — assina/verifica o cookie de sessão (`cookie.ts`). SEM ela o
   * worker não consegue emitir sessão nenhuma; configurar antes do deploy. */
  COOKIE_HMAC_SECRET: string;
  /** Secrets opcionais — verificação secundária + cadastro inline via Beehiiv
   * (mesmo padrão de `workers/poll/src/index.ts` #3580: ausentes → endpoint
   * responde `subscribe_unavailable`/só usa o path KV, nunca quebra). */
  BEEHIIV_API_KEY?: string;
  BEEHIIV_PUBLICATION_ID?: string;
  BEEHIIV_API_URL?: string;
  BEEHIIV_NAME_FIELD?: string;
  ALLOWED_ORIGINS?: string;
  _requestOrigin?: string | null;
}

export function corsHeaders(env: Env): Record<string, string> {
  const base = { "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" };
  const configured = (env.ALLOWED_ORIGINS ?? "").trim();
  if (configured === "" || configured === "*") return { "Access-Control-Allow-Origin": "*", ...base };
  const allowed = configured.split(",").map((o) => o.trim()).filter(Boolean);
  const origin = env._requestOrigin;
  if (origin && allowed.includes(origin)) return { "Access-Control-Allow-Origin": origin, Vary: "Origin", ...base };
  return base;
}

export function json(data: unknown, status = 200, env?: Env, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...(env ? corsHeaders(env) : {}), ...extraHeaders },
  });
}

function html(body: string, extraHeaders: Record<string, string> = {}): Response {
  return new Response(body, { headers: { "Content-Type": "text/html;charset=utf-8", ...extraHeaders } });
}

/** #4305: paths que servem o MESMO asset (`public/index.html`) e portanto
 * precisam passar pelo gate. Tem que casar com o `run_worker_first` do
 * `wrangler.toml` — declarar lá um path que `fetch` não roteia pra
 * `handleIndex` faz o script rodar só pra devolver o teaser cru, um gate que
 * promete cobertura e não entrega (travado por `test/cursos-worker-first.test.ts`). */
export const GATED_INDEX_PATHS = ["/", "/index.html"];

/** Handler do index — resolve qual variante servir. Path A (`?email=`) tem
 * prioridade sobre o cookie (a newsletter é a fonte de verdade mais fresca);
 * cookie é o fallback pra navegação subsequente na mesma sessão.
 *
 * #4305: fail-soft. Antes do `run_worker_first`, o asset era servido sem o
 * script rodar, então nada aqui podia derrubar a home. Agora TODA visita a
 * `/` depende deste handler terminar — um throw do KV (`kv.get` não é
 * envolvido em try/catch em lugar nenhum da cadeia) passaria direto pro
 * `fetch` e derrubaria a página inteira. O catch devolve o teaser: degradar
 * pra "todo mundo vê o teaser" é aceitável, derrubar a home não.
 *
 * O custo disso é observabilidade — 200 silencioso não aparece no gráfico de
 * erro nativo do Cloudflare como um 500 apareceria. Mitigado desde #4320:
 * todo caminho de degradação deste handler loga, `[observability]` está
 * ligado no `wrangler.toml`, e agora `scripts/cursos-error-alarm.ts` consome
 * esses logs (Cloudflare GraphQL Analytics API) numa cadência agendada (task
 * "Diaria-Cursos-Error-Alarm", a cada 2h — ver
 * `scripts/setup-cursos-error-alarm-schedule.ps1`) e alarma o editor por
 * e-mail quando uma linha fatal aparece ou a taxa de `?email= não
 * confirmado` estoura o limiar. Ainda vale a ressalva de que Workers Logs
 * amostra sob volume alto (o sinal pode degradar justo durante uma pane
 * total), mas o caminho de descoberta deixou de ser "um leitor reclamar". */
async function handleIndex(request: Request, env: Env): Promise<Response> {
  try {
    const url = new URL(request.url);
    const emailParam = (url.searchParams.get("email") || "").trim();

    // #4305: sem o secret do HMAC não dá pra emitir nem ler sessão — a
    // assinatura em si NÃO fica fraca (`TextEncoder().encode(undefined)`
    // devolve buffer vazio sem lançar, mas o `crypto.subtle.importKey`
    // seguinte rejeita chave de tamanho zero com `DataError`, por spec da
    // WebCrypto — verificado). Ou seja: sem o guard isto QUEBRA, não vaza. O
    // guard troca esse throw por degradação explícita e logada. Mesmo guard de
    // `workers/poll/src/web-gate.ts`.
    const canIssueSession = Boolean(env.COOKIE_HMAC_SECRET);
    if (!canIssueSession) {
      // Este ramo é a única degradação que NÃO passa pelo catch abaixo (é
      // desvio de fluxo, não exceção) — sem log próprio, um deploy sem o
      // secret serviria teaser pra assinante ativo vindo da newsletter com
      // zero sinal em qualquer camada: nem status HTTP, nem log.
      console.error("[cursos] COOKIE_HMAC_SECRET ausente — servindo teaser; NINGUÉM consegue desbloquear");
      // #4382: contraparte em KV do log acima — scripts/cursos-error-alarm.ts
      // lê este contador (não mais grep de texto via Cloudflare GraphQL
      // Analytics API, dataset inexistente — ver scripts/lib/cursos-error-alarm.ts).
      await incrementKvCounter(env.CURSOS_SUBSCRIBERS, CURSOS_ALARM_COUNTER_KEYS.fatalCookieHmacSecretAusente);
    }

    // #4305: os dois ramos abaixo logam SEM o endereço. O anti-probing do
    // #4052 exige que a RESPOSTA não distinga os casos — o log do servidor é
    // invisível pro visitante e não enfraquece nada disso. Sem ele, uma
    // merge tag quebrada (Beehiiv mandando `{{email}}` cru, lista errada
    // sincronizada pro KV) produz exatamente este caminho em 100% dos cliques
    // da newsletter e fica indistinguível do tráfego normal de quem não
    // assina. O e-mail em si fica DE FORA destes dois `console.warn` — eles
    // não interpolam `emailParam` em lugar nenhum. Isso vale só pra estes
    // dois ramos: o handler como um todo (incluindo o `catch` genérico lá
    // embaixo, que loga `request.url` cru) também garante isso, mas por outro
    // mecanismo — redação explícita do param `email` antes de logar, não
    // ausência de interpolação. Despejar endereço em log de plataforma é
    // vazamento de PII a troco de nada — a contagem é o que importa, não
    // quem.
    if (canIssueSession && emailParam && !isValidEmailFormat(emailParam)) {
      console.warn("[cursos] ?email= presente mas malformado — provável merge tag não resolvida");
    }

    if (canIssueSession && emailParam && isValidEmailFormat(emailParam)) {
      const outcome = await checkGateSubscriber(env, emailParam);
      if (outcome.status === "active") {
        // #4320: contraparte do log de "não confirmado" logo abaixo — sem
        // este log, o caminho de SUCESSO nunca aparecia em nenhuma linha,
        // e o alarme de taxa (scripts/cursos-error-alarm.ts) não tinha
        // denominador pra calcular "% não confirmado" (só o numerador).
        // Mesmo cuidado de redação dos dois `console.warn` logo abaixo:
        // NUNCA interpola `emailParam` — a contagem é o que importa, não
        // quem.
        console.log("[cursos] ?email= confirmado como assinante ativo — desbloqueado");
        // #4382: denominador da taxa "?email= não confirmado" que o alarme lê.
        await incrementKvCounter(env.CURSOS_SUBSCRIBERS, CURSOS_ALARM_COUNTER_KEYS.emailGateConfirmed);
        const setCookie = await issueSessionCookie(env.COOKIE_HMAC_SECRET, emailParam);
        return html(CURSOS_FULL_HTML, { "Set-Cookie": setCookie });
      }
      // #4052: e-mail na URL mas não confirmado ativo — NUNCA vaza esse sinal
      // pro leitor (poderia ser link velho/editado à mão); cai pro teaser
      // normal, igual a não ter mandado `?email=` nenhum. Do lado do servidor,
      // porém, isto é o sinal de saúde do caminho A: taxa baixa é normal, taxa
      // de 100% é o gate quebrado de novo.
      //
      // #4321: `reason` distingue "verificamos e não é assinante" (warn, taxa
      // é o sinal) de "não conseguimos verificar" (error — Beehiiv fora do
      // ar/key rotacionada/rate-limit; sinal distinto, não deve se misturar
      // com a taxa de negativo confirmado nem no alarme nem no dashboard de
      // logs). A resposta ao visitante não muda em nenhum dos dois ramos.
      if (outcome.reason === "verification_failed") {
        console.error(
          "[cursos] ?email= — verificação Beehiiv falhou (rede/401/403/429/5xx) — servindo teaser mesmo assim",
        );
        // #4321/#4382: `verification_failed` fica DE FORA de ambos os
        // contadores da taxa (nem confirmed nem not-confirmed) — não deve se
        // misturar com o sinal de negativo confirmado.
      } else {
        console.warn("[cursos] ?email= não confirmado como assinante ativo — servindo teaser");
        await incrementKvCounter(env.CURSOS_SUBSCRIBERS, CURSOS_ALARM_COUNTER_KEYS.emailGateNotConfirmed);
      }
    }

    if (canIssueSession) {
      const session = await readSession(env.COOKIE_HMAC_SECRET, request.headers.get("Cookie"));
      if (session && !session.pending) return html(CURSOS_FULL_HTML);
      // #4323: sessão `pending` (cadastro feito via /gate/subscribe, Beehiiv
      // ainda não tinha confirmado `status: "active"` na hora) — reconsulta
      // o mesmo `checkGateSubscriber` do path `?email=`/`gate/verify`; se já
      // confirmou ativo, promove pra sessão completa nesta visita (mesmo
      // mecanismo de promoção do `workers/poll/src/web-gate.ts`, #4121: "na
      // próxima visita ou no /gate/verify seguinte"). Sem isso, quem assinou
      // e cujo double opt-in não confirmou na mesma resposta ficaria preso
      // no teaser mesmo depois de confirmar, até refazer o cadastro.
      // #4387: sem isto, TODO reload de `/` com sessão pending disparava
      // `checkGateSubscriber` de novo — que cai pra uma chamada AO VIVO da
      // Beehiiv quando o KV ainda não sincronizou (sync roda só 1x/dia). O
      // cooldown é por SESSÃO (hash do e-mail), não por IP — ver docstring de
      // `shouldRecheckPendingSession` em gate.ts pro porquê.
      if (session && session.pending) {
        const shouldRecheck = await shouldRecheckPendingSession(env.CURSOS_SUBSCRIBERS, session.email);
        if (shouldRecheck) {
          const outcome = await checkGateSubscriber(env, session.email);
          if (outcome.status === "active") {
            const setCookie = await issueSessionCookie(env.COOKIE_HMAC_SECRET, session.email);
            return html(CURSOS_FULL_HTML, { "Set-Cookie": setCookie });
          }
        }
      }
    }
  } catch (err) {
    // Contexto no log: sem ele não dá pra distinguir "um request com azar" de
    // "100% dos requests falhando" num `wrangler tail`. `?email=` é redigido
    // antes de logar — este catch é genérico (qualquer exceção não tratada
    // no bloco acima) e uma URL com e-mail de assinante real não pode virar
    // PII em log de plataforma. Se o próprio `new URL(request.url)` lançar
    // (URL malformada — não deveria, o runtime já validou pra chegar aqui),
    // cai no fallback com a URL inteira omitida, nunca com o cru.
    const safeUrl = (() => {
      try {
        const u = new URL(request.url);
        if (u.searchParams.has("email")) u.searchParams.set("email", "[redacted]");
        return u.toString();
      } catch {
        return "[url indisponível]";
      }
    })();
    console.error(
      `[cursos] handleIndex falhou (url=${safeUrl}, cookie=${request.headers.has("Cookie")}) — degradando pro teaser:`,
      err,
    );
  }

  return env.ASSETS.fetch(request);
}

/** Handler `POST /gate/verify` — só verificação (sem criar assinante). */
async function handleGateVerify(request: Request, env: Env): Promise<Response> {
  // #4305: fail-closed — sem o secret do HMAC a emissão de sessão quebra (ver
  // `handleIndex`). 503 explícito em vez de exceção não-tratada: o front
  // distingue os dois (`gate_unavailable` vira aviso de indisponibilidade, não
  // "e-mail não encontrado" — culpar o e-mail da pessoa por erro nosso é pior
  // que não responder).
  if (!env.COOKIE_HMAC_SECRET) {
    console.error("[cursos] COOKIE_HMAC_SECRET ausente — /gate/verify indisponível");
    await incrementKvCounter(env.CURSOS_SUBSCRIBERS, CURSOS_ALARM_COUNTER_KEYS.fatalCookieHmacSecretAusente);
    return json({ ok: false, error: "gate_unavailable" }, 503, env);
  }

  // #4322 item 1: rate-limit consumido SÓ depois de corpo/formato validados —
  // antes disso, um typo de e-mail repetido 8× trancava o IP por 1h sem que
  // nenhuma tentativa tivesse chegado a consultar um assinante de verdade
  // (aconteceu ao vivo com o editor testando o #4305). O limite existe contra
  // força-bruta de e-mail; requisição que nem chega a `checkGateSubscriber`
  // não é tentativa de força-bruta.
  let body: { email?: unknown; website?: unknown };
  try {
    body = (await request.json()) as { email?: unknown; website?: unknown };
  } catch {
    return json({ ok: false, error: "invalid_body" }, 400, env);
  }
  // Honeypot silencioso (mesmo padrão de subscribe.ts #3580) — bot que
  // preenche o campo invisível recebe 200 fake-fail, não sinaliza detecção.
  if (typeof body.website === "string" && body.website.trim() !== "") {
    return json({ ok: false, error: "not_active" }, 200, env);
  }
  const email = typeof body.email === "string" ? body.email.trim() : "";
  if (!email || !isValidEmailFormat(email)) return json({ ok: false, error: "invalid_email" }, 400, env);

  const ip = request.headers.get("CF-Connecting-IP") || request.headers.get("X-Forwarded-For") || "";
  const rl = await checkGateRateLimit(env.CURSOS_SUBSCRIBERS, ip);
  if (!rl.allowed) return json({ ok: false, error: "rate_limited" }, 429, env);

  const outcome = await checkGateSubscriber(env, email);
  if (outcome.status !== "active") {
    // #4321: mesma distinção de `handleIndex` — resposta ao visitante
    // inalterada (anti-probing #4052), só o log distingue "confirmado
    // negativo" de "não conseguimos verificar".
    if (outcome.reason === "verification_failed") {
      console.error(
        "[cursos] /gate/verify — verificação Beehiiv falhou (rede/401/403/429/5xx) — respondendo not_active mesmo assim",
      );
    }
    return json({ ok: false, error: "not_active" }, 200, env);
  }

  const setCookie = await issueSessionCookie(env.COOKIE_HMAC_SECRET, email);
  return json({ ok: true }, 200, env, { "Set-Cookie": setCookie });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const runtimeEnv: Env = { ...env, _requestOrigin: request.headers.get("Origin") };

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(runtimeEnv) });
    }

    if (GATED_INDEX_PATHS.includes(url.pathname) && request.method === "GET") {
      return handleIndex(request, runtimeEnv);
    }
    if (url.pathname === "/gate" && request.method === "GET") {
      return html(renderGatePage());
    }
    if (url.pathname === "/gate/verify" && request.method === "POST") {
      return handleGateVerify(request, runtimeEnv);
    }
    if (url.pathname === "/gate/subscribe" && request.method === "POST") {
      return handleGateSubscribe(request, runtimeEnv);
    }
    if (url.pathname === "/gate/logout" && request.method === "POST") {
      return json({ ok: true }, 200, runtimeEnv, { "Set-Cookie": clearSessionCookieHeader() });
    }

    return env.ASSETS.fetch(request);
  },
};
