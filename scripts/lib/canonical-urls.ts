/**
 * canonical-urls.ts (#1456)
 *
 * Helper pra lookup de URL canonical a partir do `01-approved.json` da edição,
 * pra evitar que edições manuais de `02-reviewed.md` (top-level Claude,
 * orchestrator durante dedup cleanup, etc.) introduzam URLs hallucinadas.
 *
 * Caso real 260522: durante dedup cleanup eu (top-level Claude) movi
 * Hassabis Nobel pra OUTRAS NOTÍCIAS e, ao reescrever o item no MD, re-derivei
 * URL/título de cabeça em vez de copiar do JSON canonical. Resultado: 404 no
 * link da Guardian (URL real era sobre Jack Clark da Anthropic, não Hassabis).
 *
 * Uso típico no orchestrator/top-level antes de editar manualmente:
 *
 *   const map = getCanonicalUrls(approvedJson);
 *   const url = lookupByTitle(map, "Hassabis aposta...");
 *   if (!url) throw new Error("título não está no approved JSON — fonte desconhecida");
 *
 * Helpers complementares:
 * - `extractUrlsFromMd`: lista URLs presentes no MD final (incluindo body)
 * - `findMismatchedUrls`: dado um MD pós-edit e o JSON canonical, lista URLs
 *   no MD que NÃO aparecem em nenhum bucket — candidates pra verificação.
 */

import { normalizeTitle } from "../dedup.ts";

interface ArticleLike {
  url?: string;
  title?: string;
  article?: { url?: string; title?: string };
}

interface ApprovedJsonShape {
  highlights?: ArticleLike[];
  runners_up?: ArticleLike[];
  lancamento?: ArticleLike[];
  pesquisa?: ArticleLike[];
  noticias?: ArticleLike[];
  tutorial?: ArticleLike[];
  video?: ArticleLike[];
}

/**
 * Pure: extrai (title → url) de todos os artigos no approved JSON.
 * Inclui highlights (article.url), runners_up, e todos os buckets secundários.
 *
 * Múltiplos titles podem mapear pra mesma URL (artigos duplicados entre buckets);
 * a primeira URL encontrada vence — ordem de iteração: highlights, runners_up,
 * buckets.
 */
export function getCanonicalUrls(approved: ApprovedJsonShape): Map<string, string> {
  const map = new Map<string, string>();
  const addEntry = (title: string | undefined, url: string | undefined) => {
    if (!title || !url) return;
    const key = normalizeTitle(title);
    if (!key) return;
    if (!map.has(key)) map.set(key, url);
  };

  for (const h of approved.highlights ?? []) {
    addEntry(h.article?.title, h.article?.url);
    addEntry(h.title, h.url);
  }
  for (const r of approved.runners_up ?? []) {
    addEntry(r.article?.title, r.article?.url);
    addEntry(r.title, r.url);
  }
  for (const bucket of ["lancamento", "pesquisa", "noticias", "tutorial", "video"] as const) {
    for (const a of approved[bucket] ?? []) {
      addEntry(a.title, a.url);
    }
  }
  return map;
}

/**
 * Pure: dado um título arbitrário (pós-edit do MD), busca URL canonical no
 * mapa via fuzzy match (normalize → exact match). Retorna `undefined` se não
 * houver match — caller decide se fail-fast ou flagga.
 */
export function lookupCanonicalUrl(
  map: Map<string, string>,
  title: string,
): string | undefined {
  const key = normalizeTitle(title);
  return key ? map.get(key) : undefined;
}

/**
 * Pure: extrai todas as URLs `[...](url)` de um MD. Ignora URLs em
 * frontmatter YAML (se houver) e blocos de código.
 */
export function extractUrlsFromMd(md: string): string[] {
  // Strip frontmatter
  const body = md.replace(/^---\s*\n[\s\S]*?\n---\s*\n/, "");
  // Strip code blocks (```...```)
  const noCode = body.replace(/```[\s\S]*?```/g, "");
  const urls: string[] = [];
  const re = /\[(?:[^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(noCode)) !== null) {
    urls.push(m[1]);
  }
  return urls;
}

/**
 * Pure: lista URLs no MD que NÃO aparecem como valor em nenhum bucket do
 * approved JSON. Indica edição manual que adicionou URL nova — caller deve
 * verificar acessibilidade.
 *
 * Footer/affiliate URLs (diaria.beehiiv.com, wisprflow, clarice.ai, etc.)
 * são puladas — sempre são adicionadas em runtime fora do approved.
 */
const FOOTER_DOMAINS = [
  "diaria.beehiiv.com",
  "wisprflow.ai",
  "clarice.ai",
  "beehiiv.com?via",
  "linkedin.com/company",
  "facebook.com/diar.ia",
  "pt.wikipedia.org",
  "commons.wikimedia.org",
  "creativecommons.org",
  "wikidata.org",
];

export function findMismatchedUrls(
  md: string,
  approved: ApprovedJsonShape,
): string[] {
  const mdUrls = new Set(extractUrlsFromMd(md));
  const approvedUrls = new Set<string>();
  const addUrl = (u: string | undefined) => {
    if (u) approvedUrls.add(u);
  };
  for (const h of approved.highlights ?? []) {
    addUrl(h.article?.url);
    addUrl(h.url);
  }
  for (const r of approved.runners_up ?? []) {
    addUrl(r.article?.url);
    addUrl(r.url);
  }
  for (const bucket of ["lancamento", "pesquisa", "noticias", "tutorial", "video"] as const) {
    for (const a of approved[bucket] ?? []) {
      addUrl(a.url);
    }
  }
  const mismatched: string[] = [];
  for (const url of mdUrls) {
    if (FOOTER_DOMAINS.some((d) => url.includes(d))) continue;
    if (!approvedUrls.has(url)) mismatched.push(url);
  }
  return mismatched;
}

