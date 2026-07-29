/**
 * workers/poll/src/web-gate.ts (#4054)
 *
 * Tela de entrada do caminho B do "É IA?" (`/jogar`, brand `web`, visitante
 * de fora — social, busca, link compartilhado, leaderboard, bookmark).
 * Mesmo padrão de `workers/cursos/src/gate.ts`/`cookie.ts` (#4052, PR #4088):
 * cookie de sessão HMAC-assinado + verificação de assinante (KV primário +
 * Beehiiv `by_email` secundário) + cadastro inline (honeypot + rate-limit +
 * double opt-in via Beehiiv). Os PRIMITIVOS (assinatura de cookie, hash de
 * e-mail, rate-limit por KV) são os mesmos de `scripts/lib/shared/`, mas
 * ESPELHADOS localmente (`session-cookie.ts`, `subscriber-verify.ts`,
 * `rate-limit.ts` neste diretório) — o bundle do worker `poll` não alcança
 * `scripts/**`, ver o header de qualquer um desses 3 arquivos pro rationale
 * completo (mesmo mecanismo já em produção pra `utm-registry.ts`/
 * `ds-tokens.generated.ts`).
 *
 * Diferença de #4052 (cursos, gate PARCIAL: teaser sempre visível, cadastro é
 * convite): aqui o gate é POR RODADA — nunca é preciso e-mail pra JOGAR
 * (qualquer número de rodadas), só pra entrar no ranking público e guardar o
 * histórico entre sessões. O client (`jogar.ts`, `renderJogarPageHtml`/
 * `renderJogarSequencePageHtml`) mantém um cookie NÃO-httponly
 * `eia_web_rounds_played` (contador, 1 ano) incrementado a cada voto;
 * `handleJogarPage` (jogar.ts) o gateia pra esta tela quando o valor cruza um
 * múltiplo de `ROUNDS_NUDGE_INTERVAL` (#4253 item 3 — nudge recorrente a cada
 * 5 rodadas, não bloqueio na 1ª) E não há sessão válida.
 *
 * Identidade pós-gate: o cookie de sessão emitido aqui é uma origem de
 * identidade PARALELA ao token anônimo (`isValidWebToken`) em `/vote` —
 * NUNCA substitui o guard que rejeita `?email=` cru no brand `web` (#3976/
 * #4011, `vote.ts`). Ver o bloco "identidade pós-gate" em `handleVote`
 * (vote.ts) pro mecanismo de override.
 *
 * #4253 item 6 (bugfix): cadastrar/identificar pelo gate agora TAMBÉM aciona
 * `POST /jogar/identify` (mesmo endpoint que o form de identidade do jogo já
 * usa, #3975/identify.ts) — client-side, logo após verify/subscribe
 * responder ok (ver script de `renderJogarGatePage`). Isso mergeia o
 * histórico anônimo pro e-mail, grava o nickname a partir do `name` do form,
 * e persiste `localStorage["eia_web_identified_email"]` — sem isso (bug
 * original), quem se cadastrava pelo gate nunca aparecia no ranking nem
 * usava o nome digitado, porque `handleJogarGateSubscribe`/`handleJogarGateVerify`
 * só emitiam o cookie de sessão (que só decide se o gate reaparece, nunca
 * mergeia score nem seta identidade local). Reusar `/jogar/identify` (em vez
 * de duplicar a lógica de merge aqui) preserva a proteção contra histórico
 * órfão (#3996, link mágico de confirmação cross-device) — MAS só porque o
 * campo "Nome" do gate é `required` (achado do review consolidado: era
 * "opcional" na 1ª versão deste PR). `identify.ts` só roda a checagem de
 * histórico órfão quando `name` não é vazio (a premissa de #3996 é que
 * `name === ""` só vem do re-sync silencioso automático de um device JÁ
 * linkado, nunca de um submit humano explícito) — um campo opcional aqui
 * teria reaberto exatamente o que o #3996 fechou, só que através de uma UI
 * normal em vez de uma chamada de API forjada.
 */
import type { Env } from "./index";
import { corsHeaders, json } from "./index";
import {
  verifySubscriberViaBeehiivByEmail,
  verifySubscriberViaKv,
} from "./subscriber-verify";
import { checkKvRateLimit, clientIpFromRequest, type RateLimitResult } from "./rate-limit";
import {
  buildClearCookieHeader,
  buildSetCookieHeader,
  parseCookieHeader,
  signSessionCookie,
  verifySessionCookie,
} from "./session-cookie";
import { isValidVoteEmailFormat, isAnonymousWebIdentity, WEB_TOKEN_DOMAIN } from "./lib"; // #4121: isAnonymousWebIdentity fecha o gap do domínio reservado no gate
import { subscribeToBeehiiv, resolveSubscribeUtm, type SubscribeDeps } from "./subscribe";
import { DS_COLORS, DS_FONTS } from "./ds-tokens.generated";

/** Nome do cookie de sessão do caminho `/jogar` — namespace próprio, distinto
 * de `diaria_cursos_session` (#4052): domínios/workers diferentes, mas o
 * nome não precisaria colidir mesmo se fossem o mesmo domínio (path `/` de
 * cada worker é o seu próprio host). */
export const WEB_SESSION_COOKIE = "diaria_jogar_session";
/** ~30 dias — mesma decisão de #4052 (sessão longa, verificação já é
 * soft-gate; re-gatear a cada visita destruiria a UX do nudge periódico
 * (#4253 item 3) pra quem já se identificou). */
export const WEB_SESSION_TTL_SEC = 30 * 24 * 60 * 60;

/**
 * #4121: estado da sessão embutido no PAYLOAD assinado (não um cookie
 * separado — decisão do editor, "pra não multiplicar superfície"). `pending`
 * = cadastro feito, Beehiiv ainda não confirmou (double opt-in); `confirmed`
 * = verificado de verdade (via `checkWebSubscriber` retornando "active", seja
 * no `/verify` original, seja numa revisita pós-confirmação).
 *
 * Mecanismo: `pending` prefixa o e-mail com `PENDING_PREFIX` ANTES de assinar
 * (`pending:{email}`) — `:` nunca aparece num e-mail válido
 * (`isValidVoteEmailFormat`, lib.ts, rejeita `:` nos dois lados do `@`), então
 * o prefixo nunca colide com um e-mail real e não precisa de campo extra no
 * payload de `signSessionCookie` (que é genérico/compartilhado com
 * `workers/cursos`, #4052 — não convém acoplar um conceito exclusivo do
 * brand `web` ali). Cookies emitidos ANTES do #4121 nunca têm o prefixo —
 * `readWebSession` trata ausência como `confirmed` (decisão do editor: a
 * janela de exposição já passou, e tratar como `confirmed` mantém quem já
 * cadastrou funcionando sem exigir novo login).
 */
export type WebSessionState = "pending" | "confirmed";
const PENDING_PREFIX = "pending:";

export async function issueWebSessionCookie(
  secret: string,
  email: string,
  state: WebSessionState = "confirmed",
): Promise<string> {
  const payload = state === "pending" ? `${PENDING_PREFIX}${email}` : email;
  const value = await signSessionCookie(secret, payload, WEB_SESSION_TTL_SEC);
  return buildSetCookieHeader(WEB_SESSION_COOKIE, value, WEB_SESSION_TTL_SEC);
}

export interface WebSession {
  email: string;
  /** true = cadastro feito, Beehiiv ainda não confirmou o opt-in — a
   * identidade NÃO deve sobrepor o token anônimo em `handleVote` (vote.ts),
   * mas AINDA libera o jogo no gate (`handleJogarPage`, jogar.ts). */
  pending: boolean;
}

/**
 * #4121: lê a sessão completa (e-mail + estado). `cookieHeader`
 * pode ser `null`/ausente (request sem `Cookie`, ou secret ausente — sem
 * `COOKIE_HMAC_SECRET` NUNCA há sessão válida, fail-closed).
 */
export async function readWebSession(
  secret: string | undefined,
  cookieHeader: string | null,
): Promise<WebSession | null> {
  if (!secret) return null;
  const raw = parseCookieHeader(cookieHeader, WEB_SESSION_COOKIE);
  if (!raw) return null;
  const result = await verifySessionCookie(secret, raw);
  if (!result.ok) return null;
  if (result.email.startsWith(PENDING_PREFIX)) {
    return { email: result.email.slice(PENDING_PREFIX.length), pending: true };
  }
  return { email: result.email, pending: false };
}

/**
 * Retrocompat: só o e-mail, independente do estado pending/confirmed — usado
 * pelos call sites que só precisam saber "existe sessão" (o gate por rodada
 * em `handleJogarPage`, jogar.ts, que libera o jogo pros dois estados) ou
 * exibir o e-mail sem aplicar override de identidade em escrita. NUNCA usar
 * este helper onde a distinção pending/confirmed importa (ex: override de
 * identidade em `handleVote`, vote.ts) — usar `readWebSession` ali.
 */
export async function readWebSessionEmail(
  secret: string | undefined,
  cookieHeader: string | null,
): Promise<string | null> {
  const session = await readWebSession(secret, cookieHeader);
  return session ? session.email : null;
}

export function clearWebSessionCookieHeader(): string {
  return buildClearCookieHeader(WEB_SESSION_COOKIE);
}

/** Cookie NÃO-httponly, lido/escrito pelo próprio JS de `jogar.ts` — conta
 * quantas rodadas este navegador já jogou (incrementado a cada voto, nunca
 * resetado). Não é sessão nem prova de identidade nenhuma, só um contador
 * client-controlled (o pior caso de abuso — limpar cookies pra "resetar" a
 * contagem — é exatamente o mesmo custo/benefício de qualquer paywall soft
 * baseado em localStorage; não é o mecanismo que protege o ranking,
 * `isValidWebToken`/o dedup por edição continuam sendo a defesa real).
 *
 * #4253 item 3: substitui o antigo `FREE_ROUND_COOKIE` (binário, "rodada
 * livre já usada", gate na transição rodada 1→2). O gate original (#4054)
 * era agressivo demais — cobrava e-mail a cada 1 rodada. Agora o servidor
 * decide pelo VALOR do contador (`roundsHitNudgeThreshold` abaixo) em vez de
 * só presença/ausência do cookie: 1ª cobrança só depois da 5ª rodada, e daí
 * em diante a cada 5 (10ª, 15ª...) — "nudge recorrente", nunca bloqueio
 * permanente (mesmo espírito do skip de #4109). */
export const ROUNDS_PLAYED_COOKIE = "eia_web_rounds_played";

/** A cada quantas rodadas o gate volta a aparecer (#4253 item 3). */
export const ROUNDS_NUDGE_INTERVAL = 5;

/** Pure: decide se a contagem de rodadas jogadas cruza um múltiplo do
 * intervalo de nudge — mesma checagem usada pelo servidor (`handleJogarPage`,
 * jogar.ts) e espelhada no client (`goNext`, renderJogarSequencePageHtml). */
export function roundsHitNudgeThreshold(count: number): boolean {
  return count > 0 && count % ROUNDS_NUDGE_INTERVAL === 0;
}

/** Cadastro/verificação: N tentativas por IP por janela — mesmo teto de
 * `GATE_RATE_LIMIT` (#4052, `workers/cursos/src/gate.ts`). */
export const GATE_RATE_LIMIT = 8;
export const GATE_RATE_WINDOW_SEC = 3600; // 1h

export function checkGateRateLimit(kv: KVNamespace, ip: string): Promise<RateLimitResult> {
  return checkKvRateLimit(kv, `rl:jogar-gate:${ip}`, GATE_RATE_LIMIT, GATE_RATE_WINDOW_SEC);
}

/** `json()` de `index.ts` não aceita headers extras (diferente do homônimo em
 * `workers/cursos/src/index.ts`, #4052) — este worker nunca precisou setar
 * cookie antes do gate. Wrapper local só pra esses 2 call sites que precisam
 * de `Set-Cookie` junto com o corpo JSON. */
function jsonWithCookie(data: unknown, status: number, env: Env, setCookie: string): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(env), "Set-Cookie": setCookie },
  });
}

export type GateCheckResult = "active" | "not_active";

/**
 * Verifica se `email` é assinante ATIVO da Diar.ia. PRIMÁRIO: `env.SUBSCRIBERS_KV`
 * (mesma população/formato de chave de `CURSOS_SUBSCRIBERS`, #4052). SECUNDÁRIO
 * (só se o binding faltar/"unknown" E os secrets Beehiiv estiverem
 * configurados): `by_email` direto na API — não confirmado ao vivo (mesma nota
 * de `subscriber-verify.ts`). Nunca lança; ausência de qualquer verificação
 * disponível cai em `"not_active"` — o form de cadastro inline cobre esse caso.
 */
export async function checkWebSubscriber(env: Env, email: string): Promise<GateCheckResult> {
  if (env.SUBSCRIBERS_KV) {
    const viaKv = await verifySubscriberViaKv(env.SUBSCRIBERS_KV, email);
    if (viaKv === "active") return "active";
  }

  if (env.BEEHIIV_API_KEY && env.BEEHIIV_PUBLICATION_ID) {
    const viaApi = await verifySubscriberViaBeehiivByEmail(env.BEEHIIV_API_KEY, env.BEEHIIV_PUBLICATION_ID, email, {
      baseUrl: env.BEEHIIV_API_URL,
    });
    if (viaApi === "active") return "active";
  }

  return "not_active";
}

/** Mesmo regex de forbidden-chars/formato de `isValidVoteEmailFormat` (lib.ts)
 * — reusado direto (já é local a este worker, sem necessidade de espelho). */
export const isValidEmailFormat = isValidVoteEmailFormat;

/**
 * Handler `POST /jogar/gate/verify` — só verificação (sem criar assinante).
 * Honeypot silencioso (mesmo padrão de `subscribe.ts` #3580): campo `website`
 * preenchido devolve `not_active` fake, sem sinalizar detecção ao bot.
 */
export async function handleJogarGateVerify(request: Request, env: Env): Promise<Response> {
  const ip = clientIpFromRequest(request);
  const rl = await checkGateRateLimit(env.POLL, ip);
  if (!rl.allowed) return json({ ok: false, error: "rate_limited" }, 429, env);

  let body: { email?: unknown; website?: unknown };
  try {
    body = (await request.json()) as { email?: unknown; website?: unknown };
  } catch {
    return json({ ok: false, error: "invalid_body" }, 400, env);
  }
  if (typeof body.website === "string" && body.website.trim() !== "") {
    return json({ ok: false, error: "not_active" }, 200, env);
  }
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!email || !isValidEmailFormat(email)) return json({ ok: false, error: "invalid_email" }, 400, env);
  // #4121 (achado relacionado, mesma issue): domínio reservado da identidade
  // anônima do brand `web` (`@web.eia.diaria.local`) nunca pode virar
  // identidade "verificada" pelo gate — mesmo guard que `vote.ts`/#3976/#4011
  // já aplicam na ESCRITA do voto. `isValidEmailFormat` só valida a FORMA
  // genérica, não distingue esse domínio reservado de um e-mail comum.
  if (isAnonymousWebIdentity(email)) return json({ ok: false, error: "invalid_email" }, 400, env);

  const result = await checkWebSubscriber(env, email);
  if (result !== "active") return json({ ok: false, error: "not_active" }, 200, env);

  if (!env.COOKIE_HMAC_SECRET) return json({ ok: false, error: "gate_unavailable" }, 503, env);
  // #4121: verificação REAL confirmada pela Beehiiv/KV — estado "confirmed"
  // (default), sobrepõe identidade em handleVote imediatamente.
  const setCookie = await issueWebSessionCookie(env.COOKIE_HMAC_SECRET, email);
  return jsonWithCookie({ ok: true }, 200, env, setCookie);
}

export interface GateSubscribeDeps extends SubscribeDeps {}

/**
 * Handler `POST /jogar/gate/subscribe` — cadastro inline no MESMO mecanismo
 * de `POST /jogar/subscribe` (#3580: honeypot + rate-limit + double opt-in
 * via Beehiiv), aqui com `source` FIXO `"jogar-gate"` (UTM próprio,
 * `resolveSubscribeUtm`) e emissão de cookie de sessão IMEDIATA no sucesso —
 * a confirmação da Beehiiv segue em paralelo (double opt-in), o cookie NÃO
 * espera por ela (decisão do editor, #4054: a fricção de esperar clique em
 * e-mail mataria a conversão do gate).
 *
 * #4253 item 4: `optin` deixa de ser pré-requisito. Identidade de ranking
 * (a promessa do gate) e assinatura da newsletter são coisas DIFERENTES —
 * amarrar as duas fazia quem só queria continuar jogando (sem newsletter)
 * ficar barrado sem saída real. Sem `optin`: pula a Beehiiv inteiramente e
 * emite sessão `pending` (NUNCA `confirmed` — achado do review consolidado:
 * `confirmed` é o marcador que `handleVote`/vote.ts usa pra SOBREPOR a
 * identidade do voto pelo e-mail da sessão, sem exigir o token anônimo de
 * novo — reservado pra quando o e-mail foi VERIFICADO de verdade, seja
 * `checkWebSubscriber` achando "active", seja a Beehiiv confirmando o double
 * opt-in. Sem `optin` não existe verificação NENHUMA — nenhum contato foi
 * criado, nenhum e-mail foi enviado, é só um e-mail digitado. Emitir
 * `confirmed` aqui reabriria a vulnerabilidade que o #4121 fechou: qualquer
 * um digitando o e-mail de outra pessoa herdaria a identidade de voto dela
 * sem nunca provar posse. `pending` ainda libera o gate normalmente — ver
 * `handleJogarPage`/#4121, que já trata pending e confirmed igual pra esse
 * fim — a identidade de RANKING de verdade vem do merge via
 * `POST /jogar/identify` (`identifyAfterGate`, #4253 item 6), que não
 * depende do estado desta sessão). Com `optin`: comportamento INALTERADO
 * (tenta Beehiiv, sessão `pending` até a confirmação).
 */
export async function handleJogarGateSubscribe(
  request: Request,
  env: Env,
  deps: GateSubscribeDeps = {},
): Promise<Response> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const raw = await request.text();
  let parsed: { name?: unknown; email?: unknown; optin?: unknown; website?: unknown };
  const ct = (request.headers.get("Content-Type") ?? "").toLowerCase();
  if (ct.includes("application/json")) {
    try {
      parsed = JSON.parse(raw) as typeof parsed;
    } catch {
      parsed = {};
    }
  } else {
    const params = new URLSearchParams(raw);
    parsed = {
      name: params.get("name") ?? "",
      email: params.get("email") ?? "",
      optin: params.get("optin") ?? "",
      website: params.get("website") ?? "",
    };
  }

  const honeypot = typeof parsed.website === "string" ? parsed.website.trim() : "";
  if (honeypot) return json({ ok: true }, 200, env);

  const optinRaw = parsed.optin;
  const optin = optinRaw === true || optinRaw === "on" || optinRaw === "true" || optinRaw === "1" || optinRaw === "yes";

  const email = typeof parsed.email === "string" ? parsed.email.trim().toLowerCase() : "";
  if (!isValidEmailFormat(email)) return json({ ok: false, error: "invalid_email" }, 400, env);
  // #4121 (achado relacionado): mesmo guard do handler de verify acima —
  // sem ele, se a Beehiiv aceitasse criar assinatura pra este domínio
  // reservado (validação só de sintaxe, sem checar MX), o atacante receberia
  // um cookie "confirmado" cujo e-mail herda o domínio da identidade anônima.
  if (isAnonymousWebIdentity(email)) return json({ ok: false, error: "invalid_email" }, 400, env);
  const name = typeof parsed.name === "string" ? parsed.name.trim().slice(0, 100) : "";

  const ip = clientIpFromRequest(request);
  const rl = await checkGateRateLimit(env.POLL, ip);
  if (!rl.allowed) return json({ ok: false, error: "rate_limited" }, 429, env);

  // #4253 item 4: sem opt-in, pula a Beehiiv inteiramente — identidade de
  // ranking não depende de assinar a newsletter. Sessão sai `pending`, NUNCA
  // `confirmed` (achado do review consolidado — ver docstring da função):
  // sem qualquer verificação, `confirmed` sobreporia a identidade do voto
  // (vote.ts) pra um e-mail nunca provado. `pending` já libera o gate
  // normalmente; a identidade de ranking de verdade vem do merge via
  // /jogar/identify (item 6), independente deste cookie.
  if (!optin) {
    if (!env.COOKIE_HMAC_SECRET) return json({ ok: false, error: "gate_unavailable" }, 503, env);
    const setCookie = await issueWebSessionCookie(env.COOKIE_HMAC_SECRET, email, "pending");
    return jsonWithCookie({ ok: true }, 200, env, setCookie);
  }

  const utm = resolveSubscribeUtm("jogar-gate");
  const result = await subscribeToBeehiiv(env, { name, email }, fetchImpl, utm);
  if (!result.ok) {
    if (result.reason === "not_configured") return json({ ok: false, error: "subscribe_unavailable" }, 503, env);
    return json({ ok: false, error: "subscribe_failed" }, 502, env);
  }

  if (!env.COOKIE_HMAC_SECRET) {
    // Assinou de verdade na Beehiiv, mas o worker não consegue emitir sessão
    // (secret ausente) — ainda assim 200 (o cadastro FOI feito), sem cookie.
    // O leitor precisa confirmar o opt-in E revisitar depois que o editor
    // configurar o secret pra ver a sessão persistir.
    return json({ ok: true, sessionUnavailable: true }, 200, env);
  }
  // #4121: `subscribeToBeehiiv` só confirma sucesso HTTP da CRIAÇÃO — o
  // double opt-in (respeitado, não mandamos `double_opt_override`) continua
  // pendente. Ninguém provou posse do e-mail ainda, então o cookie sai
  // "pending": libera continuar jogando (o gate só quer saber "existe
  // sessão"), mas NÃO sobrepõe a identidade em `/vote` (vote.ts) até a
  // Beehiiv confirmar — a promoção pending→confirmed acontece na próxima
  // visita ao gate, quando `checkWebSubscriber` já retornar "active"
  // (handleJogarGateVerify acima), sem precisar de webhook nenhum.
  const setCookie = await issueWebSessionCookie(env.COOKIE_HMAC_SECRET, email, "pending");
  return jsonWithCookie({ ok: true }, 200, env, setCookie);
}

/**
 * Pure: HTML da tela de entrada do caminho B — mesmo form serve os dois
 * fluxos (login OU cadastro): o JS tenta `/jogar/gate/verify` primeiro; se
 * `not_active`, re-submete o MESMO e-mail (+ nome opcional + opt-in) pra
 * `/jogar/gate/subscribe`. Mesmo DS canônico (`ds-tokens.generated.ts`) do
 * resto do worker.
 */
export function renderJogarGatePage(identifyContextEdition: string | null): string {
  // #4253 item 6: repassado pro script (via JSON.stringify abaixo) como
  // `edition` do POST /jogar/identify — deriva o índice MENSAL do merge
  // (score-by-month:{slug}:{email}), que é o que o leaderboard público
  // (period="month") de fato lê. Sem isso o merge ainda funciona (só o score
  // GLOBAL é migrado na hora; o mensal se autocorrige no próximo voto via
  // sync(), ver identityFormScript/jogar.ts), mas o jogador veria "você ainda
  // não aparece no ranking" por mais 1 rodada — o mesmo sintoma do bug
  // original, só que temporário em vez de permanente.
  const gateEdition = identifyContextEdition ?? "";
  // #4268 (achado ao vivo, editor, 260728): o gate encontrado NO MEIO da
  // sequência (goNext em jogar.ts) repassa `edition=editions[0]` pra cá —
  // mas isso é só o contexto do identify acima (GATE_EDITION), NUNCA deveria
  // ir pro alvo de navegação abaixo. `handleJogarPage` roda o check de gate
  // PRIMEIRO — só depois, se o gate liberar a request (skip_gate=1 OU
  // sessão já válida), despacha pra página de UMA edição só (sem
  // next-round) sempre que a URL tiver `?edition=`, sem saber se esse valor
  // veio de um link legítimo pra uma edição específica ou só do contexto do
  // identify que acabou de passar pelo gate. Antes deste fix, a navegação
  // pós-gate (skip OU sucesso) ainda carregava `edition=editions[0]` —
  // exatamente a request seguinte que o gate libera — então caía direto
  // nesse dispatch de edição única, jogando o jogador pra fora da sequência
  // de 23 rodadas. Se editions[0] já tinha voto de uma sessão anterior (bem
  // provável pra quem testa o jogo com frequência), o /vote respondia "já
  // votou" sem nenhum caminho de volta — dead end reproduzido ao vivo. Fix:
  // a navegação pós-gate (skip OU sucesso) volta SEMPRE pra `/jogar` puro
  // (sequência), nunca carrega `edition` — só GATE_EDITION (acima) continua
  // levando o contexto pro identify, que é o único lugar que precisa dele.
  // Parâmetro renomeado de `edition` pra `identifyContextEdition`
  // (achado do review consolidado): o nome genérico convidava reincidência
  // — nada no tipo distinguia "contexto do identify" de "destino de
  // navegação", e o único guard contra reusar o valor errado era este
  // comentário.
  //
  // Tradeoff aceito (achado do review consolidado): quem chega no gate via
  // um link de edição única de verdade (ponte clarice/arquivo, jogar.ts
  // ~linha 2190, #3524/#3578) e cruza o nudge nessa mesma visita agora
  // volta pra sequência genérica em vez de voltar pra edição específica
  // pedida — perda de destino, não um dead end (o jogo continua jogável).
  // Resolver isso de verdade exigiria diferenciar as duas origens de
  // `edition=` na URL na origem (goNext()/jogar.ts passaria o contexto do
  // identify por um query param separado, preservando `edition=` com
  // significado único de "navegar pra esta edição") — fora do escopo deste
  // fix. Rastreado em #4271.
  // #4109 (achado ao vivo 260727, editor): o gate original (#4054) bloqueava
  // sem saída — quem não queria assinar ficava travado na tela. Link de skip
  // manda `skip_gate=1`, único-uso por navegação (handleJogarPage abaixo só
  // lê esse param nesta request específica, não grava cookie/sessão nenhuma)
  // — a próxima transição de rodada volta a checar o servidor e pode gatear
  // de novo (nudge recorrente, não permanente; decisão do editor).
  const skipHref = `/jogar?v=${Date.now()}&skip_gate=1`;
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>É IA? | Entrar no ranking</title>
<style>
  body { font-family: ${DS_FONTS.sans}; font-size: 17px; max-width: 480px; margin: 60px auto; padding: 0 20px; text-align: center; color: ${DS_COLORS.ink}; background: ${DS_COLORS.paper}; }
  h1 { font-family: ${DS_FONTS.serif}; font-size: 1.5rem; line-height: 1.4; margin: 0 0 12px 0; }
  p.explain { font-size: 0.95rem; line-height: 1.5; margin: 0 0 24px 0; }
  form { display: flex; flex-direction: column; gap: 10px; text-align: left; }
  input[type=email], input[type=text] { padding: 10px 12px; border: 1px solid ${DS_COLORS.rule}; border-radius: 4px; font-size: 0.95rem; font-family: ${DS_FONTS.sans}; }
  label.optin { font-size: 0.85rem; display: flex; gap: 6px; align-items: flex-start; }
  button { padding: 10px 16px; background: ${DS_COLORS.ink}; color: ${DS_COLORS.paper}; border: none; border-radius: 4px; font-weight: 600; cursor: pointer; font-family: ${DS_FONTS.sans}; }
  .website { position: absolute; left: -9999px; }
  #gate-msg { margin-top: 10px; min-height: 1.2em; }
  #gate-msg.err { padding: 12px 14px; font-size: 0.95rem; font-weight: 700; color: ${DS_COLORS.ink}; background: #FBECEC; border: 1px solid #E3B4B4; border-radius: 4px; }
  #gate-msg.info { font-size: 0.9rem; color: ${DS_COLORS.ink}; opacity: 0.75; }
  .skip-link { display: block; margin-top: 18px; font-size: 0.9rem; opacity: 0.75; }
</style>
</head>
<body>
<h1>Quer disputar o ranking?</h1>
<p class="explain">Com seu e-mail a gente guarda seus acertos e te coloca no ranking público do mês. Já assina a Diar.ia? Entre direto. Continuar jogando sem cadastrar também vale. É só seguir.</p>
<form id="gate-form">
  <input type="text" name="website" class="website" tabindex="-1" autocomplete="off">
  <input type="text" name="name" placeholder="Seu nome ou apelido" required>
  <input type="email" name="email" placeholder="seu@email.com" required>
  <label class="optin"><input type="checkbox" name="optin" value="1"> Quero receber a Diar.ia — newsletter diária e gratuita que resume as principais notícias e tutoriais de IA em 5 minutos de leitura, direto no seu e-mail.</label>
  <button type="submit">Entrar no ranking</button>
</form>
<p id="gate-msg"></p>
<a class="skip-link" href="${skipHref}">Continuar sem cadastrar</a>
<script>
(function () {
  var form = document.getElementById("gate-form");
  var msg = document.getElementById("gate-msg");
  var GATE_EDITION = ${JSON.stringify(gateEdition)};
  function setMsg(text, cls) {
    msg.textContent = text;
    msg.className = cls || "";
  }
  // #4253 item 6: token anônimo é read-ONLY aqui (nunca cria um novo) —
  // quem chega no gate já votou pelo menos 1 rodada, então o token já
  // existe (mesmo padrão de leitura de /jogar/arquivo, jogar.ts).
  function readCookie(name) {
    var m = document.cookie.match(new RegExp("(?:^|; )" + name + "=([^;]*)"));
    return m ? decodeURIComponent(m[1]) : null;
  }
  function getAnonEmail() {
    var token = null;
    try { token = window.localStorage.getItem("eia_web_token"); } catch (e) {}
    if (!token) token = readCookie("eia_web_token");
    return token ? token + "@" + ${JSON.stringify(WEB_TOKEN_DOMAIN)} : "";
  }
  // #4253 item 6 (bugfix): aciona a MESMA máquina de identificação que o
  // form de identidade do jogo já usa (POST /jogar/identify, identify.ts) —
  // mergeia o histórico anônimo pro e-mail, grava o nickname a partir do
  // nome, e preserva a proteção contra histórico órfão (#3996: se este
  // e-mail já tem ranking sob outro device/token, NÃO mergeia na hora — a
  // resposta vem com pending=true e um e-mail de confirmação é enviado
  // separadamente). optin é SEMPRE false aqui — o opt-in de newsletter já
  // foi resolvido por gate/verify ou gate/subscribe antes desta chamada;
  // repassar true duplicaria a tentativa de assinatura na Beehiiv.
  // Retorna { pending: boolean } — nunca lança. pending=true só quando o
  // servidor confirmou histórico órfão (#3996); qualquer falha de rede/parse
  // vira pending=false (achado do review consolidado: antes o caller não
  // tinha como diferenciar "confirmação por e-mail pendente" de "deu erro,
  // mas segue o jogo igual" — os dois casos redirecionavam em silêncio pro
  // jogo sem explicar nada, mesmo já existindo a mensagem certa pra isso em
  // identityFormScript/jogar.ts).
  function identifyAfterGate(email, name) {
    var anonEmail = getAnonEmail();
    if (!anonEmail || typeof window.fetch !== "function") return Promise.resolve({ pending: false });
    return window.fetch("/jogar/identify?brand=web", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name, email: email, anonEmail: anonEmail, optin: false, edition: GATE_EDITION }),
    }).then(function (res) {
      return res.json().then(function (d) { return d; }, function () { return null; });
    }).then(function (d) {
      // pending=true = histórico órfão detectado, merge aguardando
      // confirmação por link mágico — NÃO marca como identificado ainda
      // (mesma disciplina de identityFormScript/jogar.ts).
      if (d && d.ok && d.pending) return { pending: true };
      if (d && d.ok) {
        try { window.localStorage.setItem("eia_web_identified_email", email); } catch (e) {}
      }
      return { pending: false };
    }).catch(function () { return { pending: false }; });
  }
  function goToGame() {
    window.location.href = "/jogar?v=" + Date.now();
  }
  // Achado do review consolidado: sem isso, um histórico órfão (#3996)
  // redirecionava em silêncio pro jogo, sem avisar que o merge ficou
  // pendente de confirmação por e-mail — mesma mensagem que
  // identityFormScript (jogar.ts) já usa pro caso equivalente. A sessão do
  // gate (verify/subscribe) já libera o jogo de qualquer forma — quem quiser
  // seguir sem esperar clica no link de skip abaixo.
  function afterIdentify(result) {
    if (result && result.pending) {
      setMsg("Quase lá! Enviamos um e-mail de confirmação: clique no link pra migrar seu histórico e entrar no ranking. Enquanto isso, toque em 'Continuar sem cadastrar' abaixo pra seguir jogando.", "info");
      return;
    }
    goToGame();
  }
  form.addEventListener("submit", function (ev) {
    ev.preventDefault();
    var email = form.email.value.trim();
    var name = form.name.value.trim();
    var optin = form.optin.checked;
    var website = form.website.value;
    // #4253 (achado do review consolidado): nome é OBRIGATÓRIO (atributo
    // required acima cobre o caminho normal do navegador, este check cobre
    // qualquer submit programático que pule a validação nativa). Sem isso,
    // identifyAfterGate chamaria /jogar/identify com name="" pra uma
    // identificação de PRIMEIRA VEZ — e identify.ts só roda a checagem de
    // histórico órfão (#3996) quando name não é vazio (a premissa lá é que
    // name="" só vem do re-sync silencioso automático de um device JÁ
    // linkado, nunca de um submit humano explícito). Sem esta validação, um
    // e-mail já identificado sob OUTRO device seria mergeado na hora, sem
    // confirmação por link mágico — reabrindo exatamente o que o #3996 fechou.
    if (!name) { setMsg("Digite seu nome ou apelido.", "err"); return; }
    setMsg("Verificando…", "info");
    // #4253 item 6: handleJogarGateVerify (web-gate.ts) não LÊ o campo name —
    // vai só pra identifyAfterGate logo abaixo, se a verificação der certo.
    // Mantido no corpo por paridade com o subscribe (mesmo shape nos 2 POSTs).
    fetch("/jogar/gate/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: email, name: name, website: website }),
    }).then(function (r) { return r.json(); }).then(function (data) {
      if (data.ok) { return identifyAfterGate(email, name).then(afterIdentify); }
      // #4253 item 4: opt-in deixa de ser pré-requisito pra continuar — sem
      // e-mail assinante confirmado, tenta cadastrar (com ou sem newsletter,
      // gate/subscribe decide server-side a partir de optin).
      return fetch("/jogar/gate/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email, name: name, optin: optin, website: website }),
      }).then(function (r2) { return r2.json(); }).then(function (data2) {
        if (data2 && data2.ok && !data2.sessionUnavailable) { return identifyAfterGate(email, name).then(afterIdentify); }
        if (data2 && data2.ok && data2.sessionUnavailable) { setMsg("Assinatura feita! Confirme o e-mail que te enviamos, depois é só voltar aqui pra continuar jogando.", "err"); return; }
        setMsg("Não deu, tente de novo em instantes.", "err");
      });
    }).catch(function () { setMsg("Erro de conexão. Tente de novo.", "err"); });
  });
})();
</script>
</body>
</html>`;
}
