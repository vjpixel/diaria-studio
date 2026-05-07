/**
 * ai-relevance.ts (#642)
 *
 * Regex e helpers compartilhados pra detectar relevância temática (IA, ML, NLP).
 * Centraliza o que antes vivia inline em scripts/categorize.ts (#501) — pra
 * evitar drift quando outros scripts (post-categorize defense, scorer, lint
 * heurístico) precisarem do mesmo critério.
 *
 * O filtro é permissivo (basta 1 match) pra minimizar falsos negativos:
 * prefere-se manter um artigo de borda do que perder um relevante.
 *
 * #901: expansão grande pra reduzir falso-positivo em validate-stage-1-output
 * — adicionado nomes de produto (ChatGPT, Claude, Gemini, Codex...), empresas
 * (OpenAI, Anthropic, xAI...), termos compostos PT-BR ("chips de IA",
 * "data center de IA"), hardware (GPU, H100, TPU), slug-match em URL
 * (`/ai-`, `/inteligencia-artificial/`), e bypass por domínio editorial 100%-IA.
 */

/**
 * Termos relevantes pro tema da Diar.ia (IA, ML, NLP, agentes, gerativo,
 * vision, speech, alignment, RAG, etc.). Catalogados em #501, expandidos em
 * #901, mantidos deliberadamente permissivos.
 *
 * Importante: o regex está em flag `i` (case-insensitive) e usa `\b` pra
 * boundaries — match em `LLM`, `Llm`, `llm`, mas não em `controll` ou `mello`.
 *
 * Categorias cobertas:
 *   - Conceitos técnicos: language model, LLM, transformer, diffusion, RAG…
 *   - Produtos: ChatGPT, Claude, Gemini, Codex, Copilot, Grok, Sora, Veo…
 *   - Empresas: OpenAI, Anthropic, DeepMind, xAI, Cohere, Mistral, HuggingFace…
 *   - Termos PT-BR compostos: "inteligência artificial", "chips de IA", "agente de IA"…
 *   - Hardware/infra: GPU, TPU, H100, H200, B200, CUDA, Tensor Core…
 *   - Aplicados: protein folding, drug discovery, genomic, AGI…
 */
export const AI_RELEVANT_TERMS =
  /\b(language\s+model\w*|llm\b|transformer\w*|diffusion\b|neural\s+network\w*|deep\s+learn\w*|reinforcement\s+learn\w*|computer\s+vision\b|natural\s+language\b|multimodal\b|foundation\s+model\w*|generative\b|bert\b|gpt\b|attention\s+mechanism\w*|fine[-_ ]?tun\w*|instruction\b|alignment\b|benchmark\w*|reasoning\b|chain[-.]of[-.]thought\b|rag\b|retrieval\b|embedding\w*|agent\b|agentic\b|tool\s+use\b|context\s+window\b|mcp\b|chatbot\w*|text.to.image\b|speech\s+recognition\b|sentiment\b|named\s+entit\w*|question\s+answer\w*|text\s+generation\b|image\s+generation\b|video\s+generation\b|code\s+generation\b|protein\b|genomic\b|drug\s+discovery\b|agi\b|asi\b|superintelligence\b|chatgpt\b|claude\b|gemini\b|gemma\b|codex\b|copilot\b|grok\b|llama\b|mistral\b|mixtral\b|whisper\b|sora\b|veo\b|dall[-.]?e\b|midjourney\b|stable\s+diffusion\b|kimi\b|qwen\b|deepseek\b|phi[-_ ]?[0-9]+\b|gpt[-_ ]?\d+(\.\d+)?o?\b|openai\b|anthropic\b|deepmind\b|xai\b|cohere\b|hugging\s*face\b|stability\s+ai\b|runway\s*ml\b|together\s+ai\b|cerebras\b|groq\b|sambanova\b|inflection\b|character\.?ai\b|reka\s+ai\b|liquid\s+ai\b|nomic\s+ai\b|perplexity\b|inteligência\s+artificial|inteligencia\s+artificial|aprendizado\s+de\s+m[áa]quina|rede\s+neural|redes\s+neurais|modelo\s+de\s+linguagem|modelos\s+de\s+linguagem|modelo\s+gerativo|modelos\s+gerativos|agente\s+aut[ôo]nomo|agentes\s+aut[ôo]nomos|agente\s+de\s+ia|agentes\s+de\s+ia|chip\s+de\s+ia|chips\s+de\s+ia|data\s+center\s+de\s+ia|data\s+centers\s+de\s+ia|centro\s+de\s+dados\s+de\s+ia|treinamento\s+de\s+ia|gpu\b|tpu\b|h100\b|h200\b|b100\b|b200\b|cuda\b|tensor\s+core\w*|nvidia\b)/i;

/**
 * Padrão de slug em URL que indica conteúdo de IA mesmo quando o título é
 * genérico (ex: cnnbrasil.com.br/.../chips-de-ia/, mittechreview.com.br/ia-x/).
 *
 * Bate em:
 *   - `/ai-`, `/ai/`, `/ai$` (path segment ai delimitado por separador ou end)
 *   - `-ai-`, `-ai/`, `-ai$` (kebab-case delimitando ai)
 *   - `/ia-`, `/ia/`, `-ia-`, `-ia/` (PT-BR equivalente)
 *   - `/inteligencia-artificial/`, `/inteligência-artificial/`
 *   - `/artificial-intelligence/`
 *   - `/machine-learning/`
 *   - `/genai`, `/ai-agents/`
 *
 * Boundaries usados: `[-/]` delimitando ai/ia. Não match em `/main-` (sem
 * boundary antes de "ai").
 */
export const AI_RELEVANT_URL_SLUG =
  /[-/](ai|ia)[-/]|[-/](ai|ia)$|\/inteligencia-artificial\b|\/intelig[êe]ncia-artificial\b|\/artificial-intelligence\b|\/machine-learning\b|\/genai\b|\/ai-agents?\b/i;

/**
 * Domínios cuja editorial é 100% IA — qualquer artigo deles é tratado como
 * relevante mesmo sem keyword match. Reduz falso-positivo em titulos curtos
 * tipo "Anthropic + SpaceX" ou "Higher usage limits" (ambos são IA mas o
 * título não tem termo bate-bate).
 *
 * Mantido conservador: só blogs/sites onde 100% do conteúdo é sobre IA.
 * NÃO inclui sites generalistas com seção AI (cnn, exame, g1, theguardian) —
 * naqueles, queremos que a heurística de keyword/slug funcione.
 */
export const AI_RELEVANT_DOMAINS = new Set<string>([
  // Frontier labs — blogs oficiais
  "anthropic.com",
  "openai.com",
  "ai.meta.com",
  "deepmind.google",
  "deepmind.com",
  "blog.google", // Editorial Google AI; alguns posts não-IA mas raros
  "research.google",
  "blog.research.google",
  "machinelearning.apple.com",
  "developer.apple.com",
  "blogs.microsoft.com",
  "blogs.nvidia.com",
  "developer.nvidia.com",
  // Open-source / weights
  "huggingface.co",
  "mistral.ai",
  "cohere.com",
  "ai21.com",
  "xai.com",
  "x.ai",
  "deepseek.com",
  "perplexity.ai",
  "research.perplexity.ai",
  "stability.ai",
  "runwayml.com",
  "together.ai",
  "fireworks.ai",
  "groq.com",
  "cerebras.ai",
  "sambanova.ai",
  "inflection.ai",
  "character.ai",
  "scale.com",
  "01.ai",
  "reka.ai",
  "liquid.ai",
  "nomic.ai",
  "imbue.com",
  "adept.ai",
  "poolside.ai",
  "qwenlm.github.io",
  // Pesquisa
  "arxiv.org",
  "openreview.net",
  // Newsletters AI-only
  "alphasignal.ai",
  "alphasignalai.substack.com",
  "importai.substack.com",
  "tldr.tech",
  "datamachina.com",
  "datamachina.substack.com",
  "thedeepview.com",
  "archive.thedeepview.com",
  "agentpulse.beehiiv.com",
  "aibreakfast.beehiiv.com",
  "theaipulse.beehiiv.com",
  "therundown.ai",
  "bensbites.co",
  "bensbites.com",
  "theneurondaily.com",
  "superhuman.ai",
  "cyberman.ai",
  "evolvingai.io",
  "recaply.co",
  "7min.ai",
]);

function extractHostForRelevance(url: string | undefined | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Pure: retorna `true` se o texto (título + resumo, etc.) contém ao menos 1
 * termo do `AI_RELEVANT_TERMS`. String vazia/null retorna false.
 */
export function containsAITerms(text: string | null | undefined): boolean {
  if (!text) return false;
  return AI_RELEVANT_TERMS.test(text);
}

/**
 * Pure: retorna `true` se a URL contém slug indicando conteúdo de IA
 * (`/ai-`, `/ia-`, `/inteligencia-artificial/`, etc.). Útil pra reportagens
 * em veículos generalistas onde o título pode ser ambíguo mas o slug é
 * explícito (ex: cnnbrasil.com.br/.../chips-de-ia/).
 */
export function urlHasAISlug(url: string | undefined | null): boolean {
  if (!url) return false;
  return AI_RELEVANT_URL_SLUG.test(url);
}

/**
 * Pure: retorna `true` se o domínio é uma fonte 100%-IA (blogs oficiais
 * de labs, newsletters dedicadas, etc.). Bypass que economiza checagem
 * de keyword.
 */
export function isAIRelevantDomain(url: string | undefined | null): boolean {
  const host = extractHostForRelevance(url);
  if (!host) return false;
  return AI_RELEVANT_DOMAINS.has(host);
}

/**
 * Pure: predicate sobre artigo. Retorna `true` se houver qualquer sinal
 * de relevância pra IA — em ordem de checagem:
 *
 *   1. Domínio 100%-IA (bypass) — anthropic.com, openai.com, …
 *   2. Slug de URL (`/ai-`, `/inteligencia-artificial/`, …)
 *   3. Keyword em título OU summary (regex AI_RELEVANT_TERMS)
 *
 * #901 expansão: antes só checava (3); agora (1) e (2) capturam casos onde
 * o título é curto/genérico mas o conteúdo é claramente IA. Reduz
 * falso-positivo no `validate-stage-1-output` ai_relevance_ratio (de 11%
 * reportado pra ~95% real em pool tipicamente IA).
 *
 * Use isto como filtro defensive em qualquer ponto do pipeline.
 *
 * Diferença pro `isArxivRelevant` em categorize.ts: aqui o predicate é
 * agnóstico de URL/source — só olha texto. Decida no caller se quer aplicar
 * só pra arXiv (pre-categorize) ou pra todos (defense-in-depth post-categorize,
 * #642 nível 2).
 */
export function isArticleAIRelevant(article: {
  url?: string;
  title?: string;
  summary?: string;
}): boolean {
  // 1. Bypass por domínio 100%-IA — evita falso-positivo em títulos curtos
  //    de blog oficial (#901: ex "Higher limits", "Class of 2026").
  if (isAIRelevantDomain(article.url)) return true;
  // 2. Slug de URL (`/ai-`, `/inteligencia-artificial/`, …) — pega
  //    reportagens em veículos generalistas com título ambíguo.
  if (urlHasAISlug(article.url)) return true;
  // 3. Keyword em título ou summary (regex tradicional pré-#901).
  const text = `${article.title ?? ""} ${article.summary ?? ""}`;
  return containsAITerms(text);
}
