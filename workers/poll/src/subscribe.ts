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
import { sendCompleteRegistrationEvent, logMetaCapiSendResult } from "../../../scripts/lib/shared/meta-capi.ts"; // #5504, #7776
import { applyKitSignupOriginField } from "../../../scripts/lib/shared/kit-signup-origin.ts"; // #6048
// #7723: consome a maquinaria COMPARTILHADA (scripts/lib/shared/kit-doi.ts),
// a mesma de `cursos` e `reativar`. Antes o poll tinha copias locais de
// `resolveKitCreateState`/`vincularKitDoiForm` — duas implementacoes da
// mesma regra, que e a classe de bug que o #7723 existe pra fechar.
import {
  resolveKitCreateState,
  vincularKitDoiForm,
  extrairSubscriberId,
  mensagemSubscriberIdAusente,
} from "../../../scripts/lib/shared/kit-doi.ts"; // #7723

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
 *
 * #6427: `"apex"` — página própria de cadastro do apex (`diar.ia.br/assinar`,
 * `workers/site/public/assinar/`), que POSTa aqui CROSS-ORIGIN (mesmo
 * mecanismo de `livros-hero`/`livros-footer`). Único `source` que aceita
 * `utm_source`/`utm_medium`/`utm_campaign` DINÂMICOS vindos do cliente — ver
 * `isAllowedClientUtmSource`/`resolveSubscribeUtm` abaixo pro porquê e a
 * exceção estreita ao design "nunca aceita utm_* do cliente" descrito 2
 * parágrafos acima. Motivo: o cadastro Clarice (`withClariceUtm`,
 * `scripts/lib/mensal/monthly-render.ts`) injeta um `utm_campaign` que MUDA a
 * cada ciclo/posição (`clarice-{ciclo}-{posicao}`) — um `SubscribeSource`
 * fixo por campanha, como os demais deste enum, exigiria adicionar 1 entrada
 * nova aqui a cada envio, o que não escala.
 */
export type SubscribeSource = "jogar" | "livros-hero" | "livros-footer" | "vote-clarice" | "jogar-gate" | "jogar-identify" | "jogar-postweb" | "arquivo" | "hub" | "apex";

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
  /** #7535 (Camada 1): canal pago do CLIENTE quando `isAllowedClientUtmSource`
   * casa — gravado num campo PRÓPRIO (`origem_paga`), nunca sobrescrevendo o
   * triplo fixo por posição (`source`/`medium`/`campaign` acima). `""` =
   * não veio de um canal pago reconhecido (cadastro orgânico, ou o triplo
   * `apex` já carrega a info no próprio `source` — ver `resolveSubscribeUtm`). */
  origemPaga: string;
}

const SUBSCRIBE_UTM_BY_SOURCE: Record<SubscribeSource, SubscribeUtm> = {
  jogar: {
    source: SUBSCRIBE_UTM_SOURCE,
    medium: INLINE_SUBSCRIBE_UTM_MEDIUM,
    campaign: INLINE_SUBSCRIBE_UTM_CAMPAIGN,
    referringSite: "eia-jogar-inline",
    origemPaga: "",
  },
  // utm_source=livros / utm_medium distinto por posição — pedido explícito da
  // issue #4051 pra medir hero × fim-de-lista separadamente.
  // #4041: valores do registry espelhado (./utm-registry).
  "livros-hero": {
    source: LIVROS_INLINE_UTM.source,
    medium: LIVROS_INLINE_UTM.hero.medium,
    campaign: LIVROS_INLINE_UTM.campaign,
    referringSite: "livros-inline-hero",
    origemPaga: "",
  },
  "livros-footer": {
    source: LIVROS_INLINE_UTM.source,
    medium: LIVROS_INLINE_UTM.footer.medium,
    campaign: LIVROS_INLINE_UTM.campaign,
    referringSite: "livros-inline-footer",
    origemPaga: "",
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
    origemPaga: "",
  },
  // #4054: cadastro na tela de gate do caminho de fora (`web-gate.ts`).
  "jogar-gate": {
    source: JOGAR_GATE_INLINE_UTM.source,
    medium: JOGAR_GATE_INLINE_UTM.medium,
    campaign: JOGAR_GATE_INLINE_UTM.campaign,
    referringSite: "jogar-gate-inline",
    origemPaga: "",
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
    origemPaga: "",
  },
  // #4578: caixa unificada do gate no pós-voto de /jogar?from=post-web —
  // mesmo endpoint de "jogar-gate" (POST /jogar/gate/subscribe), source
  // distinto pra não misturar os 2 pontos de entrada na atribuição.
  "jogar-postweb": {
    source: JOGAR_POSTWEB_UTM.source,
    medium: JOGAR_POSTWEB_UTM.medium,
    campaign: JOGAR_POSTWEB_UTM.campaign,
    referringSite: "jogar-postweb-gate",
    origemPaga: "",
  },
  // #5167 item 1: CTA no topo de arquivo.diar.ia.br.
  arquivo: {
    source: ARQUIVO_INLINE_UTM.source,
    medium: ARQUIVO_INLINE_UTM.medium,
    campaign: ARQUIVO_INLINE_UTM.campaign,
    referringSite: "arquivo-inline",
    origemPaga: "",
  },
  // #5167 item 2: CTA no topo de cada hub temático (arquivo.diar.ia.br/temas/{slug}).
  hub: {
    source: HUB_INLINE_UTM.source,
    medium: HUB_INLINE_UTM.medium,
    campaign: HUB_INLINE_UTM.campaign,
    referringSite: "hub-inline",
    origemPaga: "",
  },
  // #6427: triplo DEFAULT do cadastro do apex — usado sempre que o cliente
  // não mandar utm_source/utm_medium/utm_campaign, ou mandar um utm_source
  // que não casa a allowlist de `isAllowedClientUtmSource` abaixo. Nunca
  // confundir com o triplo Clarice em si (esse é dinâmico, resolvido em
  // runtime — ver `resolveSubscribeUtm`).
  apex: {
    source: "diaria-apex",
    medium: "web",
    campaign: "cadastro-apex",
    referringSite: "apex-subscribe-page",
    origemPaga: "",
  },
};

/**
 * #6427/#6980: allowlist de prefixos de `utm_source` que o cliente tem
 * permissão de repassar cru — nasceu escopada só a `source === "apex"`
 * (comportamento preservado abaixo). #7535 (Camada 1) estendeu a CONSULTA
 * pra qualquer `source` (ver `resolveSubscribeUtm`), mas a allowlist em si
 * NÃO mudou de lugar por acidente: moveu pra `scripts/lib/shared/
 * client-utm-allowlist.ts` porque o worker `cursos` (bundle SEPARADO, sem
 * import cross-worker por convenção — ver `workers/cursos/src/subscribe.ts`)
 * também precisa dela pro mesmo fix. Re-exportado aqui pra não quebrar os
 * imports existentes (`test/poll-subscribe-apex-utm-6427.test.ts` e afins).
 */
export { CLIENT_UTM_SOURCE_ALLOWED_PREFIXES, isAllowedClientUtmSource } from "../../../scripts/lib/shared/client-utm-allowlist.ts";
import { isAllowedClientUtmSource } from "../../../scripts/lib/shared/client-utm-allowlist.ts";

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

/** #6427: triplo UTM cru mandado pelo cliente — só consultado quando
 * `source === "apex"` (ver `resolveSubscribeUtm`). Campos individuais, não a
 * struct `SubscribeUtm` inteira, porque o cliente nunca manda
 * `referringSite` (esse é sempre o fixo `SUBSCRIBE_UTM_BY_SOURCE.apex.referringSite`,
 * nunca variável por campanha). */
export interface ClientUtmOverride {
  source?: unknown;
  medium?: unknown;
  campaign?: unknown;
}

/**
 * Pure: resolve o triplo UTM a partir do `source` mandado pelo cliente
 * (default `jogar` pra valor ausente/desconhecido — nunca lança).
 *
 * #6427: quando `raw === "apex"` E `clientUtm.source` casa a allowlist de
 * `isAllowedClientUtmSource`, o triplo final vem do CLIENTE (source/medium/
 * campaign, com `medium`/`campaign` ausentes/vazios caindo no default do
 * apex individualmente — só `source` é obrigatório pra sequer tentar este
 * caminho). `referringSite` nunca vem do cliente. Fora desse caso (source
 * diferente de `"apex"`, ou `utm_source` fora da allowlist), comportamento
 * idêntico ao pré-#6427: cai no triplo fixo do `source` resolvido.
 *
 * #7535 (Camada 1): pra QUALQUER `source` que não seja `"apex"` (que já
 * carrega o canal pago no próprio `source`, ver acima), quando
 * `clientUtm.source` casa a allowlist, o valor vai pro campo NOVO
 * `origemPaga` — o triplo fixo (`source`/`medium`/`campaign`) do registry
 * NUNCA muda. É como `livros`/`cursos`/`arquivo`/`hub` deixam de perder a
 * atribuição de tráfego pago sem sacrificar a granularidade por posição que
 * o triplo fixo carrega (rationale completo na issue #7535). `utm_source`
 * fora da allowlist (ou ausente) → `origemPaga: ""`, comportamento idêntico
 * ao pré-#7535.
 */
export function resolveSubscribeUtm(raw: unknown, clientUtm?: ClientUtmOverride): SubscribeUtm {
  const key = typeof raw === "string" ? raw : "";
  const base = SUBSCRIBE_UTM_BY_SOURCE[key as SubscribeSource] ?? SUBSCRIBE_UTM_BY_SOURCE.jogar;
  if (key === "apex" && clientUtm && isAllowedClientUtmSource(clientUtm.source)) {
    const source = String(clientUtm.source).trim();
    const medium =
      typeof clientUtm.medium === "string" && clientUtm.medium.trim() ? clientUtm.medium.trim() : base.medium;
    const campaign =
      typeof clientUtm.campaign === "string" && clientUtm.campaign.trim() ? clientUtm.campaign.trim() : base.campaign;
    return { source, medium, campaign, referringSite: base.referringSite, origemPaga: "" };
  }
  // #7535: triplo fixo intacto pra qualquer OUTRO source — só origemPaga
  // muda, e só quando o cliente manda um utm_source da allowlist.
  if (clientUtm && isAllowedClientUtmSource(clientUtm.source)) {
    return { ...base, origemPaga: String(clientUtm.source).trim() };
  }
  return base;
}

/** Teto de tamanho do nome capturado — evita payload abusivo (o campo é
 * opcional; a Beehiiv nem tem um campo nativo de nome, ver `subscribeToBeehiiv`). */
export const SUBSCRIBE_NAME_MAX = 100;

/** Rate-limit padrão do cadastro público: N cadastros bem-formados por IP por
 * janela. Baixo de propósito — um humano assina 1x; qualquer coisa acima é
 * abuso. */
export const SUBSCRIBE_RATE_LIMIT = 5;
export const SUBSCRIBE_RATE_WINDOW_SEC = 3600; // 1h

/** #6427: teto de tamanho dos campos utm_* crus do cliente — mesmo racional
 * de `SUBSCRIBE_NAME_MAX` (payload abusivo), aplicado ANTES de qualquer
 * validação de allowlist (`isAllowedClientUtmSource` já rejeita a maioria,
 * mas o corte de tamanho é defesa em profundidade, barato de aplicar). */
export const SUBSCRIBE_CLIENT_UTM_MAX = 100;

/** #8003: teto de tamanho de `referrer`/`click_id` crus do cliente — mesmo
 * racional de `SUBSCRIBE_CLIENT_UTM_MAX` acima (defesa em profundidade: o
 * cliente já corta em 300 chars, ver `clientOriginSignalPayloadFieldsJs`,
 * mas nunca confiar só nisso). Aplicado no parse, antes de qualquer gravação
 * em custom field. */
export const SUBSCRIBE_CLIENT_ORIGIN_MAX = 300;

/** #8003: sinal de origem do cliente — SEPARADO do triplo UTM/`origemPaga`
 * acima, nunca varia por `source` (é sinal cru do cliente pra QUALQUER
 * `source`). Puramente informativo: nunca consumido por lógica de negócio,
 * só repassado pro ESP configurado quando o custom field correspondente
 * existir (ver `BEEHIIV_ORIGEM_REFERRER_FIELD`/`KIT_ORIGEM_REFERRER_FIELD`
 * e `BEEHIIV_ORIGEM_CLICKID_FIELD`/`KIT_ORIGEM_CLICKID_FIELD`, index.ts). */
export interface SubscribeOrigin {
  referrer: string;
  clickId: string;
}

export interface ParsedSubscribe {
  name: string;
  email: string;
  optin: boolean;
  /** honeypot — campo invisível que só bot preenche. */
  honeypot: string;
  /** #4051 — chave de call site (ver `SubscribeSource`); string crua, resolvida
   * só depois via `resolveSubscribeUtm` (nunca usada diretamente como UTM). */
  source: string;
  /** #6427: utm_source/medium/campaign CRUS do cliente — só têm efeito
   * quando `source === "apex"` e `utm_source` casa `isAllowedClientUtmSource`
   * (ver `resolveSubscribeUtm`); em qualquer outro `source`, são lidos mas
   * nunca consultados. Vazio (não `undefined`) quando ausente do body. */
  utmSource: string;
  utmMedium: string;
  utmCampaign: string;
  /** #8003: `document.referrer` cru do cliente — vazio (não `undefined`)
   * quando ausente do body. Nunca usado por lógica de negócio (ver
   * `SubscribeOrigin`). */
  referrer: string;
  /** #8003: click ID de ads prefixado pelo provedor (`gclid:...`/`fbclid:...`/
   * `msclkid:...`) — vazio quando ausente do body. */
  clickId: string;
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
        utmSource: asStr(o.utm_source),
        utmMedium: asStr(o.utm_medium),
        utmCampaign: asStr(o.utm_campaign),
        referrer: asStr(o.referrer),
        clickId: asStr(o.click_id),
      };
    } catch {
      return { name: "", email: "", optin: false, honeypot: "", source: "", utmSource: "", utmMedium: "", utmCampaign: "", referrer: "", clickId: "" };
    }
  }
  const params = new URLSearchParams(raw);
  return {
    name: params.get("name") ?? "",
    email: params.get("email") ?? "",
    optin: truthyFlag(params.get("optin")),
    honeypot: params.get("website") ?? "",
    source: params.get("source") ?? "",
    utmSource: params.get("utm_source") ?? "",
    utmMedium: params.get("utm_medium") ?? "",
    utmCampaign: params.get("utm_campaign") ?? "",
    referrer: params.get("referrer") ?? "",
    clickId: params.get("click_id") ?? "",
  };
}

export type SubscribeValidation =
  | {
      ok: true;
      name: string;
      email: string;
      source: string;
      utmSource: string;
      utmMedium: string;
      utmCampaign: string;
      /** #8003: já cortados em SUBSCRIBE_CLIENT_ORIGIN_MAX. */
      referrer: string;
      clickId: string;
    }
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
  // #6427: repassados crus (allowlist/uso condicional acontece só em
  // `resolveSubscribeUtm`) — aqui só o corte de tamanho, defesa em profundidade.
  const utmSource = (p.utmSource || "").trim().slice(0, SUBSCRIBE_CLIENT_UTM_MAX);
  const utmMedium = (p.utmMedium || "").trim().slice(0, SUBSCRIBE_CLIENT_UTM_MAX);
  const utmCampaign = (p.utmCampaign || "").trim().slice(0, SUBSCRIBE_CLIENT_UTM_MAX);
  // #8003: mesmo corte de defesa em profundidade, aplicado ao sinal de
  // origem (o cliente já corta em SUBSCRIBE_CLIENT_ORIGIN_MAX, mas nunca
  // confiar só nisso).
  const referrer = (p.referrer || "").trim().slice(0, SUBSCRIBE_CLIENT_ORIGIN_MAX);
  const clickId = (p.clickId || "").trim().slice(0, SUBSCRIBE_CLIENT_ORIGIN_MAX);
  return { ok: true, name, email, source: p.source, utmSource, utmMedium, utmCampaign, referrer, clickId };
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
  reason?: "not_configured" | "subscribe_error";
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
async function subscribeToBeehiiv(
  env: Env,
  input: { name: string; email: string },
  fetchImpl: typeof fetch = fetch,
  utm: SubscribeUtm = SUBSCRIBE_UTM_BY_SOURCE.jogar,
  origin: SubscribeOrigin = { referrer: "", clickId: "" },
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
  // #7535: por simetria com KIT_ORIGEM_PAGA_FIELD abaixo — mesmo guard duplo
  // (env configurado E valor presente) antes de gravar.
  if (env.BEEHIIV_ORIGEM_PAGA_FIELD && utm.origemPaga) {
    const field = { name: env.BEEHIIV_ORIGEM_PAGA_FIELD, value: utm.origemPaga };
    body.custom_fields = Array.isArray(body.custom_fields) ? [...body.custom_fields, field] : [field];
  }
  // #8003: mesmo guard duplo (env configurado E valor presente) — referrer/
  // click_id nunca fazem parte do triplo UTM/origem_paga acima, são campos
  // PRÓPRIOS, puramente informativos.
  if (env.BEEHIIV_ORIGEM_REFERRER_FIELD && origin.referrer) {
    const field = { name: env.BEEHIIV_ORIGEM_REFERRER_FIELD, value: origin.referrer };
    body.custom_fields = Array.isArray(body.custom_fields) ? [...body.custom_fields, field] : [field];
  }
  if (env.BEEHIIV_ORIGEM_CLICKID_FIELD && origin.clickId) {
    const field = { name: env.BEEHIIV_ORIGEM_CLICKID_FIELD, value: origin.clickId };
    body.custom_fields = Array.isArray(body.custom_fields) ? [...body.custom_fields, field] : [field];
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
    return { ok: false, status: 502, reason: "subscribe_error" };
  }
  if (res.ok) return { ok: true, status: res.status };
  return { ok: false, status: res.status, reason: "subscribe_error" };
}

/**
 * #6048 (migração Beehiiv → Kit, #461/#463): equivalente Kit de
 * `subscribeToBeehiiv` — mesmo contrato de entrada/saída, `SubscribeResult`
 * compartilhado (`reason: "subscribe_error"` cobre também erro do Kit; nomear
 * um `"kit_error"` separado quebraria o consumo em `handleJogarSubscribe`
 * sem ganho real — o handler só verifica `=== "not_configured"`).
 *
 * ## Endpoint e auth (achados ao vivo #464/#6047, reconfirmados aqui)
 *
 * `POST /v4/subscribers`, header `X-Kit-Api-Key` (não Bearer, diferente da
 * Beehiiv). `state: "active"` na criação bypassa qualquer confirmação —
 * confirmado ao vivo em 24/08/2026 (subscriber volta com `state: "active"`
 * na resposta, sem nenhum passo pendente), mesmo efeito prático do
 * `double_opt_override: "off"` da Beehiiv (ver bloco DOUBLE OPT-IN no topo
 * do arquivo — a caixinha marcada nesta página já é o consentimento LGPD).
 *
 * **Idempotente por e-mail** (achado ao vivo, diferente da Beehiiv): 1º
 * `POST` com um e-mail novo devolve 201; um 2º `POST` com o MESMO e-mail
 * devolve 200 (mesmo `id`, atualiza `first_name`/`fields` se enviados) — não
 * precisa de nenhum equivalente a `reactivate_existing: false`.
 *
 * ## Sem UTM/referring-site nativo (achado ao vivo #6048)
 *
 * Ao contrário da Beehiiv, a API de criação do Kit não tem campos nativos de
 * atribuição — só `email_address`/`first_name`/`state`/`fields` (custom).
 * `KIT_UTM_*_FIELD`/`KIT_REFERRING_SITE_FIELD` (env, nomes de custom field
 * criados manualmente no dashboard, mesmo padrão de `BEEHIIV_NAME_FIELD`)
 * habilitam gravar essa atribuição via `fields` quando configurados —
 * NENHUM foi criado ainda na conta de produção (decisão de criar os campos
 * fica pro editor, no momento do switchover). Ausentes → cadastro segue
 * normal, só sem essa atribuição gravada (mesmo degrade gracioso do nome).
 *
 * ## Double opt-in (#6340, decisão do editor 26/08/2026)
 *
 * `resolveKitCreateState` decide `state: "inactive"` em vez de `"active"`
 * quando este worker está em `DOUBLE_OPT_IN_FLAG.enabledForWorkers` **E**
 * `env.KIT_DOI_FORM_ID` está configurado (`optin-flag-6340.ts` — rollout
 * worker-a-worker, `poll` primeiro por ter o menor volume, mesmo padrão do
 * #6048). **Base já importada (589 `active`) NÃO é afetada** — isto só muda
 * o `state` na CRIAÇÃO de um subscriber novo por este endpoint; nenhum
 * subscriber existente é re-escrito aqui.
 *
 * #6565: sem `KIT_DOI_FORM_ID` configurado, `vincularKitDoiForm` é no-op —
 * nenhum e-mail de confirmação sai, e um subscriber criado `inactive` nesse
 * cenário ficaria preso para sempre (nada no Kit promove `inactive→active`
 * sozinho). Por isso o guard cai de volta em `"active"` (comportamento
 * anterior ao #6340) enquanto o form não estiver configurado — o flag por
 * worker liga o ROLLOUT, mas só cria `inactive` quando o caminho de
 * confirmação (o form) de fato existe pra desafogar esse estado.
 *
 * Quando o double opt-in está ativo E `KIT_DOI_FORM_ID` está configurado
 * (nome enganoso à parte — é um ID de FORM, não um nome de campo, mesmo
 * padrão dos `KIT_*_FIELD` acima), `vincularKitDoiForm` dispara em seguida
 * (best-effort, nunca falha a assinatura) — é o vínculo
 * `POST /v4/forms/{form}/subscribers/{sub}` que, medido ao vivo (#6340,
 * comentário 27/08/2026), (a) preserva `state: "inactive"` (não promove
 * sozinho), (b) grava o `referrer` com o triplo UTM no bloco de atribuição
 * do form (`referrer_utm_parameters`, distinto — e não substituto — dos
 * `KIT_*_FIELD` de custom field acima, que continuam sendo a ÚNICA
 * atribuição que sobrevive pra quem nunca confirma), e (c) é o que de fato
 * dispara o e-mail "Important: confirm your subscription" quando o form
 * tem "Send confirmation email" ligado no dashboard do Kit — configuração
 * OPERACIONAL fora do alcance deste repo (ver #6318, mesmo form). Sem
 * `KIT_DOI_FORM_ID` configurado, o subscriber É criado `inactive`, e
 * `vincularKitDoiForm` dispara o e-mail de confirmação. Sem `KIT_DOI_FORM_ID`
 * configurado, `resolveKitCreateState` já devolve `"active"` (ver #6565
 * acima) — o cenário "preso em inactive sem e-mail" descrito aqui até
 * 27/08/2026 não é mais alcançável por este caminho.
 *
 * RISCO RESOLVIDO por medição ao vivo (#7723, 09/09/2026) — a versão
 * anterior desta nota registrava como "não confirmado se o Kit regride um
 * `active` já confirmado" e pedia reverificação antes do 1º push real.
 * Reverificado: **o Kit NÃO regride**.
 *
 * Procedimento: `POST /v4/subscribers` com `state: "active"` (201, criou
 * `active`), depois um 2º POST no MESMO e-mail com `state: "inactive"` — a
 * resposta veio `200` e `subscriber.state: "active"`. O upsert atualiza
 * campos, mas preserva o `state` de quem já existe; ele NÃO é regravado pelo
 * payload.
 *
 * Consequência prática, que vale para os 3 workers: um assinante já
 * confirmado que reenvia o formulário não é rebaixado a `inactive` nem perde
 * o recebimento. Por isso `cursos` não precisou do GET-check de idempotência
 * que o `reativar` tem (lá o GET existe por outro motivo: o guard de
 * descadastro nativo pendente, #4538).
 */

/**
 * #6340: vincula o subscriber recém-criado a `KIT_DOI_FORM_ID` — dispara o
 * e-mail de confirmação do double opt-in (quando o form tem "Send
 * confirmation email" ligado no dashboard do Kit) sem promover o `state`
 * (ver docstring de `subscribeToKit`). Best-effort: nunca lança, só loga —
 * uma falha aqui não deveria reverter uma criação de subscriber que já
 * teve sucesso (mesmo racional de fail-soft do resto do arquivo).
 */

async function subscribeToKit(
  env: Env,
  input: { name: string; email: string },
  fetchImpl: typeof fetch = fetch,
  utm: SubscribeUtm = SUBSCRIBE_UTM_BY_SOURCE.jogar,
  origin: SubscribeOrigin = { referrer: "", clickId: "" },
): Promise<SubscribeResult> {
  const apiKey = env.KIT_API_KEY;
  if (!apiKey) return { ok: false, status: 503, reason: "not_configured" };

  const base = env.KIT_API_URL ?? "https://api.kit.com/v4";
  const fields: Record<string, string> = {};
  if (input.name && env.KIT_NAME_FIELD) fields[env.KIT_NAME_FIELD] = input.name;
  if (env.KIT_UTM_SOURCE_FIELD) fields[env.KIT_UTM_SOURCE_FIELD] = utm.source;
  if (env.KIT_UTM_MEDIUM_FIELD) fields[env.KIT_UTM_MEDIUM_FIELD] = utm.medium;
  if (env.KIT_UTM_CAMPAIGN_FIELD) fields[env.KIT_UTM_CAMPAIGN_FIELD] = utm.campaign;
  if (env.KIT_REFERRING_SITE_FIELD) fields[env.KIT_REFERRING_SITE_FIELD] = utm.referringSite;
  // #7535 (Camada 1): canal pago do cliente, gravado num campo PRÓPRIO —
  // nunca sobrescreve o triplo fixo por posição acima. Guard duplo (env
  // configurado E valor presente) — mesmo padrão dos `KIT_*_FIELD` acima.
  if (env.KIT_ORIGEM_PAGA_FIELD && utm.origemPaga) fields[env.KIT_ORIGEM_PAGA_FIELD] = utm.origemPaga;
  // #8003: mesmo guard duplo — campos PRÓPRIOS, nunca sobrescrevem o triplo
  // fixo/origem_paga acima.
  if (env.KIT_ORIGEM_REFERRER_FIELD && origin.referrer) fields[env.KIT_ORIGEM_REFERRER_FIELD] = origin.referrer;
  if (env.KIT_ORIGEM_CLICKID_FIELD && origin.clickId) fields[env.KIT_ORIGEM_CLICKID_FIELD] = origin.clickId;
  // #6048: marcador "entrou pelo funil" — distingue de quem só foi copiado
  // da Beehiiv pelo sync unidirecional (necessário pra segmentar o envio
  // sem entrega duplicada, ver scripts/lib/shared/kit-signup-origin.ts).
  applyKitSignupOriginField(fields, env);

  // #6340/#6565: "active" preservado pra todo worker fora de
  // DOUBLE_OPT_IN_FLAG.enabledForWorkers OU sem KIT_DOI_FORM_ID configurado
  // (ver resolveKitCreateState acima) — era o literal fixo "active" antes
  // do #6340.
  const createState = resolveKitCreateState(env.KIT_DOI_FORM_ID, "poll");
  const body: Record<string, unknown> = {
    email_address: input.email,
    state: createState,
  };
  if (Object.keys(fields).length > 0) body.fields = fields;

  let res: Response;
  try {
    res = await fetchImpl(`${base}/subscribers`, {
      method: "POST",
      headers: {
        "X-Kit-Api-Key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      // Mesmo timeout/rationale de SUBSCRIBE_FETCH_TIMEOUT_MS (Beehiiv) —
      // um POST simples de assinatura não deve travar a resposta ao usuário.
      signal: AbortSignal.timeout(SUBSCRIBE_FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    // #6048 achado ao vivo (25/08/2026, verificação do rollout do worker
    // poll): antes desta linha, uma falha aqui era TOTALMENTE silenciosa —
    // sem log nenhum — e foi exatamente isso que escondeu um KIT_API_KEY
    // inválido até a 1ª tentativa real de cadastro. Log estruturado, nunca
    // lança (mantém o fail-soft já documentado acima).
    console.error(`[subscribeToKit] fetch exception: ${String(err)}`);
    return { ok: false, status: 502, reason: "subscribe_error" };
  }
  // 200 (upsert de e-mail já existente) e 201 (criação) são ambos sucesso —
  // ver docstring acima sobre a idempotência do Kit.
  if (res.ok) {
    // #6340: dispara o vínculo de form (e-mail de confirmação) só quando o
    // subscriber foi de fato criado `inactive` por este caminho — nunca
    // quando `createState === "active"` (worker fora do rollout), mesmo com
    // KIT_DOI_FORM_ID configurado por engano/antecipação.
    if (createState === "inactive") {
      const extraido = await extrairSubscriberId(res);
      if (extraido.ok) {
        await vincularKitDoiForm({
          apiKey,
          base,
          formId: env.KIT_DOI_FORM_ID,
          subscriberId: extraido.id,
          referrer: `https://diar.ia.br/?utm_source=${encodeURIComponent(utm.source)}&utm_medium=${encodeURIComponent(utm.medium)}&utm_campaign=${encodeURIComponent(utm.campaign)}`,
          fetchImpl,
          timeoutMs: SUBSCRIBE_FETCH_TIMEOUT_MS,
        });
      } else {
        console.error(mensagemSubscriberIdAusente(extraido, input.email, res.status));
      }
    }
    // #6508/#6694: cadastro via API direta também entra na sequence de
    // boas-vindas — mas SÓ quando `createState !== "inactive"` (worker fora
    // do rollout de double opt-in, ou DOI desligado). A razão que vale é a
    // fronteira que o #6340 existe pra proteger: subscriber `inactive` não
    // confirmou o double opt-in e não pode entrar em régua de boas-vindas.
    //
    // ⚠️ #7723 (09/09/2026) — a justificativa ORIGINAL deste branch dizia
    // outra coisa: que o vínculo ao form DOI dispararia "sozinha" a
    // Automation Rule do Kit (trigger "Subscribes to a form" → "Subscribe to
    // an email sequence", rule id 5578342, sequence 2876508), e que a chamada
    // explícita aqui duplicaria a inscrição. Isso foi MEDIDO e é falso:
    // Rules é "Paid feature" no plano Free (app.kit.com/rules redireciona pra
    // billing) e a sequence 2876508 está `active: false` — todo enroll
    // responde `422 "Sequence is inactive"`. Não existe segundo caminho, e
    // portanto não existe duplicação a evitar.
    //
    // O comportamento não muda (não inscrever antes da confirmação segue
    // certo), mas quem ler isto precisa saber que o `inactive` NÃO entra em
    // sequence nenhuma do Kit depois de confirmar — a régua de boas-vindas
    // vive na Brevo (`scripts/onboarding-welcome-run.ts`). Limpar a sequence
    // morta e este branch é follow-up da #7723.
    // Pro caminho `active` (DOI desligado, ou worker fora do rollout),
    // `vincularKitDoiForm` nunca roda — o subscriber nunca é linkado ao
    // form, então a Automation Rule não tem gatilho — daí a chamada
    // explícita aqui continuar sendo o ÚNICO caminho de inscrição na
    // sequence pra esse caso. Best-effort: nunca falha a assinatura, só
    // loga — mesmo padrão de `vincularKitDoiForm`.
    if (createState !== "inactive") {
      const seqRes = await res.clone().json().catch(() => undefined) as { subscriber?: { id?: number } } | undefined;
      const seqSubscriberId = seqRes?.subscriber?.id;
      if (typeof seqSubscriberId === "number") {
        if (env.KIT_WELCOME_SEQUENCE_ID) {
          const seqId = parseInt(env.KIT_WELCOME_SEQUENCE_ID, 10);
          if (!isNaN(seqId)) {
            try {
              const seqFetch = await fetchImpl(`${base}/sequences/${seqId}/subscribers`, {
                method: "POST",
                headers: {
                  "X-Kit-Api-Key": apiKey,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({ subscriber_id: seqSubscriberId }),
                signal: AbortSignal.timeout(SUBSCRIBE_FETCH_TIMEOUT_MS),
              });
              if (!seqFetch.ok) {
                const bodyText = await seqFetch.text().catch(() => "<unreadable>");
                console.error(`[subscribeToKit] #6508: falha ao adicionar subscriber ${seqSubscriberId} à sequence ${seqId}: ${seqFetch.status} ${bodyText.slice(0, 300)}`);
              }
            } catch (err) {
              console.error(`[subscribeToKit] #6508: fetch exception ao adicionar à sequence: ${String(err)}`);
            }
          } else {
            console.error(`[subscribeToKit] #6508: KIT_WELCOME_SEQUENCE_ID inválido: "${env.KIT_WELCOME_SEQUENCE_ID}" — pulando vínculo com sequence`);
          }
        } else {
          // #6694 item (c): diferente do irmão `vincularKitDoiForm` (que
          // retorna cedo em SILÊNCIO TOTAL quando `KIT_DOI_FORM_ID` está
          // ausente — só loga o `!res.ok`/exception de uma chamada HTTP que
          // de fato aconteceu), este ramo agora loga também o caso AUSENTE.
          // Sem KIT_WELCOME_SEQUENCE_ID configurado isto é dormência
          // esperada (nenhum wrangler.toml seta a var hoje), não erro, mas
          // registrar o skip evita silêncio indistinguível de "não devia
          // rodar".
          console.error(`[subscribeToKit] #6508: KIT_WELCOME_SEQUENCE_ID não configurado — pulando vínculo com sequence de boas-vindas para subscriber ${seqSubscriberId}.`);
        }
      }
    }
    return { ok: true, status: res.status };
  }
  // #6048 — mesmo racional do catch acima: loga o corpo do erro do Kit
  // (truncado, sem incluir o header de auth) em vez de descartar em silêncio.
  const bodyText = await res.text().catch(() => "<unreadable>");
  console.error(`[subscribeToKit] Kit respondeu ${res.status}: ${bodyText.slice(0, 500)}`);
  return { ok: false, status: res.status, reason: "subscribe_error" };
}

/**
 * #6291: parser tolerante de `env.SUBSCRIBE_BACKEND` — mesma classe de bug do
 * #6048 (fallback silencioso pro backend legado), por outra porta. Antes
 * desta função, todo call site fazia `env.SUBSCRIBE_BACKEND === "kit"` cru:
 * `"Kit"`, `"kit "`, `"beehiv"` (typo) caíam em Beehiiv sem nenhum aviso —
 * indistinguível de "backend Beehiiv escolhido de propósito". Trim + lowercase
 * tolera espaço/capitalização; qualquer valor que não seja `"kit"`/`"beehiiv"`/
 * vazio loga o valor bruto (nunca lança) antes de degradar pro default. O
 * TOML do worker está fora do alcance do type checker de qualquer jeito — só
 * o runtime pode pegar isso.
 */
function resolveBackend(env: Pick<Env, "SUBSCRIBE_BACKEND">): "beehiiv" | "kit" {
  const raw = (env.SUBSCRIBE_BACKEND ?? "").trim().toLowerCase();
  if (raw === "kit") return "kit";
  if (raw && raw !== "beehiiv") {
    console.error(`[subscribe] SUBSCRIBE_BACKEND desconhecido: ${JSON.stringify(env.SUBSCRIBE_BACKEND)} — caindo em beehiiv`);
  }
  return "beehiiv";
}

/**
 * #6291: ÚNICO ponto de entrada pro cadastro — ramifica por
 * `SUBSCRIBE_BACKEND` (via `resolveBackend`) e chama o backend certo.
 * `subscribeToBeehiiv`/`subscribeToKit` acima NÃO são mais exportadas: um 6º
 * call site que esquecesse de ramificar (o bug original do #6048) não
 * alcança mais as funções cruas — o compilador recusa a importação direta.
 * O erro deixa de ser detectável (por um teste de regex) e passa a ser
 * inexprimível (por tipo). `test/subscribe-backend-branching-guard-6048.test.ts`
 * (guard de regex que só cobria os call sites já existentes) foi removido —
 * este é o guard estrutural que o substitui.
 */
export async function subscribeViaConfiguredBackend(
  env: Env,
  input: { name: string; email: string },
  fetchImpl: typeof fetch = fetch,
  utm: SubscribeUtm = SUBSCRIBE_UTM_BY_SOURCE.jogar,
  origin: SubscribeOrigin = { referrer: "", clickId: "" },
): Promise<SubscribeResult> {
  return resolveBackend(env) === "kit"
    ? subscribeToKit(env, input, fetchImpl, utm, origin)
    : subscribeToBeehiiv(env, input, fetchImpl, utm, origin);
}

export interface SubscribeDeps {
  fetchImpl?: typeof fetch;
}

/**
 * Handler `POST /jogar/subscribe` (#3580). Fluxo: parse → valida (honeypot /
 * opt-in / e-mail) → rate-limit por IP → `subscribeViaConfiguredBackend`.
 * Sempre responde JSON (com CORS via `json(env)`).
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
  // #5504 hotfix: ExecutionContext OPCIONAL, mesmo padrão de handleVote/
  // handleVoteFastPath (#3983) — habilita `ctx.waitUntil()` pro disparo CAPI
  // abaixo SEM atrasar a resposta ao usuário. Sem `ctx` real (ex: teste que
  // não injeta um), cai no fallback síncrono (comportamento pré-hotfix).
  ctx?: ExecutionContext,
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

  // #6427: `v.source === "apex"` é o único caminho onde estes 3 campos têm
  // efeito (ver docstring de `resolveSubscribeUtm`) — passá-los sempre é
  // inofensivo pros demais `source`, que os ignoram.
  const utm = resolveSubscribeUtm(v.source, { source: v.utmSource, medium: v.utmMedium, campaign: v.utmCampaign });
  // #8003: sinal de origem cru do cliente — nunca varia por `source`, ver
  // docstring de `SubscribeOrigin`.
  const origin: SubscribeOrigin = { referrer: v.referrer, clickId: v.clickId };
  // #6291: seleção de backend via a ÚNICA função exportada — ver docstring
  // de `subscribeViaConfiguredBackend` acima sobre por que um 6º handler
  // desguardado deixou de ser possível.
  const result = await subscribeViaConfiguredBackend(env, { name: v.name, email: v.email }, fetchImpl, utm, origin);
  if (result.ok) {
    // #5504/hotfix pós-merge: CompleteRegistration pra Meta Conversions API
    // — fire-and-forget best-effort, DEPOIS que o cadastro na Beehiiv já foi
    // confirmado. `sendCompleteRegistrationEvent` nunca lança (fail-soft, ver
    // scripts/lib/shared/meta-capi.ts) — sem META_CAPI_ACCESS_TOKEN
    // configurado é no-op silencioso; qualquer erro de rede/Meta também
    // nunca chega a este handler nem afeta a resposta 200 já garantida.
    // Genuinamente fire-and-forget agora: `ctx.waitUntil()` adia o envio pra
    // depois da resposta ao usuário — o `await` direto (achado do review
    // pós-merge #5504) atrasava a resposta em até
    // `META_CAPI_FETCH_TIMEOUT_MS` (8s) sempre que a Meta respondia lento.
    // #7776: `logMetaCapiSendResult` encaixa o log estruturado (not_configured
    // vs. meta_error/network_error vs. sent) NO MEIO do mesmo caminho
    // fire-and-forget — não muda o tipo nem o timing do que `waitUntil`/
    // `await` abaixo já faziam.
    const sendEvent = logMetaCapiSendResult(
      sendCompleteRegistrationEvent(
        { email: v.email, eventSourceUrl: request.url },
        { accessToken: env.META_CAPI_ACCESS_TOKEN, fetchImpl },
      ),
      "poll",
    );
    if (ctx && typeof ctx.waitUntil === "function") {
      ctx.waitUntil(sendEvent);
    } else {
      await sendEvent;
    }
    return json({ ok: true }, 200, env);
  }
  if (result.reason === "not_configured") {
    return json({ ok: false, error: "subscribe_unavailable" }, 503, env);
  }
  return json({ ok: false, error: "subscribe_failed" }, 502, env);
}
