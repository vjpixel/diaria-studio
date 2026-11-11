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
  /**
   * Termo genérico (#12549): casa em quase todo texto de IA ("agentes",
   * "automação", "programação"). Só pontua no corpo quando o item também tem
   * um "segundo sinal": um termo NÃO genérico casado, ou qualquer termo do
   * perfil no título (mantém "OAB-SP vai à Justiça contra a startup Enter");
   * no título pontua sempre, porque ali a notícia é sobre aquilo.
   */
  generic?: boolean;
}

/**
 * Default derivado do catálogo de cursos da Stack (Lovable, n8n, Pensamento
 * Builder, Claude Code, Replit, Cursor, Agentes de IA, GitHub para Builders).
 *
 * #12549: os termos marcados `generic` são os que, no ciclo 26w45, puseram no
 * Radar "Agentes de compras com IA podem ameaçar Amazon e Walmart" (varejo) e
 * "O candidato com 278 entrevistas" (recrutamento) só por aparecer no corpo.
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
  { label: "agentes", pattern: "agent\\p{L}*|ag[êe]ntic\\p{L}*", weight: 3, generic: true },
  { label: "automação", pattern: "automa[çt]\\p{L}*|workflows?", weight: 3, generic: true },
  { label: "MCP", pattern: "mcp", weight: 3 },
  { label: "protótipo/MVP", pattern: "prot[óo]tip\\p{L}*|prototyp\\p{L}*|mvp", weight: 3 },
  { label: "app", pattern: "apps?|aplicativos?", weight: 2, generic: true },
  { label: "programação", pattern: "program\\p{L}*|c[óo]digo|coding|desenvolvedor\\p{L}*|devs?", weight: 2, generic: true },
  { label: "API", pattern: "apis?|sdks?", weight: 2 },
  { label: "open source", pattern: "open[ -]?source|c[óo]digo aberto", weight: 2 },
  { label: "startup", pattern: "startups?", weight: 1, generic: true },
  { label: "produto", pattern: "produtos?", weight: 1, generic: true },
];

/**
 * Assuntos de outro setor (#12549): varejo/publicidade, recrutamento, saúde,
 * ERP/sistema de gestão corporativo. Casados no título ou no corpo. Item que
 * cai aqui SEM nenhum sinal específico (termo não genérico do perfil ou de
 * importância) fica fora do Radar; destaque assim entra no aviso da prévia.
 * Casos do ciclo 26w45: "Agentes de compras ... Amazon e Walmart", "O candidato
 * com 278 entrevistas" e "Vale usa IA para transformar reuniões em código"
 * (troca do sistema de gestão), que o editor tirou à mão.
 */
export const STACK_OFF_TOPIC_TERMS: readonly Readonly<InterestTerm>[] = [
  {
    label: "varejo/publicidade",
    pattern: "varej\\p{L}*|e-?commerce|compras|walmart|publicidade|anunciantes?|retail\\p{L}*|advertis\\p{L}*|shopping",
    weight: 0,
  },
  {
    label: "recrutamento",
    pattern:
      "recrut\\p{L}*|recruit\\p{L}*|hiring|curr[íi]culos?|entrevistas? de emprego|job interviews?|rh|recursos humanos",
    weight: 0,
  },
  { label: "saúde", pattern: "sa[úu]de|hospita\\p{L}*|m[ée]dic[oa]s?|pacientes?|healthcare", weight: 0 },
  { label: "ERP corporativo", pattern: "erp|sistemas? de gest[ãa]o|sap", weight: 0 },
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

/**
 * Importância da notícia para quem constrói (#11782), somada só a DESTAQUES
 * diários, por cima dos termos de interesse. Sem isto a seleção contava só
 * palavras: no ciclo 26w44 o GPT-6.1 Terra (D1 de 28/10, modelo novo pela
 * metade do preço) perdeu o 3º destaque para "Hackers usam Claude e Grok
 * contra bancos", que somou pontos por citar o Cursor e "código de ataque".
 *
 * Medição nos ciclos gravados (26w42-26w44, 9 vagas de destaque): a seleção
 * automática coincidia com a do editor em 6 de 9 antes e coincide em 6 de 9
 * depois; o 26w44 passa a bater inteiro (Terra entra no lugar de "Hackers") e
 * o 26w43 perde a única vaga que batia (o editor escolheu ali itens que não
 * pontuam em termo nenhum, como "Salário em tecnologia").
 *
 * Fica fora de `circle_stack.interests` de propósito: o config troca o perfil
 * de interesse do público, não o que torna uma notícia importante.
 */
export const STACK_IMPORTANCE_TERMS: readonly Readonly<InterestTerm>[] = [
  {
    label: "modelo novo",
    pattern: "modelos?|llms?|gpt-?[\\d.]+\\p{L}*|claude (?:opus|sonnet|haiku)|gemini [\\d.]+|llama|kimi|mistral|deepseek|qwen",
    // Peso 1 (título: +2): com 2, "GPT-6 Astra achou duas falhas" tirava do
    // 26w42 o "Google Play roda o app que você criou", que o editor manteve.
    weight: 1,
  },
  { label: "custo/preço", pattern: "pre[çc]os?|custos?|custa\\p{L}*|mais barat\\p{L}*|barate\\p{L}*", weight: 3 },
];

/** Bônus pela posição na edição diária (#11782): o D1 é a notícia que o editor pôs no topo. */
export const DESTAQUE_POSITION_BONUS: Readonly<Record<1 | 2 | 3, number>> = { 1: 2, 2: 1, 3: 0 };

/**
 * Força do sinal de interesse (#12549):
 *   - `especifico`: casou termo não genérico do perfil (ferramenta/produto) ou,
 *     em destaque, termo de importância no título;
 *   - `generico`: só termo genérico, e no título;
 *   - `nenhum`: nada pontuou (termo genérico só no corpo não conta sozinho).
 */
export type StackSignal = "especifico" | "generico" | "nenhum";

export interface StackScoredCandidate extends WeeklyRawCandidate {
  score: number;
  matchedTerms: string[];
  signal: StackSignal;
  /** Assunto de outro setor (`STACK_OFF_TOPIC_TERMS`) sem sinal específico (#12549). */
  offTopic: boolean;
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

/**
 * Pure: pontua um candidato contra o perfil. Título conta em dobro. Destaque
 * diário soma ainda a importância (#11782): `DESTAQUE_POSITION_BONUS` e
 * `STACK_IMPORTANCE_TERMS`, estes só quando casam no título (peso em dobro).
 *
 * #12549: termo `generic` só no corpo pontua apenas quando o item tem também
 * um sinal específico; `signal` e `offTopic` vão junto para a seleção barrar o
 * Radar e para o aviso da prévia.
 */
export function scoreCandidate(c: WeeklyRawCandidate, profile: readonly InterestTerm[] = STACK_INTEREST_PROFILE): StackScoredCandidate {
  let score = SECTION_BONUS[c.section] ?? 0;
  const matched: string[] = [];
  const rest = `${c.body}\n${c.why}`;
  const hits = profile.map((t) => {
    const re = compileTerm(t);
    return { t, inTitle: re.test(c.title), inRest: re.test(rest) };
  });
  const importance = c.kind === "destaque" ? STACK_IMPORTANCE_TERMS.filter((t) => compileTerm(t).test(c.title)) : [];
  const specific = hits.some((h) => !h.t.generic && (h.inTitle || h.inRest)) || importance.length > 0;
  // Segundo sinal para o genérico do corpo: termo específico em qualquer lugar,
  // ou algum termo do perfil no título (a notícia é sobre aquilo).
  const anyInTitle = hits.some((h) => h.inTitle);
  let genericInTitle = false;
  for (const { t, inTitle, inRest } of hits) {
    if (!inTitle && !inRest) continue;
    if (t.generic && !inTitle && !specific && !anyInTitle) continue; // genérico só no corpo, sem segundo sinal
    if (t.generic && inTitle) genericInTitle = true;
    score += t.weight * (inTitle ? 2 : 1);
    matched.push(t.label);
  }
  if (c.kind === "destaque") {
    if (c.destaqueN !== undefined) score += DESTAQUE_POSITION_BONUS[c.destaqueN] ?? 0;
    // Só no título: "modelo" e "custo" aparecem de passagem em quase todo corpo
    // (medido nos ciclos 26w42-26w44); no título, a notícia É sobre isso.
    for (const t of importance) {
      score += t.weight * 2;
      matched.push(t.label);
    }
  }
  const signal: StackSignal = specific ? "especifico" : genericInTitle ? "generico" : "nenhum";
  const offTopic = !specific && STACK_OFF_TOPIC_TERMS.some((t) => compileTerm(t).test(`${c.title}\n${rest}`));
  return { ...c, score, matchedTerms: matched, signal, offTopic };
}

/**
 * Pure (#12549): destaque escolhido sem aderência ao público da Stack — só
 * termo genérico (ou nenhum) ou assunto de outro setor. A prévia avisa, em vez
 * de a semana sair parecendo bem servida.
 */
export function isWeakStackDestaque(c: Pick<StackScoredCandidate, "signal" | "offTopic">): boolean {
  return c.signal !== "especifico" || c.offTopic;
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
 * - radar: itens com score > 0 e sinal de interesse (#12549: termo genérico só
 *   no corpo não basta; assunto de outro setor sem sinal específico fica fora);
 *   também recebe destaques que não entraram no topo.
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
  // #12549: o Radar exige sinal de interesse que não seja só termo genérico no
  // corpo, e fora assunto de outro setor sem sinal específico.
  const radar = take(
    [...all.filter((c) => c.section === "radar" || c.kind === "destaque"), ...demoted].filter(
      (c) => c.score > 0 && c.signal !== "nenhum" && !c.offTopic,
    ),
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
    if (t.generic !== undefined && typeof t.generic !== "boolean") {
      throw new Error(`circle_stack.interests[${i}].generic precisa ser true ou false`);
    }
    const term: InterestTerm = { label: typeof t.label === "string" ? t.label : t.pattern, pattern: t.pattern, weight: t.weight };
    if (t.generic === true) term.generic = true;
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
/**
 * Palavras funcionais do português que não existem como palavra em inglês.
 * #11781: "o", "ainda", "agora", "como" e vizinhas entraram depois de
 * "Apagou a conversa? O Android ainda guarda" (título da diária, sem acento e
 * sem nenhuma das palavras da lista original) ser acusado como sem português.
 * Ficam de fora de propósito as que também são palavra em inglês: "a", "do",
 * "no", "as" ("a new model", "no-code", "AI as a service").
 */
const PORTUGUESE_FUNCTION_WORDS =
  /(?<![\p{L}\d])(?:de|da|das|dos|em|na|nas|nos|para|pra|com|que|um|uma|ao|aos|e|o|os|pelo|pela|sem|mais|seu|sua|seus|suas|ainda|agora|como|quem|onde|isso|esse|essa|este|esta|nao|vai|foi|ser|tem)(?![\p{L}\d])/iu;
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

/**
 * Pure (#11161): títulos sem nenhum sinal de português que o editor ainda não
 * confirmou (`titleReviewed: true`). Cobre o buraco do `looksEnglishTitle`:
 * título sem palavra funcional do inglês ("Codex Launch Notes") passa por
 * aquele guard, e uma seleção gravada com a tradução falhando ou com
 * `--no-translate` sairia em inglês no `--publish` seguinte. Item já acusado
 * por `circleStackSelectionViolations` (título com cara de inglês) não se
 * repete aqui. Uma linha por URL.
 */
export function circleStackUnreviewedTitles(
  sel: Pick<CircleStackSelection, "destaques" | "lancamentos" | "useMelhor" | "radar">,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const section of ["destaques", "lancamentos", "useMelhor", "radar"] as const) {
    for (const it of sel[section]) {
      if (seen.has(it.url)) continue;
      if (it.titleReviewed === true || hasPortugueseSignal(it.title) || looksEnglishTitle(it.title)) continue;
      seen.add(it.url);
      out.push(
        `${SECTION_LABEL[section]}: título sem sinal de português "${it.title}" — reescreva o campo title em português ` +
          "na seleção, rode --translate-titles (sem --publish), ou, se for só nome de produto, marque " +
          '"titleReviewed": true no item (#11161)',
      );
    }
  }
  return out;
}
