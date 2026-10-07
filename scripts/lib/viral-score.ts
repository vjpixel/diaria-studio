/**
 * scripts/lib/viral-score.ts — bônus de potencial de viralização (#8672).
 *
 * Puro e determinístico: recebe um artigo já pontuado (`score_base`) + contexto
 * da edição e devolve um bônus aditivo (slug `viral`, teto `VIRAL_BONUS_CAP`)
 * com os sinais que o justificaram. Mantém o invariante do scorer
 * (`score == score_base + soma(bonuses_applied)`) — quem aplica grava
 * `viral:+N` em `bonuses_applied`.
 *
 * Duas camadas, separadas de propósito:
 *
 * 1. `extractViralSignals` — os SINAIS crus (booleanos/contagem), sem peso.
 *    É o que `scripts/calibrate-viral-score.ts` regride contra clique real.
 * 2. `computeViralBonus` — sinais × `VIRAL_WEIGHTS`, com as guardas do item 3
 *    da #8672 (rede social, paywall/anti_bot, impacto negativo, teto).
 *
 * **Estado:** ver `docs/viral-score-calibration.md` (calibração da #8672).
 * NÃO ligar em produção.
 */

import { registrableDomain } from "./registrable-domain.ts";

export const VIRAL_BONUS_CAP = 15;
/** Só quem já passou de um piso de qualidade ganha bônus — viral não resgata lixo. */
export const VIRAL_MIN_BASE_SCORE = 40;
/** O score final nunca passa de 100 (o rubrico é 0-100). */
export const SCORE_MAX = 100;

export interface ViralInput {
  url: string;
  title?: string;
  summary?: string;
  published_at?: string;
  score_base: number;
  /** Score já com os outros bônus (o teto de 100 é sobre ele). Padrão: `score_base`. */
  score_current?: number;
  category?: string;
  /** `verify_verdict` do link-verifier — `paywall`/`anti_bot` não ganham bônus (#8672 item 3). */
  verify_verdict?: string;
  /** Flag de impacto negativo (#3916). Garantido por backstop, NUNCA por score — ver `computeViralBonus`. */
  negative_impact?: boolean;
  /** O artigo veio de uma newsletter do inbox (`flag: newsletter_extracted`): a newsletter de origem não conta como menção. */
  from_newsletter?: boolean;
}

export interface ViralContext {
  /** Corpos (texto/HTML) das newsletters do inbox capturadas para a edição. */
  newsletterBodies: string[];
  /** "Agora" de referência (ISO), para recência. */
  now: string;
}

export interface ViralResult {
  bonus: number;
  signals: string[];
  /** Motivo de o artigo não ter recebido bônus algum por guarda (`null` quando passou pelas guardas). */
  skipped: string | null;
}

/** Sinais crus, sem peso — insumo da calibração. */
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

/**
 * Pesos em pontos do rubrico. Chute do POC (#8673) — a calibração da #8672
 * não encontrou sinal que justificasse substituí-los (ver docstring do
 * módulo). `newsletter_mentions` é por menção.
 */
export const VIRAL_WEIGHTS: Readonly<Record<ViralSignalName, number>> = {
  people_gov: 3,
  big_company: 1,
  conflict_harm: 4,
  money_scale: 3,
  policy_geo: 3,
  newsletter_mentions: 3,
  recent_36h: 2,
};

/** Tetos parciais herdados do POC. */
export const VIRAL_HOOKS_CAP = 8;
export const VIRAL_CROSS_CAP = 6;

/**
 * Domínios registráveis de rede social: post em rede social não ganha bônus
 * (falso positivo do POC: um tweet ganhou +8 em 260922).
 */
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

/** Vereditos do link-verifier que bloqueiam o bônus (#8672 item 3). */
export const VIRAL_BLOCKED_VERDICTS: ReadonlySet<string> = new Set(["paywall", "anti_bot"]);

const PEOPLE_AND_GOV =
  /\b(trump|musk|altman|amodei|huang|zuckerberg|nadella|pichai|putin|xi jinping|lula|casa branca|white house|pent[áa]gono|pentagon|congress|senate|senado|governo|government)\b/i;
const BIG_COMPANIES = /\b(openai|anthropic|nvidia|google|apple|microsoft|tesla|xai|spacex|amazon|deepseek)\b/i;
/** "meta" é palavra comum em PT ("bater a meta") — a empresa só casa com M maiúsculo. */
const META_COMPANY = /\bMeta\b/;
/**
 * "processo" sozinho é falso positivo em PT ("processo seletivo") — só as
 * formas de processar alguém na Justiça casam.
 */
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

/**
 * `body` cita `key` como URL inteira — não como prefixo de outra
 * (`site.com/p/x` não casa em `site.com/p/xyz`). Review da #8673 (P3).
 */
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

export function extractViralSignals(a: Omit<ViralInput, "score_base">, ctx: ViralContext): ViralSignals {
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

/** Guarda que impede o bônus, ou `null`. Ordem fixa — a 1ª que casa é a registrada. */
export function viralGuard(a: ViralInput): string | null {
  if (a.category === "tutorial" || a.category === "video") return `category:${a.category}`;
  if (a.score_base < VIRAL_MIN_BASE_SCORE) return "below_min_base";
  if (a.verify_verdict && VIRAL_BLOCKED_VERDICTS.has(a.verify_verdict)) return `verdict:${a.verify_verdict}`;
  const domain = registrableDomain(a.url);
  if (domain && SOCIAL_DOMAINS.has(domain)) return "social_post";
  return null;
}

export function computeViralBonus(a: ViralInput, ctx: ViralContext): ViralResult {
  const skipped = viralGuard(a);
  if (skipped) return { bonus: 0, signals: [], skipped };

  const s = extractViralSignals(a, ctx);
  const w = VIRAL_WEIGHTS;
  const signals: string[] = [];
  let bonus = 0;

  // 1. Atores de alta atenção (pessoas/governo pesam mais que nomes de empresa,
  //    que aparecem em quase toda notícia de IA e discriminam pouco).
  const actors = (s.people_gov ? w.people_gov : 0) + (s.big_company ? w.big_company : 0);
  if (actors) {
    bonus += actors;
    signals.push(`actors:+${actors}`);
  }

  // 2. Ganchos. O de conflito/dano NÃO conta quando o artigo já carrega
  //    `negative_impact` (#3916/#3918): o requisito de impacto negativo é
  //    garantido por backstop (`ensureNegativeImpactHighlight`) e é
  //    `NON_CALIBRATABLE_FEATURES` — premiar o mesmo dano pelo score seria
  //    calibrá-lo por procuração e fazer o bônus competir com o backstop.
  let hooks = 0;
  if (s.conflict_harm && !a.negative_impact) hooks += w.conflict_harm;
  if (s.money_scale) hooks += w.money_scale;
  if (s.policy_geo) hooks += w.policy_geo;
  hooks = Math.min(hooks, VIRAL_HOOKS_CAP);
  if (hooks) {
    bonus += hooks;
    signals.push(`hooks:+${hooks}`);
  }

  // 3. Cobertura cruzada: em quantas newsletters do inbox o link aparece.
  //    Fontes agrupadas no cluster NÃO entram aqui: `merge-scored-chunks.ts` já
  //    soma `coverageBonus` por elas (contar de novo seria premiar 2x).
  const cross = Math.min(s.newsletter_mentions * w.newsletter_mentions, VIRAL_CROSS_CAP);
  if (cross) {
    bonus += cross;
    signals.push(`cross_coverage:+${cross}`);
  }

  // 4. Recência (≤36h).
  if (s.recent_36h) {
    bonus += w.recent_36h;
    signals.push(`recency:+${w.recent_36h}`);
  }

  // Teto do bônus e do score — e os sinais reconciliam com o que foi cortado
  // (review da #8673: antes a soma dos sinais podia passar do bônus gravado).
  const capped = Math.max(0, Math.min(bonus, VIRAL_BONUS_CAP, SCORE_MAX - (a.score_current ?? a.score_base)));
  if (capped < bonus) signals.push(`cap:-${bonus - capped}`);
  return { bonus: capped, signals, skipped: null };
}
