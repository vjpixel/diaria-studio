/**
 * workers/poll/src/subscribe.ts (#3580)
 *
 * Cadastro INLINE no fim do fluxo do jogo "É IA?" standalone (brand `web`) —
 * conversão direta do EPIC #3514, evolução do funil #3518 (que só linkava pro
 * Beehiiv). Aqui o visitante põe nome + e-mail + marca a caixinha de opt-in e
 * assina a newsletter SEM sair da página (`POST /jogar/subscribe`).
 *
 * Mecanismo de assinatura (decisão de design): API pública da Beehiiv
 * (`POST /publications/{id}/subscriptions`, `Authorization: Bearer {apiKey}`)
 * — mesma API já usada pelos scripts do repo (`scripts/lib/beehiiv-config.ts`,
 * `backup-beehiiv.ts`). É a opção mais robusta porque (a) roda 100% server-side
 * (a key NUNCA vai pro cliente, ao contrário de um form embutido/iframe que
 * exporia a publicação), (b) deixa o worker aplicar anti-abuso próprio
 * (honeypot + rate-limit + validação de e-mail) ANTES de tocar a Beehiiv, e
 * (c) ISENTA este fluxo do double opt-in da publicação (`double_opt_override:
 * "off"`) — ver bloco abaixo.
 *
 * DOUBLE OPT-IN — por que este caminho é isento (#5095, decisão do editor
 * 260812). Até aqui o worker OMITIA `double_opt_override` de propósito: a
 * publicação tinha double opt-in DESLIGADO, então omitir e passar davam no
 * mesmo, e a omissão deixava a porta aberta pra 2ª camada de confirmação.
 * Isso mudou: o editor vai LIGAR o double opt-in na publicação pra barrar
 * cadastro externo de origem duvidosa (co-registro SparkLoop do parceiro
 * `Techzip Newsletter`, ~18 contatos B2B anglófonos numa lista pt-BR). Sem
 * override, a mesma trava cairia sobre ESTE fluxo, onde ela não faz sentido:
 * o visitante acabou de digitar o e-mail e marcar a caixinha na nossa própria
 * página. A caixinha marcada CONTINUA sendo o consentimento LGPD explícito —
 * é ela que sustenta a base legal, não a confirmação da Beehiiv, que sempre
 * foi 2ª camada opcional. Trocamos essa 2ª camada por entrada direta em
 * `active` só onde a 1ª camada é nossa e auditável.
 *
 * O que NÃO muda: a promoção pending→confirmed do gate (#4121, `web-gate.ts`)
 * continua no lugar. Ela não vira código morto — a Beehiiv ainda pode devolver
 * `validating` em vez de `active`, e o gate segue tratando "não-active" como
 * sessão pending.
 *
 * SEGREDO AUSENTE (documentado no PR): o worker `poll` NÃO tem hoje os secrets
 * `BEEHIIV_API_KEY` / `BEEHIIV_PUBLICATION_ID` (só `POLL_SECRET`/`ADMIN_SECRET`,
 * ver SECRETS.md). Sem eles, `subscribeToBeehiiv` retorna `not_configured` e o
 * endpoint responde 503 amigável ("assine pela página") — o form + validação +
 * anti-abuso já ficam prontos; basta o editor rodar:
 *   cd workers/poll
 *   echo "$BEEHIIV_API_KEY"        | npx wrangler secret put BEEHIIV_API_KEY
 *   echo "$BEEHIIV_PUBLICATION_ID" | npx wrangler secret put BEEHIIV_PUBLICATION_ID
 * (padrão apoia.se: nunca hardcode; só env/secret do worker.)
 */
import type { Env } from "./index";
import { json } from "./index";
// Fonte única do utm_source do funil (`eia-standalone`, #3518, movido pra
// lib.ts no #3978) — mesma convenção de `count-subscriptions-by-utm.ts`.
// medium/campaign PRÓPRIOS abaixo distinguem o cadastro inline do CTA-link e
// do quiz.
import { isValidVoteEmailFormat, SUBSCRIBE_UTM_SOURCE } from "./lib";
import { ARQUIVO_INLINE_UTM, HUB_INLINE_UTM, JOGAR_GATE_INLINE_UTM, JOGAR_IDENTIFY_INLINE_UTM, JOGAR_INLINE_UTM, JOGAR_POSTWEB_UTM, LIVROS_INLINE_UTM, VOTE_CLARICE_INLINE_UTM } from "./utm-registry"; // #4041, #4054, #4125 item 4, #4578, #5167 itens 1/2
import { sendCompleteRegistrationEvent } from "../../../scripts/lib/shared/meta-capi.ts"; // #5504

/** UTM próprio do cadastro inline (#3580) — `utm_source` continua
 * `eia-standalone` (convenção de medição), medium/campaign distintos pra medir
 * a conversão INLINE separada do CTA-link (#3518) e do quiz (#3579). */
export const INLINE_SUBSCRIBE_UTM_MEDIUM = JOGAR_INLINE_UTM.medium; // #4041: registry único
export const INLINE_SUBSCRIBE_UTM_CAMPAIGN = JOGAR_INLINE_UTM.campaign;

/**
 * #4051: `/jogar/subscribe` passou a ser chamado CROSS-ORIGIN por
 * `livros.diar.ia.br` (2 CTAs — hero + fim da lista de cards, ver
 * `scripts/build-livros-page.ts`), não só pelo próprio `/jogar` (mesma
 * origem). O UTM não pode mais ser um único triplo fixo — cada call site
 * mede sua própria conversão via `scripts/count-subscriptions-by-utm.ts`.
 *
 * O cliente manda `source` (string curta, `SubscribeSource`) no corpo do
 * POST; o servidor resolve o triplo UTM daqui — NUNCA aceita utm_* vindo do
 * cliente diretamente (evitaria abuso de atribuição/spoofing de campanha).
 * `source` ausente/desconhecido cai no default `jogar` (comportamento
 * pré-#4051, back-compat com o form de `/jogar`/`/jogar/quiz` que não manda
 * esse campo).
 *
 * #4065: `"vote-clarice"` — cadastro inline na tela de resultado do voto
 * (`/vote?brand=clarice`, ver votePageHtml em index.ts). UTM próprio pra
 * medir essa conversão separada do cadastro inline de `/jogar` — é o mesmo
 * endpoint/mecanismo (`POST /jogar/subscribe`), só o call site muda.
 *
 * #4054: `"jogar-gate"` — cadastro na tela de gate do caminho de fora
 * (`web-gate.ts`, `POST /jogar/gate/subscribe`), quando o visitante cruza o
 * nudge periódico de rodadas (#4253 item 3) e não é assinante. UTM próprio
 * pra medir esta conversão separada do cadastro inline de fim-de-página (#3580).
 *
 * #4125 (item 4): `"jogar-identify"` — opt-in de newsletter embutido no form
 * de IDENTIDADE (#3975, `identify.ts` → `subscribeToBeehiiv`, NÃO passa por
 * `handleJogarSubscribe`/`resolveSubscribeUtm` acima, mas registra o source
 * aqui pelo mesmo motivo dos demais: inventário único, sem literal solto).
 * Antes desta entrada, `identify.ts` chamava `subscribeToBeehiiv` sem o 4º
 * argumento e caía no default `jogar` — colidindo com o form standalone do
 * #3580 (que só sobrevive em `/jogar/quiz`), tornando as duas conversões
 * indistinguíveis na atribuição.
 *
 * #4578: `"jogar-postweb"` — cadastro na CAIXA UNIFICADA DO GATE revelada no
 * pós-voto de `/jogar?from=post-web` (visitante redirecionado de `/vote` na
 * versão web de um post, merge tag nunca resolvida ali — ver rationale em
 * `vote.ts`). Mesmo endpoint/mecanismo de `"jogar-gate"` acima
 * (`POST /jogar/gate/subscribe`, `handleJogarGateSubscribe`, web-gate.ts) —
 * `handleJogarGateSubscribe` lê `source` do corpo do POST (default
 * `"jogar-gate"`, back-compat com a tela de gate por rodada que não manda
 * esse campo) pra distinguir os dois pontos de entrada na atribuição.
 *
 * #5167 (itens 1/2): `"arquivo"` — CTA no topo de `arquivo.diar.ia.br`
 * (`workers/arquivo/src/render-archive.ts`), `"hub"` — CTA no topo de cada
 * hub temático (`arquivo.diar.ia.br/temas/{slug}`, `scripts/lib/shared/hub-page.ts`).
 * Os dois substituem o antigo `<a href="https://diar.ia.br/subscribe">`
 * (form hospedado na Beehiiv, sujeito ao double opt-in) pelo mesmo mecanismo
 * inline de `livros-hero`/`livros-footer` — é justamente o tráfego frio de
 * SEO/GEO que esses 2 pontos de entrada recebem que motivou a issue: cadastro
 * `active` na hora, sem depender de confirmação por e-mail. Um `source` por
 * SUPERFÍCIE (não por hub individual) — granularidade suficiente pra medir
 * "arquivo" vs "hub" separado do resto sem multiplicar entradas de UTM por
 * slug de hub.
 */
export type SubscribeSource = "jogar" | "livros-hero" | "livros-footer" | "vote-clarice" | "jogar-gate" | "jogar-identify" | "jogar-postweb" | "arquivo" | "hub";

/**
 * #4530 Parte B: `referringSite` promovido a campo do triplo — antes disto
 * `subscribeToBeehiiv` tinha o literal `"jogar-eia-inline"` HARDCODED no
 * corpo da função, compartilhado por TODO call site (livros hero/footer,
 * gate, identify, magic-link, caixa clarice do `/set-name`) independente do
 * `source` de fato. O campo não distinguia nada — só o triplo UTM
 * distinguia. Cada entrada de `SUBSCRIBE_UTM_BY_SOURCE` abaixo agora carrega
 * o `referringSite` PRÓPRIO da posição do link; `identify.ts`/`magic-link.ts`
 * (que compartilham `source="jogar-identify"`, mas são fluxos DIFERENTES —
 * form on-page vs. link de e-mail) e `index.ts` (caixa clarice do
 * `/set-name`, que não passa por `resolveSubscribeUtm`) sobrescrevem o campo
 * na chamada — ver `JOGAR_IDENTIFY_MAGIC_LINK_REFERRING_SITE`/
 * `VOTE_CLARICE_SET_NAME_REFERRING_SITE` exportados abaixo.
 */
export interface SubscribeUtm {
  source: string;
  medium: string;
  campaign: string;
  referringSite: string;
}

const SUBSCRIBE_UTM_BY_SOURCE: Record<SubscribeSource, SubscribeUtm> = {
  jogar: {
    source: SUBSCRIBE_UTM_SOURCE,
    medium: INLINE_SUBSCRIBE_UTM_MEDIUM,
    campaign: INLINE_SUBSCRIBE_UTM_CAMPAIGN,
    referringSite: "eia-jogar-inline",
  },
  // utm_source=livros / utm_medium distinto por posição — pedido explícito da
  // issue #4051 pra medir hero × fim-de-lista separadamente.
  // #4041: valores do registry espelhado (./utm-registry).
  "livros-hero": {
    source: LIVROS_INLINE_UTM.source,
    medium: LIVROS_INLINE_UTM.hero.medium,
    campaign: LIVROS_INLINE_UTM.campaign,
    referringSite: "livros-inline-hero",
  },
  "livros-footer": {
    source: LIVROS_INLINE_UTM.source,
    medium: LIVROS_INLINE_UTM.footer.medium,
    campaign: LIVROS_INLINE_UTM.campaign,
    referringSite: "livros-inline-footer",
  },
  // #4065: cadastro inline na tela de resultado do voto do brand clarice —
  // utm_source distinto (não é o funil "eia-standalone" do jogo público, é a
  // base de e-mail da parceria Clarice) pra não poluir a atribuição do funil
  // web com conversões que vieram de um e-mail mensal.
  "vote-clarice": {
    source: VOTE_CLARICE_INLINE_UTM.source,
    medium: VOTE_CLARICE_INLINE_UTM.medium,
    campaign: VOTE_CLARICE_INLINE_UTM.campaign,
    referringSite: "vote-clarice-inline",
  },
  // #4054: cadastro na tela de gate do caminho de fora (`web-gate.ts`).
  "jogar-gate": {
    source: JOGAR_GATE_INLINE_UTM.source,
    medium: JOGAR_GATE_INLINE_UTM.medium,
    campaign: JOGAR_GATE_INLINE_UTM.campaign,
    referringSite: "jogar-gate-inline",
  },
  // #4125 (item 4): opt-in de newsletter do form de IDENTIDADE (#3975,
  // `identify.ts`) — UTM próprio pra não colidir com "jogar" (form standalone
  // do #3580, hoje só em `/jogar/quiz`). `referringSite` cobre o form
  // ON-PAGE de `identify.ts` — `magic-link.ts` (mesmo `source`, fluxo
  // DIFERENTE) sobrescreve com `JOGAR_IDENTIFY_MAGIC_LINK_REFERRING_SITE`.
  "jogar-identify": {
    source: JOGAR_IDENTIFY_INLINE_UTM.source,
    medium: JOGAR_IDENTIFY_INLINE_UTM.medium,
    campaign: JOGAR_IDENTIFY_INLINE_UTM.campaign,
    referringSite: "jogar-identify-inline",
  },
  // #4578: caixa unificada do gate no pós-voto de /jogar?from=post-web —
  // mesmo endpoint de "jogar-gate" (POST /jogar/gate/subscribe), source
  // distinto pra não misturar os 2 pontos de entrada na atribuição.
  "jogar-postweb": {
    source: JOGAR_POSTWEB_UTM.source,
    medium: JOGAR_POSTWEB_UTM.medium,
    campaign: JOGAR_POSTWEB_UTM.campaign,
    referringSite: "jogar-postweb-gate",
  },
  // #5167 item 1: CTA no topo de arquivo.diar.ia.br.
  arquivo: {
    source: ARQUIVO_INLINE_UTM.source,
    medium: ARQUIVO_INLINE_UTM.medium,
    campaign: ARQUIVO_INLINE_UTM.campaign,
    referringSite: "arquivo-inline",
  },
  // #5167 item 2: CTA no topo de cada hub temático (arquivo.diar.ia.br/temas/{slug}).
  hub: {
    source: HUB_INLINE_UTM.source,
    medium: HUB_INLINE_UTM.medium,
    campaign: HUB_INLINE_UTM.campaign,
    referringSite: "hub-inline",
  },
};

/** #4530 Parte B: `magic-link.ts` reusa o triplo UTM de `"jogar-identify"`
 * (mesmo funil de opt-in do form de identidade), mas é um CALL SITE distinto
 * (link de confirmação por e-mail, não o form on-page) — precisa do próprio
 * `referringSite`, nunca o mesmo de `identify.ts`. */
export const JOGAR_IDENTIFY_MAGIC_LINK_REFERRING_SITE = "jogar-identify-magic-link";

/** #4530 Parte B: caixa clarice do `/set-name` (`index.ts::handleSetName`) —
 * chama `subscribeToBeehiiv` direto com `VOTE_CLARICE_INLINE_UTM` (não passa
 * por `resolveSubscribeUtm`), então precisa do próprio `referringSite`
 * explícito na chamada. */
export const VOTE_CLARICE_SET_NAME_REFERRING_SITE = "vote-clarice-set-name";

/** Pure: resolve o triplo UTM a partir do `source` mandado pelo cliente
 * (default `jogar` pra valor ausente/desconhecido — nunca lança). */
export function resolveSubscribeUtm(raw: unknown): SubscribeUtm {
  const key = typeof raw === "string" ? raw : "";
  return SUBSCRIBE_UTM_BY_SOURCE[key as SubscribeSource] ?? SUBSCRIBE_UTM_BY_SOURCE.jogar;
}

/** Teto de tamanho do nome capturado — evita payload abusivo (o campo é
 * opcional; a Beehiiv nem tem um campo nativo de nome, ver `subscribeToBeehiiv`). */
export const SUBSCRIBE_NAME_MAX = 100;

/** Rate-limit padrão do cadastro público: N cadastros bem-formados por IP por
 * janela. Baixo de propósito — um humano assina 1x; qualquer coisa acima é
 * abuso. */
export const SUBSCRIBE_RATE_LIMIT = 5;
export const SUBSCRIBE_RATE_WINDOW_SEC = 3600; // 1h

export interface ParsedSubscribe {
  name: string;
  email: string;
  optin: boolean;
  /** honeypot — campo invisível que só bot preenche. */
  honeypot: string;
  /** #4051 — chave de call site (ver `SubscribeSource`); string crua, resolvida
   * só depois via `resolveSubscribeUtm` (nunca usada diretamente como UTM). */
  source: string;
}

function asStr(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function truthyFlag(v: unknown): boolean {
  if (v === true) return true;
  const s = asStr(v).trim().toLowerCase();
  return s === "on" || s === "true" || s === "1" || s === "yes";
}

/**
 * Pure (#3580): parse do corpo do POST — aceita `application/json` (caminho do
 * fetch do cliente) e `application/x-www-form-urlencoded` (fallback de form
 * nativo sem JS, defensivo). Nunca lança — JSON malformado vira input vazio
 * (que o validador rejeita depois), nunca 500.
 */
export function parseSubscribeBody(raw: string, contentType: string): ParsedSubscribe {
  const ct = (contentType || "").toLowerCase();
  if (ct.includes("application/json")) {
    try {
      const o = JSON.parse(raw) as Record<string, unknown>;
      return {
        name: asStr(o.name),
        email: asStr(o.email),
        optin: truthyFlag(o.optin),
        honeypot: asStr(o.website),
        source: asStr(o.source),
      };
    } catch {
      return { name: "", email: "", optin: false, honeypot: "", source: "" };
    }
  }
  const params = new URLSearchParams(raw);
  return {
    name: params.get("name") ?? "",
    email: params.get("email") ?? "",
    optin: truthyFlag(params.get("optin")),
    honeypot: params.get("website") ?? "",
    source: params.get("source") ?? "",
  };
}

export type SubscribeValidation =
  | { ok: true; name: string; email: string; source: string }
  | { ok: false; status: number; error: string };

/**
 * Pure (#3580): valida o input do cadastro server-side (NUNCA confiar só no JS
 * do cliente). Ordem importa:
 *   1. honeypot preenchido → `honeypot` (o handler responde 200 fake-success
 *      pra NÃO sinalizar ao bot que foi detectado; nenhuma assinatura acontece).
 *   2. opt-in não marcado → 400 `optin_required` (consentimento LGPD é
 *      obrigatório; a caixinha é o consentimento explícito).
 *   3. e-mail inválido → 400 `invalid_email` (mesma autoridade de formato do
 *      voto, `isValidVoteEmailFormat`).
 * Nome é opcional, trimado e cortado em SUBSCRIBE_NAME_MAX.
 */
export function validateSubscribeInput(p: ParsedSubscribe): SubscribeValidation {
  if (p.honeypot && p.honeypot.trim() !== "") {
    return { ok: false, status: 200, error: "honeypot" };
  }
  if (!p.optin) {
    return { ok: false, status: 400, error: "optin_required" };
  }
  const email = (p.email || "").trim();
  if (!isValidVoteEmailFormat(email)) {
    return { ok: false, status: 400, error: "invalid_email" };
  }
  const name = (p.name || "").trim().slice(0, SUBSCRIBE_NAME_MAX);
  return { ok: true, name, email, source: p.source };
}

export interface RateLimitResult {
  allowed: boolean;
  count: number;
}

/**
 * #3580: rate-limit por IP via KV (`rl:subscribe:{ip}`). Sem DO novo — o
 * volume é baixo (form público de cadastro), a consistência eventual do KV é
 * aceitável pra anti-abuso (o pior caso é 1-2 cadastros a mais numa corrida,
 * não um vetor de spam em massa). Só é alcançado por requests JÁ bem-formados
 * (honeypot/opt-in/e-mail validados antes) — ou seja, protege a API da Beehiiv
 * de flood. `expirationTtl` reseta a janela a cada tentativa (janela deslizante
 * — mais estrita pra abusador, irrelevante pro humano que assina 1x). Sem IP
 * (fixtures/ambiente sem CF-Connecting-IP) → permite (as outras barreiras
 * continuam valendo).
 */
export async function checkSubscribeRateLimit(
  kv: KVNamespace,
  ip: string,
  limit: number = SUBSCRIBE_RATE_LIMIT,
  windowSec: number = SUBSCRIBE_RATE_WINDOW_SEC,
): Promise<RateLimitResult> {
  if (!ip) return { allowed: true, count: 0 };
  const key = `rl:subscribe:${ip}`;
  const raw = await kv.get(key);
  const count = raw ? parseInt(raw, 10) || 0 : 0;
  if (count >= limit) return { allowed: false, count };
  await kv.put(key, String(count + 1), { expirationTtl: windowSec });
  return { allowed: true, count: count + 1 };
}

export interface SubscribeResult {
  ok: boolean;
  status: number;
  reason?: "not_configured" | "beehiiv_error";
}

/**
 * #4438 (fleet review oficial, achado 1 — silent-failure-hunter): timeout
 * explícito do fetch pra API da Beehiiv. Antes deste fix, `subscribeToBeehiiv`
 * não tinha NENHUM timeout — uma rede instável ou a Beehiiv respondendo devagar
 * podia deixar o `await fetchImpl(...)` pendurado indefinidamente (nunca
 * resolve, nunca rejeita). Isso é mais grave que um erro comum: o try/catch ao
 * redor já cobria EXCEÇÃO (rejeição rápida), mas um hang nunca lança — o
 * caller (`handleSetName`, index.ts) ficava preso pra sempre nesse `await`,
 * sem nunca chegar no `env.POLL.put` que persiste o apelido do leitor. 8s é
 * generoso pra um POST simples de assinatura — falha rápido (cai no mesmo
 * ramo `beehiiv_error` do catch já existente) em vez de travar a resposta.
 */
export const SUBSCRIBE_FETCH_TIMEOUT_MS = 8000;

/**
 * #3580: ponto de integração com a Beehiiv. Lê `BEEHIIV_API_KEY` +
 * `BEEHIIV_PUBLICATION_ID` do env do worker (secrets — NUNCA hardcode). Se
 * qualquer um faltar, retorna `not_configured` (o handler traduz pra 503
 * amigável) — o resto do fluxo (form + validação + anti-abuso) já funciona,
 * só a chamada externa fica pendente da configuração do secret.
 *
 * `fetchImpl` injetável pra teste (nunca faz rede real nos testes, #633).
 *
 * Nome: a Beehiiv não tem campo nativo de "nome" na criação de assinatura.
 * Quando `BEEHIIV_NAME_FIELD` (nome do custom field criado no dashboard da
 * Beehiiv) está configurado E há nome, mandamos via `custom_fields`. Sem esse
 * env, a assinatura vai só com e-mail + UTM (degrada com graça — nunca falha a
 * assinatura por causa do nome). Double opt-in: ISENTO — mandamos
 * `double_opt_override: "off"` desde o #5095 (ver bloco DOUBLE OPT-IN no topo
 * deste arquivo); `send_welcome_email: true` dispara o fluxo de boas-vindas
 * configurado na publicação.
 */
export async function subscribeToBeehiiv(
  env: Env,
  input: { name: string; email: string },
  fetchImpl: typeof fetch = fetch,
  utm: SubscribeUtm = SUBSCRIBE_UTM_BY_SOURCE.jogar,
): Promise<SubscribeResult> {
  const apiKey = env.BEEHIIV_API_KEY;
  const pubId = env.BEEHIIV_PUBLICATION_ID;
  if (!apiKey || !pubId) return { ok: false, status: 503, reason: "not_configured" };

  const base = env.BEEHIIV_API_URL ?? "https://api.beehiiv.com/v2";
  const body: Record<string, unknown> = {
    email: input.email,
    reactivate_existing: false,
    send_welcome_email: true,
    // #5095: isenta ESTE fluxo do double opt-in da publicação — o consentimento
    // LGPD veio da caixinha marcada nesta página. Ver bloco DOUBLE OPT-IN no
    // topo do arquivo.
    double_opt_override: "off",
    utm_source: utm.source,
    utm_medium: utm.medium,
    utm_campaign: utm.campaign,
    // #4530 Parte B: era o literal fixo "jogar-eia-inline" pra TODO call
    // site — agora vem do triplo, um valor por posição de link (ver
    // docstring de `SubscribeUtm`).
    referring_site: utm.referringSite,
  };
  if (input.name && env.BEEHIIV_NAME_FIELD) {
    body.custom_fields = [{ name: env.BEEHIIV_NAME_FIELD, value: input.name }];
  }

  let res: Response;
  try {
    res = await fetchImpl(`${base}/publications/${pubId}/subscriptions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      // #4438: aborta o fetch se a Beehiiv não responder a tempo — ver
      // rationale completo em SUBSCRIBE_FETCH_TIMEOUT_MS acima.
      signal: AbortSignal.timeout(SUBSCRIBE_FETCH_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, status: 502, reason: "beehiiv_error" };
  }
  if (res.ok) return { ok: true, status: res.status };
  return { ok: false, status: res.status, reason: "beehiiv_error" };
}

export interface SubscribeDeps {
  fetchImpl?: typeof fetch;
}

/**
 * Handler `POST /jogar/subscribe` (#3580). Fluxo: parse → valida (honeypot /
 * opt-in / e-mail) → rate-limit por IP → `subscribeToBeehiiv`. Sempre responde
 * JSON (com CORS via `json(env)`).
 *
 * Respostas:
 *   - 200 `{ ok: true }`  — assinou (ou honeypot silenciosamente descartado)
 *   - 400 `{ ok: false, error }` — opt-in ausente / e-mail inválido
 *   - 429 `{ ok: false, error: "rate_limited" }` — abuso por IP
 *   - 503 `{ ok: false, error: "subscribe_unavailable" }` — secret Beehiiv não
 *          configurado (o form cai no fallback "assine pela página")
 *   - 502 `{ ok: false, error: "subscribe_failed" }` — Beehiiv rejeitou/erro
 */
export async function handleJogarSubscribe(
  request: Request,
  env: Env,
  deps: SubscribeDeps = {},
): Promise<Response> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const raw = await request.text();
  const parsed = parseSubscribeBody(raw, request.headers.get("Content-Type") ?? "");
  const v = validateSubscribeInput(parsed);
  if (!v.ok) {
    // Honeypot: 200 fake-success — não revela ao bot que foi pego.
    if (v.error === "honeypot") return json({ ok: true }, 200, env);
    return json({ ok: false, error: v.error }, v.status, env);
  }

  const ip =
    request.headers.get("CF-Connecting-IP") ||
    request.headers.get("X-Forwarded-For") ||
    "";
  const rl = await checkSubscribeRateLimit(env.POLL, ip);
  if (!rl.allowed) return json({ ok: false, error: "rate_limited" }, 429, env);

  const utm = resolveSubscribeUtm(v.source);
  const result = await subscribeToBeehiiv(env, { name: v.name, email: v.email }, fetchImpl, utm);
  if (result.ok) {
    // #5504: CompleteRegistration pra Meta Conversions API — fire-and-forget
    // best-effort, DEPOIS que o cadastro na Beehiiv já foi confirmado.
    // `sendCompleteRegistrationEvent` nunca lança (fail-soft, ver
    // scripts/lib/shared/meta-capi.ts) — sem META_CAPI_ACCESS_TOKEN
    // configurado é no-op silencioso; qualquer erro de rede/Meta também
    // nunca chega a este handler nem afeta a resposta 200 já garantida.
    await sendCompleteRegistrationEvent(
      { email: v.email, eventSourceUrl: request.url },
      { accessToken: env.META_CAPI_ACCESS_TOKEN, fetchImpl },
    );
    return json({ ok: true }, 200, env);
  }
  if (result.reason === "not_configured") {
    return json({ ok: false, error: "subscribe_unavailable" }, 503, env);
  }
  return json({ ok: false, error: "subscribe_failed" }, 502, env);
}
