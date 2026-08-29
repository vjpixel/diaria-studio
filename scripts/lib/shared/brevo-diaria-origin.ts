/**
 * brevo-diaria-origin.ts — parser/construtor canônico de origem do campo
 * `beehiiv_subscription_id` (#6678).
 *
 * O campo `BrevoDiariaContact.beehiiv_subscription_id: string` carrega HOJE
 * quatro origens distintas, separadas só por prefixo de string — nunca por
 * tipo. Cada produtor monta seu prefixo com template literal inline, sem
 * verificação centralizada. Consequências:
 *
 * 1. Nada travava os produtores — typo ou mudança de constante num lado só
 *    faz o consumidor tratar silenciosamente aquela origem como Beehiiv.
 * 2. `evaluate-brevo-diaria.ts` trata "não é kit" como sinônimo de "é Beehiiv"
 *    no roteamento do #6340 item 4 — falso para `curated:`/`sunset:`.
 * 3. Adicionar uma 5ª origem não força revisão de nenhum `switch`.
 * 4. O campo mente no nome — qualquer código que leia `contact.beehiiv_subscription_id`
 *    e o passe para uma chamada da API da Beehiiv sem checar prefixo antes
 *    se comporta mal em três das quatro origens.
 *
 * Este módulo centraliza a convenção: um parser/construtor único que
 * devolve uma união discriminada sobre as quatro origens, com os produtores
 * construindo o prefixo por ele em vez de template literal inline.
 *
 * #6678: não muda o tipo do campo armazenado (continua `string`) — centraliza
 * a convenção para que uma 5ª origem forçasse revisão de todos os consumidores.
 *
 * Fronteira: `scripts/lib/shared/` é genérico (não importa de `scripts/lib/diaria/`
 * nem `scripts/lib/mensal/` — ver `test/lib-boundary.test.ts`). Este módulo
 * não importa de domínio nenhum, é puro e dependência zero.
 */

/** Prefixos reconhecidos, em ordem de preferência de parse (mais específico primeiro). */
export const ORIGIN_PREFIX = {
  BEEHIIV: "" as const,         // id real da Beehiiv — sem prefixo, não pode ter `:`
  KIT: "kit:" as const,
  CURATED: "curated:" as const,
  SUNSET: "sunset:" as const,
} as const;

export type OriginKind = "beehiiv" | "kit" | "curated" | "sunset";

/** Valor bruto do campo, parseado em sua origem e payload. */
export interface ParsedOrigin {
  kind: OriginKind;
  /** O que vem depois do prefixo. Para beehiiv: o id real. Para kit: o kit_subscriber_id. curated/sunset: o email normalizado. */
  payload: string;
  /** O valor completo, para round-trip idêntico. */
  raw: string;
}

/** Parseia um valor de `beehiiv_subscription_id` na origem correspondente.
 *  Lança se o valor for vazio ou não reconhecido. */
export function parseOrigin(raw: string): ParsedOrigin {
  if (!raw || typeof raw !== "string") {
    throw new Error(`[brevo-diaria-origin] beehiiv_subscription_id inválido (vazio/não-string): ${JSON.stringify(raw)}`);
  }
  if (raw.startsWith(ORIGIN_PREFIX.KIT)) {
    const payload = raw.slice(ORIGIN_PREFIX.KIT.length);
    if (!payload) throw new Error(`[brevo-diaria-origin] valor kit: sem payload: ${JSON.stringify(raw)}`);
    return { kind: "kit", payload, raw };
  }
  if (raw.startsWith(ORIGIN_PREFIX.CURATED)) {
    const payload = raw.slice(ORIGIN_PREFIX.CURATED.length);
    if (!payload) throw new Error(`[brevo-diaria-origin] valor curated: sem payload: ${JSON.stringify(raw)}`);
    return { kind: "curated", payload, raw };
  }
  if (raw.startsWith(ORIGIN_PREFIX.SUNSET)) {
    const payload = raw.slice(ORIGIN_PREFIX.SUNSET.length);
    if (!payload) throw new Error(`[brevo-diaria-origin] valor sunset: sem payload: ${JSON.stringify(raw)}`);
    return { kind: "sunset", payload, raw };
  }
  // Sem prefixo reconhecido — Beehiiv real (id numérico ou alfanumétrico da API v2).
  // Rejeita valores que contêm `:` em posição estranha (não é prefixo conhecido).
  if (raw.includes(":")) {
    throw new Error(`[brevo-diaria-origin] valor não reconhecido (possui ':' sem prefixo conhecido): ${JSON.stringify(raw)}`);
  }
  return { kind: "beehiiv", payload: raw, raw };
}

/** Constroi o valor de `beehiiv_subscription_id` a partir da origem + payload. */
export function buildOrigin(kind: OriginKind, payload: string): string {
  if (!payload) throw new Error(`[brevo-diaria-origin] payload vazio para origem ${kind}`);
  switch (kind) {
    case "beehiiv":
      // Beehiiv real: payload é o id, sem prefixo. Rejeita se contém `:`.
      if (payload.includes(":")) throw new Error(`[brevo-diaria-origin] payload beehiiv não pode conter ':': ${JSON.stringify(payload)}`);
      return payload;
    case "kit":
      return `${ORIGIN_PREFIX.KIT}${payload}`;
    case "curated":
      return `${ORIGIN_PREFIX.CURATED}${payload}`;
    case "sunset":
      return `${ORIGIN_PREFIX.SUNSET}${payload}`;
  }
}

