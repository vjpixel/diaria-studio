/**
 * use-melhor-curation.ts (#2276, #2278)
 *
 * Helpers determinísticos para curadoria da seção USE MELHOR:
 *   #2276 — Tutorial/academy boost + de-dup temático + cap por domínio
 *   #2278 — How-to discovery PT-BR: queries, allowlist BR, boost de sinal
 *
 * Todos os exports são funções puras, sem I/O, testáveis diretamente.
 */

// ---------------------------------------------------------------------------
// #2276 — Boost: tutorial/academy oficial
// ---------------------------------------------------------------------------

/**
 * Domínios que são plataformas de ensino oficial.
 * CTR de "Treinamento" (1.80% geral, 3.02% INT) é a categoria mais alta
 * do perfil — priorizar esses links surfaceando "academy:true" no scorer.
 */
export const TUTORIAL_ACADEMY_DOMAINS = new Set<string>([
  "learn.deeplearning.ai",
  "deeplearning.ai",
  "kaggle.com",
  "fast.ai",
  "www.fast.ai",
  "console.anthropic.com",
  "learndigital.withgoogle.com",
  "grow.google",
  "learn.microsoft.com",
  "academy.openai.com",
  "courses.nvidia.com",
  "hub.asimov.academy",
  "cursos.alura.com.br",
]);

/**
 * Paths de hosts amplos que indicam seção de cursos/tutoriais.
 */
const TUTORIAL_ACADEMY_PATHS: Array<{ host: string; pathPrefix: string }> = [
  { host: "huggingface.co", pathPrefix: "/learn" },
  { host: "developers.google.com", pathPrefix: "/machine-learning" },
  { host: "ai.google.dev", pathPrefix: "/gemini-api/docs" },
  { host: "github.com", pathPrefix: "/anthropics/anthropic-cookbook" },
  { host: "github.com", pathPrefix: "/openai/openai-cookbook" },
  { host: "cookbook.openai.com", pathPrefix: "/" },
  { host: "developers.openai.com", pathPrefix: "/cookbook" },
  { host: "langchain.com", pathPrefix: "/blog" },
  { host: "pinecone.io", pathPrefix: "/learn" },
  { host: "wandb.ai", pathPrefix: "/fully-connected" },
  { host: "learn.microsoft.com", pathPrefix: "/en-us/training" },
  { host: "learn.microsoft.com", pathPrefix: "/pt-br/training" },
  { host: "learn.microsoft.com", pathPrefix: "/en-us/paths" },
  { host: "blog.google", pathPrefix: "/intl/pt-br/novidades" },
];

const TUTORIAL_ACADEMY_TITLE_RE =
  /\b(curso|course|trilha|bootcamp|forma[cç][aã]o|lesson|li[cç][aã]o|m[oó]dulo|module|masterclass|workshop|lab\s+(?:pr[aá]tico|hands[- ]on)|tutorial\s+(?:completo|interativo|oficial|passo)|guia\s+(?:completo|oficial|passo\s+a\s+passo|pr[aá]tico)|learn(?:ing)?\s+(?:path|guide|course)|certifica(?:[cç][aã]o|tion))\b/i;

/**
 * #2276: retorna true se o artigo parece uma página de curso/tutorial
 * oficial de alta qualidade (sinal de "Treinamento" — top-CTR category).
 * Adicionado ao campo `matched` em audience-affinity para que o scorer
 * LLM dê bônus extra dentro do bucket use_melhor.
 */
export function isTutorialAcademy(url: string, title: string): boolean {
  let host = "";
  let pathname = "";
  try {
    const u = new URL(url);
    host = u.hostname.toLowerCase().replace(/^www\./, "");
    pathname = u.pathname;
  } catch {
    return false;
  }
  if (TUTORIAL_ACADEMY_DOMAINS.has(host) || TUTORIAL_ACADEMY_DOMAINS.has("www." + host)) {
    return true;
  }
  for (const { host: h, pathPrefix } of TUTORIAL_ACADEMY_PATHS) {
    if (host === h && pathname.startsWith(pathPrefix)) return true;
  }
  if (TUTORIAL_ACADEMY_TITLE_RE.test(title)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// #2276 — Filtro: marketing case study (não é how-to acionável)
// ---------------------------------------------------------------------------

/**
 * Padrões de título/summary que indicam case study de marketing.
 * Distingue de howto-tutorial legítimo:
 *   "Como usar IA para entrevista" — NOT matched (sem sujeito-empresa)
 *   "How to build a RAG pipeline" — NOT matched (infinitivo after "to")
 *   "How Rocket Close optimized document processing" — MATCHED
 */
const MARKETING_CASE_STUDY_RE =
  /(?:how\s+[A-Z]\w{2,}(?:\s+[A-Z]\w+){0,3}\s+(?:uses?|leverag(?:e[sd]?)?|adopted?|built|scaled?|optimized?|automated?|deployed?|achieved?|cut|saved?|reduced?)\b|how\s+we\s+(?:built|scaled?|optimized?|automated?|deployed?|achieved?|cut|saved?|reduced?)\s+\w|[A-Z]\w{2,}(?:\s+[A-Z]\w+){0,2}\s+(?:cuts?|saves?|reduces?|optimizes?|automates?)\s+(?:.{0,20})?(?:\d+%|costs?|time|hours?)\b|case\s+stud(?:y|ies)\s*:|estudo[s]?\s+de\s+caso\s*:)/i;

const MARKETING_SUMMARY_RE =
  /\b(roi\b|return\s+on\s+investment|cost.{0,10}saving|hours?\s+saved?|produtividade\s+aument|productivity\s+(?:gain|boost|increas))\b/i;

/**
 * #2276: retorna true se o artigo parece um case study de marketing —
 * "Como a Empresa X usou IA para otimizar Y". Uso: em categorize.ts,
 * checar ANTES de classificar como tutorial — se retornar true,
 * reclassificar para noticias (radar).
 */
export function isMarketingCaseStudy(title: string, summary: string): boolean {
  const hay = title + "\n" + summary;
  if (!MARKETING_CASE_STUDY_RE.test(hay)) return false;
  // Para "how we {verbo}", reforçar com sinal de negócio
  if (/\bhow\s+we\s+\b/i.test(title)) {
    return MARKETING_SUMMARY_RE.test(hay);
  }
  return true;
}

// ---------------------------------------------------------------------------
// #2276 — De-dup temático + cap por domínio em use_melhor
// ---------------------------------------------------------------------------

/** Artigo mínimo para as funções de dedup/cap. */
export interface UseMelhorArticle {
  url: string;
  title?: string;
  summary?: string;
  [k: string]: unknown;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

/**
 * Extrai domínio raiz para o cap (suporte a ccTLD duplo: .com.br, .co.uk).
 * Ex: "aws.amazon.com" → "amazon.com"; "canaltech.com.br" → "canaltech.com.br"
 */
export function rootDomain(url: string): string {
  const host = hostOf(url);
  if (!host) return "";
  const parts = host.split(".");
  const lastTwo = parts.slice(-2).join(".");
  const knownCompoundTlds = new Set([
    "com.br", "org.br", "net.br", "edu.br", "gov.br",
    "co.uk", "org.uk", "me.uk", "co.jp", "com.ar", "com.au", "co.nz",
  ]);
  if (parts.length >= 3 && knownCompoundTlds.has(lastTwo)) {
    return parts.slice(-3).join(".");
  }
  if (parts.length >= 2) return parts.slice(-2).join(".");
  return host;
}

const STOPWORDS = new Set([
  "como", "usar", "para", "uma", "com", "que", "por", "dos", "das",
  "seu", "sua", "nos", "nas", "aos", "pelo", "pela", "mais", "este",
  "essa", "isto", "bem", "ter", "ser", "foi", "sao", "tem", "vai",
  "passo", "guia", "aprenda", "comece", "aprend",
  "with", "from", "this", "that", "your", "have", "will", "using",
  "into", "what", "how", "build", "make", "create", "guide", "use",
  "the", "and", "for", "not", "but", "can", "all", "get", "new",
  "learn", "step", "start", "getting", "started",
  "builds", "building", "makes", "making", "creates", "creating",
  "runs", "running", "works", "working", "shows", "showing",
  "helps", "helps", "needs", "takes", "brings",
]);

/**
 * Extrai tokens-chave do título para de-dup temático.
 */
export function topicTokens(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .replace(/[^À-ɏa-z0-9\s]/gi, " ")
      .split(/\s+/)
      .filter((t) => t.length >= 4 && !STOPWORDS.has(t)),
  );
}

function intersectionSize(a: Set<string>, b: Set<string>): number {
  let count = 0;
  for (const t of a) if (b.has(t)) count++;
  return count;
}

/**
 * #2276: De-dup temático e cap por domínio nos candidatos use_melhor.
 *
 * Regras (items presume-se ordenados por score desc):
 *   1. Cap por domínio raiz (maxPerDomain, default 1)
 *   2. De-dup temático (minSharedTokens, default 2 tokens em comum)
 *
 * Caso 260615: 3/5 AWS Bedrock → após dedup, fica só 1 por domínio.
 */
export function dedupeUseMelhorBucket(
  items: UseMelhorArticle[],
  opts: { maxPerDomain?: number; minSharedTokens?: number } = {},
): UseMelhorArticle[] {
  const maxPerDomain = opts.maxPerDomain ?? 1;
  const minSharedTokens = opts.minSharedTokens ?? 2;

  const domainCount = new Map<string, number>();
  const keptTokens: Set<string>[] = [];
  const kept: UseMelhorArticle[] = [];

  for (const item of items) {
    const domain = rootDomain(item.url);
    const count = domainCount.get(domain) ?? 0;

    if (domain && count >= maxPerDomain) continue;

    if (item.title) {
      const tokens = topicTokens(item.title);
      if (tokens.size >= 2) {
        const isDuplicate = keptTokens.some(
          (kt) => intersectionSize(tokens, kt) >= minSharedTokens,
        );
        if (isDuplicate) continue;
        keptTokens.push(tokens);
      }
    }

    domainCount.set(domain, count + 1);
    kept.push(item);
  }

  return kept;
}

// ---------------------------------------------------------------------------
// #2278 — How-to discovery PT-BR aplicado
// ---------------------------------------------------------------------------

/**
 * Allowlist de fontes BR de alta qualidade para how-tos práticos.
 * DENYLIST (NÃO adicionar): findskill.ai, gptprompts.ai (SEO farms).
 */
export const HOWTO_BR_ALLOWLIST = new Set<string>([
  "canaltech.com.br",
  "tecnoblog.net",
  "techtudo.globo.com",
  "olhardigital.com.br",
  "meiobit.com",
  "startups.com.br",
  "exame.com",
  "infomoney.com.br",
  "b9.com.br",
]);

/**
 * #2278: retorna true se a URL é de uma fonte BR de how-to confiável.
 */
export function isHowtoBrAllowlisted(url: string): boolean {
  const host = hostOf(url);
  if (!host) return false;
  return HOWTO_BR_ALLOWLIST.has(host);
}

/**
 * #2278: sinal de how-to aplicado PT-BR no título/slug.
 * Boost: adiciona "howto_br:true" ao matched em audience-affinity.
 */
export const HOWTO_BR_SIGNAL_RE =
  /\b(?:como\s+usar\s+(?:ia|intelig[eê]ncia\s+artificial|chatgpt|o\s+chat(?:gpt)?|claude|gemini|copilot|llm)\b|como\s+fazer\s+.{0,30}\b(?:com|usando|via)\s+(?:ia|intelig[eê]ncia\s+artificial|chatgpt|claude|gemini)\b|passo\s+a\s+passo\s+(?:para|de|com)\b|guia\s+(?:para|de)\s+.{0,20}\b(?:ia|intelig[eê]ncia\s+artificial|chatgpt|claude|gemini)\b|(?:ia|intelig[eê]ncia\s+artificial)\s+(?:para|no)\s+(?:emprego|trabalho|curr[ií]culo|entrevista|estudos|concurso|pequena\s+empresa|empreendedor|planilha|financ|email|produtividade|freelanc|aut[oô]nom)\b)\b/i;

/**
 * #2278: retorna true se o título/slug tem sinal forte de how-to PT-BR.
 */
export function hasHowToBrSignal(url: string, title: string): boolean {
  if (HOWTO_BR_SIGNAL_RE.test(title)) return true;
  let slug = "";
  try {
    slug = decodeURIComponent(new URL(url).pathname).replace(/[-_/]+/g, " ");
  } catch {
    // URL inválida
  }
  return HOWTO_BR_SIGNAL_RE.test(slug);
}

// ---------------------------------------------------------------------------
// #2278 — Queries de discovery por edição
// ---------------------------------------------------------------------------

/**
 * Temas de how-to PT-BR para o passo de discovery dedicado.
 * Rotaciona para cobrir diferentes domínios de aplicação por edição.
 */
export const HOWTO_BR_DISCOVERY_TOPICS: readonly string[] = [
  "como usar IA para se preparar para entrevista de emprego",
  "como usar IA para criar curriculo",
  "como usar IA para estudar e passar em concurso",
  "como usar IA para pequena empresa e empreendedor",
  "como usar IA para produtividade no trabalho",
  "como usar IA para criar conteudo para redes sociais",
  "como usar ChatGPT para organizar planilhas",
  "como usar IA para financas pessoais",
  "como usar IA para atendimento ao cliente",
  "como usar IA para aprender ingles",
  "guia passo a passo IA para iniciantes Brasil",
  "como usar IA para freelancer e autonomo",
];

/**
 * #2278: retorna as queries de how-to PT-BR para discovery nesta edição.
 * Seleção pseudo-determinística por editionNum para variar por dia.
 *
 * @param editionNum  Número da edição (ex: parseInt("260615") = 260615).
 * @param count       Quantas queries retornar (default 3).
 */
export function getHowToDiscoveryQueries(
  editionNum: number,
  count = 3,
): string[] {
  const total = HOWTO_BR_DISCOVERY_TOPICS.length;
  const queries: string[] = [];
  for (let i = 0; i < count; i++) {
    const idx = (editionNum + i) % total;
    queries.push(HOWTO_BR_DISCOVERY_TOPICS[idx]);
  }
  return queries;
}
