/**
 * truncated-summary.ts (#2596)
 *
 * Helper para detectar `summary` truncado vindo de `og:description`.
 *
 * Muitos veículos (ex: Exame) truncam sua og:description com "…" no servidor,
 * produzindo frases incompletas que chegam até o render da newsletter. Este
 * helper identifica quando um summary termina em reticências de truncamento
 * (distinguindo de reticências intencionais de estilo).
 *
 * ESTRATÉGIA (ação (c) — só sinaliza warning no Stage 4, nunca DROP/auto-fix;
 * custo de falso-positivo é BAIXO, custo de falso-negativo é o bug da issue):
 *
 *   FLAG como truncado quando o texto (após trim) termina em `…` (U+2026) ou
 *   em `...` (3 pontos ASCII) — exceto quando reconhecidamente intencional.
 *
 *   O caso central da issue #2596 — Exame "...conformidade…" — DEVE disparar:
 *   um substantivo seguido de "…" sem pontuação final é exatamente o sintoma
 *   de og:description cortada na fonte.
 *
 *   CARVE-OUT (reticências intencionais que NÃO disparam):
 *     1. Reticências precedidas de pontuação final válida (`.`, `!`, `?`) —
 *        ex: "fim de frase.…" sinaliza fechamento intencional.
 *     2. Idiomas de suspense reconhecidos no fim — ex: "e por aí vai…",
 *        "e assim por diante…", "etc…".
 *
 * Exemplos:
 *   "...conformidade…"           → TRUNCADO (substantivo + "…", sem pontuação)
 *   "Novas regras de…"           → TRUNCADO (preposição pendente)
 *   "crescimento, inovação e…"   → TRUNCADO (conjunção pendente)
 *   "e por aí vai..."            → NÃO truncado (idioma de suspense)
 *   "e assim por diante…"        → NÃO truncado (idioma de suspense)
 *   "Texto completo."            → NÃO truncado (sem reticências)
 */

/**
 * Idiomas de suspense em PT-BR que terminam legitimamente em reticências.
 * Comparados contra o fim do texto (case-insensitive), permitindo flagrar
 * reticências de truncamento sem pegar fechamentos estilísticos comuns.
 *
 * Mantemos a lista pequena e ancorada — só expressões que de fato fecham
 * ideia com reticências por estilo. Ampliar com cautela.
 */
const INTENTIONAL_ELLIPSIS_ENDINGS = [
  "e por aí vai",
  "e assim por diante",
  "e por aí",
  "entre outros",
  "entre outras",
  "etc",
];

/**
 * Retorna `true` se o summary parece truncado involuntariamente.
 *
 * Critério principal: termina em `…` (U+2026) ou `...` (3 ASCII dots).
 *
 * Casos que retornam `false`:
 *   - Não termina em ellipsis.
 *   - Só reticências (sem texto antes).
 *   - Antes do ellipsis há pontuação final válida (`.`/`!`/`?`).
 *   - O fim do texto bate com um idioma de suspense reconhecido
 *     (`INTENTIONAL_ELLIPSIS_ENDINGS`).
 */
export function isTruncatedSummary(summary: string): boolean {
  const trimmed = summary.trim();
  if (!trimmed) return false;

  // 1. Detectar sufixo de ellipsis (U+2026 ou 3 ASCII dots).
  let withoutEllipsis: string;
  if (trimmed.endsWith("…")) {
    withoutEllipsis = trimmed.slice(0, -1).trimEnd();
  } else if (trimmed.endsWith("...")) {
    withoutEllipsis = trimmed.slice(0, -3).trimEnd();
  } else {
    return false;
  }

  // Só reticências (sem texto antes) → não há frase a truncar.
  if (!withoutEllipsis) return false;

  // 2. Carve-out: pontuação final válida antes do ellipsis = fechamento
  //    intencional (ex: "frase completa.…").
  if (/[.!?]$/.test(withoutEllipsis)) return false;

  // 3. Carve-out: idioma de suspense reconhecido no fim do texto.
  //    Comparação case-insensitive contra o sufixo normalizado (sem pontuação
  //    residual nas bordas).
  const tail = withoutEllipsis
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+$/u, "")
    .trimEnd();
  for (const ending of INTENTIONAL_ELLIPSIS_ENDINGS) {
    if (tail.endsWith(ending)) return false;
  }

  // 4. Caso contrário: termina em "…"/"..." sem fechamento → truncado.
  return true;
}
