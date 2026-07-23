/**
 * negative-impact-promotion.ts (#3916, #3918)
 *
 * Backstop determinístico pra regra editorial "sempre ≥1 destaque de impacto
 * NEGATIVO da IA" (context/editorial-rules.md — Destaques). `scorer-select.md`
 * já instrui o agent (Opus) a promover o melhor finalista `negative_impact:true`
 * quando os 6 escolhidos por mérito não incluem nenhum — mas por ser
 * julgamento de LLM, não é garantido (#573: nunca confiar só no prompt).
 *
 * `ensureNegativeImpactHighlight` é uma função PURA que reproduz essa mesma
 * decisão deterministicamente a partir de `finalists` (que carrega
 * `article.negative_impact` desde o merge dos chunks, ver
 * `merge-scored-chunks.ts`). Chamada por `assemble-scored.ts` DEPOIS da
 * seleção do agent — só age quando o agent não documentou promoção nenhuma
 * (`negative_impact_promoted` ausente) E os 6 highlights de fato não têm a
 * tag. Idempotente: se o agent já cumpriu a regra, esta função é um no-op.
 *
 * Regra de swap: nunca demove o destaque de MAIOR score (D1 do dia) — sempre
 * troca o de MENOR score dentre os já selecionados. Nunca promove um
 * candidato que já está entre os highlights (evita duplicata).
 */

export interface FinalistLike {
  url: string;
  score: number;
  bucket?: string;
  article?: (Record<string, unknown> & { negative_impact?: boolean; url?: string }) | undefined;
}

export interface HighlightLike {
  rank?: number;
  score?: number;
  bucket?: string;
  reason?: string;
  url?: string;
  negative_impact?: boolean;
  article?: (Record<string, unknown> & { negative_impact?: boolean; url?: string }) | undefined;
  [key: string]: unknown;
}

export interface NegativeImpactPromotion {
  promoted_url: string;
  demoted_url: string;
  reason: string;
}

export interface NegativeImpactSwapResult<H extends HighlightLike = HighlightLike> {
  highlights: H[];
  promotion?: NegativeImpactPromotion;
}

/** True se o highlight (flat ou nested em .article) está tagueado negative_impact:true. */
export function hasNegativeImpactTag(h: HighlightLike): boolean {
  if (h.negative_impact === true) return true;
  if (h.article?.negative_impact === true) return true;
  return false;
}

function urlOf(h: { url?: string; article?: { url?: string } }): string | undefined {
  return h.url ?? h.article?.url;
}

/**
 * Garante que `highlights` tem ≥1 item com `negative_impact:true`, promovendo
 * do pool de `finalists` quando necessário. Puro — não muta os argumentos.
 *
 * @param highlights Os N destaques já selecionados (por mérito, ordem editorial).
 * @param finalists  O pool de finalistas (~15) do merge dos chunks, com `article`
 *                   completo — de onde vem o candidato a promover.
 */
export function ensureNegativeImpactHighlight<H extends HighlightLike>(
  highlights: H[],
  finalists: FinalistLike[],
): NegativeImpactSwapResult<H> {
  if (highlights.length === 0) return { highlights };
  if (highlights.some(hasNegativeImpactTag)) return { highlights };

  const highlightUrls = new Set(
    highlights.map(urlOf).filter((u): u is string => typeof u === "string"),
  );

  // Melhor finalista tagueado, fora dos já escolhidos, por maior score.
  const candidate = finalists
    .filter((f) => f.article?.negative_impact === true && !highlightUrls.has(f.url))
    .sort((a, b) => b.score - a.score)[0];

  if (!candidate) {
    // Pool sem candidato digno — caso legítimo (#3918), nada a promover.
    // O invariant-check (has-negative-impact-highlight) avisa no gate.
    return { highlights };
  }

  // Nunca demove o de MAIOR score (D1 do dia) — troca sempre o de MENOR score.
  let demoteIdx = 0;
  for (let i = 1; i < highlights.length; i++) {
    const cur = highlights[i].score ?? -Infinity;
    const min = highlights[demoteIdx].score ?? -Infinity;
    if (cur < min) demoteIdx = i;
  }
  const demoted = highlights[demoteIdx];
  const demotedUrl = urlOf(demoted) ?? "(desconhecida)";

  const promoted: H = {
    ...demoted,
    score: candidate.score,
    bucket: candidate.bucket,
    article: candidate.article,
    url: candidate.url,
    reason:
      "Promovido automaticamente (#3916/#3918): nenhum dos destaques selecionados por mérito " +
      "tinha negative_impact:true — backstop determinístico de assemble-scored.ts.",
  };

  const nextHighlights = highlights.slice();
  nextHighlights[demoteIdx] = promoted;

  return {
    highlights: nextHighlights,
    promotion: {
      promoted_url: candidate.url,
      demoted_url: demotedUrl,
      reason:
        "nenhum dos destaques selecionados por mérito tinha negative_impact:true; promovido " +
        "automaticamente o melhor finalista tagueado (backstop determinístico, #3916/#3918)",
    },
  };
}
