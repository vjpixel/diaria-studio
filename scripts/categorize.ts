/**
 * categorize.ts
 *
 * Classifica artigos em lancamento / pesquisa / noticias usando regras de domínio.
 * Substitui o subagente `categorizer` (Haiku) por lógica determinística.
 *
 * Uso:
 *   npx tsx scripts/categorize.ts --articles <articles.json> [--out <out.json>]
 *
 * Input:  array JSON de artigos (post-dedup, com { url, title?, type_hint?, ... })
 * Output: { lancamento: [...], pesquisa: [...], noticias: [...] }
 *         cada artigo recebe campo adicional `category`
 *
 * Regras (espelham context/editorial-rules.md):
 *   - lancamento: URL no domínio oficial de empresa de tech (blog, news, release)
 *   - pesquisa:   URL em site acadêmico/de pesquisa (arxiv, openreview, etc.)
 *                 ou type_hint === "pesquisa" quando domínio não enquadra em lancamento
 *   - noticias:   todo o resto (jornalismo, análise, cobertura secundária, opinião)
 *
 * Dúvida entre lancamento e noticias: se URL não for do domínio oficial → noticias.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { exitWithError } from "./lib/exit-handler.ts";
import { parseArgs as parseCliArgs } from "./lib/cli-args.ts"; // #535
import { lancamentoDomains, lancamentoPatterns } from "./lib/official-domains.ts"; // #566
import { AI_RELEVANT_TERMS, containsAITerms, isArticleAIRelevant } from "./lib/ai-relevance.ts"; // #642
import type { Article } from "./lib/types/article.ts"; // #650
export { AI_RELEVANT_TERMS, isArticleAIRelevant };
export type { Article };

export type Category = "lancamento" | "pesquisa" | "noticias" | "tutorial" | "video";

// ---------------------------------------------------------------------------
// Domínios e padrões que indicam LANÇAMENTO (anúncio oficial) — #566
// Derivados de scripts/lib/official-domains.ts (fonte única de verdade).
// Para adicionar empresa nova: editar official-domains.ts, não aqui.
// ---------------------------------------------------------------------------
const LANCAMENTO_DOMAINS = lancamentoDomains();
const LANCAMENTO_PATTERNS = lancamentoPatterns();

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
  // Posts de aniversário: "AI Max Turns 1", "3 years of X" (#486)
  /\b(turns?\s+\d+|\d+\s+(years?|anos?)\s+of\b)/i,
  // Expansão incremental: "expansion to more X" (#486)
  /\bexpansion\s+to\s+(more|new)\b/i,
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
 * Anúncios de programa / bolsa / iniciativa não-produto. Cobrem blogs
 * oficiais que falam de scholarships, fellowships, grants, etc.
 */
const NON_PRODUCT_ANNOUNCEMENT_PATTERNS: RegExp[] = [
  /\b(announc(ing|es|ed)|launches?)\s+.{0,40}\b(scholar(s|ship)?|fellowship|grant(s)?|bolsa(s)?|program(a)?|residenc(y|ia)|competi[çc][ãa]o)\b/i,
  /\b(apple|google|meta|microsoft|openai|anthropic)\s+scholars?\b/i,
  /\b(research|compute)\s+grants?\b/i,
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
];

export function isNonLaunchPath(url: string): boolean {
  const { full } = hostAndPath(url);
  if (!full) return false;
  return NON_LAUNCH_PATH_PATTERNS.some((p) => p.test(full));
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
  "simonwillison.net",
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

  // 0. Tutorial — domínio/pattern DEDICADO (alta confiança).
  //    Ordem: domínio > pattern > pesquisa > keyword > lancamento > default.
  //    Keyword tutorial vem DEPOIS de pesquisa pra evitar falso positivo
  //    em papers acadêmicos ("A Tutorial on Diffusion Models" em arxiv).
  if (TUTORIAL_DOMAINS.has(host)) return "tutorial";
  if (TUTORIAL_PATTERNS.some((p) => p.test(full))) return "tutorial";

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
    if (isNonLaunchPath(article.url)) return "noticias"; // #898
    if (isBusinessDeal(article)) return "noticias";
    if (isNonProductAnnouncement(article)) return "noticias";
    if (isCustomerStory(article)) return "noticias"; // #898
    if (isUpdate(article)) return "noticias";
    // #486: títulos de pesquisa em domínio oficial → reclassificar como pesquisa
    if (RESEARCH_IN_LAUNCH_DOMAIN.test(article.title ?? "")) return "pesquisa";
    // #898: as overrides acima (path-blocklist, deal, customer-story,
    // non-product-announcement, update) cobrem os falso-positivos comuns.
    // `hasLaunchVerb` continua exposta como helper pra callers que queiram
    // gating mais agressivo (ex: scorer), mas não é gate aqui — quebraria
    // títulos product-name-only ("Gemini 2.0 Flash", "Claude for Creative Work").
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

export function categorizeArticles(articles: Article[]): Record<Category, Article[]> {
  const result: Record<Category, Article[]> = {
    lancamento: [],
    pesquisa: [],
    noticias: [],
    tutorial: [],
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
    result[cat].push({ ...article, category: cat });
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

  const stats = `lancamento:${result.lancamento.length} pesquisa:${result.pesquisa.length} noticias:${result.noticias.length} tutorial:${result.tutorial.length} video:${result.video.length}`;

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
