/**
 * weekly-linkedin-render.ts (#4456)
 *
 * Monta o artefato colável (`ln-{cycle}.html`) da newsletter semanal do
 * LinkedIn a partir da seleção já aprovada (`select-linkedin-weekly.ts`) +
 * texto novo já humanizado/corrigido (abertura, fecho, comentário do USE
 * MELHOR — a skill roda `humanizador` + Clarice ANTES de chamar este módulo;
 * ver `.claude/skills/diaria-linkedin-semanal/SKILL.md`).
 *
 * Regras do comentário 260802 (3º) do #4456, todas aplicadas aqui:
 *   - Título do destaque entra LITERAL — só a numeração ("1.", "2.", "3.")
 *     é adicionada. Nunca reescrito, nunca linkado (ver "Cai o link por
 *     destaque").
 *   - Bloco USE MELHOR é OBRIGATÓRIO só quando há comentário do editor —
 *     ausente/vazio → bloco inteiro omitido (nunca gerado por esta função).
 *   - Texto de link NUNCA termina em domínio nu (auto-linkagem do LinkedIn
 *     parte o link em dois e a parte clicável fica sem UTM) — usa sempre
 *     rótulo de ação.
 *   - UTM: `utm_source=linkedin&utm_medium=newsletter&utm_campaign=ln-{cycle}
 *     &utm_content=lista|cta-usemelhor|cta-fim` (item-01/02/03 SAÍRAM).
 */

import { deriveEditionUrl } from "./edition-url.ts";

export const LINKEDIN_WEEKLY_UTM_SOURCE = "linkedin";
export const LINKEDIN_WEEKLY_UTM_MEDIUM = "newsletter";

/** Pure: `utm_campaign` da newsletter semanal do LinkedIn — `ln-{cycle}` (#4456). */
export function linkedinWeeklyCampaign(cycle: string): string {
  return `ln-${cycle}`;
}

export type LinkedinWeeklyUtmContent = "lista" | "cta-usemelhor" | "cta-fim";

/** Pure: monta uma URL com o triplo UTM completo (+ `utm_content`) do contrato do #4456. */
export function buildLinkedinWeeklyUrl(baseUrl: string, cycle: string, content: LinkedinWeeklyUtmContent): string {
  const u = new URL(baseUrl);
  u.searchParams.set("utm_source", LINKEDIN_WEEKLY_UTM_SOURCE);
  u.searchParams.set("utm_medium", LINKEDIN_WEEKLY_UTM_MEDIUM);
  u.searchParams.set("utm_campaign", linkedinWeeklyCampaign(cycle));
  u.searchParams.set("utm_content", content);
  return u.toString();
}

/** Base da diar.ia.br pros 2 CTAs de assinatura (meio e fim) — mesma constante base de `edition-url.ts`. */
export const LINKEDIN_WEEKLY_SUBSCRIBE_BASE_URL = "https://diar.ia.br";

/** Pure: rótulo de ação nunca termina em domínio nu (achado operacional #4456 — auto-linkagem do LinkedIn). */
export function endsInBareDomainLabel(label: string): boolean {
  return /(^|\s)([a-z0-9-]+\.)+[a-z]{2,}\/?$/i.test(label.trim());
}

const CTA_USEMELHOR_LABEL = "Receba todo dia, é grátis →";
const CTA_FIM_LABEL = "Assine grátis, é rapidinho →";

export interface WeeklyLinkedinHeadlineInput {
  /** Título literal (copiado do bloco de origem — nunca reescrito). */
  title: string;
  /** Corpo literal (parágrafos separados por linha em branco dupla). */
  body: string;
  /** "Por que isso importa" literal — "" se ausente (candidato de seção, não destaque). */
  why: string;
}

export interface WeeklyLinkedinUseMelhorInput {
  title: string;
  url: string;
  description: string;
  /** Comentário do editor — OBRIGATÓRIO pra o bloco renderizar. Vazio/whitespace = bloco omitido. */
  editorComment: string;
}

export interface WeeklyLinkedinRestItem {
  editionDate: string;
  /** Título do D1 da edição — usado como texto do item + fonte do slug da URL. */
  title: string;
}

export interface WeeklyLinkedinRenderInput {
  cycle: string;
  /** 1-3 manchetes, na ordem de seleção. */
  headlines: WeeklyLinkedinHeadlineInput[];
  useMelhor?: WeeklyLinkedinUseMelhorInput;
  restOfWeek: WeeklyLinkedinRestItem[];
  /** Abertura — prosa nova, já humanizada/corrigida pela skill (Skill("humanizador") + Clarice). */
  opening: string;
  /** Fecho antes do CTA final — prosa nova, já humanizada/corrigida. */
  closing: string;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function paragraphsHtml(text: string): string {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${escapeHtml(p)}</p>`)
    .join("\n");
}

/** Pure: título numerado — única transformação permitida sobre o título literal (#4456). */
export function numberedTitle(n: number, title: string): string {
  return `${n}. ${title}`;
}

export interface WeeklyLinkedinRenderResult {
  html: string;
  warnings: string[];
  /** `false` quando `useMelhor` foi passado mas o bloco foi OMITIDO por falta de comentário do editor. */
  useMelhorRendered: boolean;
}

/**
 * Monta o HTML colável. Pure — nenhuma chamada de rede/disco. `input.opening`/
 * `input.closing`/`useMelhor.editorComment` já devem estar humanizados/
 * corrigidos (responsabilidade da skill, não deste módulo).
 */
export function renderLinkedinWeeklyHtml(input: WeeklyLinkedinRenderInput): WeeklyLinkedinRenderResult {
  const warnings: string[] = [];
  const parts: string[] = [];

  if (input.opening.trim()) {
    parts.push(`<p>${escapeHtml(input.opening.trim())}</p>`);
  }

  input.headlines.forEach((h, i) => {
    parts.push(`<h2>${escapeHtml(numberedTitle(i + 1, h.title))}</h2>`);
    parts.push(paragraphsHtml(h.body));
    if (h.why.trim()) {
      parts.push(`<p><strong>Por que isso importa:</strong> ${escapeHtml(h.why.trim())}</p>`);
    }
    parts.push("<hr/>");
  });

  let useMelhorRendered = false;
  const hasComment = !!input.useMelhor?.editorComment?.trim();
  if (input.useMelhor && !hasComment) {
    warnings.push('USE MELHOR: comentário do editor ausente — bloco inteiro omitido (regra do #4456, nunca gerado automaticamente).');
  }
  if (input.useMelhor && hasComment) {
    const um = input.useMelhor;
    if (endsInBareDomainLabel(um.title)) {
      warnings.push(`USE MELHOR: título "${um.title}" termina em domínio nu — risco de auto-linkagem partir o link no paste do LinkedIn.`);
    }
    parts.push(`<h3>🛠️ Use melhor</h3>`);
    parts.push(`<p><a href="${escapeHtml(um.url)}">${escapeHtml(um.title)}</a></p>`);
    if (um.description.trim()) parts.push(`<p>${escapeHtml(um.description.trim())}</p>`);
    parts.push(`<p><em>${escapeHtml(um.editorComment.trim())}</em></p>`);
    const ctaUseMelhorUrl = buildLinkedinWeeklyUrl(LINKEDIN_WEEKLY_SUBSCRIBE_BASE_URL, input.cycle, "cta-usemelhor");
    parts.push(`<p><a href="${escapeHtml(ctaUseMelhorUrl)}">${escapeHtml(CTA_USEMELHOR_LABEL)}</a></p>`);
    parts.push("<hr/>");
    useMelhorRendered = true;
  }

  if (input.restOfWeek.length > 0) {
    parts.push(`<h3>Resto da semana</h3>`);
    parts.push("<ul>");
    for (const item of input.restOfWeek) {
      const listUrl = buildLinkedinWeeklyUrl(deriveEditionUrl(item.title), input.cycle, "lista");
      parts.push(`<li><a href="${escapeHtml(listUrl)}">${escapeHtml(item.title)}</a></li>`);
    }
    parts.push("</ul>");
    parts.push("<hr/>");
  }

  if (input.closing.trim()) {
    parts.push(`<p>${escapeHtml(input.closing.trim())}</p>`);
  }
  const ctaFimUrl = buildLinkedinWeeklyUrl(LINKEDIN_WEEKLY_SUBSCRIBE_BASE_URL, input.cycle, "cta-fim");
  parts.push(`<p><a href="${escapeHtml(ctaFimUrl)}">${escapeHtml(CTA_FIM_LABEL)}</a></p>`);

  return { html: parts.join("\n"), warnings, useMelhorRendered };
}
