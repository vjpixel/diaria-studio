/**
 * circle-stack-select.ts (#10904)
 *
 * Seleção da edição semanal da diar.ia.br para o espaço "Radar de Notícias
 * Stack" (Circle da Stack). Diferente da semanal do LinkedIn (ranking por
 * clique), aqui o critério é o INTERESSE dos alunos da Stack: quem faz os
 * cursos de Lovable, n8n, Claude Code, Cursor, Replit, GitHub, agentes de IA
 * e "pensamento builder" — gente que constrói produto com IA, muitas vezes
 * sem programar.
 *
 * Fonte: todos os candidatos da semana (destaques + itens de seção) do
 * `02-reviewed.md` das 5 edições, extraídos por `extractWeeklyCandidates`.
 * Cada candidato recebe um score = soma dos pesos dos termos de interesse
 * que aparecem no título (peso dobrado) ou no corpo/"por que importa", mais
 * um bônus por seção prática (LANÇAMENTOS, USE MELHOR). Links comerciais e
 * próprios saem pelo mesmo filtro da semanal do LinkedIn.
 *
 * O perfil de interesse é um default em código (`STACK_INTEREST_PROFILE`),
 * substituível por `platform.config.json` → `circle_stack.interests`.
 */

import type { WeeklyRawCandidate } from "./weekly-linkedin-parse.ts";
import { isCommercialOrOwnLink, hasSuspiciousCommercialLanguage } from "./weekly-social-click-rank.ts";
import { normalizeUrl } from "./weekly-linkedin-clicks.ts";

export interface InterestTerm {
  /** Rótulo legível (entra em `matchedTerms`). */
  label: string;
  /** Fonte de regex, casada com flags `iu` e bordas de palavra unicode. */
  pattern: string;
  weight: number;
}

/**
 * Default derivado do catálogo de cursos da Stack (Lovable, n8n, Pensamento
 * Builder, Claude Code, Replit, Cursor, Agentes de IA, GitHub para Builders).
 */
export const STACK_INTEREST_PROFILE: InterestTerm[] = [
  { label: "Lovable", pattern: "lovable", weight: 4 },
  { label: "n8n", pattern: "n8n", weight: 4 },
  { label: "Claude Code", pattern: "claude code", weight: 4 },
  { label: "Cursor", pattern: "cursor", weight: 4 },
  { label: "Replit", pattern: "replit", weight: 4 },
  { label: "GitHub", pattern: "github|copilot", weight: 3 },
  { label: "Codex", pattern: "codex", weight: 3 },
  { label: "vibe coding", pattern: "vibe[ -]?cod\\p{L}*", weight: 4 },
  { label: "no-code", pattern: "no[ -]?code|low[ -]?code|sem c[óo]digo", weight: 4 },
  { label: "agentes", pattern: "agent\\p{L}*|ag[êe]ntic\\p{L}*", weight: 3 },
  { label: "automação", pattern: "automa[çt]\\p{L}*|workflows?", weight: 3 },
  { label: "MCP", pattern: "mcp", weight: 3 },
  { label: "protótipo/MVP", pattern: "prot[óo]tip\\p{L}*|prototyp\\p{L}*|mvp", weight: 3 },
  { label: "app", pattern: "apps?|aplicativos?", weight: 2 },
  { label: "programação", pattern: "program\\p{L}*|c[óo]digo|coding|desenvolvedor\\p{L}*|devs?", weight: 2 },
  { label: "API", pattern: "apis?|sdks?", weight: 2 },
  { label: "open source", pattern: "open[ -]?source|c[óo]digo aberto", weight: 2 },
  { label: "startup", pattern: "startups?", weight: 1 },
  { label: "produto", pattern: "produtos?", weight: 1 },
];

/** Bônus por seção — itens práticos interessam mais a quem constrói. */
export const SECTION_BONUS: Record<WeeklyRawCandidate["section"], number> = {
  destaque: 0,
  lancamentos: 2,
  use_melhor: 2,
  radar: 0,
  videos: 0,
  outro: 0,
};

export interface StackScoredCandidate extends WeeklyRawCandidate {
  score: number;
  matchedTerms: string[];
}

export interface CircleStackSelectionCaps {
  destaques: number;
  lancamentos: number;
  useMelhor: number;
  radar: number;
}

export const DEFAULT_CAPS: CircleStackSelectionCaps = { destaques: 3, lancamentos: 4, useMelhor: 3, radar: 4 };

export interface CircleStackPicks {
  destaques: StackScoredCandidate[];
  lancamentos: StackScoredCandidate[];
  useMelhor: StackScoredCandidate[];
  radar: StackScoredCandidate[];
}

function compileTerm(t: InterestTerm): RegExp {
  return new RegExp(`(?<![\\p{L}\\d])(?:${t.pattern})(?![\\p{L}\\d])`, "iu");
}

/** Pure: pontua um candidato contra o perfil. Título conta em dobro. */
export function scoreCandidate(c: WeeklyRawCandidate, profile: InterestTerm[] = STACK_INTEREST_PROFILE): StackScoredCandidate {
  let score = SECTION_BONUS[c.section] ?? 0;
  const matched: string[] = [];
  const rest = `${c.body}\n${c.why}`;
  for (const t of profile) {
    const re = compileTerm(t);
    const inTitle = re.test(c.title);
    const inRest = re.test(rest);
    if (!inTitle && !inRest) continue;
    score += t.weight * (inTitle ? 2 : 1);
    matched.push(t.label);
  }
  return { ...c, score, matchedTerms: matched };
}

/** Pure: ordena por score desc, depois edição mais recente, depois título. */
function byScore(a: StackScoredCandidate, b: StackScoredCandidate): number {
  return b.score - a.score || b.editionDate.localeCompare(a.editionDate) || a.title.localeCompare(b.title);
}

/**
 * Pure: escolhe as seções do post.
 *
 * - destaques: os destaques diários mais aderentes, preenchendo até N (se
 *   faltar aderência, completa com os de maior score mesmo zerado; só fica
 *   abaixo de N se a semana tiver menos destaques que isso) — a edição
 *   semanal nunca sai sem manchete.
 * - lançamentos / use melhor: só itens com score ACIMA do bônus da própria
 *   seção (`SECTION_BONUS`) — ou seja, que casaram pelo menos 1 termo de
 *   interesse; o bônus sozinho não basta.
 * - radar: itens com score > 0; também recebe destaques que não entraram no topo.
 * - URL nunca repete entre seções.
 */
export function selectCircleStack(
  candidates: WeeklyRawCandidate[],
  opts: { profile?: InterestTerm[]; caps?: CircleStackSelectionCaps } = {},
): CircleStackPicks {
  const profile = opts.profile ?? STACK_INTEREST_PROFILE;
  const caps = opts.caps ?? DEFAULT_CAPS;

  const byUrl = new Map<string, StackScoredCandidate>();
  for (const c of candidates) {
    if (!c.url || isCommercialOrOwnLink(c.url) || hasSuspiciousCommercialLanguage(`${c.title} ${c.body}`)) continue;
    const scored = scoreCandidate(c, profile);
    const key = normalizeUrl(c.url);
    const prev = byUrl.get(key);
    // Mesma URL em 2 lugares: fica a versão destaque (texto mais rico), senão a de maior score.
    if (!prev || (scored.kind === "destaque" && prev.kind !== "destaque") || (scored.kind === prev.kind && scored.score > prev.score)) {
      byUrl.set(key, scored);
    }
  }
  const all = [...byUrl.values()];
  const used = new Set<string>();
  const take = (pool: StackScoredCandidate[], n: number): StackScoredCandidate[] => {
    const out: StackScoredCandidate[] = [];
    for (const c of pool.sort(byScore)) {
      if (out.length >= n) break;
      const k = normalizeUrl(c.url);
      if (used.has(k)) continue;
      used.add(k);
      out.push(c);
    }
    return out;
  };

  const destaques = take(all.filter((c) => c.kind === "destaque"), caps.destaques);
  const lancamentos = take(all.filter((c) => c.section === "lancamentos" && c.score > SECTION_BONUS.lancamentos), caps.lancamentos);
  const useMelhor = take(all.filter((c) => c.section === "use_melhor" && c.score > SECTION_BONUS.use_melhor), caps.useMelhor);
  const radar = take(all.filter((c) => (c.section === "radar" || c.kind === "destaque") && c.score > 0), caps.radar);

  return { destaques, lancamentos, useMelhor, radar };
}

/** Pure: valida/normaliza `circle_stack.interests` do config. */
export function parseInterestProfile(raw: unknown): InterestTerm[] | null {
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw) || raw.length === 0) throw new Error("circle_stack.interests deve ser uma lista não vazia");
  return raw.map((r, i) => {
    const t = r as Record<string, unknown>;
    if (typeof t.pattern !== "string" || typeof t.weight !== "number") {
      throw new Error(`circle_stack.interests[${i}] precisa de pattern (string) e weight (número)`);
    }
    const term = { label: typeof t.label === "string" ? t.label : t.pattern, pattern: t.pattern, weight: t.weight };
    compileTerm(term);
    return term;
  });
}
