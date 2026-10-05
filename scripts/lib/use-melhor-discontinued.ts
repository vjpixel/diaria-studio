/**
 * use-melhor-discontinued.ts (#9599)
 *
 * Tutorial do USE MELHOR sobre um recurso que as últimas edições já noticiaram
 * como em DESCONTINUAÇÃO. Edição 261005: o USE MELHOR trouxe "What is a custom
 * GPT?" (jotform) e o seletor do 4º post o escolheu, quando a 260929 já tinha
 * noticiado "Fim dos GPTs personalizados: OpenAI vai matar recurso no ChatGPT"
 * (Canaltech). O dedup de tema não liga um tutorial à notícia de que o recurso
 * vai acabar, e o scorer não penaliza guia de recurso em fim de vida.
 *
 * Mecanismo, 100% determinístico:
 *   1. `extractDiscontinuationTopics` — das URLs de `data/past-editions.md`
 *      (só há URL lá, sem título), pega as cujo SLUG traz sinal de
 *      descontinuação ("fim dos", "descontinuado", "vai matar", "encerra",
 *      "shut down", "sunset", "deprecated"...) e guarda os tokens do slug.
 *   2. `findDiscontinuedTopic` — um item casa um tópico quando título + slug
 *      dele compartilham ≥ `DISCONTINUED_MIN_SHARED_TOKENS` tokens ESPECÍFICOS
 *      com o slug da notícia. Marcas/plataformas (ChatGPT, OpenAI, Google...)
 *      e palavras de IA genéricas não contam — senão todo tutorial de ChatGPT
 *      casaria qualquer notícia de descontinuação da OpenAI. Um alias mínimo
 *      PT→EN ("personalizado" → "custom") liga o slug em português ao título
 *      em inglês, o caso real da 261005.
 *
 * Consumidores:
 *   - `split-articles-for-scoring.ts` anota `discontinued_topic:true` em
 *     `audience_affinity.matched` dos itens `use_melhor` — o scorer aplica a
 *     penalidade (`scorer.md`/`scorer-chunk.md`);
 *   - `select-use-melhor-post.ts` tira o item da disputa do 4º post social.
 *
 * Fail-soft: `past-editions.md` ausente/ilegível → nenhum tópico, nada muda.
 * Heurística de baixo custo de erro: falso positivo rebaixa um tutorial / faz
 * o 4º post usar o próximo item; nunca tira nada da edição.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Tokens específicos em comum exigidos pra casar item × notícia. */
export const DISCONTINUED_MIN_SHARED_TOKENS = 2;

/** Marca adicionada a `audience_affinity.matched` (consumida pelo scorer). */
export const DISCONTINUED_TOPIC_MATCH = "discontinued_topic:true";

/**
 * Sinal de descontinuação no texto do slug (hífens já viraram espaço, sem
 * acento). "vai matar" e não "matar" sozinho: "IA pode matar todos os
 * humanos" é manchete comum e não fala de recurso nenhum.
 */
export const DISCONTINUATION_SIGNAL_RE =
  /\b(fim d[oa]s?|descontinu\w*|vai matar|mata recurso|matar recurso|encerr\w+|desativ\w+|aposent\w+|sunset\w*|deprecat\w*|discontinu\w*|shut(?:s|ting)? down|shutdown|kill(?:s|ing|ed)? off|phas(?:e|es|ing|ed) out|end of life|retir(?:e|es|ing|ed))\b/;

/** Tokens que nunca contam pro casamento (stopwords PT/EN, marcas, IA genérica, sinais). */
const NON_SPECIFIC = new Set<string>([
  // stopwords PT
  "a", "o", "as", "os", "um", "uma", "de", "do", "da", "dos", "das", "no", "na", "nos", "nas", "em", "e",
  "que", "para", "pra", "por", "com", "sem", "seu", "sua", "seus", "suas", "como", "mais", "menos", "ser",
  "sera", "vai", "vao", "saiba", "veja", "entenda", "agora", "novo", "nova", "novos", "novas", "apos",
  "ate", "sobre", "entre", "quem", "qual", "quais", "isso", "esse", "essa", "este", "esta", "ela", "ele",
  "guia", "passo", "dica", "dicas", "usar", "uso", "recurso", "recursos", "ferramenta", "ferramentas",
  "noticia", "noticias", "tecnologia", "salvar", "fazer", "pode",
  // stopwords EN
  "the", "and", "for", "from", "with", "what", "how", "your", "you", "are", "its", "into", "this", "that",
  "will", "new", "now", "use", "using", "guide", "tutorial", "step", "steps", "about", "why", "who",
  "feature", "features", "tool", "tools", "app", "apps", "ins", "out", "off", "down",
  // IA genérica / marcas — compartilhar só isso não é o mesmo tema
  "ia", "ai", "inteligencia", "artificial", "chatgpt", "openai", "google", "gemini", "claude",
  "anthropic", "microsoft", "copilot", "meta", "apple", "amazon", "aws", "nvidia", "llm", "llms",
  "modelo", "modelos", "model", "models", "chatbot", "chatbots",
  // sinais de descontinuação (não são o TEMA)
  "fim", "matar", "mata", "kill", "kills", "killing", "killed", "sunset", "shutdown", "shut",
  "retire", "retires", "retiring", "retired", "phase", "phasing", "end", "life",
  // ruído de URL
  "www", "com", "br", "html", "ghtml", "htm", "php", "amp", "index", "blog", "post", "posts", "news",
]);

/** Alias PT→EN mínimo (o caso real da 261005). Aplicado nos dois lados. */
const ALIASES: Array<[RegExp, string]> = [[/^personaliz\w*$/, "custom"]];

const SIGNAL_TOKEN_RE = /^(descontinu|encerr|desativ|aposent|deprecat|discontinu)/;

function stripAccents(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

/** Pure: texto do último segmento do path da URL (slug), hífens → espaço, sem extensão. */
export function urlSlugWords(url: string): string {
  let path = url;
  try {
    path = new URL(url).pathname;
  } catch {
    // URL malformada: usa o texto cru
  }
  const segs = path.split("/").filter(Boolean);
  const last = (segs[segs.length - 1] ?? "").replace(/\.[a-z0-9]{2,5}$/i, "");
  return stripAccents(decodeURIComponentSafe(last).toLowerCase()).replace(/[-_+]+/g, " ");
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Pure: tokens específicos de um texto livre (já normalizados e com alias aplicado). */
export function specificTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (let raw of stripAccents(text.toLowerCase()).split(/[^a-z0-9]+/)) {
    if (raw.length < 3 || /^\d+$/.test(raw)) continue;
    if (raw.length >= 4 && raw.endsWith("s") && !raw.endsWith("ss")) raw = raw.slice(0, -1);
    for (const [re, to] of ALIASES) if (re.test(raw)) raw = to;
    if (NON_SPECIFIC.has(raw) || SIGNAL_TOKEN_RE.test(raw)) continue;
    out.add(raw);
  }
  return out;
}

export interface DiscontinuationTopic {
  /** URL da notícia de descontinuação (em `past-editions.md`). */
  url: string;
  /** Data da edição em que saiu (`YYYY-MM-DD`), quando o cabeçalho foi lido. */
  edition_date: string | null;
  tokens: string[];
}

/**
 * Pure: tópicos de descontinuação noticiados nas edições de `past-editions.md`
 * (formato `## YYYY-MM-DD — "título"` + lista `- https://...`).
 */
export function extractDiscontinuationTopics(pastEditionsMd: string): DiscontinuationTopic[] {
  const topics: DiscontinuationTopic[] = [];
  const seen = new Set<string>();
  let date: string | null = null;
  for (const line of pastEditionsMd.split(/\r?\n/)) {
    const h = line.match(/^##\s+(\d{4}-\d{2}-\d{2})\b/);
    if (h) {
      date = h[1];
      continue;
    }
    const m = line.match(/^\s*-\s+(https?:\/\/\S+)/);
    if (!m) continue;
    const url = m[1];
    if (seen.has(url)) continue;
    const slug = urlSlugWords(url);
    if (!DISCONTINUATION_SIGNAL_RE.test(slug)) continue;
    const tokens = [...specificTokens(slug)];
    if (tokens.length < DISCONTINUED_MIN_SHARED_TOKENS) continue;
    seen.add(url);
    topics.push({ url, edition_date: date, tokens });
  }
  return topics;
}

export interface DiscontinuedTopicMatch {
  topic: DiscontinuationTopic;
  shared: string[];
}

/**
 * Pure: o item (título + slug da URL dele) casa algum tópico de
 * descontinuação? Devolve o de MAIS tokens em comum, ou `null`. A própria
 * notícia de descontinuação (mesma URL) nunca casa consigo mesma.
 */
export function findDiscontinuedTopic(
  item: { url?: string; title?: string },
  topics: readonly DiscontinuationTopic[],
  minShared: number = DISCONTINUED_MIN_SHARED_TOKENS,
): DiscontinuedTopicMatch | null {
  if (topics.length === 0) return null;
  const url = item.url ?? "";
  const mine = specificTokens(`${item.title ?? ""} ${url ? urlSlugWords(url) : ""}`);
  let best: DiscontinuedTopicMatch | null = null;
  for (const topic of topics) {
    if (url && topic.url === url) continue;
    const shared = topic.tokens.filter((t) => mine.has(t));
    if (shared.length >= minShared && (!best || shared.length > best.shared.length)) {
      best = { topic, shared };
    }
  }
  return best;
}

/** Pure: frase curta do motivo, pra log/estado. */
export function describeDiscontinuedMatch(m: DiscontinuedTopicMatch): string {
  const when = m.topic.edition_date ? ` (edição de ${m.topic.edition_date})` : "";
  return `tema em descontinuação já noticiado${when}: ${m.topic.url} — tokens em comum: ${m.shared.join(", ")}`;
}

/** Lê `data/past-editions.md` de `rootDir`. Ausente/ilegível → `[]` (fail-soft). */
export function loadDiscontinuationTopics(rootDir: string): DiscontinuationTopic[] {
  const p = resolve(rootDir, "data", "past-editions.md");
  if (!existsSync(p)) return [];
  try {
    return extractDiscontinuationTopics(readFileSync(p, "utf8"));
  } catch {
    return [];
  }
}

interface AffinityLike {
  affinity: number;
  matched: string[];
  hands_on: boolean;
}

/**
 * Anota `discontinued_topic:true` em `audience_affinity.matched` dos itens do
 * bucket `use_melhor` que casam um tópico de descontinuação. Em-place,
 * idempotente. Devolve quantos itens ganharam a marca.
 */
export function annotateDiscontinuedUseMelhor(
  categorized: Record<string, Array<{ url?: string; title?: string; audience_affinity?: AffinityLike | null; [key: string]: unknown }>>,
  topics: readonly DiscontinuationTopic[],
): number {
  if (topics.length === 0) return 0;
  let count = 0;
  for (const item of categorized["use_melhor"] ?? []) {
    if (!findDiscontinuedTopic(item, topics)) continue;
    if (!item.audience_affinity) item.audience_affinity = { affinity: 0, matched: [], hands_on: false };
    if (!item.audience_affinity.matched.includes(DISCONTINUED_TOPIC_MATCH)) {
      item.audience_affinity.matched.push(DISCONTINUED_TOPIC_MATCH);
      count++;
    }
  }
  return count;
}
