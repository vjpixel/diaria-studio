/**
 * scripts/lib/viral-score.ts — POC do bônus de potencial de viralização.
 *
 * Puro e determinístico: recebe um artigo já pontuado (`score_base`) + contexto
 * da edição e devolve um bônus aditivo (slug `viral`, teto `VIRAL_BONUS_CAP`)
 * com os sinais que o justificaram. Mantém o invariante do scorer
 * (`score == score_base + soma(bonuses_applied)`) — quem aplica grava
 * `viral:+N` em `bonuses_applied`.
 *
 * É um POC: os pesos abaixo são chute informado, NÃO calibrados contra CTR.
 * A calibração (regressão contra cliques reais da Beehiiv/Kit, mesma
 * maquinaria de `calibrate-scoring-weights.ts`) é o trabalho da issue que
 * originou este módulo. Não usar em produção sem ela.
 */

export const VIRAL_BONUS_CAP = 15;
/** Só quem já passou de um piso de qualidade ganha bônus — viral não resgata lixo. */
export const VIRAL_MIN_BASE_SCORE = 40;

export interface ViralInput {
  url: string;
  title?: string;
  summary?: string;
  published_at?: string;
  score_base: number;
  category?: string;
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
}

const PEOPLE_AND_GOV =
  /\b(trump|musk|altman|amodei|huang|zuckerberg|nadella|pichai|putin|xi jinping|lula|casa branca|white house|pent[áa]gono|pentagon|congress|senate|senado|governo|government)\b/i;
const BIG_COMPANIES =
  /\b(openai|anthropic|nvidia|google|meta|apple|microsoft|tesla|xai|spacex|amazon|deepseek)\b/i;
const CONFLICT_OR_HARM =
  /\b(hack\w*|invad\w*|invas\w*|breach\w*|leak\w*|vazament\w*|lawsuit|sued|processo|ban(ned|s)?|block(ed|s)?|bloque\w*|demiss\w*|layoff\w*|kill switch|loss of control|perda de controle|jailbreak\w*|deepfake\w*)\b/i;
const MONEY_OR_SCALE = /\b(ipo|trilh\w+|trillion|bilh\w+|billion)\b|\$\s?\d+(\.\d+)?\s?(b|bn|billion|bilh)/i;
const POLICY_OR_GEOPOLITICS =
  /\b(regula\w*|regulation|law|lei|guerra|war|military|militar\w*|china|onu|united nations|safeguards?|slowdown|freio)\b/i;
/** Sigla "UN" só casa em maiúsculas (senão pega "un" de outras línguas). */
const UN_ACRONYM = /\bUN\b/;

/** URL sem query/fragmento, para casar contra corpos de newsletter. */
export function urlKey(url: string): string {
  return url.replace(/^https?:\/\//, "").split(/[?#]/)[0].replace(/\/+$/, "");
}

export function computeViralBonus(a: ViralInput, ctx: ViralContext): ViralResult {
  const none: ViralResult = { bonus: 0, signals: [] };
  if (a.category === "tutorial" || a.category === "video") return none;
  if (a.score_base < VIRAL_MIN_BASE_SCORE) return none;

  const text = `${a.title ?? ""} ${a.summary ?? ""}`;
  const signals: string[] = [];
  let bonus = 0;

  // 1. Atores de alta atenção (pessoas/governo pesam mais que nomes de empresa,
  //    que aparecem em quase toda notícia de IA e discriminam pouco).
  let actors = 0;
  if (PEOPLE_AND_GOV.test(text)) actors += 3;
  if (BIG_COMPANIES.test(text)) actors += 1;
  if (actors) {
    bonus += actors;
    signals.push(`actors:+${actors}`);
  }

  // 2. Ganchos de conflito/dano, dinheiro/escala e política/geopolítica (teto +8).
  let hooks = 0;
  if (CONFLICT_OR_HARM.test(text)) hooks += 4;
  if (MONEY_OR_SCALE.test(text)) hooks += 3;
  if (POLICY_OR_GEOPOLITICS.test(text) || UN_ACRONYM.test(text)) hooks += 3;
  hooks = Math.min(hooks, 8);
  if (hooks) {
    bonus += hooks;
    signals.push(`hooks:+${hooks}`);
  }

  // 3. Cobertura cruzada: em quantas newsletters do inbox o link aparece (teto +6).
  //    Fontes agrupadas no cluster NÃO entram aqui: `merge-scored-chunks.ts` já
  //    soma `coverageBonus` por elas (contar de novo seria premiar 2x).
  const key = urlKey(a.url);
  const mentions = ctx.newsletterBodies.filter((b) => b.includes(key)).length;
  const cross = Math.min(mentions * 3, 6);
  if (cross) {
    bonus += cross;
    signals.push(`cross_coverage:+${cross}`);
  }

  // 4. Recência (≤36h).
  if (a.published_at) {
    const ageH = (Date.parse(ctx.now) - Date.parse(a.published_at)) / 3_600_000;
    if (Number.isFinite(ageH) && ageH >= 0 && ageH <= 36) {
      bonus += 2;
      signals.push("recency:+2");
    }
  }

  return { bonus: Math.min(bonus, VIRAL_BONUS_CAP), signals };
}
