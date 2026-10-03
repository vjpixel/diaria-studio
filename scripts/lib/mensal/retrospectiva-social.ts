/**
 * scripts/lib/mensal/retrospectiva-social.ts (#9500, #9508)
 *
 * Regras puras dos posts PÚBLICOS de chamada da Retrospectiva do Mês
 * (`/diaria-mensal-apoiadores`) — LinkedIn página, Facebook, Instagram,
 * Threads e X. Mesma regra de CTA dos posts de LinkedIn (#9474): apontam pro
 * `apoia.se/diaria`, NUNCA pra URL direta da retrospectiva paywalled; texto
 * de chamada, não recorte.
 *
 * ## #9508: um post por história, no formato dos destaques diários
 *
 * Desde o #9508 cada rede leva 3 posts, um por história (DESTAQUE 1/2/3 do
 * `draft.md`), no formato da diária: carrossel de 5 slides no Instagram e no
 * Threads, até 4 imagens no X (capa + 3 parágrafos), imagem + texto no
 * Facebook e na página LinkedIn.
 *
 * ## Dois arquivos por história (espelho da diária)
 *
 * A diária usa UM texto pra LinkedIn/Facebook/Instagram (`# Social`, decisão
 * do editor 260724) e outro pra X/Threads (`# Curto`); os 3 parágrafos dos
 * slides são o MESMO texto do `# Social`. Aqui é igual, por história:
 *
 *   - `divulgacao/d{N}.md` — exatamente 3 parágrafos (+ até 5 hashtags numa
 *     linha final, opcional), SEM CTA. É o texto dos 3 slides de parágrafo e o
 *     corpo da legenda de LinkedIn/Facebook/Instagram, à qual o script soma a
 *     linha longa de CTA (`composeRetrospectivaLongCaption`).
 *   - `divulgacao/d{N}-curto.md` — ≤280 caracteres COM a linha curta de CTA,
 *     pra Threads e X.
 *
 * State, `--skip`, `--force` e checagem continuam por (rede × história) — o
 * arquivo compartilhado não acopla nada disso.
 *
 * ## Duas linhas de CTA
 *
 * LinkedIn, Facebook e Instagram levam a linha longa
 * (`RETROSPECTIVA_PUBLIC_CTA`). X e Threads têm 280 caracteres: aceitam a
 * longa ou a curta `RETROSPECTIVA_PUBLIC_CTA_CURTO` — adaptação da frase do
 * editor que mantém o "Apoie" (o pedido de conversão) e corta o resto
 * (premissa do #9500; não reescrever, não passar por Clarice/humanizador). O
 * slide de CTA do carrossel diz a linha longa (`RETROSPECTIVA_CAROUSEL_CTA`).
 */

import {
  RETROSPECTIVA_PUBLIC_CTA,
  citesPaywalledRetrospectiva,
  publicPostCtaProblems,
  RETROSPECTIVA_POST_CHANNELS,
  type RetrospectivaHistoria,
  type RetrospectivaPostChannel,
} from "./retrospectiva-divulgacao.ts";
import { splitBodyAndTags } from "../social-cta-lines.ts";
import { DAILY_CAROUSEL_PARAGRAPH_CHAR_TARGET, findOverflowingCarouselSlides } from "../daily-carousel-card.ts";
import type { CarouselCtaOverride } from "../instagram-test-override.ts";

export { RETROSPECTIVA_POST_CHANNELS as RETROSPECTIVA_SOCIAL_CHANNELS };
export type RetrospectivaSocialChannel = RetrospectivaPostChannel;

/** Linha curta de CTA pra X/Threads (54 caracteres) — ver docstring do módulo. */
export const RETROSPECTIVA_PUBLIC_CTA_CURTO = "Apoie e leia a retrospectiva completa: apoia.se/diaria";

/** Arquivos de texto de uma história em `data/monthly/{ciclo}/divulgacao/`. */
export function retrospectivaHistoriaFiles(h: RetrospectivaHistoria): { corpo: string; curto: string } {
  return { corpo: `${h}.md`, curto: `${h}-curto.md` };
}

/** Rede curta (≤280, linha curta de CTA, arquivo `d{N}-curto.md`). */
export function isShortChannel(ch: RetrospectivaSocialChannel): boolean {
  return ch === "x" || ch === "threads";
}

/** Arquivo de onde sai o texto de uma rede numa história. */
export function retrospectivaPostTextFile(ch: RetrospectivaSocialChannel, h: RetrospectivaHistoria): string {
  const f = retrospectivaHistoriaFiles(h);
  return isShortChannel(ch) ? f.curto : f.corpo;
}

/**
 * Teto de caracteres por canal. Instagram: 2200 da Graph API (o publicador
 * diário trunca; aqui o texto é RECUSADO, porque truncar comeria o CTA).
 * Facebook: o mesmo 2200, por paridade com o Instagram (a diária usa um texto
 * só pros dois). LinkedIn: 3000 (limite do post). X e Threads: 280 — o X
 * conta URL como 23 (`xWeightedLength`); o Threads aceitaria 500,
 * mas o texto curto é o mesmo formato do X (`social-curto` da diária).
 */
export const RETROSPECTIVA_SOCIAL_MAX_CHARS: Record<RetrospectivaSocialChannel, number> = {
  linkedin_pagina: 3000,
  facebook: 2200,
  instagram: 2200,
  threads: 280,
  x: 280,
};

/** `platform` gravado no store de dispatch — o mesmo vocabulário da diária (`twitter`, não `x`). */
export const RETROSPECTIVA_SOCIAL_PLATFORM: Record<RetrospectivaSocialChannel, string> = {
  linkedin_pagina: "linkedin",
  facebook: "facebook",
  instagram: "instagram",
  threads: "threads",
  x: "twitter",
};

/** Máximo de hashtags na linha final do `d{N}.md` (o Instagram pede poucas; a diária usa até 5). */
export const RETROSPECTIVA_MAX_HASHTAGS = 5;

/**
 * Teto de caracteres por parágrafo do `d{N}.md` — o mesmo do `social-writer`
 * da diária (`DAILY_CAROUSEL_PARAGRAPH_CHAR_TARGET`). Lá ele é orientação e
 * só o overflow barra; aqui o editor fixou ≤260 como regra no #9508, então é
 * barreira dura também — junto do overflow, que continua sendo checado.
 */
export const RETROSPECTIVA_PARAGRAPH_MAX_CHARS = DAILY_CAROUSEL_PARAGRAPH_CHAR_TARGET;

/**
 * Slide final (CTA) do carrossel: a linha longa de CTA, com uma faixa que
 * substitui o "Assine grátis" da diária (aqui o pedido é apoio, não
 * assinatura). Reusa o override de slide CTA do #8681 — nenhum render novo.
 */
export const RETROSPECTIVA_CAROUSEL_CTA: CarouselCtaOverride = {
  kicker: "Exclusivo para apoiadores",
  title: RETROSPECTIVA_PUBLIC_CTA,
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
 * Pura: problemas do texto FINAL de um canal (lista vazia = ok): CTA
 * (`publicPostCtaProblems`, com a linha curta aceita em X/Threads), URL
 * paywalled, texto vazio, teto de caracteres e markdown de ênfase (nenhuma
 * dessas redes renderiza `**`, #6862 — o editor aprova no gate o que vai ao
 * ar). Medido sobre o texto como vai ao ar.
 */
export function retrospectivaSocialPostProblems(channel: RetrospectivaSocialChannel, text: string): string[] {
  const body = text.replace(/\r\n/g, "\n").trim();
  if (!body) return ["texto vazio"];
  const short = isShortChannel(channel);
  const problems = publicPostCtaProblems(body, short ? [RETROSPECTIVA_PUBLIC_CTA_CURTO, RETROSPECTIVA_PUBLIC_CTA] : [RETROSPECTIVA_PUBLIC_CTA]);
  const max = RETROSPECTIVA_SOCIAL_MAX_CHARS[channel];
  const len = channel === "x" ? xWeightedLength(body) : body.length;
  if (len > max) {
    problems.push(`${len} caracteres${channel === "x" ? " (ponderado: link = 23)" : ""} — teto do ${channel} é ${max}; encurte o corpo, nunca o CTA`);
  }
  if (/\*\*|__/.test(body)) problems.push("markdown de ênfase (** ou __) — a rede não renderiza; escreva texto puro");
  return problems;
}

/** Pura: legenda de LinkedIn/Facebook/Instagram = `d{N}.md` + linha longa de CTA. */
export function composeRetrospectivaLongCaption(corpo: string): string {
  return `${corpo.replace(/\r\n/g, "\n").trim()}\n\n${RETROSPECTIVA_PUBLIC_CTA}`;
}

/** Pura: texto que vai ao ar numa rede, a partir dos dois arquivos da história. */
export function retrospectivaPostText(ch: RetrospectivaSocialChannel, texts: { corpo?: string; curto?: string }): string | undefined {
  if (isShortChannel(ch)) return texts.curto?.replace(/\r\n/g, "\n").trim();
  return texts.corpo === undefined ? undefined : composeRetrospectivaLongCaption(texts.corpo);
}

/** Pura: parágrafos do corpo (sem a linha final de hashtags), como os slides os veem. */
export function retrospectivaParagraphs(corpo: string): { paragraphs: string[]; tags: string } {
  const { body, tags } = splitBodyAndTags(corpo.replace(/\r\n/g, "\n").trim());
  const paragraphs = body
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  return { paragraphs, tags };
}

/**
 * Pura: problemas do `d{N}.md` de uma história (lista vazia = ok). É o texto
 * dos 3 slides de parágrafo E o corpo da legenda longa, então:
 *
 *   - exatamente 3 parágrafos (1 por slide; a diária redistribui quando o
 *     número diverge, aqui o texto é escrito pra isso e a divergência é erro);
 *   - cada parágrafo ≤ `RETROSPECTIVA_PARAGRAPH_MAX_CHARS`;
 *   - nenhum slide transborda o card em 62px (`findOverflowingCarouselSlides`,
 *     o mesmo guard do invariante `carousel-text-overflow` da diária) — quem
 *     não cabe é REESCRITO, nunca encolhido nem truncado (#6078);
 *   - sem CTA (o script acrescenta), sem URL paywalled, sem markdown, até 5
 *     hashtags.
 */
export function retrospectivaHistoriaBodyProblems(corpo: string): string[] {
  const text = corpo.replace(/\r\n/g, "\n").trim();
  if (!text) return ["texto vazio"];
  const problems: string[] = [];
  if (citesPaywalledRetrospectiva(text)) {
    problems.push("o texto cita a URL da retrospectiva paywalled (retrospectiva./artigo.diar.ia.br) — post público aponta só pro apoia.se");
  }
  if (/apoia\.se\/diaria/i.test(text)) {
    problems.push("não inclua o CTA nem apoia.se/diaria no corpo — o script soma a linha de CTA à legenda e o slide final já é o CTA");
  }
  if (/\*\*|__/.test(text)) problems.push("markdown de ênfase (** ou __) — a legenda não renderiza; escreva texto puro");
  const { paragraphs, tags } = retrospectivaParagraphs(text);
  if (paragraphs.length !== 3) {
    problems.push(`${paragraphs.length} parágrafo(s) — são exatamente 3 (1 por slide), separados por linha em branco`);
  }
  paragraphs.forEach((p, i) => {
    if (p.length > RETROSPECTIVA_PARAGRAPH_MAX_CHARS) {
      problems.push(`parágrafo ${i + 1}: ${p.length} caracteres — teto ${RETROSPECTIVA_PARAGRAPH_MAX_CHARS}; REESCREVA (nunca encolher nem truncar)`);
    }
  });
  const nTags = tags ? tags.split(/\s+/).filter(Boolean).length : 0;
  if (nTags > RETROSPECTIVA_MAX_HASHTAGS) problems.push(`${nTags} hashtags — no máximo ${RETROSPECTIVA_MAX_HASHTAGS}`);
  if (paragraphs.length === 3) {
    for (const o of findOverflowingCarouselSlides(text, RETROSPECTIVA_CAROUSEL_CTA)) {
      problems.push(`slide ${o.slot} não cabe no card (${o.chars} caracteres → ${o.lines} linhas, ${o.excessPx}px além) — REESCREVA o parágrafo`);
    }
  }
  return problems;
}
