/**
 * negative-promotion-eligibility.ts (#10795, decisão do editor no briefing 261023)
 *
 * Duas restrições à promoção de destaque `negative_impact:true` para o top-3
 * ou para D1 — a cota de ≥1 negativo (#3916) e o padrão "incidente com dano
 * já ocorrido sobe para D1" (#9883) do `scorer-select`:
 *
 *   1. **Processo/acusação não é dano já ocorrido.** Ação judicial, denúncia,
 *      acusação ou ação movida num tribunal é alegação, não dano comprovado.
 *      Pode estar no trio por mérito; não entra nele por promoção nem sobe
 *      para D1 por esse padrão.
 *   2. **Entidade+tema que já foi destaque nos últimos 14 dias.** Mesma
 *      entidade (nome próprio dos títulos do destaque passado, palavra
 *      inteira — mesma extração do matcher de mesmo fato #9100) E ao menos 1
 *      termo de conteúdo em comum com a MANCHETE do destaque passado (título
 *      publicado + título da fonte): palavra em minúscula, fora nomes
 *      próprios e verbos de anúncio genéricos ("lança", "anuncia"). Só a empresa nunca
 *      basta. O matcher de mesmo fato do #9100 (mesma URL, ou entidade + ≥2
 *      números) também conta, agora na janela de 14 dias.
 *
 * O `scorer-select` recebe as duas regras no prompt, mas não recebe os
 * destaques passados — a regra 2 só existe aqui. A regra 1 é aplicada no
 * prompt por julgamento e aqui por evidência explícita no TÍTULO (o termo
 * "processo" sozinho é ambíguo em PT — "processo de contratação" — então só
 * formas judiciais inequívocas contam).
 *
 * O que a função faz com um negativo inelegível no top-3:
 *   - fora do trio por mérito (top-3 por score) → chegou lá por promoção:
 *     sai do top-3 (vira o 1º reserva, nunca é descartado). A vaga vai para o
 *     melhor negativo ELEGÍVEL fora do top-3, na posição 3 (quando não sobra
 *     negativo no trio), ou para o reserva de maior score;
 *   - dentro do trio por mérito, mas em D1 à frente de item de score maior →
 *     o padrão de D1 por incidente não vale para ele: desce até a posição de
 *     mérito dentro do trio. Continua no trio.
 * Negativo inelegível que está no trio por mérito e já na posição de mérito
 * fica onde está — as regras só barram a PROMOÇÃO.
 *
 * Puro: não lê disco, não muta os argumentos.
 */

import { canonicalize } from "./url-utils.ts";
import { containsWholeWord, cutoffAammdd, themeFactTokens } from "./past-editions-extract.ts";
import { hasNegativeImpactTag } from "./negative-impact-promotion.ts";
import {
  candidateOf,
  extractDemotionEntities,
  findSameFactDemotionMatch,
  type DemotableHighlight,
  type PublishedDestaque,
} from "./same-fact-demotion.ts";

/** Janela, em dias corridos, da regra entidade+tema (decisão do editor). */
export const NEGATIVE_THEME_WINDOW_DAYS = 14;

/**
 * Formas judiciais inequívocas no título. "processo" só conta seguido de
 * contra/judicial/movido/coletivo; "aciona" só com justiça/tribunal.
 */
const ALLEGATION_PATTERNS: RegExp[] = [
  /\bprocess(?:a|am|ou|aram|ada|ado|adas|ados)\b/iu,
  /\bprocesso(?:s)?\s+(?:contra|judicia(?:l|is)|movidos?|coletivos?|na justi[çc]a)\b/iu,
  /\ba[çc][ãa]o\s+(?:judicial|coletiva|civil)\b/iu,
  /\bacus(?:a|am|ou|aram|ada|ado|adas|ados|a[çc][ãa]o|a[çc][õo]es)\b/iu,
  /\bden[uú]ncia(?:s)?\b|\bdenunciad[oa]s?\b/iu,
  /\baciona(?:m|ram|ou)?\b.{0,40}\b(?:justi[çc]a|tribunal|tse|stf|stj|tst|minist[ée]rio p[uú]blico|mpf)\b/iu,
  /\b(?:lawsuit|lawsuits|sue|sues|sued|suing)\b/iu,
  /\b(?:alleges|alleged|allegation|allegations|accuses|accused)\b/iu,
];

/** True quando o título traz evidência explícita de processo/acusação. */
export function isAllegationHeadline(title: string): boolean {
  return ALLEGATION_PATTERNS.some((re) => re.test(title));
}

/**
 * Termos que não caracterizam tema (verbo de anúncio, palavra genérica do
 * domínio) — compartilhá-los não faz dois destaques serem do mesmo tema.
 */
const GENERIC_THEME_TERMS = new Set([
  "lança", "lançam", "lançou", "lançamento", "anuncia", "anunciou", "apresenta", "revela", "mostra",
  "ganha", "usa", "faz", "quer", "vai", "agora", "launches", "announces", "unveils", "releases", "says",
  "inteligência", "artificial", "modelo", "modelos", "usuários", "usuario", "usuário", "empresa", "empresas",
  "ferramenta", "recurso", "função", "users", "model", "models", "company",
]);

/** Tokens escritos com maiúscula na manchete — nome próprio, contam como entidade, nunca como tema. */
function capitalizedTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.normalize("NFC").matchAll(/\p{L}[\p{L}\p{N}]*/gu)) {
    if (/\p{Lu}/u.test(m[0])) out.add(m[0].toLowerCase());
  }
  return out;
}

export interface RecentThemeMatch {
  matched_edition: string;
  matched_destaque: number;
  matched_title: string;
  evidence: "same-fact" | "entity+theme";
  shared_entities: string[];
  shared_terms: string[];
}

/** Destaques passados dentro da janela de `days` dias antes de `edition`. */
export function withinThemeWindow(
  past: PublishedDestaque[],
  edition: string,
  days = NEGATIVE_THEME_WINDOW_DAYS,
): PublishedDestaque[] {
  const cutoff = cutoffAammdd(edition, days);
  if (!cutoff) return [];
  return past.filter((p) => p.aammdd >= cutoff && p.aammdd < edition);
}

/**
 * Casa o candidato contra os destaques da janela. `past` já deve vir filtrado
 * pela janela (`withinThemeWindow`). Edição mais recente primeiro.
 */
export function findRecentThemeMatch(
  h: DemotableHighlight,
  past: PublishedDestaque[],
): RecentThemeMatch | null {
  const cand = candidateOf(h);
  const sameFact = findSameFactDemotionMatch(cand, past);
  if (sameFact) {
    return {
      matched_edition: sameFact.matched_edition,
      matched_destaque: sameFact.matched_destaque,
      matched_title: sameFact.matched_title,
      evidence: "same-fact",
      shared_entities: sameFact.shared_entities,
      shared_terms: sameFact.shared_numbers,
    };
  }
  const hay = `${cand.title}\n${cand.text}`.normalize("NFC").toLowerCase();
  const sorted = [...past].sort((a, b) => b.aammdd.localeCompare(a.aammdd) || a.n - b.n);
  for (const p of sorted) {
    const entities = [...extractDemotionEntities([p.title, p.source_title ?? ""], p.text)];
    const sharedEntities = entities.filter((e) => containsWholeWord(hay, e));
    if (sharedEntities.length === 0) continue;
    // Tema = palavra de conteúdo em minúscula da manchete passada (título
    // publicado + título da fonte), fora entidades e nomes próprios.
    const headlineText = `${p.title} ${p.source_title ?? ""}`;
    const proper = capitalizedTokens(headlineText);
    const sharedTerms = [...themeFactTokens(headlineText)].filter(
      (t) =>
        !proper.has(t) &&
        !entities.includes(t) &&
        !GENERIC_THEME_TERMS.has(t) &&
        !/^\p{N}/u.test(t) &&
        containsWholeWord(hay, t),
    );
    if (sharedTerms.length === 0) continue;
    return {
      matched_edition: p.aammdd,
      matched_destaque: p.n,
      matched_title: p.title,
      evidence: "entity+theme",
      shared_entities: sharedEntities.sort(),
      shared_terms: sharedTerms.sort(),
    };
  }
  return null;
}

export type NegativeIneligibility =
  | { kind: "acusacao" }
  | { kind: "tema-recente"; match: RecentThemeMatch };

/** Por que um negativo não pode ser PROMOVIDO (null = elegível ou não-negativo). */
export function negativePromotionIneligibility(
  h: DemotableHighlight,
  pastInWindow: PublishedDestaque[],
): NegativeIneligibility | null {
  if (!hasNegativeImpactTag(h)) return null;
  if (isAllegationHeadline(candidateOf(h).title)) return { kind: "acusacao" };
  const match = findRecentThemeMatch(h, pastInWindow);
  return match ? { kind: "tema-recente", match } : null;
}

export interface NegativePolicyAction {
  url: string;
  title: string;
  action: "removido-do-top3" | "desceu-no-trio" | "mantido-sem-substituto";
  from_rank: number;
  to_rank: number;
  why: NegativeIneligibility;
  /** URL que ocupou a vaga, quando `removido-do-top3`. */
  replaced_by?: string;
}

export interface NegativePolicyResult<H extends DemotableHighlight> {
  highlights: H[];
  actions: NegativePolicyAction[];
  /** Top-3 ficou sem negativo depois das exclusões (o gate da Etapa 4 avisa, #3918). */
  no_eligible_negative: boolean;
}

/** Rebaixado pelo #9100 — a marca vive no highlight ou no artigo (mesma leitura de `apply-gate-edits.ts`). */
function isSameFactDemoted(h: DemotableHighlight): boolean {
  const rec = h as { same_fact_demoted?: unknown; article?: { same_fact_demoted?: unknown } | null };
  const flag = rec.same_fact_demoted ?? rec.article?.same_fact_demoted;
  return flag !== undefined && flag !== null && flag !== false;
}

function urlKey(h: DemotableHighlight): string {
  const u = candidateOf(h).url;
  return u ? canonicalize(u) : "";
}

function describe(why: NegativeIneligibility): string {
  if (why.kind === "acusacao") return "processo/acusação não é dano já ocorrido";
  const m = why.match;
  const detail = m.evidence === "same-fact"
    ? "mesmo fato"
    : `entidade: ${m.shared_entities.join(", ")}; tema: ${m.shared_terms.join(", ")}`;
  return `entidade+tema já foi o D${m.matched_destaque} de ${m.matched_edition} "${m.matched_title}" (${detail})`;
}

/** Linha de aviso (gate / relatório do Stage 1). */
export function formatNegativePolicyNote(a: NegativePolicyAction): string {
  const head = `#10795 — "${a.title}"`;
  if (a.action === "removido-do-top3") {
    return `⬇️ ${head} saiu de D${a.from_rank} para o pool (posição ${a.to_rank}): ${describe(a.why)} — não justifica promoção ao top-3. Promova de volta se discordar.`;
  }
  if (a.action === "desceu-no-trio") {
    return `↕️ ${head} desceu de D${a.from_rank} para D${a.to_rank}: ${describe(a.why)} — não sobe para D1 à frente de item de score maior.`;
  }
  return `⚠️ ${head} segue em D${a.from_rank} sem substituto: ${describe(a.why)}.`;
}

/**
 * Aplica as duas restrições sobre `highlights` já ordenados por `rank`.
 * `pastInWindow`: destaques publicados nos últimos 14 dias (`withinThemeWindow`).
 */
export function applyNegativePromotionEligibility<H extends DemotableHighlight>(
  highlights: H[],
  pastInWindow: PublishedDestaque[],
  topN = 3,
): NegativePolicyResult<H> {
  const ordered = [...highlights].sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
  const actions: NegativePolicyAction[] = [];
  if (ordered.length === 0) return { highlights: highlights.slice(), actions, no_eligible_negative: false };

  const why = new Map<H, NegativeIneligibility>();
  for (const h of ordered.slice(0, topN)) {
    const w = negativePromotionIneligibility(h, pastInWindow);
    if (w) why.set(h, w);
  }
  if (why.size === 0) return { highlights: highlights.slice(), actions, no_eligible_negative: false };

  // Trio por mérito: top-N por score, empate pela ordem atual — só entre os
  // ELEGÍVEIS a destaque. Item que o #9100 rebaixou (`same_fact_demoted`)
  // segue na lista com o score original, mas não pode ser destaque: contá-lo
  // no trio faria o negativo que subiu para ocupar a vaga dele parecer
  // "promovido" e ser retirado do top-3 (#10985).
  const meritTrio = new Set(
    ordered
      .map((h, i) => ({ h, i }))
      .filter(({ h }) => !isSameFactDemoted(h))
      .sort((a, b) => (b.h.score ?? 0) - (a.h.score ?? 0) || a.i - b.i)
      .slice(0, topN)
      .map((x) => x.h),
  );

  let next = ordered.slice();
  const fromRank = new Map<H, number>(ordered.map((h, i) => [h, i + 1]));
  const replacedBy = new Map<H, string>();
  const kept = new Set<H>();

  // 1. Promovidos inelegíveis saem do top-N.
  for (const h of ordered.slice(0, topN)) {
    if (!why.has(h) || meritTrio.has(h)) continue;
    const top = next.slice(0, topN).filter((x) => x !== h);
    const rest = next.slice(topN).filter((x) => x !== h);
    const fillable = rest.filter(
      (x) => !isSameFactDemoted(x) && !negativePromotionIneligibility(x, pastInWindow),
    );
    const needsNegative = !top.some((x) => hasNegativeImpactTag(x) && !why.has(x));
    const negFill = needsNegative
      ? fillable.filter(hasNegativeImpactTag).sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0]
      : undefined;
    const fill = negFill ?? [...fillable].sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0];
    if (!fill) {
      kept.add(h);
      continue;
    }
    const restWithout = rest.filter((x) => x !== fill);
    // Negativo que entra no lugar vai para a posição N (D3); outro reserva
    // ocupa a vaga do removido.
    const slot = next.indexOf(h);
    const newTop = negFill
      ? [...top, fill]
      : [...top.slice(0, slot), fill, ...top.slice(slot)];
    next = [...newTop, h, ...restWithout];
    replacedBy.set(h, urlKey(fill) || candidateOf(fill).url);
  }

  // 2. Inelegível no trio por mérito, mas à frente de item de score maior.
  for (const h of ordered.slice(0, topN)) {
    if (!why.has(h) || !meritTrio.has(h)) continue;
    const top = next.slice(0, topN);
    const idx = top.indexOf(h);
    if (idx !== 0) continue; // só o padrão de D1 é barrado
    const others = top.filter((x) => x !== h);
    const higher = others.filter((x) => (x.score ?? 0) > (h.score ?? 0)).length;
    if (higher === 0) continue;
    const at = Math.min(higher, others.length);
    next = [...others.slice(0, at), h, ...others.slice(at), ...next.slice(topN)];
  }

  const out = next.map((h, i) => {
    const w = why.get(h);
    const moved = w && i >= topN;
    return {
      ...h,
      rank: i + 1,
      ...(moved ? { negative_promotion_excluded: w.kind } : {}),
    };
  }) as H[];

  for (const [h, w] of why) {
    const from = fromRank.get(h)!;
    const to = next.indexOf(h) + 1;
    const title = candidateOf(h).title;
    const url = candidateOf(h).url;
    if (kept.has(h)) {
      actions.push({ url, title, action: "mantido-sem-substituto", from_rank: from, to_rank: to, why: w });
    } else if (to > topN) {
      actions.push({ url, title, action: "removido-do-top3", from_rank: from, to_rank: to, why: w, replaced_by: replacedBy.get(h) });
    } else if (to !== from) {
      actions.push({ url, title, action: "desceu-no-trio", from_rank: from, to_rank: to, why: w });
    }
  }

  const noEligibleNegative =
    actions.length > 0 && !next.slice(0, topN).some((x) => hasNegativeImpactTag(x) && !why.has(x));
  if (actions.length === 0) return { highlights: highlights.slice(), actions, no_eligible_negative: false };
  return { highlights: out, actions, no_eligible_negative: noEligibleNegative };
}
