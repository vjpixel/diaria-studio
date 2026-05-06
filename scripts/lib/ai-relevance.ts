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
 */

/**
 * Termos relevantes pro tema da Diar.ia (IA, ML, NLP, agentes, gerativo,
 * vision, speech, alignment, RAG, etc.). Catalogados em #501 e mantidos
 * deliberadamente permissivos.
 *
 * Importante: o regex está em flag `i` (case-insensitive) e usa `\b` pra
 * boundaries — match em `LLM`, `Llm`, `llm`, mas não em `controll` ou `mello`.
 */
export const AI_RELEVANT_TERMS =
  /\b(language\s+model\w*|llm\b|transformer\w*|diffusion\b|neural\s+network\w*|deep\s+learn\w*|reinforcement\s+learn\w*|computer\s+vision\b|natural\s+language\b|multimodal\b|foundation\s+model\w*|generative\b|bert\b|gpt\b|attention\s+mechanism\w*|fine[-_ ]?tun\w*|instruction\b|alignment\b|benchmark\w*|reasoning\b|chain[-.]of[-.]thought\b|rag\b|retrieval\b|embedding\w*|agent\b|chatbot\w*|text.to.image\b|speech\s+recognition\b|sentiment\b|named\s+entit\w*|question\s+answer\w*|text\s+generation\b|image\s+generation\b|video\s+generation\b|code\s+generation\b|protein\b|genomic\b|drug\s+discovery\b)/i;

/**
 * Pure: retorna `true` se o texto (título + resumo, etc.) contém ao menos 1
 * termo do `AI_RELEVANT_TERMS`. String vazia/null retorna false.
 */
export function containsAITerms(text: string | null | undefined): boolean {
  if (!text) return false;
  return AI_RELEVANT_TERMS.test(text);
}

/**
 * Pure: predicate sobre artigo. Retorna `true` se título OU resumo tem termo
 * de IA. Use isto como filtro defensive em qualquer ponto do pipeline.
 *
 * Diferença pro `isArxivRelevant` em categorize.ts: aqui o predicate é
 * agnóstico de URL/source — só olha texto. Decida no caller se quer aplicar
 * só pra arXiv (pre-categorize) ou pra todos (defense-in-depth post-categorize,
 * #642 nível 2).
 */
export function isArticleAIRelevant(article: { title?: string; summary?: string }): boolean {
  const text = `${article.title ?? ""} ${article.summary ?? ""}`;
  return containsAITerms(text);
}
