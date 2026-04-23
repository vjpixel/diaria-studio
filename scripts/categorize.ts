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
  type_hint?: string;
  [key: string]: unknown;
}

export type Category = "lancamento" | "pesquisa" | "noticias";

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
  "blog.google",
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
  // OpenAI
  "openai.com",
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

export function categorize(article: Article): Category {
  const { host, full } = hostAndPath(article.url);

  // 1. Pesquisa tem prioridade sobre lancamento quando o caminho é de paper
  if (PESQUISA_DOMAINS.has(host)) return "pesquisa";
  if (PESQUISA_PATTERNS.some((p) => p.test(full))) return "pesquisa";

  // 2. Lançamento (domínio oficial)
  if (LANCAMENTO_DOMAINS.has(host)) return "lancamento";
  if (LANCAMENTO_PATTERNS.some((p) => p.test(full))) return "lancamento";

  // 3. type_hint "pesquisa" como sinal secundário (quando domínio não é reconhecido)
  if (article.type_hint === "pesquisa") return "pesquisa";

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
  };

  for (const article of articles) {
    const cat = categorize(article);
    result[cat].push({ ...article, category: cat });
  }

  const stats = `lancamento:${result.lancamento.length} pesquisa:${result.pesquisa.length} noticias:${result.noticias.length}`;

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
