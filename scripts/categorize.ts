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
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { exitWithError } from "./lib/exit-handler.ts";
import { parseArgs as parseCliArgs } from "./lib/cli-args.ts"; // #535
import { lancamentoDomains, lancamentoPatterns, OFFICIAL_SOURCES } from "./lib/official-domains.ts"; // #566
import { AI_RELEVANT_TERMS, containsAITerms, isArticleAIRelevant } from "./lib/ai-relevance.ts"; // #642
import { isLikelyNewsNotLaunch } from "./lib/launch-vs-news.ts"; // #1442
import type { Article } from "./lib/types/article.ts"; // #650
import { looksEnglish } from "./lib/lang-detect.ts"; // #1473/#1790 (era inline)
import { loadUseMelhorPrefixes, matchesUseMelhorPrefix, loadAllSourcePrefixMap, resolveUseMelhorBySpecificity, type SourcePrefixEntry } from "./lib/use-melhor-sources.ts"; // #1899 / #2176
export { AI_RELEVANT_TERMS, isArticleAIRelevant };
export type { Article };

export type Category = "lancamento" | "pesquisa" | "noticias" | "tutorial" | "video";

/**
 * Bucket (= seção da newsletter): a chave usada em todo JSON intermediário
 * do pipeline (`_internal/01-categorized.json`, `01-approved.json`, etc).
 *
 * **Bucket ≠ Category.** Category é o tipo de artigo (per-article); Bucket
 * é a seção pra qual ele será endereçado (1 seção pode reunir múltiplas
 * categorias). Mapping em `categoryToBucket()`.
 *
 * #1629: introduzido pra alinhar nomenclatura interna com seções
 * publicadas (RADAR substituiu PESQUISAS + OUTRAS NOTÍCIAS — #1569;
 * USE MELHOR substituiu TUTORIAIS — #1568).
 */
export type Bucket = "lancamento" | "radar" | "use_melhor" | "video";

/**
 * Mapping Category → Bucket (#1629).
 * - `pesquisa` e `noticias` ambas vão pra `radar` (fundidas em #1569).
 * - `tutorial` vira `use_melhor` (#1568).
 * - `lancamento` e `video` mantêm nome.
 */
export function categoryToBucket(c: Category): Bucket {
  switch (c) {
    case "lancamento":
      return "lancamento";
    case "pesquisa":
    case "noticias":
      return "radar";
    case "tutorial":
      return "use_melhor";
    case "video":
      return "video";
  }
}

export interface BucketedArticles {
  lancamento: Article[];
  radar: Article[];
  use_melhor: Article[];
  video: Article[];
}

// ---------------------------------------------------------------------------
// Domínios e padrões que indicam LANÇAMENTO (anúncio oficial) — #566
// Derivados de scripts/lib/official-domains.ts (fonte única de verdade).
// Para adicionar empresa nova: editar official-domains.ts, não aqui.
// ---------------------------------------------------------------------------
const LANCAMENTO_DOMAINS = lancamentoDomains();
const LANCAMENTO_PATTERNS = lancamentoPatterns();

// #2176: mapa COMPLETO de fontes (todas, não só use_melhor) para o desempate
// path-mais-específico-vence quando dois sources compartilham o mesmo host.
// Fallback: lista vazia → cai no comportamento legado (matchesUseMelhorPrefix).
// Finding 2: console.warn explícito indica que o fix #2176 NÃO está ativo.
const ALL_SOURCE_PREFIX_MAP: SourcePrefixEntry[] = (() => {
  try {
    return loadAllSourcePrefixMap();
  } catch (e) {
    console.warn(`[categorize] #2176 FIX NÃO ATIVO: loadAllSourcePrefixMap falhou (${(e as Error).message}) — fallback legado (matchesUseMelhorPrefix)`);
    return [];
  }
})();

// #1899 (Finding 5): USE_MELHOR_PREFIXES é derivável de ALL_SOURCE_PREFIX_MAP
// (filter useMelhor=true) — elimina o readFileSync duplo do mesmo CSV.
// Usado apenas no caminho de fallback (ALL_SOURCE_PREFIX_MAP vazio).
const USE_MELHOR_PREFIXES: string[] = ALL_SOURCE_PREFIX_MAP.length > 0
  ? ALL_SOURCE_PREFIX_MAP.filter((e) => e.useMelhor).map((e) => e.prefix)
  : (() => {
      try {
        return loadUseMelhorPrefixes();
      } catch (e) {
        console.error(`[categorize] WARN: loadUseMelhorPrefixes falhou (${(e as Error).message}) — só inferência por conteúdo`);
        return [];
      }
    })();

// ---------------------------------------------------------------------------
// Domínios e padrões que indicam PESQUISA (papers, estudos, relatórios)
// ---------------------------------------------------------------------------

const PESQUISA_DOMAINS = new Set([
  // Preprints
  "arxiv.org",
  "biorxiv.org",
  "medrxiv.org",
  // Conferências / proceedings
  "openreview.net",
  "proceedings.neurips.cc",
  "proceedings.mlr.press",
  // Bibliotecas digitais
  "dl.acm.org",
  "ieeexplore.ieee.org",
  "papers.ssrn.com",
  "semanticscholar.org",
  // Revistas científicas
  "nature.com",
  "science.org",
  "pubmed.ncbi.nlm.nih.gov",
  // Labs de pesquisa
  "research.google",
]);

// ---------------------------------------------------------------------------
// Filtro arXiv — relevância editorial (#501)
// ---------------------------------------------------------------------------

/**
 * Termos relevantes para o tema da Diar.ia (IA, ML, NLP).
 * Re-export de `scripts/lib/ai-relevance.ts` (#642) — `ARXIV_RELEVANT_TERMS`
 * mantido como alias deprecated pra compat com callers existentes.
 *
 * @deprecated Use `AI_RELEVANT_TERMS` de `scripts/lib/ai-relevance.ts`.
 */
export const ARXIV_RELEVANT_TERMS = AI_RELEVANT_TERMS;

/**
 * Retorna `true` se o artigo arXiv deve passar pelo pipeline editorial.
 * Para artigos não-arXiv, sempre retorna `true` (sem filtro).
 * Para artigos arXiv, exige ao menos 1 match de `AI_RELEVANT_TERMS`
 * no título ou resumo (#501, #642, #901).
 *
 * Importante: usamos `containsAITerms` em vez de `isArticleAIRelevant` porque
 * a versão #901 da `isArticleAIRelevant` faz bypass automático para artigos
 * em domínios 100%-IA (incluindo arxiv.org). Isso desativaria o filtro de
 * relevância pra arxiv (que é o oposto do que queremos: arxiv tem alto
 * volume off-topic em outras áreas, exatamente o cenário que motivou #501).
 */
export function isArxivRelevant(article: Article): boolean {
  if (!article.url?.includes("arxiv.org")) return true; // não é arXiv → passa
  // Avaliar SOMENTE título + summary, sem bypass de domínio.
  const text = `${article.title ?? ""} ${article.summary ?? ""}`;
  // import { containsAITerms } resolvido abaixo via re-export
  return containsAITerms(text);
}

const PESQUISA_PATTERNS: RegExp[] = [
  // arxiv (inclui /abs/ e /pdf/)
  /^arxiv\.org\//,
  // HuggingFace papers (não blog)
  /^huggingface\.co\/papers\//,
  // Meta AI research (papers)
  /^ai\.meta\.com\/research\//,
  // Google Research
  /^research\.google\//,
  // Perplexity Research (papers e estudos técnicos)
  /^research\.perplexity\.ai\//,
  // Anthropic research (papers, não news/blog)
  /^anthropic\.com\/research\//,
  // OpenAI research (não blog)
  /^openai\.com\/research\//,
];

// ---------------------------------------------------------------------------
// Domínios de veículos jornalísticos — ignorar type_hint do source-researcher
// nesses domínios, pois qualquer conteúdo deles é cobertura (noticias), não
// o estudo/pesquisa em si (#356).
// ---------------------------------------------------------------------------
const NOTICIAS_DOMAINS = new Set([
  "cnnbrasil.com.br",
  "exame.com",
  "g1.globo.com",
  "tecnoblog.net",
  "canaltech.com.br",
  "startse.com",
  "mitsloanreview.com.br",
  "techcrunch.com",
  "theverge.com",
  "reuters.com",
  "wired.com",
  "venturebeat.com",
  "theregister.com",
  "zdnet.com",
  "arstechnica.com",
  "bloomberg.com",
  "ft.com",
  "wsj.com",
  "nytimes.com",
  "bbc.com",
  "folha.uol.com.br",
  "estadao.com.br",
  "infomoney.com.br",
  "computerworld.com",
  "infoq.com",
]);

// ---------------------------------------------------------------------------
// Business-deal override — artigos cujo domínio é oficial (ex: anthropic.com/news)
// mas cujo TÍTULO claramente descreve um acordo comercial / parceria /
// investimento devem ir para `noticias`, não `lancamento`. "Lançamento" é
// reservado a anúncio de produto/feature/versão nova.
// ---------------------------------------------------------------------------

const DEAL_PATTERNS: RegExp[] = [
  // Parceria/colaboração expandida
  /\b(expand(s|ed)?|expande[mr]?)\s+(the\s+)?(collaboration|partnership|deal|agreement|parceria|acordo|colabora[çc][ãa]o)/i,
  // Aquisições e fusões
  /\b(acquir(es|ed|ing)?|acquisition of|adquir[ei]|aquisi[çc][ãa]o|merger|fus[ãa]o)\b/i,
  // Investimento explícito com número (bilhões)
  /\b(\$|US\$|USD\s?)?\d+(\.\d+)?\s*(bilh[ãõ]es|billion|bn)\b[^.]{0,40}\b(deal|invest(ment)?|commit(ment|s)?|compromet|funding|rodada)/i,
  /\b(deal|invest(ment|s)?|commit(ment|s)?|rodada|funding)\b[^.]{0,40}\b(\$|US\$|USD\s?)?\d+(\.\d+)?\s*(bilh[ãõ]es|billion|bn)\b/i,
  // Rodadas em milhões — seed/série A/B/C/D, etc. (#164)
  /\b(raise[sd]?|raises|raised|levantou?|levanta[mr]?|capt(a|ou|am)?)\b[^.]{0,30}\b(\$|US\$|USD\s?|€|R\$\s?)?\d+(\.\d+)?\s*(M\b|million|millions?|milh[ãõ]es)\b/i,
  /\b(\$|US\$|USD\s?|€|R\$\s?)?\d+(\.\d+)?\s*(M\b|million|millions?|milh[ãõ]es)\b[^.]{0,30}\b(round|rodada|series\s+[A-Z]|s[ée]rie\s+[A-Z]|seed|funding)/i,
  // Valuation explícito (M ou B)
  /\b(valuation|val(uation)?\s+(of|de|atingiu)|hits?\s+\$?\d)\b[^.]{0,30}\b(\$|US\$)?\d+(\.\d+)?\s*(M\b|B\b|million|billion)\b/i,
  /\b(\$|US\$)?\d+(\.\d+)?\s*(M\b|B\b|million|billion)\s+valuation\b/i,
  // IPO e listagem
  /\b(IPO|oferta p[úu]blica|listagem na bolsa|goes? public|files? to go public)\b/i,
  // Contratos de compute/infra (ex: "5 gigawatts of new compute")
  /\b\d+\s*(gigawatt|megawatt|GW|MW)s?\b.*\bcompute\b/i,
  // Acordos genéricos gigantes
  /\b(strategic agreement|multi[- ]year (deal|agreement|contract)|acordo estrat[ée]gico)\b/i,
];

/**
 * #898: Customer stories / case studies / parcerias com cliente.
 * Override → noticias (anteriormente classificadas como lancamento).
 *
 * Padrões cobertos (alta-confiança, baixo falso-positivo):
 *   - "How {company} uses {product}" / "How {company} delivered/built X"
 *   - Customer story headings
 *   - "{Brand} works with X / partners with Y / brings"
 *   - "{Brand} helps X" (Singular Bank helps bankers move fast with ChatGPT)
 *   - "Class of YYYY" (ChatGPT Futures: Class of 2026 — programa, não produto)
 *   - "Frontier enterprises" / "B2B Signals" / "Field Notes" — relatórios B2B
 */
const CUSTOMER_STORY_PATTERNS: RegExp[] = [
  // "How {entity} (uses|leverages|powered|delivered|built|works|achieves)"
  /\bhow\s+\w+(\s+\w+){0,3}\s+(uses?|leverag(es?|ed?)|powered?|delivered?|built|works?\s+with|achiev(es?|ed?)|earn(s|ed)?\s+smarter)\b/i,
  // "How {entity} delivers/scales X" — variante com objeto direto
  /\bhow\s+\w+(\s+\w+){0,3}\s+(delivers?|scales?|optimizes?|automates?)\b.{0,40}\b(at scale|workflow|business)\b/i,
  // "X helps Y move/grow/scale/work" — customer narrative
  /\b\w+\s+helps?\s+\w+(\s+\w+){0,3}\s+(move|grow|scale|work|earn|build|automate|deliver)\b/i,
  // Programa de bolsa / aceleradora — "Class of YYYY"
  /\bclass\s+of\s+\d{4}\b/i,
  // "X uses Y/Z to Z" (Uber uses OpenAI to help people earn)
  /\b\w+\s+uses?\s+(openai|claude|chatgpt|gemini|copilot|anthropic)\b/i,
  // "Customer story", "customer stories", "case study", "case studies"
  /\bcustomer\s+(story|stories|spotlight)\b|\bcase\s+stud(y|ies)\b/i,
  // Relatórios B2B / signals
  /\bfrontier\s+enterprises?\b|\bb2b\s+signals?\b|\bfield\s+notes?\b/i,
  // "X collaborate(s) with Y" / "collaboration with Y"
  /\b(collaborat(es?|ed|ion)|partners?|partnership|brings?)\s+with\s+\w+/i,
  // "X and Y collaborate/partner/announce" — parceria explícita no título
  // Ex: "OpenAI and PwC collaborate", "Anthropic and Apple partner"
  /\b\w+\s+and\s+\w+\s+(collaborat(es?|ed?)|partners?|jointly|announce[ds]?)\b/i,
  // "X + Y" pattern em título oficial — quase sempre parceria
  // Ex: "Flow Music and Believe bring next-gen tools"
  /\b(\w+\s+and\s+\w+\s+bring|jointly\s+(announce|launch|introduce))\b/i,
  // #1321: "X integra Y em workflows/produtos" — integração com SaaS/empresa
  // Ex: "Databricks adota GPT-5.5 em workflows empresariais" (caso 260518)
  /\b(integra(m|r|mos)?|adota(m|r|mos)?|incorpora(m|r|mos)?|integrate[sd]?|adopt[sed]?|incorporate[sd]?)\s+.{0,40}\bem\s+(workflow|produto|sistema|plataforma|stack)/i,
  /\b(integrates?|adopts?|incorporates?)\s+.{0,40}\bin(to)?\s+(workflow|product|platform|system|stack)/i,
];

/**
 * #898: Updates incrementais / changelogs / melhorias em produto existente.
 * Domínio oficial mas título claramente aponta pra update, não lançamento novo.
 * Override → noticias (#318).
 */
const UPDATE_PATTERNS: RegExp[] = [
  // "An update on...", "Update: X", "atualização de/do/da"
  /\b(an\s+update\s+on|update\s*[:\-]\s|atualiza[çc][ãa]o\s+(de|do|da|sobre))\b/i,
  // "Improvements to X", "Improving X"
  /\b(improvements?\s+to|improving\b|melhor(i)?as?\s+(d[oae]|n[ao])\b)/i,
  // "X now supports Y / X agora inclui Y"
  /\bnow\s+(supports?|includes?|available|works?)\b|\bagora\s+(suporta|inclui|disponí?vel)\b/i,
  // Release notes / changelog / patch notes
  /\b(release\s+notes?|changelog|patch\s+notes?|notas\s+de\s+vers[ãa]o)\b/i,
  // "Our commitment to X", "Our approach to X" — posicionamento editorial sem produto
  /\bour\s+(commitment|approach|policy|stance|plans?)\s+to\b/i,
  // "Election safeguards", "safety update", "policy update"
  /\b(safety|security|election)\s+(safeguards?|update[sd]?|report)\b/i,
  // #1544: "election" near "safeguards" with words between (caso 260528:
  // "Election information and safeguards in 2026" — "election" + "safeguards"
  // separated by up to 5 words, not just adjacent)
  /\belection\b.{0,40}\bsafeguards?\b/i,
  // Posts de aniversário: "AI Max Turns 1", "3 years of X" (#486)
  /\b(turns?\s+\d+|\d+\s+(years?|anos?)\s+of\b)/i,
  // Expansão incremental: "expansion to more X" (#486)
  /\bexpansion\s+to\s+(more|new)\b/i,
  // #1544: "goes (fully)? local/offline/on-device" — update de funcionalidade
  // Caso 260528: "Reachy Mini goes fully local" (HF blog, not a new product)
  /\bgoes?\s+(fully\s+)?(local|offline|on[- ]device|open[- ]source)\b/i,
  // #1544: concept/vision/infrastructure posts — blog posts about concepts,
  // not actual product launches. Caso 260528: "AI Factories: The New
  // Infrastructure of Intelligence" (Nvidia blog about a concept, not a product)
  /\b(infrastructure|arquitetura|architecture)\s+of\s+(intelligence|AI|IA)\b/i,
  /\bnew\s+(era|paradigm|model)\s+of\s+(intelligence|computing|AI)\b/i,
];

export function isUpdate(article: Article): boolean {
  const hay = `${article.title ?? ""}\n${article.summary ?? ""}`;
  return UPDATE_PATTERNS.some((p) => p.test(hay));
}

/**
 * Títulos de pesquisa publicados em domínio oficial de empresa.
 * Ocorre quando um lab posta um paper no próprio blog (ex: openai.com/blog/toward-a-theory-of-mind).
 * Reclassificar como pesquisa, não lançamento (#486).
 */
const RESEARCH_IN_LAUNCH_DOMAIN =
  /\b(researching|toward\s+a|path\s+to(ward)?|exploring|a\s+study\s+on)\b/i;

// #1544: Technical methodology/technique posts on official blogs → pesquisa.
// Caso 260528: "Delta Weight Sync in TRL" (HF blog about a training technique).
const TECHNIQUE_IN_LAUNCH_DOMAIN =
  /\b(sync(hroniz\w+)?|weight\s+sync|delta\s+weight|training\s+(technique|method|recipe)|quantiz(ation|ing)|distill(ation|ing)|speculative\s+decoding|inference\s+(optim|trick|technique))\b/i;

/**
 * Domínios que são predominantemente tutoriais / case studies, mesmo quando
 * publicados em domínio oficial de empresa. Override → tutorial (#318).
 */
const TUTORIAL_DOMAIN_EXTRA_PATTERNS: RegExp[] = [
  // AWS ML Blog — historicamente tutoriais e case studies, não anúncios de produto
  /^aws\.amazon\.com\/blogs?\/(machine-learning|ai|compute|big-data)\//,
  // Google Developers blog (distinto de blog.google que é anúncio)
  /^developers\.googleblog\.com\//,
  // blog.google com slug imperativo (how-to, guide, tips etc.) — tutorial, não anúncio (#486)
  /^blog\.google\/.*\b(adapt|how-to|get-started|tips|guide|learn|discover)\b/i,
];

export function isTutorialByDomainExtra(url: string): boolean {
  const { full } = hostAndPath(url);
  return TUTORIAL_DOMAIN_EXTRA_PATTERNS.some((p) => p.test(full));
}

/**
 * Padrões de título/summary que indicam tutorial mesmo em domínio oficial (#318).
 */
const TUTORIAL_TITLE_EXTRA_RE =
  /\b(migrat(ing|ion)\b|how\s+\w+\s+(used?|leverag(es?|ed?)|powered?)\b|case\s+stud(y|ies)\b|build\s+and\s+deploy\b|step[- ]by[- ]step\b|guia\s+(pr[áa]tico|completo|passo)\b)\b/i;

function isTutorialByTitleExtra(article: Article): boolean {
  const hay = `${article.title ?? ""}\n${article.summary ?? ""}`;
  return TUTORIAL_TITLE_EXTRA_RE.test(hay);
}

/**
 * #1754: página de curso/formação/treinamento — sinal de ALTA confiança de que o
 * link É a página do curso (matrícula/conteúdo), não cobertura jornalística sobre
 * um curso. Vence o `type_hint` do agent: o Haiku às vezes lê uma landing de
 * formação e rotula "noticia" (caso 260603: hub.asimov.academy/formacao/... caiu
 * em RADAR em vez de USE MELHOR). Sinais:
 *   - host termina em `.academy` (plataformas de curso, ex: hub.asimov.academy)
 *   - path com /formação|curso(s)|course(s)|bootcamp|trilha/
 * Conservador de propósito: notícia SOBRE curso ("Empresa X lança formação")
 * mora em domínio jornalístico SEM esses paths → não é capturada. "learn" foi
 * deixado de fora (review #1773): casava /research/learn, /docs/learn de vendors
 * (huggingface.co/learn legítimo já é coberto por TUTORIAL_PATTERNS).
 */
export function isCoursePage(url: string): boolean {
  const { host, full } = hostAndPath(url);
  if (host.endsWith(".academy")) return true;
  return /\/(forma[çc][ãa]o|cursos?|courses?|bootcamp|trilha)(\/|$)/i.test(full);
}

/**
 * Anúncios de programa / bolsa / iniciativa não-produto. Cobrem blogs
 * oficiais que falam de scholarships, fellowships, grants, etc.
 *
 * #1321: adiciona accelerator/acelerador, estudo de caso PT, partnership
 * standalone (sem "expands"), program standalone.
 */
const NON_PRODUCT_ANNOUNCEMENT_PATTERNS: RegExp[] = [
  /\b(announc(ing|es|ed)|launches?)\s+.{0,40}\b(scholar(s|ship)?|fellowship|grant(s)?|bolsa(s)?|program(a)?|residenc(y|ia)|competi[çc][ãa]o)\b/i,
  /\b(apple|google|meta|microsoft|openai|anthropic)\s+scholars?\b/i,
  /\b(research|compute)\s+grants?\b/i,
  // #1321: acelerador/accelerator standalone — caso 260518 (programa Databricks)
  /\b(accelerator|acelerador(a|es)?|incubadora|incubator)\b/i,
  // #1321: programa de IA / programa de pesquisa — não produto
  /\bprograma\s+de\s+(ia|inteligência\s+artificial|pesquisa|treinamento|desenvolvimento)\b/i,
  /\bai\s+program(me)?\b/i,
  // #1321: estudo de caso PT
  /\bestudos?\s+de\s+caso\b/i,
];

function isNonProductAnnouncement(article: Article): boolean {
  const hay = `${article.title ?? ""}\n${article.summary ?? ""}`;
  return NON_PRODUCT_ANNOUNCEMENT_PATTERNS.some((p) => p.test(hay));
}

function isBusinessDeal(article: Article): boolean {
  const hay = `${article.title ?? ""}\n${article.summary ?? ""}`;
  return DEAL_PATTERNS.some((p) => p.test(hay));
}

/**
 * #898: predicate pra customer story / case study / programa / parceria.
 * Aplicado apenas em domínio oficial (LANCAMENTO_DOMAINS / LANCAMENTO_PATTERNS)
 * pra reclassificar pra `noticias`. Não toca conteúdo de jornalismo.
 */
export function isCustomerStory(article: Article): boolean {
  const hay = `${article.title ?? ""}\n${article.summary ?? ""}`;
  return CUSTOMER_STORY_PATTERNS.some((p) => p.test(hay));
}

/**
 * #898: paths em domínio oficial que sinalizam claramente NÃO-lançamento
 * (customer stories, programs, marketing, ads, field notes). Match em
 * `host+pathname` (ex: "openai.com/customers/foo").
 *
 * Mantido conservador — paths reservados pra anúncios de produto (`/blog/`,
 * `/news/`, `/index/`, `/research/`) NÃO entram aqui.
 */
const NON_LAUNCH_PATH_PATTERNS: RegExp[] = [
  /\/customers?\//i,
  /\/customer-stor(y|ies)\//i,
  /\/case-stud(y|ies)\//i,
  /\/futures?\//i, // openai.com/futures (programa, não produto)
  /\/scholars?\//i,
  /\/fellowship\//i,
  /\/grants?\//i,
  /\/b2b-signals?\//i,
  /\/field-notes?\//i,
  /\/ads?\//i, // marketing/ads dashboards/announcements
  /\/marketing\//i,
  /\/safety-report\//i, // já filtrado no openai pattern, redundante mas defensive
  /\/transparency\//i,
  /\/on-the-issues\//i, // #1096 — Microsoft analysis blog (essays, não lançamentos)
  /\/threat-intelligence\//i, // #1096 — Google GTIG reports (Cloud blog) são notícias
  /\/threat-intelligence-group-report\//i, // #1096 — blog.google GTIG report path
];

export function isNonLaunchPath(url: string): boolean {
  const { full } = hostAndPath(url);
  if (!full) return false;
  return NON_LAUNCH_PATH_PATTERNS.some((p) => p.test(full));
}

/**
 * #1096: detecta "release de relatório" — posts editoriais em sites de
 * fornecedor que NÃO anunciam produto/feature, e sim divulgam um relatório
 * ou análise de mercado.
 *
 * Exemplos da 260512 (falsos positivos como LANÇAMENTO antes do fix):
 *   - "Read our new report on AI-powered threats and our latest defenses"
 *     (blog.google/.../google-threat-intelligence-group-report/)
 *   - "The state of global AI diffusion in 2026"
 *     (blogs.microsoft.com/on-the-issues/.../)
 *
 * Sinais detectados no título (case-insensitive):
 *   - "Read our new report" / "Read our latest" / "Our X report"
 *   - "The state of X" (snapshot/análise de mercado)
 *   - "Annual report" / "Q1/Q2/Q3/Q4 X" / "H1/H2 X"
 *   - "Inside the X report" / "Behind the X"
 *   - "Insights from X" / "Lessons from X"
 *
 * Não dispara em títulos que combinam "release/launch" com "report" (ex:
 * "Launching our Threat Defense Suite alongside the GTIG report") porque
 * são genuinamente lançamentos.
 */
const REPORT_TITLE_PATTERNS: RegExp[] = [
  /\b(read|see)\s+our\s+(new\s+|latest\s+)?report\b/i,
  /\bour\s+\w+\s+report\b/i,
  /\bthe\s+state\s+of\s+\w/i,
  /\bannual\s+report\b/i,
  /\b(Q[1-4]|H[12])\s+\d{4}\b/,
  /\binside\s+(the|our)\s+\w+\s+report\b/i,
  /\b(insights|lessons|takeaways)\s+from\s+\w/i,
  /\bo\s+estado\s+de\s+\w/i, // pt: "O estado de IA em 2026"
  /\brelat[óo]rio\s+(anual|trimestral|de\s+ano)/i,
];

// #1765: relatório/pesquisa sinalizado no SUMMARY (não só no título). Caso real
// 260603: openai.com/index/codex-for-knowledge-work tem título product-y
// ("Codex is becoming a productivity tool for everyone") mas o summary diz
// "The Next Era of Knowledge Work report explores how...". Alta confiança:
// substantivo de relatório seguido de verbo de relatório. FP é improvável
// (lançamento que diz "report explores" é raro), e o guard de launch-verb +
// o short-circuit type_hint==='lancamento' no categorize protegem mais ainda.
// O substantivo de relatório e o verbo podem ter um qualificador curto entre
// eles ("relatório anual da OpenAI mostra", "report from X finds") — permite
// até 30 chars SEM ponto/quebra (mesma frase), o que evita casar através de
// fronteiras de sentença e mantém o sinal de alta confiança.
const SUMMARY_REPORT_PATTERN =
  /\b(report|study|índice|relat[óo]rio|pesquisa|survey|whitepaper)\b[^.\n]{0,30}\b(explores?|finds?|shows?|reveals?|examines?|details?|analyzes?|highlights?|explora|mostra|revela|aponta|detalha|analisa|conclui|indica)\b/i;

export function isReport(article: Article): boolean {
  const title = article.title ?? "";
  const summary = article.summary ?? "";
  const hay = `${title}\n${summary}`;
  // Skip se claramente também é launch (ex: "Launching X alongside our report")
  if (/\b(launching|launches?|announcing|unveils?|lan[çc]a)\b.{0,40}\breport\b/i.test(hay)) {
    return false;
  }
  if (REPORT_TITLE_PATTERNS.some((p) => p.test(title))) return true;
  // #1765: relatório sinalizado no summary mesmo com título product-y. MAS não
  // demove se o TÍTULO tem verbo de lançamento — "Introducing X" + summary que
  // menciona "report shows" é lançamento, não relatório (o título é o sinal mais
  // forte). Sem isso, o guard de launch-verb (acima) deixava passar verbos fora
  // da sua lista (ex: "Introducing"), gerando falso-positivo (review #1769).
  return !hasLaunchVerb(article) && SUMMARY_REPORT_PATTERN.test(summary);
}

/**
 * #898: verbos PT/EN de anúncio de produto. Requeridos no título quando o
 * domínio é oficial — sem isso, "lançamento" puxa pra `noticias` por
 * default (cobertura de imprensa, blog técnico, posicionamento editorial,
 * etc. não anuncia produto).
 *
 * Mantido permissivo pra evitar falso-negativo em formatos novos:
 * "Introducing X", "Meet X", "Say hello to X" todos contam.
 */
const LAUNCH_VERB_PATTERN =
  /\b(introducing|introduces|launch(es|ing)?|launches?|now\s+available|unveils?|releas(e|es|ing)|announc(es|ing|ed)|meet\s+\w+|say\s+hello\s+to\b|presents?|reveals?|debuts?|disponibiliza|lan[çc]a(mos|m|r)?|apresenta(mos|m|r)?|revela(mos|m|r)?|chega(m)?\s+(o|a|os|as)\s+novo|chegou\s+o\s+novo)\b/i;

/**
 * Detecta se o título/summary tem verbo de anúncio explícito ("lança",
 * "apresenta", "revela", "disponibiliza", "anuncia", "introducing", "unveils",
 * etc.).
 *
 * **AVISO — NÃO usar como gate de classificação de lançamento.** Muitos
 * lançamentos legítimos têm headlines product-name-only ("Gemini 2.0 Flash",
 * "Claude 4 Sonnet", "Claude for Creative Work") que NÃO contêm verbo de
 * anúncio mas são lançamentos reais. Gating por este helper geraria
 * falso-negativo agressivo. Este helper só serve como sinal *informativo* —
 * ex: input pro scorer dar weight extra, ou em combinação com outros checks.
 *
 * Para gating real de "é lançamento", usar combinação de:
 *   isOfficialLaunchDomain(url) + !isCustomerStory(...) + !isNonLaunchPath(url)
 *   + !isDeal(...) + !isUpdate(...)
 * (ver lógica em `categorize()` neste mesmo arquivo.)
 */
export function hasLaunchVerb(article: Article): boolean {
  const hay = `${article.title ?? ""}\n${article.summary ?? ""}`;
  return LAUNCH_VERB_PATTERN.test(hay);
}

/**
 * #1698: explainer/análise — título COMEÇA com prefixo de explicação
 * ("How X helps/works", "Why ...", "Beyond ...", "Understanding ...",
 * "A guide to ...", "What is ...", "The case for ...", "Lessons from ...").
 * Em domínio oficial isso NÃO é anúncio de produto → noticias (radar).
 * Per editorial-rules: LANÇAMENTOS = anúncio oficial de produto/atualização;
 * análise/opinião/explainer vão pra RADAR.
 *
 * Casos reais (260602) que caíam em LANÇAMENTOS indevidamente:
 *   - "How Cosmos 3 Helps Physical AI Think Before It Acts" (blogs.nvidia.com)
 *   - "Beyond LLMs: Why Scalable Enterprise AI Adoption Depends on Agent Logic"
 *
 * Anchored no INÍCIO do título (alta confiança — esses prefixos quase nunca
 * iniciam um anúncio de produto). A branch "How" pede um verbo de explicação
 * (helps/works/thinks/…) pra não colidir com customer-story ("How we built X",
 * já coberto por isCustomerStory) nem com tutorial ("How to use X", coberto por
 * isTutorialByKeyword antes do bloco de lançamento). Guard: não dispara se há
 * verbo de anúncio — anúncio sempre vence (evita falso-negativo em launches).
 */
// Removida a branch "what" do EN: `what the …` casava títulos de marketing/FAQ
// de lançamento ("What the new GPT-5 API unlocks") → falso-positivo. PT-BR
// adicionado (#1717 review) pra consistência com os helpers irmãos (DEAL/UPDATE
// já têm PT): como X funciona/ajuda, por que, entendendo, um guia para/de.
const EXPLAINER_TITLE_RE =
  /^\s*(how\s+\S+.*\b(help|helps|works?|thinks?|enabl\w+|chang\w+|matters?|powers?|reshap\w+|learns?)\b|why\s+\w|beyond\s+\w|understanding\s+\w|a\s+(guide|primer|deep[-\s]?dive|look)\s+(to|on|into|at)\b|the\s+case\s+for\b|lessons?\s+(from|learned|of)\b|rethinking\s+\w|demystif\w+|explained\b|como\s+\S+.*\b(funciona|funcionam|ajuda|muda|importa|aprende)\b|por\s?que\s+\w|entendendo\s+\w|um\s+guia\s+(para|de|sobre|completo)\b|o\s+caso\s+(a\s+favor\s+)?(de|para)\b)/i;

export function isExplainerByTitle(article: Article): boolean {
  if (hasLaunchVerb(article)) return false; // anúncio explícito vence
  return EXPLAINER_TITLE_RE.test(article.title ?? "");
}

/**
 * #1712: artigo em domínio/pattern de TUTORIAL que NÃO é tutorial — é
 * notícia/comentário/análise. Os domínios de "Use Melhor" (cookbook.openai.com,
 * blogs de devrel) também postam comentário/cobertura, e a classificação por
 * domínio (sem checagem de intenção) os jogava em use_melhor indevidamente.
 *
 * MUITO conservador — falso-ejetar um tutorial real custa mais que manter um
 * comentário borderline. Só desclassifica com sinal inequívoco de não-tutorial:
 *   - type_hint do agent (que LEU a página) = noticia OU opiniao, OU
 *   - business deal (funding/M&A) ou relatório no título.
 *
 * Deliberadamente NÃO usa:
 *   - `isExplainerByTitle` — "How X works" / "Understanding Y" / "A guide to Z"
 *     são EXATAMENTE os títulos de tutoriais canônicos nesses domínios
 *     (fast.ai, eugeneyan, Raschka). Usá-lo aqui ejetaria tutoriais reais
 *     pro RADAR (#1717 review). O prefixo explainer só desclassifica em domínio
 *     de LANÇAMENTO (lá um "How X works" é explainer, não tutorial).
 *   - `type_hint === "analise"` — deep-dives analíticos nesses domínios são
 *     frequentemente tutoriais ("Building an LLM from scratch", "Evaluating
 *     LLMs: a reference"); ejetá-los esvaziaria use_melhor.
 */
export function isNewsNotTutorial(article: Article): boolean {
  if (isTutorialByKeyword(article)) return false; // sinal de how-to vence
  if (article.type_hint === "noticia" || article.type_hint === "opiniao") {
    return true;
  }
  return isBusinessDeal(article) || isReport(article);
}

/**
 * #1453: detecta resultado científico/pesquisa em domínio que normalmente
 * seria lançamento. Patterns são CONSERVADORES — pedem contexto explícito
 * pra evitar match em marketing copy ("breakthrough in performance",
 * "proves capable", "proof of concept").
 *
 * Caso real 260522: openai.com/index/model-disproves-discrete-geometry-conjecture
 * passou todas as defenses anteriores e virou LANÇAMENTO indevidamente.
 */
const RESEARCH_RESULT_PATTERNS: RegExp[] = [
  // Verbos de prova/refutação acadêmica — precisam de objeto matemático
  // (conjectura, teorema, problem, proof) pra evitar match em "proves itself"
  /\b(disprove[sd]?|refute[sd]?)\s+(?:a|an|the|its|some|this|that)\s+(conjectur|theorem|hypothesis|lemma|problem|proof)/i,
  /\b(prove[sd]?\s+(?:a|an|the)\s+(conjectur|theorem|hypothesis|lemma|problem))/i,
  /\b(solve[sd]?\s+(?:a|an|the)?\s*\d+-year-old|solve[sd]?\s+(?:a|an|the)\s+(conjectur|theorem|hypothesis|problem))/i,
  // Termos puramente acadêmicos no título (sem ambiguidade com marketing)
  /\b(conjectur(e|a)|lemma|theorem)\b/i,
  // "open problem" em contexto matemático (com modificador acadêmico)
  /\b(long-standing|open|unsolved|unresolved)\s+(open\s+)?problem\s+(in|of|from)\s+\w+/i,
  // PT — prova/refutação com objeto acadêmico (resolv[eu]? não casava "resolveu",
  // agora aceita formas conjugadas)
  /\b(refuta(m|r|ram|ria)?|resolv(eu|e|emos|eram|ido)|comprova(m|r|ram)?)\s+(?:a|o|uma|um)\s+(conjectur|problem|teorema|hip[oó]tese)/i,
  // URL path com slug acadêmico explícito
  /\/(disprov|refut|solv|prov)(e|es|ed)?-(a|the|an|model)?-?(conjectur|theorem|problem|geometry|math)/i,
];
export function isLikelyResearchResult(article: Article): boolean {
  const hay = `${article.title ?? ""}\n${article.summary ?? ""}\n${article.url ?? ""}`;
  return RESEARCH_RESULT_PATTERNS.some((p) => p.test(hay));
}

/**
 * #1453: detecta milestone de logística/entrega — \"ships TO {client}\",
 * \"first units\", \"arrives at\", \"lands at\". Patterns CONSERVADORES —
 * \"delivers\" e \"ships\" bare NÃO casam (marketing comum).
 *
 * Caso real 260522: blogs.nvidia.com/blog/vera-cpu-delivery/ — \"NVIDIA's First
 * CPU Built for Agents Lands at Top AI Labs\".
 */
const LOGISTICS_PATTERNS: RegExp[] = [
  // "ships to {entity}" e "delivered to {entity}" — precisa destino explícito
  /\b(ships?|shipped|deliver(ing|ed|s)?)\s+to\s+(top|major|first|enterprise|select|early|partner|its|the)\b/i,
  // "first units" e "arrives at/in {client}" — explícito milestone de logística
  /\bfirst\s+units?\b/i,
  /\barrives?\s+at\s+\w+\s+labs?\b/i,
  /\blands?\s+at\s+\w+\s+labs?\b/i,
  // URL path com slug explícito de entrega
  /\/[\w-]*-cpu-delivery(\/|$)|\/(hardware-)?delivery-to-/i,
];
export function isLogisticsMilestone(article: Article): boolean {
  const hay = `${article.title ?? ""}\n${article.summary ?? ""}\n${article.url ?? ""}`;
  return LOGISTICS_PATTERNS.some((p) => p.test(hay));
}

/**
 * #1453: detecta URL com slug que parece nome de empresa cliente
 * (\`/adventhealth\`, \`/databricks\`, \`/kpmg\`) em domínios oficiais
 * tipo openai.com/index/ — sinal de customer story / partnership.
 *
 * Heurística conservadora: **só single-token slugs** (sem hyphens) com 4-25
 * chars, alphabetic, sem aparecer no título do artigo como produto.
 * Multi-token slugs (\"claude-creative-work\", \"gpt-5-flash\") são quase
 * sempre nomes de produto/feature, não clientes — não casamos pra evitar
 * falso-positivo (caso \"Claude for Creative Work\" vira noticias indevidamente).
 *
 * Combinar com `!hasLaunchVerb(article)` no caller pra cobrir o edge case
 * \"single-token brand launching\" (raro mas possível).
 */
export function isCustomerSlug(url: string): boolean {
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\/+$/, "");
    const segments = path.split("/").filter(Boolean);
    if (segments.length === 0) return false;
    const last = segments[segments.length - 1].toLowerCase();
    // Single-token only (no hyphens) — restrição vs multi-token slugs (#1453)
    if (last.includes("-")) return false;
    // Length check: customer names tendem a ser 4-25 chars
    if (last.length < 4 || last.length > 25) return false;
    // Alphabetic only (sem números/versões)
    if (!/^[a-z]+$/.test(last)) return false;
    // Skip se aparece em lista de palavras genéricas / produto
    const genericSlugs = new Set([
      "news", "blog", "post", "article", "index", "story", "stories",
      "research", "papers", "tools", "products", "features", "updates",
      "docs", "guide", "guides", "learn", "tutorial", "tutorials",
      "about", "contact", "team", "careers", "jobs", "press",
      "support", "help", "pricing", "plans", "compare",
    ]);
    if (genericSlugs.has(last)) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * #1852: pesquisa identificada pelo SLUG (não só pelo título). Ocorre quando um
 * lab posta um paper/resultado de conferência no próprio blog oficial e o slug
 * carrega a sigla da conferência, mas o título não. Caso 260605:
 * blogs.nvidia.com/blog/cvpr-research-grasping-driving-agent-training/ — slug tem
 * `cvpr-research`, título não tinha keyword de pesquisa → caía em lançamento.
 *
 * Só siglas de conferência de ALTA precisão + arxiv/preprint. `research` cru NÃO
 * entra (casaria "research preview", que é termo de lançamento). `nips` (nome
 * legado do NeurIPS) ficou de fora — `neurips` cobre o nome atual e `nips`
 * colide com token solto (review #1875).
 */
const RESEARCH_SLUG_RE =
  /\b(cvpr|neurips|iclr|icml|iccv|eccv|aaai|emnlp|naacl|siggraph|interspeech|arxiv|preprint)\b/i;
export function isResearchBySlug(url: string): boolean {
  let slug = "";
  try {
    slug = decodeURIComponent(new URL(url).pathname).replace(/[-_/]+/g, " ");
  } catch {
    return false;
  }
  return RESEARCH_SLUG_RE.test(slug);
}

/**
 * #1852: "Frontiers" é a série de customer stories da OpenAI
 * (openai.com/index/{empresa}-frontiers). Caso 260605:
 * openai.com/index/endava-frontiers — estudo de caso da Endava, não lançamento.
 * O slug é multi-token (`endava-frontiers`), então escapa o `isCustomerSlug`
 * (single-token only). Match host+path específico pra não pegar um produto que
 * por acaso tenha "frontiers" no nome.
 */
const OPENAI_FRONTIERS_RE = /^openai\.com\/index\/[a-z0-9-]*frontiers(\/|$)/i;
export function isOpenAIFrontiersStory(url: string): boolean {
  const { full } = hostAndPath(url);
  return OPENAI_FRONTIERS_RE.test(full);
}

// #1473/#1790: looksEnglish movido pro lib canônico (./lib/lang-detect.ts,
// importado no topo) — era duplicado aqui e em stitch-newsletter.ts.

/**
 * #1472: detecta artigo hospedado em blog de terceiro sobre produto de outra empresa.
 * Caso real 260525: huggingface.co/blog/nvidia/nemotron-labs-diffusion — post da NVIDIA
 * publicado no blog da HuggingFace. URL bate o pattern de lancamento (huggingface.co/blog/)
 * mas o conteúdo é sobre produto da NVIDIA, não da HuggingFace.
 *
 * Heurística: se o path contém subdiretório com nome de empresa conhecida
 * (da lista OFFICIAL_SOURCES), o artigo é sobre o produto daquela empresa
 * publicado em plataforma de terceiro → noticias.
 */
const THIRD_PARTY_BLOG_HOSTS = new Set(["huggingface.co"]);
const KNOWN_COMPANY_SLUGS: Set<string> = (() => {
  const slugs = new Set<string>();
  for (const src of OFFICIAL_SOURCES) {
    slugs.add(src.company.split(/[\s\/()]+/)[0].toLowerCase());
    for (const d of src.domains ?? []) {
      slugs.add(d.split(".")[0].replace(/^(blogs|developer|ai|about|engineering)$/, ""));
    }
  }
  slugs.delete("");
  return slugs;
})();
export function isThirdPartyBlogAboutOtherCompany(url: string): boolean {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "");
    if (!THIRD_PARTY_BLOG_HOSTS.has(host)) return false;
    const segments = u.pathname.split("/").filter(Boolean);
    // huggingface.co/blog/{company}/{slug} — check if segment after "blog" is a known company
    const blogIdx = segments.indexOf("blog");
    if (blogIdx < 0 || blogIdx + 1 >= segments.length) return false;
    const companySegment = segments[blogIdx + 1].toLowerCase();
    return KNOWN_COMPANY_SLUGS.has(companySegment);
  } catch {
    return false;
  }
}

/**
 * #1852: post de blog primeira-parte sobre a CLI/SDK própria (design/uso da
 * ferramenta), não a página oficial do produto. Caso 260605:
 * huggingface.co/blog/hf-cli-for-agents — design de uma CLI, não anúncio de
 * produto. Per #160, LANÇAMENTOS exige a página oficial do produto; um post de
 * /blog/ sobre uma ferramenta é cobertura/design → noticias (RADAR).
 *
 * Conservador: só nos hosts de blog-de-terceiro (huggingface.co) + path /blog/
 * + slug com token de tooling (`cli`/`sdk`). Um model release ("Introducing
 * SmolLM3") não casa (sem cli/sdk no slug) e segue como lançamento.
 */
const TOOLING_SLUG_RE = /\b(cli|sdk)\b/i;
export function isFirstPartyToolingBlog(url: string): boolean {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "");
    if (!THIRD_PARTY_BLOG_HOSTS.has(host)) return false;
    if (!/^\/blog\//i.test(u.pathname)) return false;
    const slug = decodeURIComponent(u.pathname).replace(/[-_/]+/g, " ");
    return TOOLING_SLUG_RE.test(slug);
  } catch {
    return false;
  }
}

/**
 * #1759: sinais TEXTUAIS de que o "lançamento" é re-anúncio de um produto que JÁ
 * existe (pré-existência). Lançamento = novidade da janela da edição; um blog
 * pode reescrever sobre produto antigo. A data do conteúdo estar na janela NÃO
 * basta. Sinais (alta precisão — um lançamento real diz "hoje"/"agora", não cita
 * ano nem "available since"):
 *   - "available since" / "disponível desde"
 *   - "originally/inicialmente launched/released/lançado"
 *   - "first launched/released/introduced/unveiled"
 *   - "lançado originalmente"
 *   - "launched/released/introduced/lançado in/em {ano}" (ano explícito = passado)
 *   - "lançado há meses/anos"
 *   - expansão regional de produto existente ("agora disponível no Brasil",
 *     "chega ao Brasil", "expande para a Europa") — disponibilidade nova de algo
 *     que já existe, não produto novo.
 * NÃO casa "released today", "now available in the API", "Gemini 2.0",
 * "Introducing Claude 4" — lançamentos reais.
 */
const MONTH_TOKEN =
  "(20\\d{2}|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|january|february|march|april|june|july|august|september|october|november|december|janeiro|fevereiro|mar[çc]o|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)";
const PRE_EXISTENCE_PATTERNS: RegExp[] = [
  // "available since {data passada}" — disponibilidade iniciada no passado.
  // Exige data/mês/ano após "since" pra não casar "available since this morning".
  new RegExp(`\\b(available|dispon[íi]vel)\\s+(since|desde)\\s+${MONTH_TOKEN}\\b`, "i"),
  // "originally/initially launched/released/introduced" — pré-existência inequívoca.
  /\b(originally|initially|inicialmente)\s+(launch|releas|introduc|lan[çc]ad)/i,
  /\blan[çc]ad[oa]\s+originalmente\b/i,
  // "back in {ano}" — retrospectivo; ninguém escreve "back in" pro ano corrente.
  /\bback\s+in\s+20\d{2}\b/i,
  // "{N} months/years ago" / "há {N} meses/anos" — passado explícito.
  /\b\d*\s*(months?|years?)\s+ago\b/i,
  /\bh[áa]\s+(\d+\s+)?(meses|anos)\b/i,
  // Expansão regional de produto existente (#1759: editor incluiu "qualquer
  // sinal de pré-existência", e.g. "agora no Brasil", "chega à América Latina").
  /\b(agora|now|finalmente)\s+(dispon[íi]vel|available)\b[^.\n]{0,30}\b(no\s+brasil|in\s+brazil|na\s+europa|in\s+europe|na\s+[ií]ndia|in\s+india|no\s+m[ée]xico|am[ée]rica\s+latina|latin\s+america)\b/i,
  /\b(chega(ndo)?|expande|expand(s|ing)?|llega)\b[^.\n]{0,25}\b(ao\s+brasil|to\s+brazil|[àa]\s+europa|to\s+europe|[àa]\s+am[ée]rica\s+latina|to\s+latin\s+america|new\s+(markets|regions))\b/i,
];

export function hasPreExistenceSignal(article: Article): boolean {
  const hay = `${article.title ?? ""}\n${article.summary ?? ""}`;
  return PRE_EXISTENCE_PATTERNS.some((p) => p.test(hay));
}

/**
 * #1759: release incremental (versão-ponto X.Y com Y≥1, COLADA ao nome) num blog
 * de hospedagem de TERCEIROS (huggingface.co/blog/{empresa-desconhecida}/...).
 * Uma versão .1/.5 implica predecessor → produto já existe (re-anúncio incremental).
 *
 * Dois guards pra não rebaixar lançamento real (review #1773):
 *   1. A empresa do path NÃO pode ser fonte oficial conhecida — HF hospeda blogs
 *      first-party de open-models (huggingface.co/blog/meta-llama/llama-3-1). Só
 *      rebaixa empresas fora de OFFICIAL_SOURCES (Holo3.1 = "Hcompany").
 *   2. Versão COLADA ao nome (`/[A-Za-z]\d+\.[1-9]/`, ex "Holo3.1") — não casa
 *      decimais soltos ("June 2.5", "rated 4.8 stars", "raised $3.5M") nem versões
 *      espaçadas ("Llama 3.1", "GPT-4.5") que são tipicamente lançamentos canônicos.
 * Caso 260603: Holo3.1 (huggingface.co/blog/Hcompany/holo31), lançado meses antes.
 */
export function isIncrementalReleaseOnThirdPartyBlog(article: Article): boolean {
  const { host } = hostAndPath(article.url);
  if (!THIRD_PARTY_BLOG_HOSTS.has(host)) return false;
  try {
    const segs = new URL(article.url).pathname.split("/").filter(Boolean);
    const blogIdx = segs.indexOf("blog");
    if (blogIdx < 0 || blogIdx + 1 >= segs.length) return false;
    // Empresa oficial conhecida (meta-llama, qwen, …) → lançamento real, mantém.
    if (KNOWN_COMPANY_SLUGS.has(segs[blogIdx + 1].toLowerCase())) return false;
  } catch {
    return false;
  }
  // versão-ponto Y≥1 COLADA ("Holo3.1"); ".0" é major/canônico → mantém.
  return /[A-Za-z]\d+\.[1-9]\d*\b/.test(article.title ?? "");
}

// ---------------------------------------------------------------------------
// Detecção de vídeos — YouTube e Vimeo (#359)
// ---------------------------------------------------------------------------

/**
 * Retorna true se a URL aponta para um vídeo em plataforma conhecida.
 * Detectado antes de qualquer outra regra no categorize() — vídeos nunca
 * devem cair em `lancamento`, `noticias` ou serem descartados como redes sociais.
 */
export function isVideoUrl(url: string): boolean {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "");
    if (host === "youtu.be") return true;
    if (host === "youtube.com" && u.pathname.startsWith("/watch")) return true;
    if (host === "vimeo.com") return true;
    return false;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hostAndPath(url: string): { host: string; full: string } {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "");
    return { host, full: host + u.pathname };
  } catch {
    return { host: "", full: "" };
  }
}

/**
 * Domínios e padrões que indicam TUTORIAL (conteúdo acionável — cookbooks,
 * walkthroughs, how-tos). Seção "Aprenda hoje" em #59.
 */
const TUTORIAL_DOMAINS = new Set([
  // #1760: simonwillison.net removido — agora em blacklist editorial
  // (scripts/lib/editorial-blocklist.ts), descartado no dedup antes de chegar aqui.
  // #1568 — novas fontes para seção "Use melhor"
  "cookbook.openai.com",
  "magazine.sebastianraschka.com",
  "www.fast.ai",
  "fast.ai",
  "blog.langchain.dev",
  "hamel.dev",
  "eugeneyan.com",
  "hub.asimov.academy",
]);

const TUTORIAL_PATTERNS: RegExp[] = [
  // Anthropic cookbook no GitHub
  /^github\.com\/anthropics\/anthropic-cookbook/,
  // HuggingFace learn section
  /^huggingface\.co\/learn\//,
  // DeepLearning.ai The Batch (domínio dedicado a tutoriais)
  /^deeplearning\.ai\/the-batch\//,
  // Latent Space (newsletter com tutoriais práticos)
  /^latent\.space\//,
  // Every Inc Chain of Thought (coluna tech com walkthroughs)
  /^every\.to\/chain-of-thought/,
  // #1568 — novas fontes
  /^(www\.)?pinecone\.io\/learn\//,
  /^(www\.)?kaggle\.com\/learn/,
  /^wandb\.ai\/site\/articles/,
  /^wandb\.ai\/fully-connected/, // #1862 — W&B "Fully Connected" (novo hub; /site/articles tinha feed morto)
  /^learn\.microsoft\.com\/.*\/(training|paths)\//i,
  // #1862 — fontes "Use Melhor" que migraram de domínio (RSS morto → WebSearch
  // site:). Path-scoped (não host-wide) pra não pegar páginas de produto.
  /^developers\.openai\.com\/cookbook/, // OpenAI Cookbook migrou de cookbook.openai.com
  /^(www\.)?langchain\.com\/blog/, // LangChain Blog migrou de blog.langchain.dev
];

/**
 * Keywords em título/summary que reforçam classificação como tutorial
 * quando o domínio não é dedicado (ex: artigo de tutorial publicado no
 * Medium ou blog pessoal).
 *
 * Regex conservador — evita falso positivo em:
 * - Papers acadêmicos com "A Tutorial on X" (precedência PESQUISA vem antes)
 * - "how to" genérico em press releases (exige contexto forte)
 */
const TUTORIAL_KEYWORDS_RE =
  /\b(cookbook|crash course|passo a passo|walkthrough|hands[- ]on|guia (passo a passo|pr[aá]tico|completo))\b|\btutorial:?\s|\bhow[- ]to\s+(build|create|deploy|train|fine[- ]?tune|implement|use)\b|\bbuild (your )?(first|own)\s/i;

function isTutorialByKeyword(article: Article): boolean {
  const hay = `${article.title ?? ""}\n${article.summary ?? ""}`;
  return TUTORIAL_KEYWORDS_RE.test(hay);
}

/**
 * Check se uma URL bateria com a whitelist oficial de LANÇAMENTOS
 * (sem considerar título). Usado por `scripts/validate-lancamentos.ts`
 * (#160) pra garantir que a seção LANÇAMENTOS do MD final só tem
 * links de domínio oficial.
 *
 * Não reaplica overrides (deal/scholarship/research) — só valida o
 * gate inicial de domínio. Dúvida = noticias.
 */
export function isOfficialLancamentoUrl(url: string): boolean {
  const { host, full } = hostAndPath(url);
  if (!host) return false;
  return (
    LANCAMENTO_DOMAINS.has(host) ||
    LANCAMENTO_PATTERNS.some((p) => p.test(full))
  );
}

/**
 * Classifica um artigo em uma categoria editorial.
 *
 * Ordem de avaliacao (primeira regra que bater vence):
 *  -1. Video -- YouTube/Vimeo tem precedencia absoluta sobre tudo.
 *   0. Tutorial por dominio dedicado (TUTORIAL_DOMAINS).
 *   0. Tutorial por pattern dedicado (TUTORIAL_PATTERNS).
 *   1. Pesquisa por dominio dedicado (PESQUISA_DOMAINS) + filtro arXiv.
 *   1. Pesquisa por pattern (PESQUISA_PATTERNS) + filtro arXiv.
 *  1b. Tutorial por keyword no titulo/summary (isTutorialByKeyword)
 *      -- vem depois de pesquisa pra evitar falso positivo em papers.
 *  1c. Tutorial por dominio extra com padrao de tutorial (isTutorialByDomainExtra).
 *  1c. Tutorial por titulo extra em dominio oficial (isTutorialByTitleExtra).
 *   2. Lancamento (dominio/pattern oficial), com overrides internos em ordem:
 *      a. Caminho /research/ -> pesquisa.
 *      b. Business deal (DEAL_PATTERNS) -> noticias.
 *      c. Anuncio nao-produto (bolsa/grant/fellowship) -> noticias.
 *      d. Update incremental (UPDATE_PATTERNS) -> noticias.
 *         IMPORTANTE: UPDATE_PATTERNS e avaliado ANTES de RESEARCH_IN_LAUNCH_DOMAIN.
 *         Titulo como An update on our research toward AGI vira noticias,
 *         nao pesquisa -- update ganha de research nesse conflito.
 *      e. Titulo com keyword de pesquisa (RESEARCH_IN_LAUNCH_DOMAIN) -> pesquisa.
 *      f. Default -> lancamento.
 *   3. type_hint pesquisa (quando dominio nao e jornalistico).
 *   4. Default -> noticias.
 */
export function categorize(article: Article): Category {
  const { host, full } = hostAndPath(article.url);

  // -1. Vídeo — detectado antes de qualquer outra regra (#359).
  //     URLs de YouTube/Vimeo nunca caem em noticias/lancamento nem são
  //     descartadas como redes sociais. Precedência absoluta.
  if (isVideoUrl(article.url)) return "video";

  // 0a. #1754: página de curso/formação — sinal forte de USE MELHOR. Vence o
  //     type_hint=noticia do agent (Haiku lê landing de formação e rotula mal).
  if (isCoursePage(article.url)) return "tutorial";

  // 0. Tutorial — domínio/pattern DEDICADO (alta confiança).
  //    Ordem: domínio > pattern > pesquisa > keyword > lancamento > default.
  //    Keyword tutorial vem DEPOIS de pesquisa pra evitar falso positivo
  //    em papers acadêmicos ("A Tutorial on Diffusion Models" em arxiv).
  // #1712: o domínio/pattern de tutorial é forte, mas esses blogs também postam
  // notícia/comentário/análise. Desclassificar (cair pro fluxo geral) quando há
  // sinal claro de não-tutorial — senão use_melhor fica poluído.
  if (TUTORIAL_DOMAINS.has(host) && !isNewsNotTutorial(article)) return "tutorial";
  if (TUTORIAL_PATTERNS.some((p) => p.test(full)) && !isNewsNotTutorial(article)) return "tutorial";

  // #1899 (Slice 2) / #2176 (path-mais-específico-vence):
  //
  // Quando múltiplas fontes cadastradas compartilham o mesmo host (ex: 'Google'
  // Primária em `blog.google` e 'Blog do Google Brasil' Tutoriais em
  // `blog.google/intl/pt-br/novidades/tecnologia`), a atribuição de bucket é
  // determinística pela especificidade do path:
  //   - A fonte com o prefixo MAIS LONGO que for prefixo da URL vence.
  //   - Empate de comprimento: use_melhor=1 vence; depois menor índice no CSV.
  //
  // Quando ALL_SOURCE_PREFIX_MAP está disponível (caso normal), usamos
  // resolveUseMelhorBySpecificity. Fallback para matchesUseMelhorPrefix (legado)
  // se o mapa falhou ao carregar.
  //
  // Híbrido lista+tipo: a flag cobre fontes dedicadas (kaggle.com/learn,
  // github.com/anthropics/anthropic-cookbook) que os patterns hardcoded não
  // pegavam; isTutorialByKeyword/etc seguem capturando how-to fora da lista.
  const _useMelhorBySpecificity = ALL_SOURCE_PREFIX_MAP.length > 0
    ? resolveUseMelhorBySpecificity(article.url, ALL_SOURCE_PREFIX_MAP)
    : (USE_MELHOR_PREFIXES.length > 0 && matchesUseMelhorPrefix(article.url, USE_MELHOR_PREFIXES) ? true : null);

  if (_useMelhorBySpecificity === true && !isNewsNotTutorial(article)) {
    return "tutorial";
  }
  // _useMelhorBySpecificity === false → URL pertence a uma fonte NOT use_melhor
  // (ex: 'Google' em blog.google) com path mais específico — não rotear pra
  // tutorial via seed-list. Porém isTutorialByKeyword/isTutorialByDomainExtra
  // ainda podem disparar abaixo para URLs com slug how-to explícito (ex:
  // blog.google/technology/how-to-get-started-with-gemini): esses sinais são
  // independentes do seed e não são "override" do path-specificity — o sinal
  // de seed cobre *cobertura* (fontes que o agent não detectaria como tutorial),
  // e o sinal de keyword cobre *conteúdo* (how-to no slug, independente da fonte).
  // _useMelhorBySpecificity === null → URL fora do seed → fallback por tipo normal.

  // 1. Pesquisa tem prioridade sobre lancamento quando o caminho é de paper
  if (PESQUISA_DOMAINS.has(host)) {
    // #501: arXiv retorna muitos papers off-topic. Filtrar por termos relevantes
    // ao tema da Diar.ia antes de classificar como pesquisa. Papers sem match
    // vão para "noticias" — o scorer vai penalizá-los por falta de contexto de IA
    // e eles dificilmente chegam ao gate editorial.
    if (!isArxivRelevant(article)) {
      console.error(`[categorize] arXiv off-topic → noticias: ${article.url}`); // #699
      return "noticias";
    }
    return "pesquisa";
  }
  if (PESQUISA_PATTERNS.some((p) => p.test(full))) {
    if (!isArxivRelevant(article)) {
      console.error(`[categorize] arXiv off-topic → noticias: ${article.url}`); // #699
      return "noticias";
    }
    return "pesquisa";
  }

  // 1b. Tutorial por keyword — só depois da checagem de pesquisa.
  //    Papers acadêmicos com "tutorial" no título já foram classificados
  //    como pesquisa acima.
  if (isTutorialByKeyword(article)) return "tutorial";

  // 1c. Tutorial por domínio extra ou título (domínio oficial mas conteúdo é tutorial).
  //     Aplicado ANTES do check de lançamento para que AWS ML Blog etc. não virem
  //     lancamento por default (#318).
  if (isTutorialByDomainExtra(article.url)) return "tutorial";
  if (isTutorialByTitleExtra(article)) return "tutorial";

  // 2. Lançamento (domínio oficial) — mas só se o tema for realmente
  //    anúncio de produto/feature. Desclassificar:
  //    - Path-blocklist (`/customers/`, `/futures`, `/b2b-signals`, …) → noticias (#898).
  //    - Business deals (parceria, aquisição, contrato de infra, investimento)
  //      → noticias.
  //    - Anúncios de programa/bolsa/grant/fellowship → noticias.
  //    - Customer stories / case studies / parcerias-com-cliente → noticias (#898).
  //    - Updates incrementais / changelogs → noticias (#318).
  //    - URLs em `/research/` de blogs de ML → pesquisa (papers, não produto).
  //    - SEM verbo de anúncio no título → noticias (#898). Defensive final.
  if (LANCAMENTO_DOMAINS.has(host) || LANCAMENTO_PATTERNS.some((p) => p.test(full))) {
    if (/\/research\//.test(full)) return "pesquisa";
    // #1852: sigla de conferência no slug (cvpr/neurips/...) → pesquisa, mesmo
    // que o agent rotule launch. Caso 260605: blogs.nvidia.com/blog/cvpr-research-…
    if (isResearchBySlug(article.url)) return "pesquisa";
    if (isNonLaunchPath(article.url)) return "noticias"; // #898
    // #1852: customer story "Frontiers" da OpenAI → noticias. Caso 260605:
    // openai.com/index/endava-frontiers. Roda antes do short-circuit type_hint.
    if (isOpenAIFrontiersStory(article.url)) return "noticias";
    // #1852: HF /blog/ sobre CLI/SDK própria = post de design da ferramenta, não
    // a página oficial do produto (#160). Caso 260605: hf-cli-for-agents. Roda
    // ANTES do short-circuit type_hint — o agent às vezes lê o post e o rotula
    // launch, mas o editor (260605) move pra RADAR; o blog não é a página do
    // produto. Escopo conservador (host HF + /blog/ + token cli/sdk) evita pegar
    // model release.
    if (isFirstPartyToolingBlog(article.url)) return "noticias";

    // #1759: re-anúncio de produto pré-existente → noticias. Roda ANTES do
    // short-circuit type_hint=lancamento: o agent às vezes rotula re-anúncio/
    // expansão como launch, e o sinal de pré-existência é autoritativo.
    //   (a) texto explícito ("available since", "lançado em {ano}", expansão regional);
    //   (b) versão-ponto (X.Y, Y≥1) em blog de TERCEIRO (huggingface.co) — não é
    //       link oficial (#160) e a versão .1/.5 implica predecessor. Caso Holo3.1.
    if (hasPreExistenceSignal(article)) return "noticias";
    if (isIncrementalReleaseOnThirdPartyBlog(article)) return "noticias";

    // #1173/#1453: type_hint=lancamento do source-researcher (Haiku que LEU
    // a página) curto-circuita TODAS as heurísticas defensivas abaixo.
    // Agent leu o conteúdo, é o sinal mais autoritativo. Caso: agent confirma
    // launch mesmo que título tenha "delivers" ou path tenha customer-name.
    if (article.type_hint === "lancamento") return "lancamento";

    if (isBusinessDeal(article)) return "noticias";
    if (isNonProductAnnouncement(article)) return "noticias";
    if (isCustomerStory(article)) return "noticias"; // #898
    if (isUpdate(article)) return "noticias";
    if (isReport(article)) return "noticias"; // #1096 — relatórios/análises não são lançamentos
    // #1698 — "How X helps", "Why...", "Beyond..." em blog oficial = explainer.
    // Roda APÓS o short-circuit type_hint==='lancamento' (acima): isso é
    // intencional. Se o agent LEU a página e confirmou lançamento, ele vence o
    // heurístico de título — reordenar geraria falso-positivo em launch blogs com
    // título explainer ("Why we built X", sem verbo de anúncio). O override de
    // explainer cobre o gap real do #1698: itens de RSS/websearch SEM type_hint.
    if (isExplainerByTitle(article)) return "noticias";
    if (isLikelyNewsNotLaunch(article.title ?? "")) return "noticias"; // #1442 — "X for {Country}" / "for Countries" / eventos / conferences / awards
    if (isThirdPartyBlogAboutOtherCompany(article.url)) return "noticias"; // #1472 — HF blog about NVIDIA etc.

    // #1453: resultado científico/prova matemática em domínio que normalmente
    // seria lançamento → pesquisa. Caso real 260522:
    // openai.com/index/model-disproves-discrete-geometry-conjecture.
    if (isLikelyResearchResult(article)) return "pesquisa";

    // #1453: milestone de logística/entrega em domínio oficial → noticias.
    // Caso real 260522: blogs.nvidia.com/blog/vera-cpu-delivery/.
    if (isLogisticsMilestone(article)) return "noticias";

    // #1453: slug single-token com nome de cliente em URL (ex:
    // openai.com/index/adventhealth, /databricks, /kpmg) → noticias.
    // Combinado com !hasLaunchVerb pra cobrir edge case "single-token
    // brand launching" (raro). type_hint=lancamento já curto-circuitou
    // acima — esse path só roda quando agent NÃO confirmou launch.
    if (isCustomerSlug(article.url) && !hasLaunchVerb(article)) return "noticias";

    // #486: títulos de pesquisa em domínio oficial → reclassificar como pesquisa
    if (RESEARCH_IN_LAUNCH_DOMAIN.test(article.title ?? "")) return "pesquisa";
    // #1544: technique/methodology posts in official blogs → pesquisa
    if (TECHNIQUE_IN_LAUNCH_DOMAIN.test(article.title ?? "")) return "pesquisa";

    // #1173: outros type_hints (pesquisa/noticia/analise/opiniao) também
    // vencem heurística — agent leu o conteúdo.
    if (article.type_hint === "pesquisa") return "pesquisa";
    if (article.type_hint === "noticia" || article.type_hint === "opiniao" || article.type_hint === "analise") return "noticias";

    // #898 / #1453: as overrides acima cobrem os falso-positivos comuns.
    // Default `lancamento` mantido pra títulos product-name-only ("Gemini 2.0",
    // "Claude 4 Sonnet") que NÃO contêm verbo de anúncio mas são lançamentos
    // reais. Inversão de default geraria falso-negativo agressivo nessas
    // peças canônicas — preferimos os 3 detectores específicos (#1453:
    // research-result, logistics-milestone, customer-slug) pra zerar os
    // falso-positivos da 260522 sem quebrar produtos nome-only.
    return "lancamento";
  }

  // 3. type_hint "pesquisa" como sinal secundário — ignorado em veículos jornalísticos
  //    que cobrem pesquisas mas não as produzem (#356).
  if (article.type_hint === "pesquisa" && !NOTICIAS_DOMAINS.has(host)) return "pesquisa";

  // 4. Default: notícia
  return "noticias";
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
