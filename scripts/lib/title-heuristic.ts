/**
 * title-heuristic.ts (#259)
 *
 * Heurística compartilhada usada pelo parser de destaques (`extract-destaques.ts`)
 * e pelo lint de newsletter (`lint-newsletter-md.ts`) pra distinguir uma linha
 * que parece "opção de título" de uma linha que parece "parágrafo do body".
 *
 * Caso original (#245): writer emite múltiplas linhas após o header DESTAQUE;
 * algumas são opções de título, outras (no formato pré-#172/legacy) são
 * parágrafos do corpo. A regra simples era:
 *
 *   t.length <= 60 && !/\.\s*$/.test(t)
 *
 * Mas isso rejeita títulos editorialmente válidos terminados em ellipsis
 * (`Estudo mostra...`, `O que vem por aí...`) e qualquer título terminado
 * em ponto único acidentalmente (`OpenAI lança GPT-5.5.`). Falsos positivos
 * em ambos os lados quebram o parser.
 *
 * Regra atual (#259):
 *   - Aceita: comprimento ≤ 60 chars E (não termina em ponto OU termina em
 *     `...` que é estilo editorial válido).
 *   - Rejeita: comprimento > 60 OU termina em ponto único (= parágrafo
 *     completo do body).
 */
export function looksLikeTitleOption(line: string): boolean {
  const t = line.trim();
  if (t.length === 0) return false;
  if (t.length > 60) return false;
  // Termina em ponto? Se for `...` (3+ pontos) é ellipsis editorial — ok.
  // Se for ponto único, é body — rejeita.
  if (/\.\s*$/.test(t) && !/\.{3,}\s*$/.test(t)) {
    return false;
  }
  return true;
}
