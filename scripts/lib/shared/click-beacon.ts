/**
 * scripts/lib/shared/click-beacon.ts (#8982)
 *
 * `CliqueIngresso` perdia quase todo o clique real: o listener de
 * `.checkout-link` em `workers/site/public/evento/agente-ia/script.js`
 * disparava `fbq('trackCustom', 'CliqueIngresso_{A|B}')` e o navegador
 * seguia o `href` pra Hotmart NO MESMO INSTANTE — a navegação cancelava a
 * requisição do pixel antes dela sair (medido no Events Manager, dataset
 * `1285191740325112`, 31/08–27/09/2026: 2 `CliqueIngresso` vs 98
 * `InitiateCheckout` disparado pela Hotmart do outro lado).
 *
 * Fix: o clique dispara TAMBÉM um beacon (`navigator.sendBeacon`, sobrevive
 * à navegação — é o ponto inteiro de existir) pro Worker `site`
 * (`POST /evento/agente-ia/clique`), que reenvia o MESMO evento via CAPI
 * com o MESMO `event_id` do `fbq(...)` client-side. A Meta dedupa os dois
 * lados pelo par (`event_name`, `event_id`) — o evento não é contado 2x, só
 * passa a CHEGAR de um jeito ou do outro, nunca de nenhum (mesmo mecanismo
 * de dedup client×server já documentado em `meta-capi.ts` pro
 * `CompleteRegistration`, #8572).
 *
 * Miolo PURO (parse + validação + resolução do nome do evento) — vive aqui,
 * não em `workers/site/src/index.ts`, pra ser testável sem `Request`/`Env`
 * reais, mesmo padrão de `parseSubscribeBody` (`workers/poll/src/subscribe.ts`).
 */

/** Só "a"/"A" ou "b"/"B" — mesma variante que `script.js` já deriva de
 * `document.body.dataset.variante`. */
const VARIANT_RE = /^[abcd]$/i; // #9335: versão C recebe 100% do tráfego desde 01/10/2026; D (conteúdo com identidade) desde 04/10/2026

/** Mesmo teto de defesa em profundidade que `SUBSCRIBE_CLIENT_ORIGIN_MAX`
 * aplica a outros campos crus do cliente (workers/poll/src/subscribe.ts). */
export const CLICK_BEACON_FIELD_MAX = 300;

export interface ParsedClickBeacon {
  /** "" quando ausente/formato inválido — validação real em `validateClickBeacon`. */
  variant: string;
  posicao: string;
  eventId: string;
  externalId: string;
  fbc: string;
  fbp: string;
}

function asStr(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/**
 * Pure — parse do corpo do beacon (sempre JSON: `navigator.sendBeacon` com
 * um `Blob({type: "application/json"})`, ver `checkoutLinkClickHandlerJs`).
 * Nunca lança — corpo malformado vira input vazio, que `validateClickBeacon`
 * rejeita depois.
 */
export function parseClickBeaconBody(raw: string): ParsedClickBeacon {
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    return {
      variant: asStr(o.variant).trim().slice(0, 4),
      posicao: asStr(o.posicao).trim().slice(0, CLICK_BEACON_FIELD_MAX),
      eventId: asStr(o.event_id).trim().slice(0, CLICK_BEACON_FIELD_MAX),
      externalId: asStr(o.external_id).trim().slice(0, CLICK_BEACON_FIELD_MAX),
      fbc: asStr(o.fbc).trim().slice(0, CLICK_BEACON_FIELD_MAX),
      fbp: asStr(o.fbp).trim().slice(0, CLICK_BEACON_FIELD_MAX),
    };
  } catch {
    return { variant: "", posicao: "", eventId: "", externalId: "", fbc: "", fbp: "" };
  }
}

export type ClickBeaconValidation =
  | { ok: true; eventName: string; eventId: string; posicao: string }
  | { ok: false; error: "invalid_variant" | "missing_event_id" };

/**
 * Valida o corpo do beacon e resolve o NOME do evento — precisa casar
 * BYTE A BYTE com o `fbq('trackCustom', `${event}_${variant}`, ...)` que o
 * script.js já disparou client-side (mesmo prefixo `CliqueIngresso_`, mesma
 * variante em MAIÚSCULA), senão a dedup por (`event_name`, `event_id`) da
 * Meta não casa os dois lados e o clique volta a contar 2x. Pure.
 */
export function validateClickBeacon(p: ParsedClickBeacon): ClickBeaconValidation {
  if (!VARIANT_RE.test(p.variant)) return { ok: false, error: "invalid_variant" };
  if (!p.eventId) return { ok: false, error: "missing_event_id" };
  return {
    ok: true,
    eventName: `CliqueIngresso_${p.variant.toUpperCase()}`,
    eventId: p.eventId,
    posicao: p.posicao || "sem-posicao",
  };
}

/**
 * Comportamento do listener novo de `.checkout-link` em
 * `workers/site/public/evento/agente-ia/script.js` (JS estático, sem passo
 * de build — não gerado por um helper daqui, mas segue o MESMO contrato
 * destas 2 constantes, verificado por teste de drift). Decisão de robustez
 * (#8982, correção sugerida na issue):
 *
 * 1. Clique com modificador (botão do meio, Ctrl/Cmd/Shift/Alt) NUNCA sofre
 *    `preventDefault` — abrir em nova aba continua funcionando exatamente
 *    como um link normal. O pixel ainda dispara (sem `eventID`
 *    determinístico: não há navegação pra sobreviver, o beacon não é
 *    necessário nesse caminho).
 * 2. Clique normal: `preventDefault`, dispara `fbq('trackCustom', ...,
 *    {eventID})` E o beacon (mesmo `eventID`) EM PARALELO, navega depois de
 *    `CLICK_BEACON_NAV_DELAY_MS` (≤300ms) OU assim que `sendBeacon`
 *    retornar (fire-and-forget — "retornar" aqui é só o enqueue síncrono,
 *    nunca uma resposta HTTP) — o que vier primeiro. Nunca bloqueia a
 *    navegação indefinidamente: `sendBeacon` ausente (browser antigo) ou
 *    lançando cai direto pro `go()` sem esperar.
 * 3. `external_id`/`_fbc`/`_fbp` vão no corpo do beacon lidos do
 *    `document.cookie` da PRÓPRIA página — o beacon é same-origin
 *    (`diar.ia.br` → `diar.ia.br`, Worker `site`), então o cookie TAMBÉM
 *    chega no header `Cookie` do request; mandar os dois é defesa em
 *    profundidade (mesmo padrão do #8978), nunca a única fonte.
 */
export const CLICK_BEACON_NAV_DELAY_MS = 300;
export const CLICK_BEACON_ENDPOINT = "/evento/agente-ia/clique";
