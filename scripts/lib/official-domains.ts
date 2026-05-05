/**
 * official-domains.ts (#566)
 *
 * Registro canônico de domínios oficiais de empresas AI — fonte única de
 * verdade pra duas estruturas que antes viviam separadas e driftavam:
 *
 *   1. `LANCAMENTO_DOMAINS` (Set<string>) em `scripts/categorize.ts`
 *   2. `LANCAMENTO_PATTERNS` (RegExp[]) em `scripts/categorize.ts`
 *   3. `COMPANY_TO_DOMAIN` (Array<{keyword, domain}>) em `scripts/lib/launch-detect.ts`
 *
 * Adicionar empresa nova: 1 entry aqui propaga pra todas as 3 estruturas.
 *
 * Drift detectado antes da unificação (#566): deepseek.com estava em
 * COMPANY_TO_DOMAIN mas não em LANCAMENTO_DOMAINS — artigos oficiais da
 * DeepSeek eram marcados como notícia mesmo vindo do domínio oficial.
 */

export interface OfficialSource {
  /** Nome canônico pra display, debug e mensagens de erro. */
  company: string;
  /**
   * Hostnames onde QUALQUER URL é classificada como lancamento.
   * Vai pra `LANCAMENTO_DOMAINS` (Set). Vazio quando só paths específicos contam.
   */
  domains?: string[];
  /**
   * Padrões de path-específico pra hosts cujo domínio inteiro NÃO é oficial
   * (ex: openai.com tem /blog/ oficial mas também /careers/, /charter/ etc.).
   * Vai pra `LANCAMENTO_PATTERNS` (RegExp[]).
   */
  path_patterns?: RegExp[];
  /**
   * Regex (case-insensitive) que detecta o nome da empresa em títulos/summaries
   * de artigos de imprensa. Vai pra `COMPANY_TO_DOMAIN`.
   * Ausente quando a empresa não é suficientemente conhecida por nome.
   */
  detection_keywords?: RegExp;
  /**
   * Domínio oficial canônico pra sugestão de fonte primária.
   * Default: domains[0] ou extraído de path_patterns[0].
   * Necessário quando domains[] é vazio (ex: Anthropic — só path-restricted).
   */
  primary_domain?: string;
}

export const OFFICIAL_SOURCES: OfficialSource[] = [
  // -----------------------------------------------------------------------
  // Domínios com path-restriction (qualquer URL no host NÃO basta)
  // -----------------------------------------------------------------------
  {
    company: "Anthropic",
    path_patterns: [/^anthropic\.com\/(news|blog|claude|research)\//],
    detection_keywords: /\b(anthropic|claude)\b/i,
    primary_domain: "anthropic.com",
  },
  {
    company: "OpenAI",
    // #354: alto volume — só /blog/, /index/, /news/ (excl. principles, reports, etc.)
    path_patterns: [/^openai\.com\/(blog|index|news)\/(?!our-principles|safety-report|transparency|fedram|fido)/],
    detection_keywords: /\b(openai|chatgpt|gpt-?[0-9]+(\.[0-9]+)?o?|sora)\b/i,
    primary_domain: "openai.com",
  },
  {
    company: "Hugging Face",
    // /papers/ fica em pesquisa; só /blog/ conta como lancamento
    path_patterns: [/^huggingface\.co\/blog\//],
    detection_keywords: /\b(hugging ?face|hf)\b/i,
    primary_domain: "huggingface.co",
  },
  {
    company: "Perplexity",
    // /hub/ = anúncios de produto; research.perplexity.ai = pesquisa (outro host)
    path_patterns: [/^perplexity\.ai\/hub\//],
    detection_keywords: /\b(perplexity)\b/i,
    primary_domain: "perplexity.ai",
  },
  {
    company: "Google (blog)",
    // blog.google/products|technology = produto; cloud.google.com/blog = dev blog;
    // blog.research.google = pesquisa aplicada
    path_patterns: [
      /^blog\.google\/(products|technology|outreach-initiatives)\//,
      /^cloud\.google\.com\/blog\//,
      /^blog\.research\.google\//,
    ],
    detection_keywords: /\b(google ai|gemma)\b/i,
    primary_domain: "blog.google",
  },
  {
    company: "Microsoft (patterns)",
    // techcommunity e microsoft.com/research|blog — blogs.microsoft.com já em domains
    path_patterns: [
      /^techcommunity\.microsoft\.com\//,
      /^microsoft\.com\/(en-[a-z]+\/)?(research|blog)\//,
    ],
  },
  {
    company: "GitHub Pages",
    // {project}.github.io = site oficial open-source; subdomain obrigatório
    path_patterns: [/^[a-z0-9][a-z0-9-]*\.github\.io\//],
  },

  // -----------------------------------------------------------------------
  // Domínios any-path (qualquer URL no host = lancamento)
  // -----------------------------------------------------------------------
  {
    company: "Adept",
    domains: ["adept.ai"],
    detection_keywords: /\b(adept)\b/i,
  },
  {
    company: "AI21 Labs",
    domains: ["ai21.com"],
    detection_keywords: /\b(ai21)\b/i,
  },
  {
    company: "Amazon / AWS",
    domains: ["aws.amazon.com"],
  },
  {
    company: "Apple ML",
    domains: ["developer.apple.com", "machinelearning.apple.com"],
    detection_keywords: /\bapple (intelligence|ml|machine learning)\b/i,
    primary_domain: "machinelearning.apple.com",
  },
  {
    company: "Character.AI",
    domains: ["character.ai"],
    detection_keywords: /\b(character\.?ai)\b/i,
  },
  {
    company: "Cerebras",
    domains: ["cerebras.ai", "cerebras.net"],
    detection_keywords: /\b(cerebras)\b/i,
  },
  {
    company: "Cohere",
    domains: ["cohere.com"],
    detection_keywords: /\bcohere\b/i,
  },
  {
    company: "DeepMind / Google",
    domains: ["ai.google", "deepmind.com", "deepmind.google"],
    detection_keywords: /\b(deepmind|gemini)\b/i,
    primary_domain: "deepmind.google",
  },
  {
    // #566: estava em COMPANY_TO_DOMAIN mas não em LANCAMENTO_DOMAINS — drift corrigido
    company: "DeepSeek",
    domains: ["deepseek.com", "api-docs.deepseek.com"],
    detection_keywords: /\b(deepseek)\b/i,
  },
  {
    company: "Fireworks AI",
    domains: ["fireworks.ai"],
    detection_keywords: /\b(fireworks ai)\b/i,
  },
  {
    company: "Groq",
    domains: ["groq.com"],
    detection_keywords: /\b(groq)\b/i,
  },
  {
    company: "Inflection",
    domains: ["inflection.ai"],
    detection_keywords: /\b(inflection)\b/i,
  },
  {
    company: "Lmarena / Chatbot Arena",
    domains: ["lmarena.ai"],
    detection_keywords: /\blmarena\b/i,
  },
  {
    company: "Meta AI",
    domains: ["about.meta.com", "ai.meta.com", "engineering.fb.com", "llama.meta.com", "about.fb.com"],
    detection_keywords: /\b(meta ai|llama)\b/i,
    primary_domain: "ai.meta.com",
  },
  {
    company: "Microsoft",
    domains: ["blogs.microsoft.com"],
    detection_keywords: /\b(microsoft|copilot|phi-?[0-9]+)\b/i,
  },
  {
    company: "Mistral",
    domains: ["mistral.ai"],
    detection_keywords: /\b(mistral|mixtral|codestral)\b/i,
  },
  {
    company: "NVIDIA",
    domains: ["blogs.nvidia.com", "developer.nvidia.com"],
    detection_keywords: /\b(nvidia|cuda)\b/i,
    primary_domain: "blogs.nvidia.com",
  },
  {
    company: "Qwen / Alibaba",
    domains: ["qwenlm.github.io"],
    detection_keywords: /\b(qwen|alibaba)\b/i,
  },
  {
    company: "Replicate",
    domains: ["replicate.com"],
    detection_keywords: /\b(replicate)\b/i,
  },
  {
    company: "RunwayML",
    domains: ["runwayml.com"],
    detection_keywords: /\b(runway|runwayml)\b/i,
  },
  {
    company: "SambaNova",
    domains: ["sambanova.ai"],
    detection_keywords: /\bsambanova\b/i,
  },
  {
    company: "Scale AI",
    domains: ["scale.com"],
    detection_keywords: /\b(scale ai)\b/i,
  },
  {
    company: "Stability AI",
    domains: ["stability.ai"],
    detection_keywords: /\b(stability ai|stable diffusion)\b/i,
  },
  {
    company: "Together AI",
    domains: ["together.ai"],
    detection_keywords: /\b(together ai)\b/i,
  },
  {
    company: "xAI",
    domains: ["x.ai"],
    detection_keywords: /\b(xai|grok)\b/i,
  },
  {
    company: "Poolside",
    domains: ["poolside.ai"],
    detection_keywords: /\b(poolside)\b/i,
  },
  {
    company: "01.ai / Yi",
    domains: ["01.ai"],
    detection_keywords: /\b(01\.ai|yi (large|model))\b/i,
  },
  {
    company: "Aleph Alpha",
    domains: ["aleph-alpha.com"],
    detection_keywords: /\b(aleph alpha)\b/i,
  },
  {
    company: "Reka AI",
    domains: ["reka.ai"],
    detection_keywords: /\b(reka ai)\b/i,
  },
  {
    company: "Arcee AI",
    domains: ["arcee.ai"],
    detection_keywords: /\b(arcee ai)\b/i,
  },
  {
    company: "Liquid AI",
    domains: ["liquid.ai"],
    detection_keywords: /\b(liquid ai)\b/i,
  },
  {
    company: "Nomic AI",
    domains: ["nomic.ai"],
    detection_keywords: /\b(nomic)\b/i,
  },
  {
    company: "Imbue",
    domains: ["imbue.com"],
    detection_keywords: /\b(imbue)\b/i,
  },
  {
    // Adicionado em #566 — artigos de AI research do Samsung Research eram
    // classificados como noticias mesmo vindo do domínio oficial da empresa.
    company: "Samsung Semiconductor (AI research)",
    domains: ["research.samsung.com"],
  },
];

// ---------------------------------------------------------------------------
// View derivations — usadas por categorize.ts e launch-detect.ts
// ---------------------------------------------------------------------------

/** Set de hostnames onde qualquer URL é classifica como lancamento. */
export function lancamentoDomains(): Set<string> {
  const out = new Set<string>();
  for (const src of OFFICIAL_SOURCES) {
    for (const d of src.domains ?? []) {
      out.add(d);
    }
  }
  return out;
}

/** Lista de regexes contra `hostname+pathname` (sem www.) que qualificam um lancamento. */
export function lancamentoPatterns(): RegExp[] {
  const out: RegExp[] = [];
  for (const src of OFFICIAL_SOURCES) {
    for (const p of src.path_patterns ?? []) {
      out.push(p);
    }
  }
  return out;
}

/**
 * Mapa empresa → domínio oficial pra sugestão de fonte primária.
 * Usado por `launch-detect.ts` pra sinalizar candidatos a lançamento.
 */
export function companyToDomain(): Array<{ keyword: RegExp; domain: string }> {
  const out: Array<{ keyword: RegExp; domain: string }> = [];
  for (const src of OFFICIAL_SOURCES) {
    if (!src.detection_keywords) continue;
    // primary_domain > domains[0]. Entries com só path_patterns devem incluir
    // primary_domain explicitamente — não há extração automática de hostname.
    const domain = src.primary_domain ?? src.domains?.[0] ?? "";
    if (domain) {
      out.push({ keyword: src.detection_keywords, domain });
    }
  }
  return out;
}
