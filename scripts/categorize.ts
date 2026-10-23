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
import { exitWithError } from "./lib/exit-handler.ts";
import { parseArgs as parseCliArgs, isMainModule } from "./lib/cli-args.ts"; // #535
import { applySemanticTiebreaker, type CategorizedBuckets } from "./lib/semantic-tiebreaker.ts"; // #8211
import { looksEnglish } from "./lib/lang-detect.ts"; // #1473/#1790 (era inline)
import { normalizeItemTitle } from "./lib/strip-publisher-suffix.ts"; // #9380
import { isNonAITopic } from "./lib/ai-relevance.ts"; // #9402
import { isRedirectStubTitle, isAmbiguousRedirectStubTitle } from "./lib/placeholder-title-guard.ts"; // #10796
import { logEvent, type RunLogEvent } from "./lib/run-log.ts"; // #10796
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
  categorizeWithRule,
  isFallbackCategorizationRule,
  MIXED_TUTORIAL_ESSAY_HOSTS,
  ESSAY_ANALYSIS_TITLE_RE,
} from "./lib/launch-heuristics.ts"; // #2833: extraído — movimentação pura
import type { CategorizationResult, CategorizationRule, FallbackCategorizationRule } from "./lib/launch-heuristics.ts"; // #6647

export { AI_RELEVANT_TERMS, isArticleAIRelevant };
export type { Article };
export type { Category, Bucket };
export type { CategorizationResult, CategorizationRule, FallbackCategorizationRule }; // #6647
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
  categorizeWithRule,
  isFallbackCategorizationRule,
  MIXED_TUTORIAL_ESSAY_HOSTS,
  ESSAY_ANALYSIS_TITLE_RE,
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

/**
 * #10796: título que ainda é o `<title>` de uma página-stub de redirect
 * ("Document moved", "301 Moved Permanently", "Redirecting...") quando chega
 * na categorização. O `enrich-inbox-articles` (1k) já segue redirects e
 * troca esse título pelo og:title real (#10843); se ele chegou até aqui, o
 * enrichment FALHOU (fetch bloqueado, timeout, página sem metadata) e o
 * artigo não tem título nenhum utilizável. Diferente do #722, vale pra
 * qualquer `flag` — o caso real (Voxtral 3, 261022) era `newsletter_extracted`
 * — e independe do summary: um summary bom não salva o título, que seria
 * renderizado como "Document moved" na seção do pool.
 *
 * Palavra solta e ambígua ("Found", "Moved", "Redirect") só conta como stub
 * com contexto de redirect: summary ausente/curto, ou summary que é o próprio
 * corpo da página-stub ("Object moved to here"). Matéria real com esse título
 * e summary de verdade segue no pool.
 */
const REDIRECT_BODY_RE =
  /\b(?:moved (?:permanently|temporarily|to)|has moved|object moved|document moved|redirect(?:ing|ed)? to)\b/i;

export function hasUnresolvedRedirectStubTitle(article: Article): boolean {
  // A palavra solta NÃO casa `isRedirectStubTitle` desde o #10881 item 4 (só
  // casa com o código HTTP antes) — por isso é checada primeiro, por conta
  // própria, e só então o caso inequívoco ("302 Found", "Document moved").
  if (isAmbiguousRedirectStubTitle(article.title)) {
    const summary = (article.summary ?? "").trim();
    return summary.length < 30 || REDIRECT_BODY_RE.test(summary);
  }
  return isRedirectStubTitle(article.title);
}

/** Evento de run-log sem `edition` — o caller (main) injeta a edição. */
export type CategorizeEvent = Omit<RunLogEvent, "edition">;

export interface CategorizeOptions {
  /**
   * #10796: sink dos descartes/sinalizações. `main()` grava em
   * `data/run-log.jsonl` via `logEvent`; default no-op mantém a função pura
   * pros testes (nenhum teste escreve no run-log real).
   */
  onEvent?: (event: CategorizeEvent) => void;
}

export function categorizeArticles(
  articles: Article[],
  opts: CategorizeOptions = {},
): BucketedArticles {
  const emit = opts.onEvent ?? (() => {});
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
      emit({
        stage: 1,
        agent: "categorize",
        level: "warn",
        message: `artigo do inbox descartado (enrich falhou, sem título nem summary): ${article.url}`,
        details: { url: article.url, reason: "unresolvable_inbox", issue: 722 },
      });
      continue;
    }
    // #10796: enrichment não conseguiu trocar o título de stub de redirect.
    let titleUnresolved = false;
    if (hasUnresolvedRedirectStubTitle(article)) {
      if (article.flag === "editor_submitted") {
        // Submissão do editor nunca some em silêncio (review #10890): fica no
        // pool com o título de stub, marcada com `title_unresolved` e um warn
        // no run-log. `isPlaceholderHighlightTitle` sozinho só barra o stub
        // inequívoco ("302 Found", "Document moved"); a palavra solta
        // ("Found") é barrada por ler ESTE marcador — o backstop do
        // `assemble-scored` e o invariante `no-placeholder-title-highlights`
        // usam `isPlaceholderHighlightItem` (#10908). Não renomear o campo
        // sem atualizar `placeholder-title-guard.ts`.
        titleUnresolved = true;
        console.warn(
          `[categorize] #10796: editor_submitted kept with unresolved redirect-stub title "${article.title}": ${article.url}`,
        );
        emit({
          stage: 1,
          agent: "categorize",
          level: "warn",
          message: `submissão do editor com título de stub de redirect "${article.title}" mantida no pool — corrigir o título: ${article.url}`,
          details: { url: article.url, title: article.title, reason: "redirect_stub_title_kept", issue: 10796 },
        });
      } else {
        console.error(
          `[categorize] dropping article with redirect-stub title "${article.title}": ${article.url}`,
        );
        emit({
          stage: 1,
          agent: "categorize",
          level: "warn",
          message: `artigo descartado com título de stub de redirect "${article.title}": ${article.url}`,
          details: { url: article.url, title: article.title, flag: article.flag ?? null, reason: "redirect_stub_title", issue: 10796 },
        });
        continue;
      }
    }
    // #6647: categorizeWithRule() é a mesma decisão de categorize() (wrapper
    // fino sobre ela) — usar a versão instrumentada aqui não muda `cat` em
    // nenhum artigo, só permite persistir `category_rule` abaixo.
    const { category: cat, rule: categoryRule } = categorizeWithRule(article);
    // #2986: gate de relevância-IA restrito à categoria `noticias` — o catch-all
    // genérico do categorize() (cobertura de imprensa sem domínio dedicado).
    // Fontes cadastradas ainda trazem, ocasionalmente, conteúdo sem ângulo de IA
    // (ex: cobertura de app store/regulação — "AltStore PAL no Brasil: vale a
    // pena usar loja alternativa do iPhone?", canaltech, 260706).
    //
    // Deliberadamente NÃO aplicado a `tutorial`/`pesquisa`/`lancamento`/`video`:
    // essas categorias já carregam sinal de relevância pelo PRÓPRIO domínio
    // dedicado (TUTORIAL_DOMAINS/PESQUISA_DOMAINS/LANCAMENTO_DOMAINS) ou pattern
    // — aplicar o gate ali arriscaria descartar tutorial/paper legítimo cujo
    // título não contém keyword de IA explícita (ex: cookbook.openai.com
    // "Structured Outputs" é tutorial de IA mas o título não bate
    // AI_RELEVANT_TERMS). `pesquisa` de arXiv já tem seu próprio filtro
    // (isArxivRelevant) dentro de categorize(); reforçar aqui duplicaria sem
    // necessidade e ampliaria a superfície de falso-positivo.
    //
    // #9402: exceção à restrição acima — assunto sabidamente SEM IA
    // (NON_AI_TOPIC_PATTERNS, ex: listas de jogos GeForce NOW em
    // blogs.nvidia.com) é derrubado em QUALQUER categoria. Caso real 261002:
    // o item caiu em `lancamento` (domínio oficial), onde o gate não rodava, e
    // chegou ao RADAR. A denylist é estreita o bastante pra não ter o risco de
    // falso-positivo descrito acima.
    // (isArticleAIRelevant já inclui isNonAITopic — por isso o ternário.)
    if (cat === "noticias" ? !isArticleAIRelevant(article) : isNonAITopic(article)) {
      // #5080: `flag: "editor_submitted"` isenta do gate #2986, mesmo
      // precedente de dedup.ts Pass-1d (#4192) e filter-date-window.ts
      // (#4656) — o editor já exerceu curadoria ao enviar o link; ausência
      // de keyword de IA explícita no título/summary (comum quando o
      // enrich não populou bem o conteúdo) não deve sobrepor essa decisão
      // editorial. Caso real 260811: submissão do editor (theregister.com)
      // foi dropada silenciosamente por este gate.
      if (article.flag === "editor_submitted") {
        console.warn(
          `[categorize] #5080: #2986/#9402 spared editor_submitted item (would have dropped as non-AI-relevant): ${article.url}`,
        );
      } else {
        console.error(`[categorize] #2986/#9402 dropping non-AI-relevant item (${cat}): ${article.url}`);
        continue;
      }
    }
    const bucket = categoryToBucket(cat);
    // #6647: category_rule é aditivo — não influencia bucket/category acima,
    // só persiste QUAL regra decidiu (ou o fallback, ver
    // isFallbackCategorizationRule) pra permitir medir o resíduo real via
    // scripts/analyze-bucket-overrides.ts --rules.
    // #9380: ponto único de normalização de título pra TODO item do pool
    // (RSS/pesquisa/inbox) — antes só o inbox passava por normalizeItemTitle.
    // Roda DEPOIS de categorizeWithRule pra não mudar a classificação (as
    // heurísticas de título viram o título cru da fonte, como sempre).
    const normalizedTitle =
      typeof article.title === "string"
        ? normalizeItemTitle(article.title, typeof article.url === "string" ? article.url : undefined) // url: #10313
        : article.title;
    // title_raw preserva o título da fonte quando mudou (auditoria/dedup).
    const rawField = normalizedTitle !== article.title ? { title_raw: article.title } : {};
    const unresolvedField = titleUnresolved ? { title_unresolved: "redirect_stub" } : {}; // #10796
    result[bucket].push({ ...article, ...rawField, ...unresolvedField, title: normalizedTitle, category: cat, category_rule: categoryRule });
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

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const { values } = parseCliArgs(args); // #535: fix indexOf+1 bug

  if (!values["articles"]) {
    exitWithError("Usage: categorize.ts --articles <articles.json> [--out <out.json>]");
  }

  const articlesPath = values["articles"];
  const outPath = values["out"] ?? null;
  const edition = values["edition"] ?? null; // #8211: opcional, só pra correlacionar no run-log

  const articles: Article[] = JSON.parse(readFileSync(articlesPath, "utf8"));
  // #10796: descartes/sinalizações vão também pro run-log (/diaria-log,
  // collect-edition-signals), não só pro stderr do stage-1-run.
  let result: CategorizedBuckets = categorizeArticles(articles, {
    onEvent: (e) => logEvent({ ...e, edition }),
  });

  // #8211: passo OPCIONAL, atrás de flag (platform.config.json →
  // semantic_tiebreaker.enabled), que reconsidera SÓ os artigos que caíram
  // num dos dois defaults silenciosos (lancamento-default/noticias-default).
  // Fail-soft — flag off, key ausente, ou falha de rede devolvem `result`
  // sem nenhuma alteração (ver scripts/lib/semantic-tiebreaker.ts).
  const tiebreak = await applySemanticTiebreaker(result, { edition });
  result = tiebreak.result;
  if (tiebreak.applied && tiebreak.reclassified > 0) {
    console.log(`[categorize] #8211: tie-breaker semântico reclassificou ${tiebreak.reclassified} artigo(s)`);
  }

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

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error("[categorize] ERRO:", e);
    process.exit(1);
  });
}

