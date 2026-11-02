/**
 * clarice-suggestion-guard.ts (#11798)
 *
 * Filtro de RUÍDO sobre as sugestões da Clarice antes de qualquer apply
 * mecânico. Na edição 261103, uma chamada de `mcp__clarice__correct_text` com
 * o texto editorial inteiro (~25 parágrafos) devolveu 21 "correções" e
 * nenhuma era de conteúdo:
 *
 *   - 20 eram só `\n\n` inserido antes da 1ª palavra de cada parágrafo
 *     (`from: "Palavra"`, `to: "\n\nPalavra"`), algumas sem regra/explicação;
 *   - 1 trocava `.` por `."}]}]);\n}` ("ponto final dentro das aspas") —
 *     resto de serialização vazando do servidor pro campo `to`.
 *
 * O defeito é do servidor MCP externo (fora deste repo). Aqui a mitigação é
 * recusar, no apply, as duas formas que nunca são correção legítima de texto
 * editorial:
 *
 *   1. `whitespace_only` — `from` e `to` só diferem em espaço/quebra de linha.
 *      Clarice corrige ortografia/gramática; mexer só em whitespace num texto
 *      markdown muda a estrutura (parágrafos, listas), nunca a língua.
 *   2. `structural_injection` — `to` introduz quebra de linha nova ou um
 *      caractere de código (`{ } [ ] < > \` ou backtick) que não existia em
 *      `from`. Português corrido não ganha chave/colchete numa correção, e
 *      quebra de linha nova reestrutura o markdown.
 *
 * Função pura, sem I/O — consumida por `scripts/clarice-apply.ts` (caminho do
 * MCP) e por `scripts/lib/clarice-chunk.ts` (fallback REST chunked), pra que
 * os dois caminhos recusem o mesmo ruído.
 */

export type ClariceNoiseReason = "whitespace_only" | "structural_injection";

/** Caracteres que nunca entram em texto editorial por uma correção da Clarice. */
const CODE_CHARS = ["{", "}", "[", "]", "<", ">", "\\", "`"] as const;

function countChar(s: string, ch: string): number {
  let n = 0;
  for (const c of s) if (c === ch) n++;
  return n;
}

function stripWhitespace(s: string): string {
  return s.replace(/\s+/g, "");
}

/**
 * Classifica uma sugestão como ruído (retorna o motivo) ou como candidata
 * legítima (retorna `null`). Não julga se a correção é boa — só recusa as
 * formas que corrompem o texto quando aplicadas mecanicamente.
 *
 * `from === to` não é ruído aqui (é no-op, os chamadores já tratam).
 */
export function classifyClariceNoise(from: string, to: string): ClariceNoiseReason | null {
  if (from === to) return null;

  if (stripWhitespace(from) === stripWhitespace(to)) return "whitespace_only";

  if (countChar(to, "\n") > countChar(from, "\n")) return "structural_injection";

  for (const ch of CODE_CHARS) {
    if (countChar(to, ch) > countChar(from, ch)) return "structural_injection";
  }

  return null;
}
