/** #10795: restrições da promoção negativa; puro, aplicado após os swaps do Stage 1. */
import { hasNegativeImpactTag, type HighlightLike } from './negative-impact-promotion.ts';
import { candidateOf, extractDemotionEntities, findSameFactDemotionMatch, type PublishedDestaque } from './same-fact-demotion.ts';
import { cutoffAammdd, containsWholeWord, themeFactTokens } from './past-editions-extract.ts';

export function applyNegativeHighlightPolicy<H extends HighlightLike>(highlights: H[], past: PublishedDestaque[], edition: string): { highlights: H[]; notes: string[] } {
  const cutoff = cutoffAammdd(edition, 14);
  const recent = past.filter(p => cutoff && p.aammdd >= cutoff && p.aammdd < edition);
  const notes: string[] = [];
  const excluded = new Set<H>();
  for (const h of highlights) {
    if (!hasNegativeImpactTag(h)) continue;
    const c = candidateOf(h);
    // A classificação semântica completa é feita no scoring; aqui só evidência explícita no título.
    const allegation = /\b(processo|acusa[çc][aã]o|acusad[oa]s?|lawsuit|sued|allegations?)\b/iu.test(c.title)
      || (/deepfake/iu.test(c.title) && /checagem|fact.check|desmente|verifica/iu.test(c.title));
    const repeated = findSameFactDemotionMatch(c, recent) || recent.some(p => {
      const entities = extractDemotionEntities([p.title, p.source_title ?? ''], p.text);
      const hay = `${c.title} ${c.text}`.toLowerCase();
      if (![...entities].some(entity => containsWholeWord(hay, entity))) return false;
      const entityTokens = themeFactTokens([...entities].join(' '));
      const oldTokens = themeFactTokens(`${p.title} ${p.source_title ?? ''} ${p.text}`);
      return [...themeFactTokens(hay)].some(token => oldTokens.has(token) && !entityTokens.has(token) && !/^\d/.test(token));
    });
    if (allegation || repeated) {
      excluded.add(h);
      notes.push(`#10795: excluído da promoção negativa: ${c.title} (${allegation ? 'acusação/processo/checagem' : 'entidade+tema nos últimos 14 dias'}).`);
    }
  }
  const eligible = highlights.filter(h => !excluded.has(h));
  const next = [...eligible, ...highlights.filter(h => excluded.has(h))];
  const meritThird = [...eligible].sort((a,b) => (b.score ?? 0) - (a.score ?? 0))[2]?.score;
  if (!next.slice(0,3).some(h => !excluded.has(h) && hasNegativeImpactTag(h))) {
    const neg = eligible.filter(hasNegativeImpactTag).sort((a,b) => (b.score ?? 0) - (a.score ?? 0))[0];
    if (neg) {
      next.splice(next.indexOf(neg), 1);
      next.splice(Math.min(2, next.length), 0, neg);
    } else notes.push('#10795/#3916: pool sem negativo elegível; revisão do editor no gate (warning).');
  }
  const negative = next.slice(0,3).find(h => !excluded.has(h) && hasNegativeImpactTag(h));
  if (negative && next.length >= 3 && meritThird !== undefined && meritThird - (negative.score ?? 0) > 15) {
    next.splice(next.indexOf(negative), 1);
    next.splice(2, 0, negative);
    notes.push(`#10795: negativo promovido entra como D3 (diferença ${meritThird - (negative.score ?? 0)} pontos).`);
  }
  return { highlights: next.map((h,i) => ({...h, rank: i+1})), notes };
}
