/**
 * strip-publisher-suffix.ts (#2140)
 *
 * Remove o sufixo de veículo que sites de imprensa embutem no título da página.
 * Exemplos:
 *   "Especialistas criticam IA no Brasil | G1"
 *     → "Especialistas criticam IA no Brasil"
 *   "Gigantes da IA terão IPOs bilionários, mas há quem tema uma nova bolha | Blogs | CNN Brasil"
 *     → "Gigantes da IA terão IPOs bilionários, mas há quem tema uma nova bolha"
 *
 * Regra: remover da 1ª ocorrência de " | " (espaço-pipe-espaço) em diante.
 * Pipes sem espaços não são tocados (padrão diferente, raro em títulos editoriais).
 *
 * Anti-falso-positivo: se o que SOBRA antes do 1º " | " tiver < 15 caracteres,
 * considera-se que o título legítimo é curto ou que o pipe é parte do nome do
 * recurso — retorna o título original sem modificação.
 *
 * Funções exportadas:
 *   - `stripPublisherSuffix(title)` — puro, sem side-effects, unit-testável.
 */

/** Comprimento mínimo (em chars) do que sobra antes do " | " para aceitar o strip. */
const MIN_PREFIX_LEN = 15;

/**
 * Remove o sufixo de atribuição de veículo de um título de artigo.
 *
 * @param title - Título bruto (ex: vindo de og:title / <title>).
 * @returns Título limpo, ou o original se o strip produzir um prefixo muito curto.
 *
 * @pure
 */
export function stripPublisherSuffix(title: string): string {
  const trimmed = title.trim();
  const idx = trimmed.indexOf(" | ");
  if (idx === -1) {
    // Nenhum " | " no título — retornar intacto.
    return trimmed;
  }
  const prefix = trimmed.slice(0, idx).trim();
  if (prefix.length < MIN_PREFIX_LEN) {
    // Anti-falso-positivo: prefixo muito curto — manter original.
    return trimmed;
  }
  return prefix;
}
