/**
 * placeholder-dedup-title.ts (#10641)
 *
 * Título SUBSTITUTO, só para comparação no dedup, de artigo cujo título ainda é
 * placeholder (`(newsletter:{sender})`, `(inbox)`, vazio — ver
 * `isPlaceholderHighlightTitle`).
 *
 * Caso real (edição 261021): o link do TechCrunch "Anthropic says its workforce
 * has become less junior..." entrou pelo inbox (extraído da newsletter 7min.ai)
 * com `title: "(newsletter:\"7min.ai\")"`. O `enrich-inbox-articles.ts` não
 * conseguiu o og:title (TechCrunch bloqueia o GET; o verify só passou por
 * "browser fallback"), então o item chegou ao `dedup.ts` com o placeholder.
 * Os passes que comparam título contra edições passadas (1b headline, 1c
 * subject-Jaccard) compararam o PLACEHOLDER — que não casa com nada — e o item
 * passou, embora a MESMA URL estivesse no pool da 261019 com o título real
 * (match de 100% quando o editor rodou o dedup à mão sobre a edição final, já
 * com o título real que o writer resolveu no Stage 2).
 *
 * Duas fontes, nesta ordem:
 * 1. Título real que a MESMA URL (canônica) teve no `01-approved.json` de uma
 *    edição recente — evidência direta, nada inferido.
 * 2. Título derivado do slug da URL (`/2026/10/17/anthropic-says-its-...`),
 *    quando o slug tem palavras suficientes para descrever o assunto
 *    (`MIN_SLUG_TOKENS` tokens que o Jaccard considera, i.e. ≥3 chars).
 *    Slug curto/numérico (`/p/123`, `/news261017`) não vira título.
 *
 * Nunca altera o título exibido — o substituto existe só para a comparação.
 */

import { canonicalize } from "./url-utils.ts";
import { isPlaceholderHighlightTitle } from "./placeholder-title-guard.ts";
import { tokenizeForJaccard } from "./title-similarity.ts";

/** Mínimo de tokens (≥3 chars, mesma regra do Jaccard) para um slug valer
 * como título. Abaixo disso o Jaccard fica instável (2 tokens em comum já
 * dariam ≥0,6 contra um título curto). */
export const MIN_SLUG_TOKENS = 5;

/**
 * Deriva um título do segmento de path mais "verboso" da URL (o que tem mais
 * palavras separadas por `-`/`_`). Retorna null se nenhum segmento tem
 * `MIN_SLUG_TOKENS` tokens significativos.
 */
export function slugTitleFromUrl(url: string): string | null {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return null;
  }
  let best: string | null = null;
  let bestTokens = 0;
  for (const raw of pathname.split("/")) {
    let seg: string;
    try {
      seg = decodeURIComponent(raw);
    } catch {
      seg = raw;
    }
    seg = seg.replace(/\.[a-z0-9]{1,6}$/i, ""); // .html, .ghtml, .php
    const words = seg
      .split(/[-_+]+/)
      .map((w) => w.trim())
      .filter((w) => w.length > 0 && !/^\d+$/.test(w));
    if (words.length < 2) continue;
    const candidate = words.join(" ");
    const n = tokenizeForJaccard(candidate).size;
    if (n > bestTokens) {
      best = candidate;
      bestTokens = n;
    }
  }
  return bestTokens >= MIN_SLUG_TOKENS ? best : null;
}

export type DedupTitleSource = "title" | "past-url" | "slug" | "placeholder";

/**
 * Título a usar nas comparações do dedup contra edições passadas.
 * `pastTitleByUrl` é indexado pela URL canônica (`canonicalize`).
 */
export function dedupComparisonTitle(
  art: { url: string; title?: string },
  pastTitleByUrl: Map<string, string>,
): { title: string | undefined; source: DedupTitleSource } {
  if (!isPlaceholderHighlightTitle(art.title)) return { title: art.title, source: "title" };
  const fromPast = pastTitleByUrl.get(canonicalize(art.url));
  if (fromPast && !isPlaceholderHighlightTitle(fromPast)) return { title: fromPast, source: "past-url" };
  const fromSlug = slugTitleFromUrl(art.url);
  if (fromSlug) return { title: fromSlug, source: "slug" };
  return { title: art.title, source: "placeholder" };
}

/** Sufixo legível para o `dedup_note` quando a comparação usou substituto. */
export function proxyNote(source: DedupTitleSource): string {
  if (source === "past-url") return " [título placeholder; comparado pelo título da mesma URL em edição recente, #10641]";
  if (source === "slug") return " [título placeholder; comparado pelo slug da URL, #10641]";
  return "";
}
