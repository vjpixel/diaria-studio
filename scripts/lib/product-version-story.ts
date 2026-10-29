/**
 * #11576: sinal "mesmo PRODUTO + VERSÃO" entre dois títulos ("Genie 4",
 * "iOS 27.2", "GPT-6.1") com o SEGUNDO SINAL que separa mesma história de
 * história diferente sobre o mesmo produto.
 *
 * Nasceu no path (b2) do dedup intra-edição (#11496) e foi extraído para cá
 * para o Pass-1f de `scripts/dedup.ts` (#11511) usar o MESMO critério contra
 * as edições anteriores. Antes, o Pass-1f removia do pool qualquer artigo que
 * dividisse um par produto+versão com um título publicado nas últimas 3
 * edições: "GPT-6.1 é banido em escolas" saía por causa de "OpenAI lança
 * GPT-6.1", sem o editor ver o item no gate.
 *
 * Versão sozinha não basta (review da PR #9430): "GPT-6.1 banido em escolas"
 * × "GPT-6.1 ganha modo de voz" são histórias diferentes e não dividem nenhum
 * tópico. O segundo sinal é ≥1 token de tópico em comum além do produto, da
 * família e dos termos genéricos, OU os dois títulos com cara de anúncio de
 * lançamento (`LAUNCH_TITLE_RE`). Variantes nomeadas diferentes ("GPT-6.1
 * Sol" × "GPT-6.1 Astra", "Gemini 3.8 Flash" × "Gemini 3.8 Pro") descartam o
 * par, como no MESMO FATO.
 *
 * As listas de stopword abaixo foram MOVIDAS de `scripts/dedup-intra-edition.ts`
 * (que as importa daqui): aquele script importa `scripts/dedup.ts`, e o
 * Pass-1f precisa delas sem criar import circular.
 */
import { extractVersionedProducts, extractProductVariants } from "./same-fact-check.ts";
import { LAUNCH_TITLE_RE } from "./story-grouping.ts";
import { tokenizeForJaccard } from "./title-similarity.ts";

/** Nomes de EMPRESA de alta frequência (#2406). NUNCA contam como entidade
 *  discriminante de evento: em edições com 2+ itens da mesma empresa, "Microsoft"
 *  sozinho não distingue histórias diferentes. Excluídos em TODOS os contextos
 *  de entity-match — inclusive o segundo-sinal do domain-match (#2587), onde a
 *  empresa já está estabelecida pelo próprio domain-match. */
export const COMPANY_STOPWORDS_INTRA = new Set([
  "microsoft", "google", "apple", "amazon", "meta", "nvidia",
  "anthropic", "deepmind", "deepseek", "mistral", "cohere",
  "openai", "perplexity",
]);

/** Nomes de PRODUTO/modelo de IA + termos genéricos do domínio + dias/meses.
 *  Excluídos do entity-match GERAL (2-entidade, #2406) porque um produto
 *  sozinho ("Gemini") cobre muitas histórias do dia. MAS, no segundo-sinal do
 *  domain-match (#2587), o nome do produto É o discriminador de evento que a
 *  issue pede ("≥1 entidade nomeada compartilhada ALÉM do nome da empresa"):
 *  a empresa já vem do domínio, então "Gemini"/"GPT" compartilhado confirma o
 *  mesmo lançamento. Por isso `extractProductEntitiesIntra` re-inclui estes. */
export const PRODUCT_STOPWORDS_INTRA = new Set([
  "ia", "ai", "ml", "llm", "gpt", "chatgpt", "claude", "gemini",
  "inteligencia", "artificial", "machine", "learning",
  "diaria", "newsletter", "edicao",
  "copilot", "alexa", "siri", "grok",
  "segunda", "terca", "quarta", "quinta", "sexta", "sabado", "domingo",
  "janeiro", "fevereiro", "marco", "abril", "maio", "junho",
  "julho", "agosto", "setembro", "outubro", "novembro", "dezembro",
]);

/** Termos puramente genéricos (não-produto, não-empresa) — sempre excluídos,
 *  inclusive no segundo-sinal do domain-match. Evita que "IA"/dia-da-semana
 *  contem como produto-discriminador. Subconjunto de PRODUCT_STOPWORDS_INTRA. */
export const GENERIC_STOPWORDS_INTRA = new Set([
  "ia", "ai", "ml", "llm",
  "inteligencia", "artificial", "machine", "learning",
  "diaria", "newsletter", "edicao",
  "segunda", "terca", "quarta", "quinta", "sexta", "sabado", "domingo",
  "janeiro", "fevereiro", "marco", "abril", "maio", "junho",
  "julho", "agosto", "setembro", "outubro", "novembro", "dezembro",
]);

/**
 * #3099: termos genéricos de manchete (verbos de atribuição jornalística,
 * substantivos de sourcing, descritores de produto de altíssima frequência)
 * que NÃO contam como TÓPICO discriminante no cross-vehicle same-company
 * match (item d de `isIntraEditionDuplicate`). Sem isso, duas notícias
 * DIFERENTES da mesma empresa no mesmo dia colidiriam só por compartilharem
 * um verbo de atribuição comum ("revela", "dizem", "anuncia") ou um
 * substantivo genérico ("modelo", "novo"). Termos de produto ESPECÍFICO
 * (chip, satélite, processador, etc.) ficam de fora de propósito — são
 * exatamente o que deve discriminar o evento.
 */
export const TOPIC_TOKEN_STOPWORDS_INTRA = new Set([
  // #3099 review: GENERIC_STOPWORDS_INTRA (ia/ai/ml/llm, dias/meses, etc.)
  // precisa entrar aqui também — sem isso, "llm" (>=3 chars, sobrevive ao
  // tokenizeForJaccard) ou um dia-da-semana poderiam contar como token de
  // tópico compartilhado entre 2 histórias DIFERENTES da mesma empresa.
  ...GENERIC_STOPWORDS_INTRA,
  "novo", "nova", "novos", "novas",
  "modelo", "modelos",
  "empresa", "empresas",
  "tecnologia", "ferramenta", "plataforma", "produto", "versao",
  "revela", "revelam", "anuncia", "anunciam", "diz", "dizem", "afirma",
  "afirmam", "aponta", "apontam", "informa", "informam", "confirma", "confirmam",
  "portal", "fontes", "fonte",
]);

/**
 * #11496: termos genéricos de manchete em INGLÊS que não discriminam a
 * história quando a empresa compartilhada veio só da URL (página oficial
 * sem a empresa no título). `normalizeTitle` só remove artigos/preposições,
 * então "new", "our", "model" sobrevivem como token e casariam qualquer
 * anúncio da mesma empresa.
 */
export const URL_COMPANY_TOPIC_STOPWORDS_INTRA = new Set([
  "new", "our", "your", "we", "model", "models", "introducing", "announcing",
  "announces", "announced", "launch", "launches", "launching", "today",
  "update", "updates", "now", "available", "more", "how", "what", "why",
]);

/** Resultado de `matchProductVersionStory`: o par divide produto+versão. */
export interface ProductVersionMatch {
  /** Pares `produto versão` em comum, sem conflito de variante. */
  products: string[];
  /** Tokens de tópico em comum além do produto e dos termos genéricos. */
  topics: string[];
  /** Os dois títulos têm cara de anúncio de lançamento. */
  bothLaunch: boolean;
}

/** Token de título que não discrimina a história no segundo sinal. */
export function isProductVersionTopicStopword(token: string): boolean {
  return (
    /^\d/.test(token) ||
    TOPIC_TOKEN_STOPWORDS_INTRA.has(token) ||
    URL_COMPANY_TOPIC_STOPWORDS_INTRA.has(token) ||
    COMPANY_STOPWORDS_INTRA.has(token) ||
    PRODUCT_STOPWORDS_INTRA.has(token)
  );
}

/**
 * Compara dois títulos (já sem sufixo de veículo, quando o chamador tem
 * esse dado). Devolve `null` quando não dividem nenhum produto+versão sem
 * conflito de variante; senão, os pares e o segundo sinal medido. Quem chama
 * decide com `hasStorySecondSignal`. `aTokens`/`bTokens` deixam o chamador
 * reaproveitar a tokenização (`tokenizeForJaccard`) que já fez.
 */
export function matchProductVersionStory(
  a: string,
  b: string,
  aTokens: Set<string> = tokenizeForJaccard(a),
  bTokens: Set<string> = tokenizeForJaccard(b),
): ProductVersionMatch | null {
  const aVersioned = extractVersionedProducts(a);
  if (aVersioned.size === 0) return null;
  const bVersioned = extractVersionedProducts(b);
  const aVariants = extractProductVariants(a);
  const bVariants = extractProductVariants(b);
  const products = [...aVersioned].filter((p) => {
    if (!bVersioned.has(p)) return false;
    const va = aVariants.get(p);
    const vb = bVariants.get(p);
    return !(va !== undefined && vb !== undefined && va !== vb);
  });
  if (products.length === 0) return null;
  const productWords = new Set(products.flatMap((p) => p.split(" ")));
  const topics = [...aTokens].filter(
    (t) => bTokens.has(t) && !productWords.has(t) && !isProductVersionTopicStopword(t),
  );
  const bothLaunch = LAUNCH_TITLE_RE.test(a) && LAUNCH_TITLE_RE.test(b);
  return { products, topics, bothLaunch };
}

/** Mesma história: ≥1 tópico em comum ou os dois títulos são anúncio. */
export function hasStorySecondSignal(m: ProductVersionMatch): boolean {
  return m.topics.length >= 1 || m.bothLaunch;
}
