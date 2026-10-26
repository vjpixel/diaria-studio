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
import { isManufacturerUrl } from "./official-domains.ts";
import type { CircleStackSelection } from "./circle-stack-render.ts";

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
export const STACK_INTEREST_PROFILE: readonly Readonly<InterestTerm>[] = [
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
export const SECTION_BONUS: Readonly<Record<WeeklyRawCandidate["section"], number>> = {
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

export const DEFAULT_CAPS: Readonly<CircleStackSelectionCaps> = { destaques: 3, lancamentos: 4, useMelhor: 3, radar: 4 };

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
export function scoreCandidate(c: WeeklyRawCandidate, profile: readonly InterestTerm[] = STACK_INTEREST_PROFILE): StackScoredCandidate {
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
 * - lançamentos / use melhor: só link do SITE DO FABRICANTE (#11004 —
 *   `isManufacturerUrl`, registro de `official-domains.ts`). Item dessas
 *   seções vindo de imprensa/blog pessoal/agregador é rebaixado ao radar,
 *   concorrendo sem o bônus de seção.
 * - radar: itens com score > 0; também recebe destaques que não entraram no topo.
 * - URL nunca repete entre seções.
 */
export function selectCircleStack(
  candidates: WeeklyRawCandidate[],
  opts: { profile?: readonly InterestTerm[]; caps?: Readonly<CircleStackSelectionCaps> } = {},
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

  const practical = (c: StackScoredCandidate) => c.section === "lancamentos" || c.section === "use_melhor";
  const destaques = take(all.filter((c) => c.kind === "destaque"), caps.destaques);
  const lancamentos = take(
    all.filter((c) => c.section === "lancamentos" && c.score > SECTION_BONUS.lancamentos && isManufacturerUrl(c.url)),
    caps.lancamentos,
  );
  const useMelhor = take(
    all.filter((c) => c.section === "use_melhor" && c.score > SECTION_BONUS.use_melhor && isManufacturerUrl(c.url)),
    caps.useMelhor,
  );
  // #11004: prático sem link do fabricante desce ao radar, sem o bônus da seção de origem.
  const demoted = all
    .filter((c) => practical(c) && c.kind !== "destaque" && !isManufacturerUrl(c.url))
    .map((c) => ({ ...c, score: c.score - (SECTION_BONUS[c.section] ?? 0) }));
  const radar = take(
    [...all.filter((c) => c.section === "radar" || c.kind === "destaque"), ...demoted].filter((c) => c.score > 0),
    caps.radar,
  );

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

/**
 * Palavras funcionais do inglês (#11005). Nome de produto em inglês ("Claude
 * Code", "Mercury 3") não tem nenhuma delas, então passa; frase em inglês
 * ("Introducing Mercury 3", "How to use X") quase sempre tem.
 */
const ENGLISH_FUNCTION_WORDS = /(?<![\p{L}\d])(?:the|of|and|to|with|introducing|your|for|how|is|are|what|from)(?![\p{L}\d])/iu;
/** Palavras funcionais do português que não existem como palavra em inglês. */
const PORTUGUESE_FUNCTION_WORDS =
  /(?<![\p{L}\d])(?:de|da|das|dos|em|na|nas|nos|para|pra|com|que|um|uma|ao|aos|e|os|pelo|pela|sem|mais|seu|sua)(?![\p{L}\d])/iu;
const ACCENTED = /[áàâãéêíóôõúüç]/i;

/**
 * Pure (#11005): o título parece frase em inglês? Heurística simples da issue:
 * tem palavra funcional do inglês e nenhum acento. Para não reprovar título em
 * português com marca em inglês ("Claude for Chrome chega ao Brasil"), também
 * exige que não haja palavra funcional do português.
 */
export function looksEnglishTitle(title: string): boolean {
  const t = title.replace(/\s+/g, " ").trim();
  if (!t || ACCENTED.test(t)) return false;
  return ENGLISH_FUNCTION_WORDS.test(t) && !PORTUGUESE_FUNCTION_WORDS.test(t);
}

/**
 * Pure (#11005): o título tem sinal positivo de português (acento ou palavra
 * funcional do português)? Usado para decidir o que vai à tradução: o que NÃO
 * tem sinal nenhum ("Mercury 3 Launch Notes", "Introducing Codex") vai ao
 * agente, mesmo sem palavra funcional do inglês que `looksEnglishTitle` pegaria.
 */
export function hasPortugueseSignal(title: string): boolean {
  const t = title.replace(/\s+/g, " ").trim();
  return ACCENTED.test(t) || PORTUGUESE_FUNCTION_WORDS.test(t);
}

const SECTION_LABEL: Record<"destaques" | "lancamentos" | "useMelhor" | "radar", string> = {
  destaques: "Destaques",
  lancamentos: "Lançamentos",
  useMelhor: "Use melhor",
  radar: "Radar",
};

/**
 * Pure: problemas editoriais da seleção que impedem o `--publish` (a seleção é
 * editável à mão e é reaproveitada, então a checagem roda sobre o que vai sair,
 * não só no momento da seleção). Cada linha nomeia a seção e o item.
 *   - #11004: Lançamentos e Use melhor só com link do site do fabricante.
 *   - #11005: todo título em português (nome de produto pode ficar em inglês).
 * No dry-run estas linhas viram avisos (o editor corrige na seleção); no
 * `--publish` elas recusam o envio.
 */
export function circleStackSelectionViolations(
  sel: Pick<CircleStackSelection, "destaques" | "lancamentos" | "useMelhor" | "radar">,
): string[] {
  const out: string[] = [];
  for (const section of ["lancamentos", "useMelhor"] as const) {
    for (const it of sel[section]) {
      if (!isManufacturerUrl(it.url)) {
        out.push(
          `${SECTION_LABEL[section]}: "${it.title}" não tem link do site do fabricante (${it.url}) — ` +
            "troque pelo link oficial (blog, changelog, docs, central de ajuda) ou mova o item para o Radar (#11004)",
        );
      }
    }
  }
  for (const section of ["destaques", "lancamentos", "useMelhor", "radar"] as const) {
    for (const it of sel[section]) {
      if (looksEnglishTitle(it.title)) {
        out.push(
          `${SECTION_LABEL[section]}: título em inglês "${it.title}" — reescreva o campo title em português na seleção ` +
            "(nome de produto pode ficar como está; o original fica em titleOriginal) (#11005)",
        );
      }
    }
  }
  return out;
}
