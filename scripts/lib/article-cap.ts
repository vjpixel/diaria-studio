/**
 * article-cap.ts (#891 / #944 review)
 *
 * Helpers compartilhados entre `fetch-rss.ts` e `fetch-sitemap.ts` pra cap
 * por source — evita payload bloat no orchestrator. Mora em `lib/` pra
 * preservar layering: scripts/* podem importar de lib/, lib/ não importa
 * de scripts/* (regra de unidirectional dependency).
 *
 * Article interface vive aqui pra ser single source of truth — antes
 * estava duplicada em fetch-rss.ts e lib/fetch-sitemap.ts.
 */

export interface Article {
  url: string;
  title: string;
  published_at: string | null;
  summary: string;
}

/**
 * #891: cap por source pra evitar payload bloat no orchestrator. arXiv
 * sozinho devolveu 229 artigos em 260507 (158K bytes só do articles[]).
 * Cap 30 cobre ~95% das fontes (CNN 47, Canaltech 50, arXiv 229 são as
 * únicas acima); reduz ~57% do payload total Stage 1.
 *
 * Articles ordenados por published_at desc antes do slice — pegamos os
 * mais recentes. published_at null vai pro fim (provavelmente antigos).
 */
export const MAX_ARTICLES_PER_SOURCE = 30;

export function capArticles(articles: Article[]): { capped: Article[]; truncated: number } {
  if (articles.length <= MAX_ARTICLES_PER_SOURCE) {
    return { capped: articles, truncated: 0 };
  }
  const sorted = [...articles].sort((a, b) => {
    if (!a.published_at && !b.published_at) return 0;
    if (!a.published_at) return 1;
    if (!b.published_at) return -1;
    return b.published_at.localeCompare(a.published_at);
  });
  return {
    capped: sorted.slice(0, MAX_ARTICLES_PER_SOURCE),
    truncated: articles.length - MAX_ARTICLES_PER_SOURCE,
  };
}
