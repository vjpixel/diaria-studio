/**
 * version-signal-detect.ts (#4337)
 *
 * Regex compartilhada pra detectar VERSÃO explícita de produto no slug/título
 * (dashes preservados): "gpt-4", "claude-opus-4-5", "v0-7", "7b", "o3".
 *
 * Extraída de `validate-lancamentos.ts` (onde nasceu como parte do #1968) pro
 * mesmo motivo de `release-note-detect.ts` (#2469 finding 4): evitar
 * dependência circular. `validate-lancamentos.ts` importa de `categorize.ts`
 * (via `isOfficialLancamentoUrl`), que importa de `launch-heuristics.ts` — se
 * `launch-heuristics.ts` importasse de volta de `validate-lancamentos.ts`,
 * fecharia um ciclo. Fonte única aqui: `launch-heuristics.ts` usa o sinal
 * ANTES de rotear por `TUTORIAL_DOMAINS` (#4337 — release note em host misto
 * tutorial/release não deve virar USE MELHOR); `validate-lancamentos.ts` usa
 * o mesmo sinal como parte da verificação POSITIVA de ferramenta (#1968).
 *
 * O major é restrito a 1-2 dígitos pra NÃO casar ANOS — um `-2025` /
 * `2026-01` / `2023-2024` (slug datado de parceria/evento/relatório) NÃO é
 * versão. `\d{1,3}b` = contagem de parâmetros (`7b`, `70b`, `405b`); `o[1-9]`
 * = série o1-o9 da OpenAI; `[a-z]{2,}-\d{1,2}o?` = nome-de-modelo + versão de
 * 1-2 dígitos (`cosmos-3`, `olmo-2`, `nemotron-4`).
 */
export const VERSION_SIGNAL_RE =
  /\bv?\d{1,2}(?:[.\-]\d+)+\b|\bv\d+\b|\b\d{1,3}b\b|\bo[1-9]\b|\b[a-z]{2,}-\d{1,2}o?\b/i;
