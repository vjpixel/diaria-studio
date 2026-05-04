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

export interface Article {
  url: string;
  title?: string;
  summary?: string;
  type_hint?: string;
  [key: string]: unknown;
}

export type Category = "lancamento" | "pesquisa" | "noticias" | "tutorial" | "video";

// ---------------------------------------------------------------------------
// Domínios e padrões que indicam LANÇAMENTO (anúncio oficial)
// ---------------------------------------------------------------------------

/**
 * Hostnames (sem www.) cujo conteúdo é predominantemente oficial da empresa.
 * Manter em ordem alfabética por empresa para facilitar manutenção.
 */
const LANCAMENTO_DOMAINS = new Set([
  // Adept
  "adept.ai",
  // AI21 Labs
  "ai21.com",
  // Amazon / AWS
  "aws.amazon.com",
  // Apple
  "developer.apple.com",
  "machinelearning.apple.com",
  // Character.AI
  "character.ai",
  // Cerebras
  "cerebras.ai",
  "cerebras.net",
  // Cohere
  "cohere.com",
  // DeepMind / Google
  "ai.google",
  "deepmind.com",
  "deepmind.google",
  // Fireworks AI
  "fireworks.ai",
  // Groq
  "groq.com",
  // Hugging Face (blog oficial — /papers/ fica em pesquisa)
  // tratado via LANCAMENTO_PATTERNS abaixo
  // Inflection
  "inflection.ai",
  // Lmarena / Chatbot Arena
  "lmarena.ai",
  // Meta AI
  "about.meta.com",
  "ai.meta.com",
  "engineering.fb.com",
  "llama.meta.com",
  "about.fb.com",
  // Microsoft (blog e research)
  "blogs.microsoft.com",
  // Mistral
  "mistral.ai",
  // NVIDIA
  "blogs.nvidia.com",
  "developer.nvidia.com",
  // OpenAI — removido: alto volume, usar LANCAMENTO_PATTERNS abaixo (#354)
  // Perplexity (apenas /hub/ e research. — resto é agregador)
  // tratado via LANCAMENTO_PATTERNS abaixo
  // Replicate
  "replicate.com",
  // RunwayML
  "runwayml.com",
  // SambaNova
  "sambanova.ai",
  // Scale AI
  "scale.com",
  // Stability AI
  "stability.ai",
  // Together AI
  "together.ai",
  // xAI (Grok)
  "x.ai",
  // Poolside (#355)
  "poolside.ai",
  // 01.ai / Yi (#355)
  "01.ai",
  // Aleph Alpha (#355)
  "aleph-alpha.com",
  // Reka AI (#355)
  "reka.ai",
  // Arcee AI (#355)
  "arcee.ai",
  // Liquid AI (#355)
  "liquid.ai",
  // Nomic AI (#355)
  "nomic.ai",
  // Imbue (#355)
  "imbue.com",
]);

/**
 * Padrões (regex contra hostname+pathname, sem www.) que indicam páginas
 * de anúncio/blog oficial em domínios que também hospedam outras coisas.
 */
const LANCAMENTO_PATTERNS: RegExp[] = [
  // Anthropic — blog e news (anthropic.com/* seria lancamento, exceto papers)
  /^anthropic\.com\/(news|blog|claude|research)\//,
  // AWS — apenas blog
  /^aws\.amazon\.com\/blogs?\//,
  // Apple — apenas ML blog e developer news
  /^machinelearning\.apple\.com\//,
  /^developer\.apple\.com\/news\//,
  // Hugging Face — apenas blog/ (não papers/)
  /^huggingface\.co\/blog\//,
  // Microsoft — blog e research
  /^techcommunity\.microsoft\.com\//,
  /^microsoft\.com\/(en-[a-z]+\/)?(research|blog)\//,
  // NVIDIA
  /^developer\.nvidia\.com\/(blog|technical-blog)\//,
  // Perplexity — apenas hub (anúncios de produto)
  /^perplexity\.ai\/hub\//,
  // Google Cloud blog
  /^cloud\.google\.com\/blog\//,
  // Google AI blog
  /^blog\.research\.google\//,
  // Meta AI research (pages, não the /research/ section que é paper)
  /^ai\.meta\.com\/(blog|news)\//,
  // Google blog — apenas anúncios de produto (blog.google tem posts de todo tipo) (#354)
  /^blog\.google\/(products|technology|outreach-initiatives)\//,
  // OpenAI — blog/index/news de produto (não research, compliance, principles) (#354)
  /^openai\.com\/(blog|index|news)\/(?!our-principles|safety-report|transparency|fedram|fido)/,
  // GitHub Pages como site oficial de projeto open-source — qualquer
  // {project}.github.io conta como lançamento (ex: openmoss.github.io
  // pra MOSS-Audio na 260429). Subdomain obrigatório (github.io bare
  // redireciona pra github.com). Tutoriais hospedados em github.io são
  // re-classificados antes via TUTORIAL_DOMAINS/PATTERNS (linhas 307-317).
  /^[a-z0-9][a-z0-9-]*\.github\.io\//,
];

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
 * Updates incrementais / changelogs / melhorias em produto existente.
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

function isUpdate(article: Article): boolean {
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

function isTutorialByDomainExtra(url: string): boolean {
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
  if (PESQUISA_DOMAINS.has(host)) return "pesquisa";
  if (PESQUISA_PATTERNS.some((p) => p.test(full))) return "pesquisa";

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
  //    - Business deals (parceria, aquisição, contrato de infra, investimento)
  //      → noticias.
  //    - Anúncios de programa/bolsa/grant/fellowship → noticias.
  //    - Updates incrementais / changelogs → noticias (#318).
  //    - URLs em `/research/` de blogs de ML → pesquisa (papers, não produto).
  if (LANCAMENTO_DOMAINS.has(host) || LANCAMENTO_PATTERNS.some((p) => p.test(full))) {
    if (/\/research\//.test(full)) return "pesquisa";
    if (isBusinessDeal(article)) return "noticias";
    if (isNonProductAnnouncement(article)) return "noticias";
    if (isUpdate(article)) return "noticias";
    // #486: títulos de pesquisa em domínio oficial → reclassificar como pesquisa
    if (RESEARCH_IN_LAUNCH_DOMAIN.test(article.title ?? "")) return "pesquisa";
    return "lancamento";
  }

  // 3. type_hint "pesquisa" como sinal secundário — ignorado em veículos jornalísticos
  //    que cobrem pesquisas mas não as produzem (#356).
  if (article.type_hint === "pesquisa" && !NOTICIAS_DOMAINS.has(host)) return "pesquisa";

  // 4. Default: notícia
  return "noticias";
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main(): void {
  const args = process.argv.slice(2);
  const articlesIdx = args.indexOf("--articles");
  const outIdx = args.indexOf("--out");

  if (articlesIdx === -1 || !args[articlesIdx + 1]) {
    console.error("Usage: categorize.ts --articles <articles.json> [--out <out.json>]");
    process.exit(1);
  }

  const articlesPath = args[articlesIdx + 1];
  const outPath = outIdx !== -1 ? args[outIdx + 1] : null;

  const articles: Article[] = JSON.parse(readFileSync(articlesPath, "utf8"));

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
    const cat = categorize(article);
    result[cat].push({ ...article, category: cat });
  }

  // Limite de 2 vídeos por edição — manter os primeiros (maior relevância por ordem de entrada).
  if (result.video.length > 2) {
    result.video = result.video.slice(0, 2);
  }

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
