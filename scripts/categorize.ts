/**
 * categorize.ts
 *
 * Classifica artigos em buckets que refletem as seções da newsletter (#1629).
 * Substitui o subagente `categorizer` (Haiku) por lógica determinística.
 *
 * Uso:
 *   npx tsx scripts/categorize.ts --articles <articles.json> [--out <out.json>]
 *
 * Input:  array JSON de artigos (post-dedup, com { url, title?, type_hint?, ... })
 * Output: { lancamento: [...], radar: [...], use_melhor: [...], video: [...] }
 *         cada artigo recebe campo adicional `category` (lancamento/pesquisa/
 *         noticias/tutorial/video) — Category é o tipo do artigo; Bucket é a
 *         seção pra onde ele vai.
 *
 * Regras (espelham context/editorial-rules.md):
 *   - Category `lancamento`: URL no domínio oficial de empresa de tech (blog, news, release) → Bucket `lancamento`
 *   - Category `pesquisa`:   URL em site acadêmico/de pesquisa (arxiv, openreview, etc.) → Bucket `radar`
 *   - Category `noticias`:   todo o resto (jornalismo, análise, cobertura secundária, opinião) → Bucket `radar`
 *   - Category `tutorial`:   tutorial, cookbook, how-to → Bucket `use_melhor`
 *   - Category `video`:      youtube/vimeo → Bucket `video`
 *
 * Dúvida entre lancamento e noticias: se URL não for do domínio oficial → noticias.
 *
 * #2833: o motor de classificação (constantes/heurísticas/categorize()) foi
 * extraído pra scripts/lib/launch-heuristics.ts — movimentação pura, re-
 * exportado abaixo pra manter compat com importadores existentes. Este
 * arquivo mantém só os tipos de I/O em lote (BucketedArticles), o loop de
 * categorização (categorizeArticles) e o CLI.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { exitWithError } from "./lib/exit-handler.ts";
import { parseArgs as parseCliArgs } from "./lib/cli-args.ts"; // #535
import { looksEnglish } from "./lib/lang-detect.ts"; // #1473/#1790 (era inline)
import {
  AI_RELEVANT_TERMS,
  isArticleAIRelevant,
  type Article,
  type Category,
  type Bucket,
  categoryToBucket,
  ARXIV_RELEVANT_TERMS,
  isArxivRelevant,
  isUpdate,
  isTutorialByDomainExtra,
  isCoursePage,
  isCustomerStory,
  isNonLaunchPath,
  isReport,
  hasLaunchVerb,
  isExplainerByTitle,
  isLaunchSlug,
  isRoundupSlug,
  isDevReleaseNote,
  isNewsNotTutorial,
  isLikelyResearchResult,
  isLogisticsMilestone,
  isCustomerSlug,
  isResearchBySlug,
  isOpenAIFrontiersStory,
  isThirdPartyBlogAboutOtherCompany,
  isFirstPartyToolingBlog,
  hasPreExistenceSignal,
  isIncrementalReleaseOnThirdPartyBlog,
  isVideoUrl,
  isOfficialLancamentoUrl,
  categorize,
} from "./lib/launch-heuristics.ts"; // #2833: extraído — movimentação pura

export { AI_RELEVANT_TERMS, isArticleAIRelevant };
export type { Article };
export type { Category, Bucket };
export {
  categoryToBucket,
  ARXIV_RELEVANT_TERMS,
  isArxivRelevant,
  isUpdate,
  isTutorialByDomainExtra,
  isCoursePage,
  isCustomerStory,
  isNonLaunchPath,
  isReport,
  hasLaunchVerb,
  isExplainerByTitle,
  isLaunchSlug,
  isRoundupSlug,
  isDevReleaseNote,
  isNewsNotTutorial,
  isLikelyResearchResult,
  isLogisticsMilestone,
  isCustomerSlug,
  isResearchBySlug,
  isOpenAIFrontiersStory,
  isThirdPartyBlogAboutOtherCompany,
  isFirstPartyToolingBlog,
  hasPreExistenceSignal,
  isIncrementalReleaseOnThirdPartyBlog,
  isVideoUrl,
  isOfficialLancamentoUrl,
  categorize,
};

export interface BucketedArticles {
  lancamento: Article[];
  radar: Article[];
  use_melhor: Article[];
  video: Article[];
}

// ---------------------------------------------------------------------------
// Batch — exportada para testes (#697)
// ---------------------------------------------------------------------------

/**
 * Returns true if an editor_submitted article is unresolvable — enrich failed
 * and there's no usable content. These are dropped before categorization to
 * avoid empty/placeholder articles reaching the writer (#722).
 *
 * Drop conditions (ALL must match):
 *   1. flag === 'editor_submitted'
 *   2. title is still '(inbox)' or empty (enrich failed)
 *   3. summary is empty or very short (< 30 chars)
 */
export function isUnresolvableInboxArticle(article: Article): boolean {
  if (article.flag !== "editor_submitted") return false;
  const title = (article.title ?? "").trim();
  const summary = (article.summary ?? "").trim();
  const titleIsPlaceholder =
    !title ||
    title === "(inbox)" ||
    title === "(no title)" ||
    title === "(sem título)" ||
    /^\(inbox/i.test(title) ||
    /^\[inbox\]/i.test(title);
  const summaryTooShort = summary.length < 30;
  return titleIsPlaceholder && summaryTooShort;
}

export function categorizeArticles(articles: Article[]): BucketedArticles {
  const result: BucketedArticles = {
    lancamento: [],
    radar: [],
    use_melhor: [],
    video: [],
  };

  for (const article of articles) {
    // #445: artigos com url null/undefined causam crash silencioso em categorize()
    // (hostAndPath(undefined) → TypeError). Filtrar antes de processar.
    if (!article.url || typeof article.url !== "string") {
      console.warn(`[categorize] artigo ignorado: url inválida (${JSON.stringify(article.url)})`);
      continue;
    }
    // #722: artigos editor_submitted com título placeholder e summary vazio são
    // falhas de enrich — não há conteúdo para o writer usar. Descartar silenciosamente.
    if (isUnresolvableInboxArticle(article)) {
      console.error(`[categorize] dropping unresolvable inbox article: ${article.url}`);
      continue;
    }
    const cat = categorize(article);
    const bucket = categoryToBucket(cat);
    result[bucket].push({ ...article, category: cat });
  }

  // #1473: detectar summaries em inglês e flaggar para tradução downstream.
  // Heurística simples: contar stop words inglesas vs portuguesas no summary.
  let englishCount = 0;
  for (const bucket of Object.keys(result) as Bucket[]) {
    for (const article of result[bucket]) {
      if (looksEnglish(article.summary ?? "")) {
        (article as any).summary_lang = "en";
        englishCount++;
      }
    }
  }
  if (englishCount > 0) {
    console.warn(`[categorize] #1473: ${englishCount} artigo(s) com summary em inglês — writer deve traduzir`);
  }

  // Limite de 2 vídeos por edição — manter os primeiros (maior relevância por ordem de entrada).
  if (result.video.length > 2) {
    const discarded = result.video.slice(2).map((v) => v.url).join(", ");
    console.error(`[categorize] ${result.video.length} vídeos → truncando para 2. Descartados: ${discarded}`); // #697
    result.video = result.video.slice(0, 2);
  }

  return result;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main(): void {
  const args = process.argv.slice(2);
  const { values } = parseCliArgs(args); // #535: fix indexOf+1 bug

  if (!values["articles"]) {
    exitWithError("Usage: categorize.ts --articles <articles.json> [--out <out.json>]");
  }

  const articlesPath = values["articles"];
  const outPath = values["out"] ?? null;

  const articles: Article[] = JSON.parse(readFileSync(articlesPath, "utf8"));
  const result = categorizeArticles(articles);

  const stats = `lancamento:${result.lancamento.length} radar:${result.radar.length} use_melhor:${result.use_melhor.length} video:${result.video.length}`;

  const json = JSON.stringify(result, null, 2);
  if (outPath) {
    writeFileSync(outPath, json, "utf8");
    console.log(`Categorized ${articles.length} articles → ${stats}`);
    console.log(`Wrote to ${outPath}`);
  } else {
    console.log(json);
  }
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}

