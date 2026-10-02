/**
 * scripts/lib/mensal/retrospectiva-social.ts (#9500)
 *
 * Regras puras dos posts PÚBLICOS de chamada da Retrospectiva do Mês fora do
 * LinkedIn — Facebook, Instagram, Threads e X (`/diaria-mensal-apoiadores`).
 * Mesma regra de CTA dos posts de LinkedIn (#9474): apontam pro
 * `apoia.se/diaria`, NUNCA pra URL direta da retrospectiva paywalled; texto
 * de chamada, não recorte.
 *
 * ## Um arquivo por canal
 *
 * `divulgacao/{facebook,instagram,threads,x}.md`, gerados no MESMO dispatch
 * do Passo 1 da skill. Um arquivo por canal (e não o par compartilhado da
 * diária, `# Social` pra LinkedIn/Facebook/Instagram e `# Curto` pra
 * X/Threads) mantém state, `--skip`, `--force` e checagem ortogonais por
 * canal; o subagente pode escrever o mesmo corpo em dois deles (Facebook ≈
 * Instagram, Threads ≈ X), adaptando o que a rede pede.
 *
 * ## Duas linhas de CTA
 *
 * Facebook e Instagram levam a linha longa do LinkedIn
 * (`RETROSPECTIVA_PUBLIC_CTA`). X e Threads têm 280 caracteres: aceitam a
 * longa ou a curta `RETROSPECTIVA_PUBLIC_CTA_CURTO` — adaptação da frase do
 * editor que mantém o "Apoie" (o pedido de conversão) e corta o resto
 * (premissa do #9500, registrada na PR; não reescrever, não passar por
 * Clarice/humanizador).
 */

import { RETROSPECTIVA_PUBLIC_CTA, publicPostCtaProblems } from "./retrospectiva-divulgacao.ts";
import type { RetrospectivaSocialChannel } from "./retrospectiva-schedule.ts";

export { RETROSPECTIVA_SOCIAL_CHANNELS, type RetrospectivaSocialChannel } from "./retrospectiva-schedule.ts";

/** Linha curta de CTA pra X/Threads (54 caracteres) — ver docstring do módulo. */
export const RETROSPECTIVA_PUBLIC_CTA_CURTO = "Apoie e leia a retrospectiva completa: apoia.se/diaria";

/** Arquivo do texto de cada canal em `data/monthly/{ciclo}/divulgacao/`. */
export const RETROSPECTIVA_SOCIAL_TEXT_FILES: Record<RetrospectivaSocialChannel, string> = {
  facebook: "facebook.md",
  instagram: "instagram.md",
  threads: "threads.md",
  x: "x.md",
};

/**
 * Teto de caracteres por canal. Instagram: 2200 da Graph API (o publicador
 * diário trunca; aqui o texto é RECUSADO, porque truncar comeria o CTA).
 * Facebook: o mesmo 2200, por paridade com o Instagram (a diária usa um texto
 * só pros dois; a Graph API do Facebook aceitaria muito mais). X e Threads:
 * 280 — o X conta URL como 23 (`xWeightedLength`); o Threads aceitaria 500
 * no Worker, mas o texto curto é o mesmo formato do X (`social-curto` da
 * diária, ≤280 compartilhado).
 */
export const RETROSPECTIVA_SOCIAL_MAX_CHARS: Record<RetrospectivaSocialChannel, number> = {
  facebook: 2200,
  instagram: 2200,
  threads: 280,
  x: 280,
};

/** `platform` gravado no store de dispatch — o mesmo vocabulário da diária (`twitter`, não `x`). */
export const RETROSPECTIVA_SOCIAL_PLATFORM: Record<RetrospectivaSocialChannel, string> = {
  facebook: "facebook",
  instagram: "instagram",
  threads: "threads",
  x: "twitter",
};

const URL_WEIGHT = 23;
/** `http(s)://…` e domínio nu (`apoia.se/diaria`, que o X também linka e conta como 23). */
const X_LINK_RE = /https?:\/\/\S+|\b(?:[a-z0-9-]+\.)+(?:se|br|com|ai|io|net|org)(?:\/\S*)?/gi;

/**
 * Pura: comprimento ponderado do X, conservador — conta toda URL e todo
 * domínio nu com TLD comum como 23 (t.co), e nunca menos que o comprimento
 * literal. `computeTwitterWeightedLength` (`prep-twitter-posts.ts`) só pesa
 * `http(s)://`; aqui o CTA é `apoia.se/diaria`, que o X linka mesmo sem
 * esquema — contar 15 deixaria passar um texto que a rede recusa.
 */
export function xWeightedLength(text: string): number {
  let delta = 0;
  for (const m of text.matchAll(X_LINK_RE)) delta += URL_WEIGHT - m[0].length;
  return Math.max(text.length, text.length + delta);
}

/**
 * Pura: problemas do texto de um canal social (lista vazia = ok): CTA
 * (`publicPostCtaProblems`, com a linha curta aceita em X/Threads), URL
 * paywalled, texto vazio, teto de caracteres e markdown de ênfase (nenhuma
 * dessas redes renderiza `**`, #6862 — o publicador remove, mas o editor
 * aprova no gate o que vai ao ar). Medido sobre o texto como vai ao ar.
 */
export function retrospectivaSocialPostProblems(channel: RetrospectivaSocialChannel, text: string): string[] {
  const body = text.replace(/\r\n/g, "\n").trim();
  if (!body) return ["texto vazio"];
  const short = channel === "x" || channel === "threads";
  const problems = publicPostCtaProblems(body, short ? [RETROSPECTIVA_PUBLIC_CTA_CURTO, RETROSPECTIVA_PUBLIC_CTA] : [RETROSPECTIVA_PUBLIC_CTA]);
  const max = RETROSPECTIVA_SOCIAL_MAX_CHARS[channel];
  const len = channel === "x" ? xWeightedLength(body) : body.length;
  if (len > max) {
    problems.push(`${len} caracteres${channel === "x" ? " (ponderado: link = 23)" : ""} — teto do ${channel} é ${max}; encurte o corpo, nunca o CTA`);
  }
  if (/\*\*|__/.test(body)) problems.push("markdown de ênfase (** ou __) — a rede não renderiza; escreva texto puro");
  return problems;
}
