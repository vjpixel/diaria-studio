/**
 * lib/title-similarity.ts (#2833)
 *
 * Similaridade de títulos usada pelo dedup: Levenshtein (intra-lista/vs-past
 * headline), Jaccard sobre tokens normalizados (subject-level, #897), e
 * extração de entidades nomeadas pra threshold dinâmico (#1331).
 *
 * Extraído de dedup.ts — movimentação pura, sem mudança de comportamento.
 * dedup.ts re-exporta esses símbolos pra manter compat com importadores
 * existentes (`./dedup.ts` / `../scripts/dedup.ts`).
 */

// ---------------------------------------------------------------------------
// Levenshtein similarity (0 = completamente diferente, 1 = idêntico)
// ---------------------------------------------------------------------------

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const prev = Array.from({ length: n + 1 }, (_, i) => i);
  const curr = new Array<number>(n + 1);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      curr[j] = a[i - 1] === b[j - 1]
        ? prev[j - 1]
        : 1 + Math.min(prev[j], curr[j - 1], prev[j - 1]);
    }
    prev.splice(0, prev.length, ...curr);
  }
  return prev[n];
}

export function normalizeTitle(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // remove diacritics
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\b(a|o|e|um|uma|de|da|do|em|para|por|com|que|se|na|no|as|os|ao|aos|das|dos|pela|pelo|pelas|pelos|is|the|a|an|of|in|for|to|and|on|at|by|with)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function titleSimilarity(a: string, b: string): number {
  const na = normalizeTitle(a), nb = normalizeTitle(b);
  const maxLen = Math.max(na.length, nb.length);
  if (maxLen === 0) return 0; // #674: sem conteúdo normalizável, não há similaridade
  return 1 - levenshtein(na, nb) / maxLen;
}

// ---------------------------------------------------------------------------
// Jaccard similarity sobre tokens normalizados (#897)
//
// Mais permissivo que Levenshtein pra comparar títulos PT-BR vs EN da mesma
// história — a sobreposição de entidades/keywords domina, palavras de
// transição diferem.
// ---------------------------------------------------------------------------

/**
 * Tokeniza título normalizado em set de palavras de >= 3 chars (descarta
 * stopwords e tokens curtos). Usa o mesmo `normalizeTitle` (lowercase, sem
 * acentos, stopwords PT/EN removidas).
 *
 * Tokens curtos descartados pra reduzir noise: "a", "de", "em" não diferenciam.
 */
export function tokenizeForJaccard(title: string): Set<string> {
  const normalized = normalizeTitle(title);
  const tokens = normalized.split(/\s+/).filter((t) => t.length >= 3);
  return new Set(tokens);
}

/**
 * Jaccard similarity entre dois sets — |A ∩ B| / |A ∪ B|. Ambos vazios = 0
 * (degeneração: títulos sem token significativo não devem disparar dup).
 */
export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection++;
  const union = a.size + b.size - intersection;
  if (union === 0) return 0;
  return intersection / union;
}

/**
 * Conveniência: similaridade de subject (Jaccard sobre tokens) entre dois
 * títulos. Se ambos são similares > threshold, considerar duplicata-de-tema.
 *
 * Threshold sugerido pelo issue #897: 0.6 (mais permissivo que Levenshtein
 * intra-edição em 0.85). Defaults conservadores são caller-controlled.
 */
export function subjectSimilarity(a: string, b: string): number {
  return jaccardSimilarity(tokenizeForJaccard(a), tokenizeForJaccard(b));
}

// ---------------------------------------------------------------------------
// #1331: Named entity extraction
//
// O caso real: dois artigos diferentes cobrindo o mesmo evento usam
// vocabulário divergente (ex: "Juiz multa advogadas..." vs "Advogadas
// paraenses multadas") — Jaccard puro fica abaixo do threshold (0.6).
//
// Ideia: extrair entidades nomeadas (palavras com inicial maiúscula que não
// estão no início da sentença) e, quando há ≥1 entidade compartilhada entre
// candidato e past, abaixar o threshold pra 0.55. Não é silver bullet — pega
// casos onde entidades aparecem em ambos (cidades, empresas, sobrenomes).
// Casos onde NENHUM dos títulos tem entidade nomeada relevante continuam
// dependendo do Jaccard normal (0.6).
//
// Filtra termos genéricos do domínio IA ("IA", "AI", "ChatGPT", etc.) pra
// não disparar overlap espúrio em todo título.
// ---------------------------------------------------------------------------

/** Termos comuns no domínio IA que NÃO contam como entidade discriminante. */
const ENTITY_STOPWORDS = new Set([
  "ia", "ai", "ml", "llm", "gpt", "chatgpt", "claude", "gemini", "openai",
  "inteligencia", "artificial", "machine", "learning",
  "diaria", "newsletter", "edicao",
  // dias da semana / meses comuns
  "segunda", "terca", "quarta", "quinta", "sexta", "sabado", "domingo",
  "janeiro", "fevereiro", "marco", "abril", "maio", "junho",
  "julho", "agosto", "setembro", "outubro", "novembro", "dezembro",
]);

/**
 * Extrai "entidades nomeadas" de um título. Heurística: palavras de 4+ chars
 * que começam com letra maiúscula no original, normalizadas (lowercase,
 * sem acentos), excluindo:
 *  - A primeira palavra (sentence-start capitalization)
 *  - Termos do `ENTITY_STOPWORDS` (vocabulário comum do domínio)
 *
 * Não é NER de verdade — só captura proper nouns prováveis. Falsos positivos
 * existem (substantivos comuns capitalizados em headlines tipo "Como"); são
 * raros o suficiente pra não ferir.
 */
export function extractNamedEntities(title: string): Set<string> {
  const entities = new Set<string>();
  // Quebrar no whitespace ANTES de normalizar — preciso checar a inicial
  // maiúscula no original.
  const words = title.split(/\s+/);
  for (let i = 0; i < words.length; i++) {
    const word = words[i].replace(/[^\p{L}\p{N}]/gu, "");
    if (word.length < 4) continue;
    // Sentence-start: pular a primeira palavra que não é grudada em pontuação.
    // Implementação simples: pular índice 0.
    if (i === 0) continue;
    const firstChar = word.charAt(0);
    if (firstChar !== firstChar.toUpperCase()) continue;
    if (firstChar === firstChar.toLowerCase()) continue; // não é letra
    // Normalizar (lowercase, sem acentos) pra match cross-edition consistente.
    // Combining Diacritical Marks (̀-ͯ) cobre todos os acentos PT-BR.
    const normalized = word
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "");
    if (ENTITY_STOPWORDS.has(normalized)) continue;
    entities.add(normalized);
  }
  return entities;
}

/**
 * Threshold dinâmico (#1331): quando candidato e past compartilham ≥1
 * entidade nomeada, baixa pra `loweredThreshold`. Caso contrário, mantém
 * `defaultThreshold` original (0.6).
 *
 * Retorna o threshold que o caller deve usar no Jaccard de tokens — o caller
 * separa lookup de threshold do match em si pra logging por par.
 */
export function thresholdForPair(
  candidateTitle: string,
  pastTitle: string,
  defaultThreshold: number,
  loweredThreshold: number,
): { threshold: number; sharedEntities: string[] } {
  const candEnts = extractNamedEntities(candidateTitle);
  const pastEnts = extractNamedEntities(pastTitle);
  const shared: string[] = [];
  for (const e of candEnts) {
    if (pastEnts.has(e)) shared.push(e);
  }
  return {
    threshold: shared.length > 0 ? loweredThreshold : defaultThreshold,
    sharedEntities: shared,
  };
}
