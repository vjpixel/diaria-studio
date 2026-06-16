/**
 * email-fetch-completeness.ts (#2317)
 *
 * Heurística de sanidade de tamanho para o corpo do email obtido via Gmail MCP.
 *
 * Problema: O Gmail MCP pode retornar o corpo truncado em emails grandes (~34KB),
 * fazendo o agente review-test-email concluir "section_missing" quando a seção
 * realmente existe mas ficou além do corte. Isso gera falsos-positivos que
 * disparam o loop fix desnecessariamente.
 *
 * Solução: antes de comparar seções, classificar o fetch como `complete` ou
 * `incomplete`. Se `incomplete`, downgrade de `section_missing` pra
 * `inconclusive` — o agente não pode afirmar que a seção falta, só que não
 * conseguiu lê-la.
 *
 * Threshold de 0.5 (50%): se o corpo do email lido é menor que 50% do
 * newsletter-final.html local, o fetch provavelmente foi truncado. Emails
 * rendering via Beehiiv adicionam template/wrapper HTML, então o email
 * renderizado DEVE ser maior ou igual ao HTML local, não menor. Um email
 * genuinamente completo que chega via Gmail MCP pode ter strip de partes
 * MIME ou compressão leve — 50% é conservador o suficiente para cobrir
 * truncamentos reais sem classificar incorretamente um corpo comprimido.
 *
 * @module
 */

export type FetchCompleteness = "complete" | "incomplete";

/**
 * Threshold padrão: se emailBodyLen < THRESHOLD * finalHtmlLen → incomplete.
 *
 * 0.5 (50%): escolhido para ser conservador. Emails grandes (~34KB) truncados
 * pelo Gmail MCP tipicamente chegam como 2-4KB (< 10%), bem abaixo do limiar.
 * Um email genuinamente comprimido (whitespace stripped) raramente cai abaixo
 * de 60-70% do HTML source. Margem de segurança ampla para não classificar
 * incorretamente corpos reais como incompletos.
 */
export const DEFAULT_COMPLETENESS_THRESHOLD = 0.5;

/**
 * Classifica se um corpo de email obtido via Gmail MCP está completo ou
 * truncado, baseado no tamanho relativo ao HTML local (newsletter-final.html).
 *
 * @param emailBodyLen   Comprimento (bytes/chars) do corpo obtido via MCP.
 * @param finalHtmlLen   Comprimento (bytes/chars) do newsletter-final.html local.
 * @param threshold      Fração mínima aceitável (padrão: 0.5). Se emailBodyLen
 *                       < threshold * finalHtmlLen → `incomplete`.
 * @returns              `"complete"` ou `"incomplete"`.
 *
 * Casos especiais:
 * - `finalHtmlLen <= 0`: sem referência local → assume `complete` (fail-safe,
 *   não bloqueia quando o HTML local não está disponível).
 * - `emailBodyLen <= 0` e `finalHtmlLen > 0`: corpo vazio com HTML presente
 *   → `incomplete` (Gmail retornou nada).
 */
export function classifyFetchCompleteness(
  emailBodyLen: number,
  finalHtmlLen: number,
  threshold = DEFAULT_COMPLETENESS_THRESHOLD,
): FetchCompleteness {
  // Guard NaN/inválido (#2317 finding 6): entradas não-numéricas devem falhar loud
  // em vez de retornar silenciosamente "complete" (NaN < X é sempre false → mascararia
  // truncamento real). O caller (CLI) valida antes de chamar, mas a lib protege
  // contra uso errado em código — invariante de segurança.
  if (!Number.isFinite(emailBodyLen) || !Number.isFinite(finalHtmlLen)) {
    throw new TypeError(
      `classifyFetchCompleteness: argumentos devem ser números finitos, recebidos: emailBodyLen=${emailBodyLen}, finalHtmlLen=${finalHtmlLen}`,
    );
  }

  // Sem HTML local de referência → não podemos avaliar → assume completo.
  if (finalHtmlLen <= 0) return "complete";

  // Corpo vazio com HTML presente → fetch falhou / truncou tudo.
  if (emailBodyLen <= 0) return "incomplete";

  return emailBodyLen < threshold * finalHtmlLen ? "incomplete" : "complete";
}
