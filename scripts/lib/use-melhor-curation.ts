/**
 * use-melhor-curation.ts (#2276, #2278)
 *
 * Helpers determinísticos para curadoria da seção USE MELHOR:
 *   #2276 — Tutorial/academy boost + de-dup temático + cap por domínio
 *   #2278 — How-to discovery PT-BR: queries, allowlist BR, boost de sinal
 *
 * Todos os exports são funções puras, sem I/O, testáveis diretamente.
 */

// #2469 (finding 4): isDevReleaseNote extraída para lib compartilhada (fonte única).
// (Não pode importar categorize.ts — dependência circular.)
import { isDevReleaseNote } from "./release-note-detect.ts";
// #2469 (finding 5): canonicalize para dedup robusto (UTM/fragment/trailing-slash).
import { canonicalize } from "./url-utils.ts";

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
  // "www.fast.ai" removed: URL parser strips www before lookup, "fast.ai" already covers it (#8).
  "console.anthropic.com",
  "learndigital.withgoogle.com",
  "grow.google",
  // "learn.microsoft.com" removed from domain set: would qualify ALL microsoft.com/learn URLs
  // regardless of path. TUTORIAL_ACADEMY_PATHS scopes to /training and /paths only (#8).
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
  // /anthropic-ai/anthropic-cookbook is the correct org (#8 — was /anthropics/anthropic-cookbook).
  { host: "github.com", pathPrefix: "/anthropic-ai/anthropic-cookbook" },
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
  // Note: `TUTORIAL_ACADEMY_DOMAINS.has("www." + host)` removed (#2309) — host already
  // has www stripped above, and the set contains no www-prefixed entries.
  if (TUTORIAL_ACADEMY_DOMAINS.has(host)) {
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
// Key change vs original: first alternative now requires >=2 consecutive capitalized
// words (company-name shape). Single tech-concept terms (LangChain, LLMs, RAG,
// Transformers) no longer false-positive as marketing case studies (#1 fix).
// Backtracking safety: .{0,20} replaced with [^\r\n]{0,20} (#4 fix).
const MARKETING_CASE_STUDY_RE =
  /(?:how\s+[A-Z]\w{2,}(?:\s+[A-Z]\w+){1,3}\s+(?:uses?|leverag(?:e[sd]?)?|adopted?|built|scaled?|optimized?|automated?|deployed?|achieved?|cut|saved?|reduced?)\b|how\s+we\s+(?:built|scaled?|optimized?|automated?|deployed?|achieved?|cut|saved?|reduced?)\s+\w|[A-Z]\w{2,}(?:\s+[A-Z]\w+){0,2}\s+(?:cuts?|saves?|reduces?|optimizes?|automates?)\s+(?:[^\r\n]{0,20})?(?:\d+%|costs?|time|hours?)\b|case\s+stud(?:y|ies)\s*:|estudo[s]?\s+de\s+caso\s*:)/i;

const MARKETING_SUMMARY_RE =
  /\b(roi\b|return\s+on\s+investment|cost[^\r\n]{0,10}savings?|hours?\s+saved?|produtividade\s+aument|productivity\s+(?:gain|boost|increas))\b/i;

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
 * Known limitation: techtudo.globo.com and g1.globo.com share rootDomain "globo.com",
 * so they count toward the same per-domain cap. Acceptable — both are Globo media properties.
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

function intersectionSize(a: Set<string>, b: Set<string>, earlyExitAt?: number): number {
  let count = 0;
  for (const t of a) {
    if (b.has(t)) {
      count++;
      // Short-circuit once we've confirmed the threshold is met (finding 4).
      if (earlyExitAt !== undefined && count >= earlyExitAt) return count;
    }
  }
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
 *
 * Ordering note (#6c): the caller at split-time passes pre-score order (not score-desc).
 * Cap keeps first-occurrence per domain. Future score-sorted callers get highest-score-first
 * for free. Do not assume score-ordering at this stage.
 *
 * Token tracking for capped items (#6a): when a domain-capped item is skipped, its topic
 * tokens are still added to the thematic-dedup pool to block near-duplicates from
 * different domains from slipping through.
 *
 * Empty rootDomain (#6b): items whose URL cannot be parsed get rootDomain="". The cap
 * is skipped (domain is falsy) — soft-fail, they still participate in thematic dedup.
 * Pinning this: do NOT cap on empty domain.
 */
export function dedupeUseMelhorBucket(
  items: UseMelhorArticle[],
  opts: { maxPerDomain?: number; minSharedTokens?: number } = {},
): UseMelhorArticle[] {
  const maxPerDomain = opts.maxPerDomain ?? 1;
  const minSharedTokens = opts.minSharedTokens ?? 2;

  const domainCount = new Map<string, number>();

  // seenTokens: unified fingerprint pool for ALL items that "claim" a topic slot —
  // both KEPT items and DOMAIN-CAPPED items (#2309 item 2, self-review findings 1-3).
  //
  // Threshold for near-dup check is adaptive per fingerprint size, with a floor of 2 (#2336):
  //   Math.max(2, Math.min(minSharedTokens, fingerprint.size))
  // This means:
  //   • 1-token fingerprint (e.g. {bedrock}) → threshold = max(2,1) = 2 (floor #2336):
  //     never blocks candidates. A 1-token fingerprint is too ambiguous to gate on.
  //     Domain cap already handles same-domain duplicates for this case.
  //   • ≥2-token fingerprint → threshold minSharedTokens (default 2): candidate must
  //     share ≥2 tokens. Prevents a generic token like "open" from a multi-token
  //     fingerprint {"open","bedrock"} from blocking unrelated articles (finding 1 fix).
  //
  // Size guard removed (#2309 item 2 + finding 2): 1-token items from kept AND capped
  // paths both register here, ensuring symmetric coverage. Items blocked by a previous
  // seenTokens entry also register (finding 3 fix: prevents thematic leak where only
  // the intermediary capped item — not the original kept item — shares tokens with the
  // later near-dup).
  //
  // #2336 floor: threshold never drops below 2, even for 1-token fingerprints.
  // Adaptive threshold `Math.min(minSharedTokens, st.size)` with st.size=1 → threshold=1
  // → any candidate containing that one generic token ('bedrock', 'open', etc.) is blocked,
  // causing over-block across different topics. Floor at 2 preserves #2325's genuine
  // near-dup catch (genuine near-dups still share ≥2 tokens) while preventing the
  // single-token over-block. A 1-token fingerprint effectively disables near-dup blocking
  // for that item (threshold=2 > fingerprint.size=1, so intersectionSize can never reach 2).
  const seenTokens: Set<string>[] = [];
  const kept: UseMelhorArticle[] = [];

  for (const item of items) {
    const domain = rootDomain(item.url);
    const count = domainCount.get(domain) ?? 0;

    // Compute tokens before the domain-cap check so that capped items still
    // contribute their token fingerprint to thematic dedup (#6a fix).
    const tokens = item.title ? topicTokens(item.title) : new Set<string>();

    if (domain && count >= maxPerDomain) {
      // Capped by domain — record tokens so thematic near-dups from other domains
      // are blocked. Adaptive threshold in the candidate check handles specificity.
      if (tokens.size >= 1) seenTokens.push(tokens);
      continue;
    }

    // Check near-dup against seenTokens with adaptive per-fingerprint threshold.
    // Candidates with no tokens (empty title) skip the dedup check entirely.
    if (tokens.size >= 1) {
      const isDuplicate = seenTokens.some((st) => {
        // #2336: floor at 2 so a 1-token fingerprint never sets threshold=1.
        // Without the floor, {"bedrock"} → threshold 1 → any article mentioning
        // "bedrock" on any topic is blocked as a near-dup (over-block).
        const threshold = Math.max(2, Math.min(minSharedTokens, st.size));
        return intersectionSize(tokens, st, threshold) >= threshold;
      });
      if (isDuplicate) {
        // Record this blocked candidate's tokens so a later near-dup of THIS
        // item is also caught (finding 3: prevents two-pool thematic leak).
        seenTokens.push(tokens);
        continue;
      }
    }

    // Accepted — record tokens and keep the item.
    if (tokens.size >= 1) seenTokens.push(tokens);
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
// #2305: [^\r\n]{0,N} prevents `.{0,N}` from crossing line boundaries.
// Also: separators between `fazer`/`guia` and the inline content use [^\S\r\n]+
// (horizontal-only whitespace) to prevent \s+ from matching a lone \n between
// 'como fazer' and 'usando ia' on a different line.
export const HOWTO_BR_SIGNAL_RE =
  /\b(?:como\s+usar\s+(?:ia|intelig[eê]ncia\s+artificial|chatgpt|o\s+chat(?:gpt)?|claude|gemini|copilot|llm)\b|como[^\S\r\n]+fazer[^\S\r\n]+[^\r\n]{0,30}\b(?:com|usando|via)\s+(?:ia|intelig[eê]ncia\s+artificial|chatgpt|claude|gemini)\b|passo\s+a\s+passo\s+(?:para|de|com)\b|guia\s+(?:para|de)[^\S\r\n]+[^\r\n]{0,20}\b(?:ia|intelig[eê]ncia\s+artificial|chatgpt|claude|gemini)\b|(?:ia|intelig[eê]ncia\s+artificial)\s+(?:para|no)\s+(?:emprego|trabalho|curr[ií]culo|entrevista|estudos|concurso|pequena\s+empresa|empreendedor|planilha|finan[cç]\w*|email|produtividade|freelan[cç]\w*|aut[oô]nom\w*)(?!\w))\b/i;

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
// #2339 — Classificação casual vs dev-iniciante
// ---------------------------------------------------------------------------

/**
 * Classe de audiência para um item USE MELHOR.
 *
 * - `"casual"`:       Tutorial para usuário não-técnico (leigo/consciente).
 *   Critérios: sinal how-to PT-BR, ferramenta consumer (ChatGPT/Gemini/Copilot),
 *   temática aplicada (carreira, produtividade, finanças), fonte BR de allowlist.
 *   Não requer código ou API.
 * - `"dev-iniciante"`: Tutorial técnico para desenvolvedor iniciante.
 *   Critérios: academy/curso oficial, getting-started, sinal "aprenda a programar
 *   IA", mas SEM indicadores avançados (fine-tuning, deployment, infra, agentes
 *   complexos).
 * - `"dev-avancado"`:  Tutorial técnico para desenvolvedor experiente — não entra
 *   nas duas cotas acima.
 */
export type UseMelhorAudienceClass = "casual" | "dev-iniciante" | "dev-avancado";

/**
 * Regex de conteúdo avançado — quando presente, classifica como `dev-avancado`
 * independente de outros sinais. Cobre: fine-tuning, RAG completo, agents/LangGraph,
 * infra de ML, verifiers, deployment, TPU/GPU, RLHF, distilação, vector stores.
 *
 * Nota: `agents?` sozinho é genérico (ex: "como usar agentes no ChatGPT"), então
 * é qualificado por termos de infra/framework ao redor.
 */
const RE_ADVANCED_DEV =
  /\b(fine[- ]?tun(ing|e|ed?)|rlhf|distillat(ion|ing)|deployment\s+(?:pipeline|infra|at\s+scale)|tpu\s+stack|langgraph|langchain\s+(?:agent|graph|multi)|multi[- ]?agents?|rag\s+pipeline|vector\s+(?:store|index|search|database)\s+(?:optim|scal|build|archit)|sentiment[- ]?analysis\s+pipeline|scikit[- ]?llm|verifier\s+(?:model|agent|chain|pipeline|module|framework)|llm[- ]?verifier|reward[- ]?verifier|legal\s+agent|end[- ]?to[- ]?end\s+pipeline|mlops|kubeflow|sagemaker\s+(?:training|pipeline|endpoint)|bedrock\s+(?:agent|fine|runtime))\b/i;

/**
 * Regex de sinal "dev iniciante" — termos de onboarding técnico sem infra avançada.
 * Exemplos: getting started, hello world, API key, build your first, intro to,
 * playground, cookbook, learn to code, iniciante dev.
 */
const RE_DEV_BEGINNER =
  /\b(getting[- ]?started|hello[- ]?world|api[- ]?key\b|build\s+your\s+first|intro(?:duction)?\s+to\s+(?:llm|ai|ml|python|prompt)|beginner(?:s?)\s+(?:guide|tutorial|course)|learn(?:ing)?\s+(?:python|typescript|javascript|coding|programming)\s+(?:with|using)?\s*(?:ai|ia)?|iniciante\s+(?:dev|programador|desenvolvedor)|python\s+para\s+iniciante|primeiros\s+passos\s+(?:com\s+)?(?:api|python|llm|dev|código)|playground\b|quickstart|step[- ]?by[- ]?step\s+(?:code|api|python|implementation)|notebook\s+(?:completo|tutorial|passo)|colab\b)/i;

/**
 * Regex de sinal casual (leigo/consciente): how-to em ferramentas consumer,
 * tópicos de produtividade/carreira/vida, sem setup técnico.
 */
const RE_CASUAL =
  /\b(chatgpt\s+(?:para|no|na|no\s+trabalho|gratis|gratuito)|gemini\s+(?:para|no|na)|copilot\s+(?:para|no)|notebooklm|como\s+usar\s+(?:ia|intelig[eê]ncia|chatgpt|gemini|claude|copilot)\s+(?:para|no|na|em)\b|passo\s+a\s+passo\s+(?:para|com|de)\b|IA\s+para\s+(?:emprego|trabalho|curriculo|currículo|entrevista|concurso|produtividade|redes\s+sociais|financ|planilha|autonomo|autônomo|freelanc|peque\w+\s+empresa|empreende(?:dor(?:e?s|as?)?|r)?|atendimento|ingles|inglês|estudos?)\b|tutorial[^\w]*(?:chatgpt|gemini|copilot|ia\s+para)|guia\s+(?:completo|prático|pratico)\s+(?:para|de)\s+(?:iniciantes|leigos|qualquer\s+um)|sem\s+(?:código|programar|saber\s+(?:programar|código))|sem\s+precisar\s+(?:programar|saber|código))\b/i;

/**
 * #2339: Classifica um item USE MELHOR como "casual", "dev-iniciante" ou "dev-avancado".
 *
 * Algoritmo (em ordem de precedência):
 *   1. Se título/summary tem sinal avançado (RE_ADVANCED_DEV) → dev-avancado (vence qualquer sinal PT-BR).
 *      Garante que artigo técnico avançado de fonte BR (ex: fine-tuning no canaltech) não caia em "casual"
 *      por causa de `howto_br_source:true`.
 *   2. Se tem sinal `"howto_br:true"` (slug URL) no audience_affinity.matched → casual.
 *   3. Se tem sinal `"howto_br_source:true"` (domínio BR, sinal mais fraco) → casual.
 *   4. Se tem sinal casual no texto (RE_CASUAL) → casual.
 *   5. Se tem sinal de dev-iniciante (RE_DEV_BEGINNER) ou academy (matched contém "academy:true") → dev-iniciante.
 *   6. Default: dev-avancado (conservador — não promover pro-novato sem sinal).
 *
 * @param item  Artigo com url, title, summary opcionais e audience_affinity opcionalmente anotado.
 */
export function classifyAudienceClass(
  item: {
    url?: string;
    title?: string;
    summary?: string;
    audience_affinity?: { matched?: string[] } | null;
  },
): UseMelhorAudienceClass {
  const matched = item.audience_affinity?.matched ?? [];
  const hay = [item.title ?? "", item.summary ?? ""].join(" ");

  // 1. Advanced dev signal always wins — even from a PT-BR tech source (fix: priority inversion)
  //    A fine-tuning/RAG article from canaltech.com.br gets howto_br_source:true annotated,
  //    but the content is dev-avancado. Strongest signal wins first.
  if (RE_ADVANCED_DEV.test(hay)) {
    return "dev-avancado";
  }

  // 2. howto_br:true (URL slug signal) → casual (strong PT-BR how-to indicator)
  if (matched.includes("howto_br:true")) {
    return "casual";
  }

  // 3. howto_br_source:true (weaker domain-only signal) + casual text content → casual.
  //    #2354 fix: domain origin alone is not enough — a clearly-technical BR article
  //    (e.g. fine-tuning tutorial on canaltech.com.br) should not be labeled casual just
  //    because the domain is in the allowlist. Require a casual TEXT signal (RE_CASUAL or
  //    HOWTO_BR_SIGNAL_RE) to confirm the content is genuinely non-technical.
  //    (RE_ADVANCED_DEV already handles the strongest technical override in step 1.)
  if (matched.includes("howto_br_source:true") && (RE_CASUAL.test(hay) || HOWTO_BR_SIGNAL_RE.test(hay))) {
    return "casual";
  }

  // 4. Casual signal in text
  if (RE_CASUAL.test(hay)) {
    return "casual";
  }

  // 5. Dev-beginner signal in text OR academy:true annotation
  if (RE_DEV_BEGINNER.test(hay) || matched.includes("academy:true")) {
    return "dev-iniciante";
  }

  // 6. Default: dev-avancado (conservador)
  return "dev-avancado";
}

/**
 * #2339: Seleciona os itens finais de USE MELHOR aplicando a cota 2 casual + 2 dev-iniciante.
 *
 * Estratégia:
 *   - Prefere preencher 2 casual + 2 dev-iniciante quando há candidatos suficientes.
 *   - Degrada graciosamente: se não há 2 de uma classe, preenche com a outra (nunca
 *     crasha, nunca adiciona item fora do pool).
 *   - Ordem de preferência dentro de cada classe: preserva ordem de entrada (presumida
 *     por score desc do scorer).
 *   - Itens "dev-avancado" só entram se uma das cotas não puder ser preenchida.
 *
 * @param items   Candidatos use_melhor (pós-dedup, pós-cap, em order de score desc).
 * @param target  Total máximo de itens (default 4 = STAGE_2_MAX_USE_MELHOR).
 * @returns       Array selecionado com ao máximo `target` itens.
 */
export function selectUseMelhorSplit(
  items: Array<{ url?: string; title?: string; summary?: string; audience_affinity?: { matched?: string[] } | null; [k: string]: unknown }>,
  target = 4,
): typeof items {
  if (items.length === 0) return [];

  const casual: typeof items = [];
  const devBeginner: typeof items = [];
  const devAdvanced: typeof items = [];

  for (const item of items) {
    const cls = classifyAudienceClass(item);
    if (cls === "casual") casual.push(item);
    else if (cls === "dev-iniciante") devBeginner.push(item);
    else devAdvanced.push(item);
  }

  // Quota: up to 2 casual + 2 dev-beginner; fill remaining from opposite class or advanced.
  //
  // #2353 guard: with target <= 2, the naive formula targetDev=min(2, target-2) yields 0,
  // silently giving dev-iniciante zero quota. When both classes exist and target >= 2,
  // guarantee dev-iniciante at least 1 slot (balanced split for small targets):
  //   - target=1: casual gets the slot (single slot → most accessible audience).
  //   - target=2 with both classes: 1 casual + 1 dev-iniciante (balanced 1+1).
  //   - target=3 with both: 2 casual + 1 dev-iniciante (or 1+2 via leftover fill).
  //   - target>=4: standard 2+2 quota.
  // The key invariant: targetCasual + targetDev <= target always.
  const bothClassesExist = casual.length > 0 && devBeginner.length > 0;
  let targetCasual: number;
  let targetDev: number;
  if (bothClassesExist && target >= 2 && target < 4) {
    // Small target with both classes: casual is the favored (harder-to-fill) class.
    // ceil for casual ensures casual >= dev on odd targets:
    //   target=3 → casual=2, dev=1  (2 casual + 1 dev — editorial standard)
    //   target=2 → casual=1, dev=1  (balanced 1+1)
    targetCasual = Math.ceil(target / 2);
    targetDev = target - targetCasual;
  } else {
    targetCasual = Math.min(2, target);
    targetDev = Math.min(2, target - targetCasual);
  }
  // #2366: drift-detection guard (not a routine warn). O warn original disparava
  // falso-alarme no caso legítimo de pool all-dev (sem casual): aí bothClassesExist
  // é false e caímos no else com targetDev=min(2, target-targetCasual)=0 — comportamento
  // correto, não merece warn. Adicionando `&& bothClassesExist` o warn só dispara se,
  // COM as duas classes presentes, a fórmula de quota acima produzir targetDev=0 — o que
  // hoje é estruturalmente impossível (target∈[2,4) → branch small dá targetDev≥1;
  // target≥4 → else dá targetDev=min(2,target-2)≥2). Fica como armadilha de regressão:
  // se a fórmula derivar no futuro e voltar a zerar dev com ambas as classes, o warn pega.
  if (targetDev === 0 && target >= 2 && devBeginner.length > 0 && bothClassesExist) {
    console.warn(
      `[selectUseMelhorSplit] targetDev computed to 0 with target=${target} and ${devBeginner.length} dev-iniciante candidates despite both classes existing — check quota logic`,
    );
  }

  const selected: typeof items = [];

  // Fill casual quota first
  selected.push(...casual.slice(0, targetCasual));
  // Fill dev-beginner quota
  selected.push(...devBeginner.slice(0, targetDev));

  // If we still have room (< target), fill with leftover casual, then dev-beginner, then advanced.
  const remaining = target - selected.length;
  if (remaining > 0) {
    const leftoverCasual = casual.slice(targetCasual);
    const leftoverDev = devBeginner.slice(targetDev);
    const extras = [...leftoverCasual, ...leftoverDev, ...devAdvanced];
    selected.push(...extras.slice(0, remaining));
  }

  return selected;
}

// ---------------------------------------------------------------------------
// #2278 — Queries de discovery por edição
// ---------------------------------------------------------------------------

/**
 * Temas de how-to PT-BR para o passo de discovery dedicado.
 * Rotaciona para cobrir diferentes domínios de aplicação por edição.
 *
 * #2339: Queries reescritas para mirar tutoriais passo-a-passo reais.
 * Problema: queries genéricas ("como usar IA para criar curriculo") voltavam com
 * listicles/matérias de jornal (Administradores, Público, R7) — jornalismo de
 * tema IA, não guias práticos. Solução: adicionar "tutorial passo a passo",
 * "como fazer", e site: filters para plataformas de tutorial. As queries PT-BR
 * são mantidas para preservar o alcance (PT-BR reach).
 *
 * Estratégia de enriquecimento (por query):
 *   a) Adicionar "tutorial passo a passo" ou "guia prático" ao final das queries
 *      mais genéricas para forçar indexadores a priorizar conteúdo how-to.
 *   b) Substituir queries amplas por pares (tema + verbo imperativo + ferramenta
 *      consumer específica) — ex: "crie seu currículo com ChatGPT passo a passo".
 *   c) Manter variedade de domínios de aplicação (carreira, finanças, negócio,
 *      redes sociais, estudos) para cobrir o perfil casual da audiência.
 */
export const HOWTO_BR_DISCOVERY_TOPICS: readonly string[] = [
  // Carreira / CV
  "tutorial passo a passo como criar curriculo com ChatGPT",
  "como se preparar para entrevista de emprego com IA guia pratico",
  // Estudos / concurso
  "tutorial como usar IA para estudar para concurso publico passo a passo",
  "guia pratico como usar ChatGPT para resumir textos e estudar",
  // Pequena empresa / empreendedor
  "tutorial passo a passo como usar IA para pequena empresa",
  "como usar ChatGPT para atendimento ao cliente guia iniciante",
  // Produtividade / planilhas
  "como usar IA para organizar planilhas Excel Google Sheets passo a passo",
  "tutorial como usar Copilot ou Gemini para produtividade no trabalho",
  // Redes sociais / conteudo
  "tutorial passo a passo como criar conteudo para redes sociais com IA",
  // Financas pessoais
  "guia como usar IA para financas pessoais iniciante passo a passo",
  // Iniciantes / geral
  "tutorial IA para iniciantes sem precisar programar passo a passo Brasil",
  // Freelancer / autonomo
  "como usar ChatGPT para freelancer e autonomo tutorial pratico",
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
  // #2305: guard NaN (e.g. parseInt("") = NaN) — fall back to slot 0 to avoid
  // pushing undefined entries into the discovery topics array.
  const safeBase = Number.isFinite(editionNum) ? editionNum : 0;
  // Clamp count to pool size to avoid duplicates (#5 fix).
  const safeCount = Math.min(count, total);
  const queries: string[] = [];
  for (let i = 0; i < safeCount; i++) {
    const idx = (safeBase + i) % total;
    queries.push(HOWTO_BR_DISCOVERY_TOPICS[idx]);
  }
  return queries;
}

// ---------------------------------------------------------------------------
// #2368 item 1 — Normalização de URL (barra dupla no path)
// ---------------------------------------------------------------------------

/**
 * Normaliza barras duplas no path de uma URL, preservando `https://` e
 * os componentes query (search) e fragment (hash) intactos.
 *
 * Caso real (260618): `https://eugeneyan.com//writing/working-with-ai/`
 * → `https://eugeneyan.com/writing/working-with-ai/`
 *
 * Regra: substituir `//` por `/` APENAS no pathname — query e fragment
 * podem conter URLs embutidas (ex: `?u=https://outro.com/post`) que não
 * devem ser tocadas.
 *
 * Implementação: usa `new URL()` para parsear e reconstruir com pathname
 * normalizado; query/hash permanecem byte-idênticos.
 *
 * @returns URL normalizada (string). Se a URL for malformada, retorna o input.
 */
export function normalizeUseMelhorUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // URL malformada (ex: sem protocolo, ftp://, etc.) — retornar como está.
    return url;
  }

  // #2414 / #2439 / HIGH fix: splice cirúrgico operando INTEIRAMENTE na string raw.
  //
  // Problema do código anterior: usava `parsed.pathname` (percent-encoded pelo
  // construtor URL) para calcular comprimento e depois indexar a string original
  // NÃO-encoded. Para URLs com caracteres não-ASCII no path (ex: /saúde, /ação)
  // o pathname encoded tem MAIS bytes que o raw, causando:
  //   - url.slice(pathStartIdx + parsed.pathname.length) começa cedo demais
  //   - a query string (?ref=email) é incluída na fatia de path e depois perdida
  //   - o path acentuado fica re-encoded no output (quebra byte-identidade do #2414)
  //
  // Fix: localizar o path na string raw estruturalmente (após '://'), depois
  // localizar onde o path TERMINA na string raw (primeiro '?' ou '#', ou fim),
  // e colapsar '//{2,}' APENAS dentro dessa fatia de path raw — nunca tocar
  // query/fragment. Preserva bytes: não re-encoda nada.
  const schemeEnd = url.indexOf("://");
  // schemeEnd deve sempre existir (URL válida passou pelo constructor acima)
  const pathStartIdx = schemeEnd !== -1 ? url.indexOf("/", schemeEnd + 3) : -1;
  if (pathStartIdx === -1) {
    // Fallback improvável: URL sem path (ex: "https://host" sem '/')
    console.warn(`[normalizeUseMelhorUrl] pathname não localizado estruturalmente — fallback toString(): ${url}`);
    parsed.pathname = parsed.pathname.replace(/\/{2,}/g, "/");
    return parsed.toString();
  }

  // Localizar onde o path termina na string raw: primeiro '?' ou '#' após o
  // início do path, ou o fim da string se não houver query/fragment.
  const qIdx = url.indexOf("?", pathStartIdx);
  const fIdx = url.indexOf("#", pathStartIdx);
  const pathEndIdx =
    qIdx === -1 && fIdx === -1
      ? url.length
      : qIdx === -1
        ? fIdx
        : fIdx === -1
          ? qIdx
          : Math.min(qIdx, fIdx);

  const rawPath = url.slice(pathStartIdx, pathEndIdx);
  // #2439 Item 2: /\/{2,}/g captura 2+ barras em uma passagem (evita residual //
  // que replace(/\/\//g,'/') deixaria de ///→//→/ em duas passagens).
  const normalizedRawPath = rawPath.replace(/\/{2,}/g, "/");

  if (normalizedRawPath === rawPath) {
    // Sem alteração no path — retornar original para preservar representação byte-a-byte.
    return url;
  }

  return url.slice(0, pathStartIdx) + normalizedRawPath + url.slice(pathEndIdx);
}

export interface UrlNormalizationResult {
  /** URL normalizada (igual à original se não havia `//` no path). */
  normalized: string;
  /** true se a URL foi modificada. */
  changed: boolean;
}

/**
 * #2368: Verifica e normaliza a URL de um item USE MELHOR.
 * Retorna `{ normalized, changed }` — o caller deve substituir item.url
 * se `changed === true` e sinalizar no gate.
 */
export function checkAndNormalizeUrl(url: string): UrlNormalizationResult {
  const normalized = normalizeUseMelhorUrl(url);
  return { normalized, changed: normalized !== url };
}

// ---------------------------------------------------------------------------
// #2447 — Estimativa de tempo auto-gerada para USE MELHOR
// ---------------------------------------------------------------------------

/**
 * Regex de tutorial longo (cursos, trilhas, workshops, formações).
 * Indica duração ≥30 min — mais do que um artigo curto.
 */
const LONG_TUTORIAL_RE =
  /\b(curso|course|trilha|bootcamp|forma[cç][aã]o|masterclass|workshop|certifica(?:[cç][aã]o|tion)|learn(?:ing)?\s+path|getting\s+started\s+with|end[- ]?to[- ]?end)\b/i;

/**
 * Regex de tutorial médio (~15 min): artigos how-to step-by-step, tutoriais
 * completos, guias práticos, cookbooks.
 */
const MEDIUM_TUTORIAL_RE =
  /\b(tutorial|guia\s+(?:completo|pr[aá]tico|passo\s+a\s+passo)|passo\s+a\s+passo|step[- ]?by[- ]?step|hands[- ]?on|walkthrough|cookbook|build(?:ing)?\s+(?:your|a|an)\b|crash\s+course|quickstart)\b/i;

/**
 * #2447 (opção b): Estima automaticamente o tempo de leitura/execução de um
 * item USE MELHOR com base no tipo de tutorial detectado no título.
 *
 * Heurística determinística (sem LLM):
 *   - Curso/trilha/formação/workshop/bootcamp → `(30 min)` (atividade longa)
 *   - Tutorial completo/passo-a-passo/guia/cookbook → `(15 min)` (how-to médio)
 *   - Default (artigo curto, how-to rápido) → `(5 min)`
 *
 * O resultado é sempre no formato canônico `(X min)` (#2450).
 * O editor pode ajustar livremente no gate.
 *
 * @param title    Título do artigo (usado para classificar o tipo).
 * @param url      URL do artigo (usado para detectar plataformas de curso).
 * @returns        String no formato `"(X min)"`.
 */
export function estimateUseMelhorTempo(title: string, url = ""): string {
  const hay = title;
  // Hoist: chamada única (finding 7 code-review #2464 — era chamado 2×).
  const isAcademy = isTutorialAcademy(url, title);
  // Plataformas de curso/academia → atividade longa (o editor vai p/ a plataforma
  // e consome mais do que lê um artigo).
  if (isAcademy && LONG_TUTORIAL_RE.test(hay)) {
    return "(30 min)";
  }
  // Plataformas de academy com título curto → médio por default
  if (isAcademy) {
    return "(15 min)";
  }
  // Tutorial/guia completo, passo-a-passo, cookbook → médio
  if (MEDIUM_TUTORIAL_RE.test(hay)) {
    return "(15 min)";
  }
  // Default: artigo curto, dica rápida, how-to simples
  return "(5 min)";
}

// ---------------------------------------------------------------------------
// #2450 — Normalização de formato de tempo: "— X min" → "(X min)"
// ---------------------------------------------------------------------------

/**
 * #2450: Normaliza o formato de estimativa de tempo de dash (`— X min`) para
 * parênteses (`(X min)`) numa string de descrição USE MELHOR.
 *
 * O editor pode digitar `— 15 min` como atalho; o stitch injeta a string,
 * e depois o lint Stage 4 verifica. Antes que o check rode, este helper
 * converte `— X min` → `(X min)` para que o formato canônico seja preservado
 * nos outputs. O lint aceita ambos os formatos (backwards-compat), mas o
 * formato CANÔNICO de saída do stitch é sempre `(X min)`.
 *
 * Regra: substitui `[–—] X min` (com variações: `~`, `de leitura`) pelo
 * equivalente entre parênteses em QUALQUER posição da string (não só no fim
 * — finding 1 do code-review #2464).
 *
 * @param desc  Linha de descrição de item USE MELHOR.
 * @returns     Descrição com `(X min)` no formato canônico; inalterada se
 *              já estiver no formato correto ou sem estimativa de tempo.
 */
export function normalizeDashToParens(desc: string): string {
  // Já tem parênteses com número? → formato canônico, não tocar.
  if (/\(\s*~?\s*\d+\s*min\b/.test(desc)) return desc;
  // Normaliza `[–—] ~? N min [sufixo opcional como "de leitura"]` em QUALQUER
  // posição da string (not só no fim — finding 1 code-review #2464).
  // Só o sufixo não-canônico de DURAÇÃO ("de leitura", "de execução") é descartado.
  // Toda outra prosa do editor após "min" é PRESERVADA — antes o `[^)–—\n]*` engolia
  // QUALQUER texto após "min" (ex: "X — 15 min para concluir o módulo" perdia a prosa;
  // perda de dado pega no code-review consolidado 260621). Agora só o allowlist explícito.
  return desc.replace(
    /[–—]\s*~?\s*(\d+)\s*min\b(?:\s+de\s+(?:leitura|execu[cç][aã]o))?/gi,
    (_match, minutes) => `(${minutes} min)`,
  );
}

// ---------------------------------------------------------------------------
// #2368 item 2 — Classificador de ensaio de opinião / estudo de pesquisa
// ---------------------------------------------------------------------------

/**
 * Domínios EXCLUSIVAMENTE de ensaio de opinião ou análise — sem how-to acionável.
 * Artigos desses domínios sem sinal how-to explícito no título devem ser
 * rebaixados (classified as "non-tutorial") pra não entrar no bucket use_melhor.
 *
 * Conservador: incluir apenas domínios onde >90% do conteúdo é opinião/análise.
 * Domínios mistos (hamel.dev, eugeneyan.com — que publicam tutoriais e ensaios)
 * são detectados pelo título via OPINION_ESSAY_TITLE_RE, não por domínio.
 *
 * Casos reais 260618:
 *   - hamel.dev opinion essay detectado por título ("Reflections on...", "My take on...")
 *   - langchain research study detectado por título ("Research Study: State of...")
 */
export const OPINION_ESSAY_DOMAINS = new Set<string>([
  // Newsletters/substack de opinião pura (nunca tutoriais hands-on):
  "garymarcus.substack.com",
  "thealgorithmicbridge.substack.com",
  // Nota: hamel.dev e eugeneyan.com NÃO estão aqui — ambos publicam tutoriais legítimos
  // e devem ser detectados pelo título (OPINION_ESSAY_TITLE_RE), não pelo domínio.
]);

/**
 * Padrões de título que indicam ensaio de opinião / perspectiva pessoal —
 * sem how-to acionável.
 *
 * Exemplos mis-bucketados em 260618:
 *   - "Working with AI: A Framework for Thought Leadership" (hamel.dev)
 *   - "Reflections on AI in 2025"
 */
// Nota (#2368 self-review): `opinion\b` (não `opinion[:\s]`) — o `\b` final do
// grupo externo mata `opinion[:\s]` quando casa `:` ou espaço (dois não-word
// chars consecutivos). `opinion\b` casa "Opinion:" e "opinion on" corretamente.
const OPINION_ESSAY_TITLE_RE =
  /\b(reflect(?:ions?|ing)\s+on\b|thoughts?\s+on\b|opinion\b|perspectiv(?:a|e)\s+(?:sobre|on)\b|ponto\s+de\s+vista\b|minha\s+(?:vis[aã]o|opini[aã]o|perspectiva)\b|my\s+(?:take|view|thoughts?)\s+on\b|framework\s+for\s+(?:thought|think|understand)|manifesto\b|what\s+i(?:'ve)?\s+learned\s+(?:from|about|after)\b|lessons?\s+(?:from|after|learned)\b|why\s+(?:i|we)\s+(?:think|believe|decided|chose|moved|stopped|gave\s+up)\b|state\s+of\s+(?:ai|ml|llm|rag|the\s+art)(?:\s+\w+){0,3}(?:\s+in\s+\d{4}|\s+\d{4}|\s+report|\s+survey)\b|year\s+in\s+review\b|\d{4}\s+(?:year\s+in|in)\s+review\b|predictions?\s+for\s+\d{4}\b|(?:ai|ml|llm)\s+(?:trends?|predictions?)\s+\d{4}\b)\b/i;

/**
 * Padrões de título que indicam estudo de pesquisa / paper / benchmark —
 * análise descritiva, não how-to acionável.
 *
 * Exemplos: "LangChain Research Study on LLM Adoption", "Benchmark: GPT vs Claude"
 */
// Nota (#2368 self-review):
//   - `analysis\s+of\b` REMOVIDO — over-match em tutoriais ("Hands-on analysis
//     of GPT-4", "sentiment analysis of data"). Os outros sinais já são específicos.
//   - `benchmark` agora EXIGE qualificador (`:`, `of`, `on`, `between`, `comparing`) —
//     sem ele, "How to Benchmark Your Models" casava por engano.
// Nota: o grupo NÃO tem `\b` final (cada alternativa ancora a si própria) — um
// `\b` externo após o `:` da forma "Benchmark:" falharia (`:` e espaço são ambos
// não-word, sem boundary). A forma colon (`benchmark(...):`) e a forma com
// qualificador-word (`benchmark of`) são alternativas separadas.
const RESEARCH_STUDY_TITLE_RE =
  /\b(research\s+(?:study|paper|report|findings?|survey)\b|estudo\s+(?:de\s+pesquisa|sobre|de\s+caso)\b|survey\s+(?:of|on|about)\b|benchmark(?:ing|s?)\s*:|benchmark(?:ing|s?)\s+(?:of|on|between|comparing)\b|whitepaper\b|white\s+paper\b|literature\s+review\b|systematic\s+review\b|meta[- ]?analysis\b|ablation\s+(?:study|test)\b|empirical\s+(?:study|analysis|evaluation|evidence)\b|estat[íi]sticas?\s+(?:de|sobre)\b|relat[óo]rio\s+(?:de|sobre|anual)\b|annual\s+report\b)/i;

/**
 * Guard de sinal how-to/tutorial. Se presente, o artigo é tutorial acionável
 * mesmo que o título também tenha sinal de opinião/estudo. Módulo-level
 * (#2368 self-review) — antes vivia inline dentro do branch de domínio, então
 * só guardava a via de domínio: "Hands-on analysis of GPT-4" e "step-by-step
 * survey of RAG" caíam como estudo apesar do sinal how-to explícito.
 */
const HOW_TO_GUARD_RE =
  /\b(how[- ]?to\b|tutorial\b|guia\b|passo\s+a\s+passo\b|como\s+(?:usar|fazer|criar|configurar|implementar|construir|desenvolver|instalar)\b|getting[- ]?started\b|walkthrough\b|hands[- ]?on\b|step[- ]?by[- ]?step\b|build(?:ing)?\s+(?:your|a|an)\b|crash\s+course\b)\b/i;

/**
 * #2368 item 2: retorna true se o artigo parece ser um ensaio de opinião ou
 * estudo de pesquisa — NÃO um tutorial hands-on acionável.
 *
 * Uso: no categorizador/scorer, checar antes de classificar como `use_melhor`.
 * Se retornar true, rebaixar para `radar` (ou excluir do bucket use_melhor).
 *
 * Precedência: sinal how-to explícito (HOW_TO_GUARD_RE) VENCE qualquer sinal de
 * opinião/estudo — um tutorial "Hands-on analysis of X" não é estudo. Depois
 * checamos domínio de opinião → título de opinião → título de estudo.
 *
 * @param url     URL do artigo.
 * @param title   Título do artigo.
 * @param summary Sumário/descrição opcional.
 */
export function isOpinionOrStudy(url: string, title: string, summary = ""): boolean {
  const hay = title + " " + summary;

  // 0. Sinal how-to explícito vence tudo — tutorial acionável, não opinião/estudo.
  if (HOW_TO_GUARD_RE.test(hay)) {
    return false;
  }

  // 1. Domínio de opinião conhecida (sem how-to, já garantido acima).
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    // URL inválida
  }
  if (OPINION_ESSAY_DOMAINS.has(host)) {
    return true;
  }

  // 2. Título com padrão de opinião — rebaixar independente do domínio.
  if (OPINION_ESSAY_TITLE_RE.test(hay)) {
    return true;
  }

  // 3. Título de estudo/pesquisa/benchmark — rebaixar independente do domínio.
  if (RESEARCH_STUDY_TITLE_RE.test(hay)) {
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// #2448 — Promoção de how-to do RADAR para USE MELHOR
// ---------------------------------------------------------------------------

/**
 * Sinal forte de how-to no título — usado pra promover do RADAR pro USE MELHOR.
 *
 * Mais restrito que HOW_TO_GUARD_RE (que vence opinião/estudo): aqui precisamos
 * de sinal MUITO explícito pra justificar mover do bucket radar, já que o
 * categorizador já tentou classificar. Requer verbo acionável explícito:
 *   - "Como usar/fazer/criar/configurar/implementar/construir/desenvolver"
 *   - "How to build/create/deploy/train/use"
 *   - "passo a passo / step-by-step"
 *   - "tutorial" ou "guia prático/completo"
 *   - Sinais how-to do HOWTO_BR_SIGNAL_RE (PT-BR consumer)
 *
 * Não basta HOW_TO_GUARD_RE (que inclui "guide" genérico) — queremos
 * conteúdo genuinamente acionável, não apenas levemente tutorial.
 */
// #2469 (finding 3): `tutorial\b` solto casava notícias SOBRE tutoriais
// ("New Tutorial Series on LLMs", "The State of Tutorials in 2026").
// Substituído por `tutorial\s*:` (com dois-pontos — sinal de how-to) e
// `tutorial\s+(?:passo|completo|pr[aá]tico|de\s+\w)` (com contexto how-to explícito).
//
// #2666: adicionados sinais PT-BR de how-to em manchete de imprensa — "veja como"
// e "veja o prompt". Padrão "X consegue fazer Y; veja como" é sinal de que o
// artigo é um tutorial disfarçado de manchete (não um simples anúncio de notícia).
// "aprenda a + verbo" é um padrão PT-BR de instrução direta.
// PRECEDÊNCIA: roundup (ROUNDUP_GUARD_RE em isRadarHowToEligible) vence esses
// sinais — "Newsletter: veja como usar X" → isRoundupSlug retorna true →
// isRadarHowToEligible retorna false antes de checar RADAR_HOWTO_PROMOTE_RE.
const RADAR_HOWTO_PROMOTE_RE =
  /\b(?:como\s+(?:usar|fazer|criar|configurar|implementar|construir|desenvolver|instalar|montar|rodar|executar)\b|how[- ]to\s+(?:build|create|deploy|train|fine[- ]?tune|implement|use|set[\s-]up|configure|run|install|make)\b|passo\s+a\s+passo\b|step[- ]by[- ]step\b|tutorial\s*:|tutorial\s+(?:passo|completo|pr[aá]tico|de\s+\w)|guia\s+(?:pr[áa]tico|completo|passo\s+a\s+passo)\b|veja\s+como\b(?=\s*(?:$|[.!?]))|veja\s+o\s+prompt\b|aprenda\s+a\s+(?:usar|criar|fazer|configurar|implementar|construir|desenvolver|instalar|montar|rodar)\b)/i;

/**
 * #2663: guard de roundup/newsletter para isRadarHowToEligible.
 * Definido localmente (não importado de categorize.ts) para evitar dependência circular.
 * Conservador: só os termos de alta precisão que tornam o slug inequivocamente um roundup.
 * Espelha ROUNDUP_SLUG_RE em categorize.ts — manter em sincronia ao editar.
 */
const ROUNDUP_GUARD_RE = /\b(newsletter|roundup|this[- ]week[- ]in)\b/i;

/**
 * #2448: identifica se um artigo do bucket RADAR tem sinal forte de how-to
 * acionável e deve ser promovido ao bucket USE MELHOR.
 *
 * Critérios (todos devem ser atendidos):
 *   1. Título tem sinal RADAR_HOWTO_PROMOTE_RE (how-to explícito).
 *   2. Título NÃO tem sinal de opinião/estudo (isOpinionOrStudy).
 *   3. Título NÃO é um anúncio de dev/feature ("New X in Y").
 *
 * Propositalmente conservador — falso-negativo (deixar how-to no RADAR) é
 * menos problemático que falso-positivo (promover análise ao USE MELHOR).
 *
 * @param url     URL do artigo.
 * @param title   Título do artigo.
 * @param summary Sumário/descrição opcional.
 */
export function isRadarHowToEligible(url: string, title: string, summary = ""): boolean {
  // #2663: newsletter/roundup no slug → não promover, mesmo que título tenha
  // sinal de how-to (ex: "Newsletter: veja como usar X"). Roundup > how-to.
  // Roda ANTES de RADAR_HOWTO_PROMOTE_RE para garantir a precedência.
  let urlSlug = "";
  try {
    urlSlug = decodeURIComponent(new URL(url).pathname).replace(/[-_/]+/g, " ");
  } catch {
    // URL inválida — prossegue sem slug
  }
  if (ROUNDUP_GUARD_RE.test(urlSlug) || ROUNDUP_GUARD_RE.test(title)) return false;

  // Sem sinal how-to explícito no título nem no slug PT-BR da URL → não promover.
  // #2469 (finding 3): checar também o slug da URL via HOWTO_BR_SIGNAL_RE —
  // conforme prometido no docstring, mas que antes nunca era chamado.
  if (!RADAR_HOWTO_PROMOTE_RE.test(title) && !HOWTO_BR_SIGNAL_RE.test(urlSlug)) return false;

  // Opinião ou estudo → não promover (how-to pode estar no summary, mas o conteúdo não é acionável).
  if (isOpinionOrStudy(url, title, summary)) return false;

  // "New X in Y" release note / dev announcement → não promover.
  // #2469 (finding 4): usa isDevReleaseNote importada de lib/release-note-detect.ts
  // (fonte única — elimina duplicação com a cópia em categorize.ts).
  if (isDevReleaseNote(title)) return false;

  return true;
}

/** Artigo mínimo aceito pela promoção radar→use_melhor. */
export interface RadarArticle {
  url: string;
  title?: string;
  summary?: string;
  [k: string]: unknown;
}

/**
 * #2448 (b): Promove how-tos do bucket RADAR para o bucket USE MELHOR.
 *
 * Percorre `radarItems` em ordem (presumida score desc) e move para USE MELHOR
 * aqueles que têm sinal forte de how-to (`isRadarHowToEligible`), respeitando:
 *   - Cap máximo de promoções (default `maxPromote = 2`) para não esvaziar o RADAR.
 *   - Não promover URLs que já estão em `useMelhorItems` (dedup por URL canônica).
 *
 * Retorna `{ newUseMelhor, newRadar, promoted }`:
 *   - `newUseMelhor` — use_melhor com os promovidos PREPENDED (score mais alto primeiro).
 *   - `newRadar`     — radar sem os promovidos.
 *   - `promoted`     — contagem de promoções realizadas.
 *
 * @param radarItems      Candidatos do bucket radar (score desc).
 * @param useMelhorItems  Itens já no bucket use_melhor.
 * @param maxPromote      Máximo de itens a promover (default 2).
 */
export function promoteHowTosFromRadar(
  radarItems: RadarArticle[],
  useMelhorItems: RadarArticle[],
  maxPromote = 2,
): {
  newUseMelhor: RadarArticle[];
  newRadar: RadarArticle[];
  promoted: number;
} {
  // #2469 (finding 5): usa canonicalize() em vez de toLowerCase() —
  // variantes com UTM params, fragment ou trailing-slash escapavam do dedup.
  const seenUrls = new Set<string>(
    useMelhorItems.map((a) => canonicalize(a.url)),
  );

  const promoted: RadarArticle[] = [];
  const remainingRadar: RadarArticle[] = [];

  for (const item of radarItems) {
    const canonUrl = canonicalize(item.url);
    if (
      promoted.length < maxPromote &&
      !seenUrls.has(canonUrl) &&
      isRadarHowToEligible(item.url, item.title ?? "", item.summary ?? "")
    ) {
      promoted.push(item);
      seenUrls.add(canonUrl);
    } else {
      remainingRadar.push(item);
    }
  }

  // Prepend promoted to use_melhor (higher-scored items first).
  const newUseMelhor = [...promoted, ...useMelhorItems];

  return {
    newUseMelhor,
    newRadar: remainingRadar,
    promoted: promoted.length,
  };
}
