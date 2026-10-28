/**
 * story-twice-in-edition.ts (#11496)
 *
 * A MESMA HISTÓRIA duas vezes na edição FINAL (`02-reviewed.md`), com URL e
 * título diferentes. Roda no Stage 4, depois de qualquer troca no gate
 * (`swap-destaque.ts`, `promote-to-destaque.ts`, edição manual), que mexe nos
 * destaques sem rodar de novo o dedup do Stage 1. Dois casos reais da edição
 * 261029:
 *
 *   - Genie 4 em D2 (deepmind.google) e em LANÇAMENTOS (blog.google): mesma
 *     história dentro da edição. Sinais de `isIntraEditionDuplicate`
 *     (dedup-intra-edition.ts), os mesmos do Stage 1.
 *   - Siri em português demovida de D3 para o RADAR, repetindo o D2 de 261028:
 *     mesma história de uma edição recente. Sinal de MESMO FATO por
 *     produto+versão no TÍTULO (`findSameFactMatches`, #9100), contra o que de
 *     fato saiu nas últimas edições (o `02-reviewed.md` delas, não o
 *     `01-approved.json`, que não reflete as trocas do gate).
 *
 * Pure, sem I/O: quem lê os arquivos é a invariante `story-twice-in-edition`
 * (`invariant-checks/stage-4.ts`). Só sinaliza; o editor decide no gate 4 se é
 * desdobramento ou corte.
 */

import { isIntraEditionDuplicate } from "../dedup-intra-edition.ts";
import { findSameFactMatches, extractVersionedProducts, extractProductVariants } from "./same-fact-check.ts";
import { canonicalize } from "./url-utils.ts";

export interface StoryItem {
  /** "D1".."D3" para destaque; nome da seção para item do pool. */
  label: string;
  title: string;
  url: string;
  summary?: string;
}

export interface PastStoryItem extends StoryItem {
  aammdd: string;
  /** Destaque da edição passada? (senão, item de seção). */
  highlight: boolean;
}

export interface StoryTwiceWarning {
  scope: "edition" | "past";
  item_label: string;
  item_title: string;
  item_url: string;
  matched_label: string;
  matched_title: string;
  matched_url?: string;
  /** Só em `scope: "past"`. */
  matched_edition?: string;
  /** Sinal que casou: match_type do dedup intra ou `produto: ios 27.2`. */
  signal: string;
}

/**
 * Seções fora da comparação: tutorial (USE MELHOR), vídeo e pesquisa sobre um
 * lançamento são formato deliberado, não a mesma notícia repetida. Medido no
 * acervo (136 edições): incluídas, elas respondiam por metade dos avisos
 * ("Prompting Claude Opus 5" × D1 "Anthropic lança o Claude Opus 5").
 */
export const STORY_TWICE_EXCLUDED_SECTION_RE = /USE MELHOR|V[IÍ]DEO|PESQUISA/i;

/**
 * Compara (1) cada destaque com os destaques anteriores, (2) cada item do
 * pool com os destaques e (3) cada item da edição com os DESTAQUES publicados
 * nas edições passadas (só produto+versão no título — alta precisão; item de
 * seção passado fica de fora porque "Gemini 3.8" em dois LANÇAMENTOS seguidos
 * é, no acervo, quase sempre outro anúncio da mesma família). No máximo 1
 * aviso por item, o da própria edição antes do da edição passada.
 */
/**
 * Mesmo produto+versão nos TÍTULOS de dois itens da mesma edição, sem segundo
 * sinal. No Stage 1 a versão sozinha não remove nada (review da PR #9430:
 * "GPT-6.1 banido" × "GPT-6.1 ganha voz"), mas na edição final o writer já
 * reescreveu o destaque em português e os sinais de vocabulário somem: caso
 * 261029, D2 "Genie 4 cria mundos que você comanda por texto" × LANÇAMENTO
 * "We’re announcing Genie 4, our new world model…" não dividem nenhuma palavra
 * além de "Genie 4". Aqui o resultado é só aviso, então a versão basta.
 * Variantes nomeadas diferentes ("GPT-6.1 Sol" × "GPT-6.1 Astra") não casam.
 */
function sharedVersionedProduct(
  item: StoryItem,
  against: StoryItem[],
): { match_type: string; matched_highlight: string } | null {
  const mine = extractVersionedProducts(item.title);
  if (mine.size === 0) return null;
  const myVariants = extractProductVariants(item.title);
  for (const h of against) {
    if (canonicalize(h.url) === canonicalize(item.url)) continue;
    const theirs = extractVersionedProducts(h.title);
    const theirVariants = extractProductVariants(h.title);
    const shared = [...mine].filter((p) => {
      if (!theirs.has(p)) return false;
      const a = myVariants.get(p);
      const b = theirVariants.get(p);
      return !(a !== undefined && b !== undefined && a !== b);
    });
    if (shared.length > 0) return { match_type: `produto: ${shared.join(", ")}`, matched_highlight: h.title };
  }
  return null;
}

export function findStoryTwice(
  highlights: StoryItem[],
  pool: StoryItem[],
  past: PastStoryItem[] = [],
): StoryTwiceWarning[] {
  const warnings: StoryTwiceWarning[] = [];
  const warned = new Set<string>();
  pool = pool.filter((it) => !STORY_TWICE_EXCLUDED_SECTION_RE.test(it.label));
  past = past.filter((p) => p.highlight);
  const hlByTitle = new Map(highlights.map((h) => [h.title, h]));
  const hlUrls = new Set(highlights.map((h) => canonicalize(h.url)));

  const intra = (item: StoryItem, against: StoryItem[]): void => {
    if (against.length === 0) return;
    const m = isIntraEditionDuplicate(
      { url: item.url, title: item.title, summary: item.summary },
      against.map((h) => ({ url: h.url, title: h.title, summary: h.summary })),
    ) ?? sharedVersionedProduct(item, against);
    if (!m) return;
    const other = hlByTitle.get(m.matched_highlight);
    warnings.push({
      scope: "edition",
      item_label: item.label,
      item_title: item.title,
      item_url: item.url,
      matched_label: other?.label ?? "destaque",
      matched_title: m.matched_highlight,
      ...(other ? { matched_url: other.url } : {}),
      signal: m.match_type,
    });
    warned.add(canonicalize(item.url));
  };

  highlights.forEach((h, i) => intra(h, highlights.slice(0, i)));
  for (const item of pool) {
    // Espelho do destaque no pool (mesma URL) é outro problema, já coberto
    // pela checagem de URL duplicada.
    if (hlUrls.has(canonicalize(item.url))) continue;
    intra(item, highlights);
  }

  if (past.length > 0) {
    const all = [...highlights, ...pool].filter((it) => !warned.has(canonicalize(it.url)));
    const byUrl = new Map(all.map((it) => [it.url, it]));
    const pastByKey = new Map(past.map((p) => [`${p.aammdd}\u0000${p.title}`, p]));
    const sameFact = findSameFactMatches(
      all.map((it) => ({ kind: it.label, title: it.title, url: it.url })),
      past.map((p) => ({
        title: p.title,
        aammdd: p.aammdd,
        url: p.url,
        bucket: p.highlight ? "highlight" : p.label,
      })),
    );
    for (const w of sameFact) {
      if (w.evidence !== "title") continue;
      const item = byUrl.get(w.item_url);
      if (!item || warned.has(canonicalize(item.url))) continue;
      const p = pastByKey.get(`${w.matched_edition}\u0000${w.matched_title}`);
      warnings.push({
        scope: "past",
        item_label: item.label,
        item_title: item.title,
        item_url: item.url,
        matched_label: p?.label ?? w.matched_bucket,
        matched_title: w.matched_title,
        ...(w.matched_url ? { matched_url: w.matched_url } : {}),
        matched_edition: w.matched_edition,
        signal: `produto: ${w.shared_products.join(", ")}`,
      });
      warned.add(canonicalize(item.url));
    }
  }
  return warnings;
}
