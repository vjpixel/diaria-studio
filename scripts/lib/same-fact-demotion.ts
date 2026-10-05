/**
 * same-fact-demotion.ts (#9100, decisão do editor de 05/10/2026)
 *
 * Quando um candidato a destaque repete um FATO já publicado nos D1–D3 das
 * últimas 3 edições, a pipeline o REBAIXA do destaque — nunca descarta: o
 * próximo candidato sobe ao top-3, o item continua no pool (o bucket dele não
 * muda) e o gate 4 avisa. O editor pode promovê-lo de volta quando for ângulo
 * novo intencional (lição da #9531: descartar perde republicação deliberada).
 *
 * Sinal (determinístico, alta precisão):
 *   - mesma URL canônica de um D1–D3 recente (defesa em profundidade do
 *     dedup por URL — caso 260918 × 260917, `claude.com/blog/cowork-is-now-claude`); OU
 *   - mesma ENTIDADE (palavra inteira, `containsWholeWord` da #9646) E ≥2
 *     NÚMEROS idênticos no título+resumo. Casos reais: 261005 × 261002 (VigIA:
 *     554, 379, 190) e 260930 × 260929 (Sonnet 5.5, 30%).
 *
 * Números: inteiros ≥10 (1 dígito é ruído), decimais ("5.5" = "5,5"),
 * percentuais ("30%" = "30 %") e valores monetários ("US$ 899" → "899").
 * Anos (1900–2100) e datas ("28 de setembro", "October 3") são ignorados —
 * qualquer notícia da semana compartilha a data.
 *
 * Puro: não lê disco. A leitura dos D1–D3 publicados fica no CLI
 * (`scripts/demote-same-fact-highlights.ts`).
 */

import { canonicalize } from "./url-utils.ts";
import { decodeHtmlEntities } from "./clean-summary.ts";
import { containsWholeWord } from "./past-editions-extract.ts";
import { hasNegativeImpactTag, type HighlightLike } from "./negative-impact-promotion.ts";

/** Mínimo de números idênticos (além da entidade) para rebaixar. */
export const DEMOTION_MIN_SHARED_NUMBERS = 2;

/** Janela de edições passadas (D1–D3 das últimas N edições úteis). */
export const DEMOTION_PAST_WINDOW = 3;

/** D1–D3 publicado numa edição recente. */
export interface PublishedDestaque {
  aammdd: string;
  /** 1, 2 ou 3. */
  n: number;
  title: string;
  url: string;
  /** Corpo publicado do destaque e/ou resumo da fonte. */
  text: string;
}

export interface SameFactDemotionMatch {
  matched_edition: string;
  matched_destaque: number;
  matched_title: string;
  matched_url: string;
  evidence: "url" | "entity+numbers";
  shared_entities: string[];
  shared_numbers: string[];
}

const MONTHS =
  "janeiro|fevereiro|março|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro|" +
  "january|february|march|april|may|june|july|august|september|october|november|december|" +
  "jan|feb|fev|mar|apr|abr|jun|jul|aug|ago|sep|sept|set|oct|out|nov|dec|dez";

const DATE_PATTERNS: RegExp[] = [
  // "28 de setembro (de 2026)", "1º de outubro"
  new RegExp(`(?<![\\p{L}\\p{N}])\\d{1,2}\\s*(?:º|°|o)?\\s+de\\s+(?:${MONTHS})(?![\\p{L}])`, "giu"),
  // "October 3", "Oct. 3rd", "setembro 28"
  new RegExp(`(?<![\\p{L}])(?:${MONTHS})\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?(?![\\p{N}])`, "giu"),
  // "3 October"
  new RegExp(`(?<![\\p{L}\\p{N}])\\d{1,2}(?:st|nd|rd|th)?\\s+(?:${MONTHS})(?![\\p{L}])`, "giu"),
  // 28/09, 28/09/2026, 2026-09-28
  /(?<![\p{N}])\d{1,4}[/-]\d{1,2}(?:[/-]\d{2,4})?(?![\p{N}])/gu,
];

function prepare(text: string): string {
  return decodeHtmlEntities(text ?? "").normalize("NFC");
}

/**
 * Números normalizados de um texto. Inteiros de 1 dígito e anos (1900–2100)
 * ficam de fora; decimais e percentuais ficam. Separador de milhar
 * ("14.000", "1,234") vira "14000"; vírgula decimal vira ponto.
 */
export function extractDemotionNumbers(text: string): Set<string> {
  let t = prepare(text);
  for (const re of DATE_PATTERNS) t = t.replace(re, " ");
  const out = new Set<string>();
  const re = /(?<![\p{L}\p{N}.,])(\d{1,3}(?:[.,]\d{3})+(?![\p{N}])|\d+(?:[.,]\d+)?)(\s?%)?(?![\p{L}\p{N}])/gu;
  for (const m of t.matchAll(re)) {
    const raw = m[1];
    // "14.000", "1,234" → milhar; "5.5"/"5,5" → decimal.
    let norm = /^\d{1,3}(?:[.,]\d{3})+$/.test(raw) ? raw.replace(/[.,]/g, "") : raw.replace(",", ".");
    const pct = m[2] !== undefined;
    if (!norm.includes(".")) {
      const n = Number(norm);
      if (!Number.isFinite(n)) continue;
      if (n < 10) continue; // 1 dígito: ruído ("3 empresas", "GPT-6")
      if (!pct && n >= 1900 && n <= 2100) continue; // ano
      norm = String(n);
    }
    out.add(pct ? `${norm}%` : norm);
  }
  return out;
}

/** Palavras capitalizadas que não são entidade (início de frase, meses, IA). */
const ENTITY_STOPWORDS = new Set([
  // PT
  "a", "o", "as", "os", "um", "uma", "em", "no", "na", "nos", "nas", "de", "do", "da", "dos", "das",
  "com", "sem", "por", "para", "pra", "que", "se", "mas", "mais", "como", "quando", "onde", "segundo",
  "após", "apos", "antes", "desde", "até", "ate", "entre", "sobre", "isso", "esse", "essa", "este",
  "esta", "ele", "ela", "eles", "elas", "seu", "sua", "seus", "suas", "não", "nao", "já", "ja", "também",
  "tambem", "ainda", "outro", "outra", "todo", "toda", "novo", "nova", "novos", "novas", "quase",
  "apenas", "mesmo", "mesma", "pela", "pelo", "pelas", "pelos", "ao", "aos", "à", "às", "é", "são",
  "foi", "ser", "tem", "têm", "há", "ha", "veja", "entenda", "saiba", "porque", "assim",
  "agora", "hoje", "ontem", "amanhã", "presidente", "empresa", "estudo", "pesquisa", "investigação",
  "monitoramento", "maioria", "metade", "parte", "governo", "brasil", "eua", "maior", "menor",
  // EN
  "the", "an", "and", "or", "of", "in", "on", "at", "to", "for", "with", "by", "from", "as", "is",
  "are", "was", "were", "it", "its", "this", "that", "these", "those", "new", "how", "why", "what",
  "who", "when", "after", "before", "about", "into", "over", "more", "most", "but", "not", "now",
  "here", "there", "today", "also", "inc", "ceo",
  // domínio
  "ia", "ai", "ias", "ais", "llm", "llms", "inteligência", "inteligencia", "artificial", "intelligence",
  // dias/meses
  ...MONTHS.split("|"),
  "segunda", "terça", "terca", "quarta", "quinta", "sexta", "sábado", "sabado", "domingo",
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
]);

/**
 * Entidades prováveis (nomes próprios/siglas) de um texto: tokens com letra
 * maiúscula (inicial ou interna — "VigIA", "OpenAI"), ≥3 caracteres, fora
 * da stoplist. Minúsculas, para comparação via `containsWholeWord`.
 */
export function extractDemotionEntities(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of prepare(text).matchAll(/[\p{L}][\p{L}\p{N}]*/gu)) {
    const w = m[0];
    if (w.length < 3) continue;
    if (!/\p{Lu}/u.test(w)) continue;
    const lower = w.toLowerCase();
    if (ENTITY_STOPWORDS.has(lower)) continue;
    out.add(lower);
  }
  return out;
}

export interface DemotionCandidate {
  url: string;
  title: string;
  /** Resumo + texto factual extra (ex: `summary_rejected`). */
  text: string;
}

/**
 * Casa um candidato contra os D1–D3 recentes. Devolve o match da edição mais
 * recente (URL idêntica vence entidade+números) ou null.
 */
export function findSameFactDemotionMatch(
  cand: DemotionCandidate,
  past: PublishedDestaque[],
): SameFactDemotionMatch | null {
  const sorted = [...past].sort((a, b) => b.aammdd.localeCompare(a.aammdd) || a.n - b.n);
  const candUrl = cand.url ? canonicalize(cand.url) : "";
  for (const p of sorted) {
    if (candUrl && p.url && canonicalize(p.url) === candUrl) {
      return {
        matched_edition: p.aammdd,
        matched_destaque: p.n,
        matched_title: p.title,
        matched_url: p.url,
        evidence: "url",
        shared_entities: [],
        shared_numbers: [],
      };
    }
  }
  const candText = `${cand.title}\n${cand.text}`;
  const candNumbers = extractDemotionNumbers(candText);
  if (candNumbers.size < DEMOTION_MIN_SHARED_NUMBERS) return null;
  const candHay = prepare(candText).toLowerCase();
  for (const p of sorted) {
    const pastText = `${p.title}\n${p.text}`;
    const sharedNumbers = [...extractDemotionNumbers(pastText)].filter((x) => candNumbers.has(x));
    if (sharedNumbers.length < DEMOTION_MIN_SHARED_NUMBERS) continue;
    const sharedEntities = [...extractDemotionEntities(pastText)].filter((e) => containsWholeWord(candHay, e));
    if (sharedEntities.length === 0) continue;
    return {
      matched_edition: p.aammdd,
      matched_destaque: p.n,
      matched_title: p.title,
      matched_url: p.url,
      evidence: "entity+numbers",
      shared_entities: sharedEntities.sort(),
      shared_numbers: sharedNumbers.sort(),
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Reordenação dos highlights
// ---------------------------------------------------------------------------

export interface DemotableHighlight extends HighlightLike {
  rank?: number;
}

export interface SameFactDemotion {
  url: string;
  title: string;
  bucket?: string;
  from_rank: number;
  to_rank: number;
  match: SameFactDemotionMatch;
}

export interface SameFactKept {
  url: string;
  title: string;
  rank: number;
  reason: string;
  match: SameFactDemotionMatch;
}

export interface SameFactDemotionResult<H extends DemotableHighlight> {
  highlights: H[];
  demoted: SameFactDemotion[];
  /** Repetições detectadas que ficaram no top-3 (sem substituto válido). */
  kept: SameFactKept[];
}

function urlOf(h: DemotableHighlight): string {
  const u = h.url ?? h.article?.url;
  return typeof u === "string" ? u : "";
}

function titleOf(h: DemotableHighlight): string {
  const t = (h.article as { title?: unknown } | undefined)?.title ?? (h as { title?: unknown }).title;
  return typeof t === "string" ? t : "";
}

export function candidateOf(h: DemotableHighlight): DemotionCandidate {
  const a = (h.article ?? {}) as Record<string, unknown>;
  const parts = [a.summary, a.summary_rejected, (h as Record<string, unknown>).summary]
    .filter((x): x is string => typeof x === "string" && x.trim().length > 0);
  return { url: urlOf(h), title: titleOf(h), text: parts.join("\n") };
}

/**
 * Rebaixa do top-3 os destaques que repetem fato recente. Ordem nova: os
 * limpos na ordem original, depois os repetidos (que continuam em
 * `highlights` com rank 4+, e portanto no pool). Ranks são renumerados.
 *
 * Invariante #3916: se o top-3 original tinha destaque de impacto negativo e
 * o novo não tem, o melhor negativo limpo sobe para a 3ª vaga; sem negativo
 * limpo, o repetido negativo fica no top-3 (só aviso, `kept`).
 * Com menos de 3 limpos, os repetidos completam o top-3 (`kept`).
 *
 * Puro: não muta `highlights`.
 */
export function demoteSameFactHighlights<H extends DemotableHighlight>(
  highlights: H[],
  past: PublishedDestaque[],
  topN = 3,
): SameFactDemotionResult<H> {
  const ordered = [...highlights].sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
  const matches = new Map<H, SameFactDemotionMatch>();
  for (const h of ordered) {
    const m = findSameFactDemotionMatch(candidateOf(h), past);
    if (m) matches.set(h, m);
  }
  // Nada repetido no top-N → nada a fazer (repetido fora do top-N já está fora).
  const topBefore = ordered.slice(0, topN);
  if (!topBefore.some((h) => matches.has(h))) {
    return { highlights: highlights.slice(), demoted: [], kept: [] };
  }

  const clean = ordered.filter((h) => !matches.has(h));
  const repeated = ordered.filter((h) => matches.has(h));
  let next = [...clean, ...repeated];
  const keptSet = new Set<H>();

  // #3916: preservar ≥1 negativo no top-N quando havia.
  if (topBefore.some(hasNegativeImpactTag) && !next.slice(0, topN).some(hasNegativeImpactTag)) {
    const cleanNeg = clean.find((h, i) => i >= topN && hasNegativeImpactTag(h));
    if (cleanNeg) {
      const rest = next.filter((h) => h !== cleanNeg);
      next = [...rest.slice(0, topN - 1), cleanNeg, ...rest.slice(topN - 1)];
    } else {
      const negRepeated = topBefore.find((h) => matches.has(h) && hasNegativeImpactTag(h));
      if (negRepeated) {
        const rest = next.filter((h) => h !== negRepeated);
        const at = Math.min(topBefore.indexOf(negRepeated), topN - 1);
        next = [...rest.slice(0, at), negRepeated, ...rest.slice(at)];
        keptSet.add(negRepeated);
      }
    }
  }

  const newHighlights = next.map((h, i) => ({ ...h, rank: i + 1 }));
  const demoted: SameFactDemotion[] = [];
  const kept: SameFactKept[] = [];
  next.forEach((h, i) => {
    const m = matches.get(h);
    if (!m) return;
    const fromIdx = ordered.indexOf(h);
    if (fromIdx >= topN) return; // já estava fora do top-N
    if (i < topN) {
      kept.push({
        url: urlOf(h),
        title: titleOf(h),
        rank: i + 1,
        reason: keptSet.has(h)
          ? "único destaque de impacto negativo sem substituto limpo (#3916) — mantido, só aviso"
          : "candidatos limpos insuficientes para completar o top-3 — mantido, só aviso",
        match: m,
      });
      return;
    }
    demoted.push({
      url: urlOf(h),
      title: titleOf(h),
      ...(typeof h.bucket === "string" ? { bucket: h.bucket } : {}),
      from_rank: fromIdx + 1,
      to_rank: i + 1,
      match: m,
    });
    newHighlights[i] = {
      ...newHighlights[i],
      same_fact_demoted: {
        matched_edition: m.matched_edition,
        matched_destaque: m.matched_destaque,
        matched_title: m.matched_title,
        evidence: m.evidence,
      },
    };
  });
  return { highlights: newHighlights as H[], demoted, kept };
}

/** Linha de aviso (gate 4 / relatório do Stage 1) para um rebaixamento. */
export function formatDemotionNote(d: SameFactDemotion): string {
  const why = d.match.evidence === "url"
    ? "mesma URL"
    : `entidade: ${d.match.shared_entities.join(", ")}; números: ${d.match.shared_numbers.join(", ")}`;
  return (
    `⬇️ MESMO FATO — "${d.title}" rebaixado de D${d.from_rank} (ficou no pool${d.bucket ? `, ${d.bucket}` : ""}): ` +
    `repete o D${d.match.matched_destaque} de ${d.match.matched_edition} "${d.match.matched_title}" (${why}). ` +
    `Promova de volta se for ângulo novo.`
  );
}
