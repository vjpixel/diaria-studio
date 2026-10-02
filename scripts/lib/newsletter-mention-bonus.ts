/**
 * newsletter-mention-bonus.ts (#9365, causa 2)
 *
 * Bônus de score determinístico por menção em newsletter recebida: o editor
 * inclui à mão justamente o que viu nas newsletters de IA que assina, e ser
 * citado em uma ou mais delas não pesava no score (31% das inclusões manuais
 * medidas na #9365 chegaram ao pool e perderam no ranking).
 *
 * Decisão do editor (01/10/2026, /diaria-develop 261001b, registrada na
 * #9365): **+5 por newsletter DISTINTA que cita o item, teto +15**.
 *
 * "Newsletter distinta" = remetente distinto (e-mail do `From`, minúsculo).
 * Duas edições da mesma newsletter citando a mesma URL contam 1 vez.
 *
 * Fluxo do dado:
 *   capture-newsletter-urls.ts grava `newsletter_mentions[]` (remetentes) por
 *   artigo em `captured-newsletter-articles.json` → inject-inbox-urls.ts
 *   carrega o campo pro pool (inclusive anotando artigo que a pesquisa já
 *   tinha trazido com a mesma URL) → toClusterSource preserva o campo nos
 *   perdedores de cluster same-story → merge-scored-chunks.ts soma o bônus
 *   (união do artigo + cluster_sources) antes da seleção de finalistas, no
 *   mesmo ponto do `coverage-bonus.ts` (#3920).
 *
 * Aplicado em TS, nunca pelo rubrico do scorer LLM; auditável via
 * `score_bonus_newsletter` e a entrada `newsletter:+N` em `bonuses_applied`.
 */

/** Pontos por newsletter distinta que cita o item. */
export const NEWSLETTER_MENTION_BONUS_PER = 5;

/** Teto do bônus de menção em newsletter. */
export const NEWSLETTER_MENTION_BONUS_CAP = 15;

/** Normaliza um identificador de newsletter (e-mail do remetente). */
function normalizeMention(m: unknown): string | null {
  if (typeof m !== "string") return null;
  const v = m.trim().toLowerCase();
  return v ? v : null;
}

/**
 * União ordenada (ordem de primeira aparição) e sem duplicatas de listas de
 * menções. Entradas não-string/vazias são ignoradas (defensivo: o campo vem
 * de JSON em disco).
 */
export function unionNewsletterMentions(...lists: unknown[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const raw of list) {
      const m = normalizeMention(raw);
      if (m === null || seen.has(m)) continue;
      seen.add(m);
      out.push(m);
    }
  }
  return out;
}

/**
 * Todas as newsletters distintas que citam o artigo: as do próprio artigo e
 * as dos perdedores do cluster same-story (`cluster_sources[]`) — a mesma
 * história citada por URL diferente conta pra quem venceu o cluster.
 */
export function articleNewsletterMentions(articleObj: object): string[] {
  const article = articleObj as { newsletter_mentions?: unknown; cluster_sources?: unknown };
  const clusterLists = Array.isArray(article.cluster_sources)
    ? article.cluster_sources.map((c) =>
        c && typeof c === "object" ? (c as { newsletter_mentions?: unknown }).newsletter_mentions : undefined,
      )
    : [];
  return unionNewsletterMentions(article.newsletter_mentions, ...clusterLists);
}

/** Bônus para `distinctCount` newsletters distintas: +5 cada, teto +15. */
export function newsletterMentionBonus(distinctCount: number): number {
  if (!Number.isFinite(distinctCount) || distinctCount <= 0) return 0;
  return Math.min(Math.floor(distinctCount) * NEWSLETTER_MENTION_BONUS_PER, NEWSLETTER_MENTION_BONUS_CAP);
}
