/**
 * scripts/lib/viral-signals.ts — sinais crus de "potencial de viralização"
 * usados SÓ pela calibração (`scripts/calibrate-viral-score.ts`, #8672).
 *
 * O bônus de viralização foi DESCARTADO em 07/10/2026 por decisão do editor,
 * com base na calibração registrada em `docs/viral-score-calibration.md`
 * (nenhum sinal prevê clique; o bônus do POC tinha efeito negativo). Este
 * módulo não pontua nada e não roda no pipeline — existe para que um sinal
 * novo possa passar pela mesma calibração antes de qualquer proposta de bônus.
 *
 * Puro e determinístico. Inclui as guardas que uma eventual produção teria
 * (rede social, paywall/anti_bot, tutorial/vídeo, piso de score) para a
 * calibração medir a mesma população que a produção mediria.
 */

import { registrableDomain } from "./registrable-domain.ts";

/** Piso de score herdado do POC: abaixo disso nenhum bônus seria aplicado. */
export const VIRAL_MIN_BASE_SCORE = 40;

export interface ViralSignalInput {
  url: string;
  title?: string;
  summary?: string;
  published_at?: string;
  /** O artigo veio de uma newsletter do inbox (`flag: newsletter_extracted`): a newsletter de origem não conta como menção. */
  from_newsletter?: boolean;
}

export interface ViralGuardInput {
  url: string;
  score_base: number;
  category?: string;
  verify_verdict?: string;
}

export interface ViralContext {
  /** Corpos (texto/HTML) das newsletters do inbox capturadas para a edição. */
  newsletterBodies: string[];
  /** "Agora" de referência (ISO), para recência. */
  now: string;
}

/** Sinais crus, sem peso. */
export interface ViralSignals {
  people_gov: boolean;
  big_company: boolean;
  conflict_harm: boolean;
  money_scale: boolean;
  policy_geo: boolean;
  /** Newsletters do inbox que citam a URL (já descontada a newsletter de origem). */
  newsletter_mentions: number;
  recent_36h: boolean;
}

export type ViralSignalName = keyof ViralSignals;

export const VIRAL_SIGNAL_NAMES: readonly ViralSignalName[] = [
  "people_gov",
  "big_company",
  "conflict_harm",
  "money_scale",
  "policy_geo",
  "newsletter_mentions",
  "recent_36h",
];

/** Domínios registráveis de rede social (falso positivo do POC: um tweet ganhou +8 em 260922). */
export const SOCIAL_DOMAINS: ReadonlySet<string> = new Set([
  "x.com",
  "twitter.com",
  "threads.net",
  "threads.com",
  "linkedin.com",
  "facebook.com",
  "instagram.com",
  "reddit.com",
  "bsky.app",
  "tiktok.com",
  "mastodon.social",
]);

/** Vereditos do link-verifier que bloqueariam um bônus. */
export const VIRAL_BLOCKED_VERDICTS: ReadonlySet<string> = new Set(["paywall", "anti_bot"]);

const PEOPLE_AND_GOV =
  /\b(trump|musk|altman|amodei|huang|zuckerberg|nadella|pichai|putin|xi jinping|lula|casa branca|white house|pent[áa]gono|pentagon|congress|senate|senado|governo|government)\b/i;
const BIG_COMPANIES = /\b(openai|anthropic|nvidia|google|apple|microsoft|tesla|xai|spacex|amazon|deepseek)\b/i;
/** "meta" é palavra comum em PT ("bater a meta") — a empresa só casa com M maiúsculo. */
const META_COMPANY = /\bMeta\b/;
/** "processo" sozinho é falso positivo em PT ("processo seletivo") — só as formas de processar na Justiça casam. */
const CONFLICT_OR_HARM =
  /\b(hack\w*|invad\w*|invas\w*|breach\w*|leak\w*|vazament\w*|lawsuit|sued|processa(da|do|m|r)?|processo judicial|ban(ned|s)?|block(ed|s)?|bloque\w*|demiss\w*|layoff\w*|kill switch|loss of control|perda de controle|jailbreak\w*|deepfake\w*)\b/i;
const MONEY_OR_SCALE = /\b(ipo|trilh\w+|trillion|bilh\w+|billion)\b|\$\s?\d+(\.\d+)?\s?(b|bn|billion|bilh)/i;
/** "lei" solto casa em qualquer menção genérica; exige a forma de lei específica. */
const POLICY_OR_GEOPOLITICS =
  /\b(regula\w*|regulation|law|projeto de lei|nova lei|lei (de|da|do) (ia|intelig[êe]ncia artificial)|marco legal|guerra|war|military|militar\w*|china|onu|united nations|safeguards?|slowdown|freio)\b/i;
/** Sigla "UN" só casa em maiúsculas (senão pega "un" de outras línguas). */
const UN_ACRONYM = /\bUN\b/;

/** URL sem esquema/query/fragmento, para casar contra corpos de newsletter. */
export function urlKey(url: string): string {
  return url.replace(/^https?:\/\//, "").split(/[?#]/)[0].replace(/\/+$/, "");
}

/** Caractere que continua um path de URL — se vier logo depois da chave, a menção é de OUTRA URL (prefixo). */
const URL_PATH_CONTINUATION = /[A-Za-z0-9\-._~%/]/;

/** `body` cita `key` como URL inteira — não como prefixo de outra (`site.com/p/x` não casa em `site.com/p/xyz`). */
export function mentionsUrl(body: string, key: string): boolean {
  if (!key) return false;
  let from = 0;
  for (;;) {
    const i = body.indexOf(key, from);
    if (i < 0) return false;
    let j = i + key.length;
    // `/` final sozinho (`.../x/`) ainda é a mesma URL.
    if (body.charAt(j) === "/") j++;
    const c = body.charAt(j);
    // Ponto final de frase (`.../x.`) não continua a URL; `.../x.html` continua.
    const continues = c === "." ? /[A-Za-z0-9]/.test(body.charAt(j + 1)) : URL_PATH_CONTINUATION.test(c);
    if (!c || !continues) return true;
    from = i + 1;
  }
}

export function extractViralSignals(a: ViralSignalInput, ctx: ViralContext): ViralSignals {
  const text = `${a.title ?? ""} ${a.summary ?? ""}`;
  const key = urlKey(a.url);
  const rawMentions = ctx.newsletterBodies.filter((b) => mentionsUrl(b, key)).length;
  let recent = false;
  if (a.published_at) {
    const ageH = (Date.parse(ctx.now) - Date.parse(a.published_at)) / 3_600_000;
    recent = Number.isFinite(ageH) && ageH >= 0 && ageH <= 36;
  }
  return {
    people_gov: PEOPLE_AND_GOV.test(text),
    big_company: BIG_COMPANIES.test(text) || META_COMPANY.test(text),
    conflict_harm: CONFLICT_OR_HARM.test(text),
    money_scale: MONEY_OR_SCALE.test(text),
    policy_geo: POLICY_OR_GEOPOLITICS.test(text) || UN_ACRONYM.test(text),
    newsletter_mentions: Math.max(0, rawMentions - (a.from_newsletter ? 1 : 0)),
    recent_36h: recent,
  };
}

/** Guarda que impediria um bônus, ou `null`. Ordem fixa — a 1ª que casa é a registrada. */
export function viralGuard(a: ViralGuardInput): string | null {
  if (a.category === "tutorial" || a.category === "video") return `category:${a.category}`;
  if (a.score_base < VIRAL_MIN_BASE_SCORE) return "below_min_base";
  if (a.verify_verdict && VIRAL_BLOCKED_VERDICTS.has(a.verify_verdict)) return `verdict:${a.verify_verdict}`;
  const domain = registrableDomain(a.url);
  if (domain && SOCIAL_DOMAINS.has(domain)) return "social_post";
  return null;
}
