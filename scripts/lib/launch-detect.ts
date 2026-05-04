/**
 * launch-detect.ts (#487)
 *
 * Heurística leve pra detectar artigos de cobertura de imprensa que provavelmente
 * são *lançamentos* mas estão na bucket "noticia" porque a URL não é da fonte
 * oficial. Útil pra sinalizar ao editor candidatos a substituição (regra editorial
 * #160 — LANÇAMENTOS só com link oficial).
 *
 * Não faz fetch / web search. Apenas (a) detecta verbos de lançamento no
 * título/summary e (b) mapeia nome de empresa conhecida pro domínio oficial
 * provável. O editor decide se vale procurar e substituir.
 *
 * Edge: matches são best-effort; um título tipo "TechCrunch reports that
 * OpenAI may launch X" gera candidato porque "OpenAI" e "launch" aparecem.
 * Falsos positivos são preferíveis a falsos negativos — o editor revisa.
 */

const LAUNCH_KEYWORDS: RegExp[] = [
  // EN
  /\blaunche?s?\b/i,
  /\breleases?\b/i,
  /\bannounces?\b/i,
  /\bunveils?\b/i,
  /\bdebuts?\b/i,
  /\bintroduces?\b/i,
  /\brolls? out\b/i,
  /\brolling out\b/i,
  /\bships?\b/i,
  /\bavailable now\b/i,
  /\bgenerally available\b/i,
  /\bopen-?sources?\b/i,
  // PT
  /\blan[çc]a(m|r|ndo)?\b/i,
  /\bapresenta(m|r|ndo)?\b/i,
  /\banuncia(m|r|ndo)?\b/i,
  /\bestreia(m|r|ndo)?\b/i,
  /\bdisponibiliza(m|r|ndo)?\b/i,
  /\bdisponível agora\b/i,
];

/**
 * Mapeia keywords (case-insensitive, com word boundaries) pro domínio oficial
 * provável. Múltiplas keywords podem apontar pro mesmo domínio (ex: "Claude"
 * e "Anthropic" → anthropic.com).
 *
 * Mantido em sync com `LANCAMENTO_DOMAINS` em categorize.ts. Quando adicionar
 * empresa nova lá, adicionar aqui também.
 */
export const COMPANY_TO_DOMAIN: Array<{ keyword: RegExp; domain: string }> = [
  { keyword: /\b(anthropic|claude)\b/i, domain: "anthropic.com" },
  { keyword: /\b(openai|chatgpt|gpt-?[0-9]+(\.[0-9]+)?o?|sora)\b/i, domain: "openai.com" },
  { keyword: /\b(deepmind|gemini)\b/i, domain: "deepmind.google" },
  { keyword: /\b(google ai|gemma)\b/i, domain: "blog.google" },
  { keyword: /\b(meta ai|llama)\b/i, domain: "ai.meta.com" },
  { keyword: /\b(microsoft|copilot|phi-?[0-9]+)\b/i, domain: "blogs.microsoft.com" },
  { keyword: /\b(mistral|mixtral|codestral)\b/i, domain: "mistral.ai" },
  { keyword: /\bcohere\b/i, domain: "cohere.com" },
  { keyword: /\b(hugging ?face|hf)\b/i, domain: "huggingface.co" },
  { keyword: /\b(nvidia|cuda)\b/i, domain: "blogs.nvidia.com" },
  { keyword: /\b(xai|grok)\b/i, domain: "x.ai" },
  { keyword: /\b(deepseek)\b/i, domain: "deepseek.com" },
  { keyword: /\b(qwen|alibaba)\b/i, domain: "qwenlm.github.io" },
  { keyword: /\b(perplexity)\b/i, domain: "perplexity.ai" },
  { keyword: /\b(cerebras)\b/i, domain: "cerebras.ai" },
  { keyword: /\b(groq)\b/i, domain: "groq.com" },
  { keyword: /\b(stability ai|stable diffusion)\b/i, domain: "stability.ai" },
  { keyword: /\b(runway|runwayml)\b/i, domain: "runwayml.com" },
  { keyword: /\b(replicate)\b/i, domain: "replicate.com" },
  { keyword: /\b(adept)\b/i, domain: "adept.ai" },
  { keyword: /\b(inflection)\b/i, domain: "inflection.ai" },
  { keyword: /\b(scale ai)\b/i, domain: "scale.com" },
  { keyword: /\b(together ai)\b/i, domain: "together.ai" },
  { keyword: /\b(fireworks ai)\b/i, domain: "fireworks.ai" },
  { keyword: /\b(character\.?ai)\b/i, domain: "character.ai" },
  { keyword: /\b(ai21)\b/i, domain: "ai21.com" },
  { keyword: /\b(reka ai)\b/i, domain: "reka.ai" },
  { keyword: /\b(arcee ai)\b/i, domain: "arcee.ai" },
  { keyword: /\b(liquid ai)\b/i, domain: "liquid.ai" },
  { keyword: /\b(nomic)\b/i, domain: "nomic.ai" },
  { keyword: /\b(poolside)\b/i, domain: "poolside.ai" },
  { keyword: /\b(imbue)\b/i, domain: "imbue.com" },
  { keyword: /\b(01\.ai|yi (large|model))\b/i, domain: "01.ai" },
  { keyword: /\b(aleph alpha)\b/i, domain: "aleph-alpha.com" },
  { keyword: /\bsambanova\b/i, domain: "sambanova.ai" },
  { keyword: /\blmarena\b/i, domain: "lmarena.ai" },
  { keyword: /\bapple (intelligence|ml|machine learning)\b/i, domain: "machinelearning.apple.com" },
];

export interface LaunchCandidate {
  is_candidate: boolean;
  /** Verbo de lançamento detectado (primeira ocorrência). */
  matched_keyword?: string;
  /** Empresa identificada por keyword no título/summary. */
  matched_company?: string;
  /** Domínio oficial sugerido pra busca de fonte primária. */
  suggested_domain?: string;
}

/**
 * Detecta se um artigo é candidato a virar LANÇAMENTO via fonte primária.
 *
 * Regras (todas obrigatórias):
 * 1. Título contém verbo de lançamento.
 * 2. Título OU summary contém nome de empresa conhecida.
 * 3. URL atual NÃO é do domínio oficial dessa empresa (senão já é lançamento).
 *
 * Quando 1 e 2 batem mas o autor da regra 3 não pôde ser verificada (ex: domínio
 * desconhecido), retorna candidato mesmo assim — editor decide.
 */
export function detectLaunchCandidate(article: {
  title?: string;
  summary?: string | null;
  url?: string;
}): LaunchCandidate {
  const title = article.title ?? "";
  const summary = article.summary ?? "";
  const haystack = `${title}\n${summary}`;

  // Regra 1: verbo de lançamento no título.
  let matchedKeyword: string | undefined;
  for (const re of LAUNCH_KEYWORDS) {
    const m = title.match(re);
    if (m) {
      matchedKeyword = m[0];
      break;
    }
  }
  if (!matchedKeyword) return { is_candidate: false };

  // Regra 2: empresa conhecida no título ou summary.
  let matchedCompany: string | undefined;
  let suggestedDomain: string | undefined;
  for (const { keyword, domain } of COMPANY_TO_DOMAIN) {
    const m = haystack.match(keyword);
    if (m) {
      matchedCompany = m[0];
      suggestedDomain = domain;
      break;
    }
  }
  if (!matchedCompany || !suggestedDomain) {
    return { is_candidate: false };
  }

  // Regra 3: URL atual não é do domínio oficial.
  if (article.url) {
    let host = "";
    try {
      host = new URL(article.url).hostname.replace(/^www\./, "");
    } catch {
      host = "";
    }
    if (host && (host === suggestedDomain || host.endsWith(`.${suggestedDomain}`))) {
      // Já é do domínio oficial — nesse caso categorize.ts deveria ter
      // classificado como lancamento. Não-candidato.
      return { is_candidate: false };
    }
  }

  return {
    is_candidate: true,
    matched_keyword: matchedKeyword,
    matched_company: matchedCompany,
    suggested_domain: suggestedDomain,
  };
}
