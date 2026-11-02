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
 *   1. `whitespace_only` — `from` e `to` só diferem em espaço, e a diferença é
 *      estrutural: muda a quantidade de quebras de linha ou fica só na borda
 *      das linhas (começo/fim do trecho, indentação). Isso muda o markdown
 *      (parágrafos, listas, hard break), nunca a língua. Espaço no MEIO da
 *      linha não é ruído (#11867): `afim de`→`a fim de`, `Porque`→`Por que`,
 *      `texto,outro`→`texto, outro` são correções reais e passam.
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

/** Apara cada linha (borda do texto inteiro e borda de cada linha). */
function trimLines(s: string): string {
  return s
    .split("\n")
    .map((l) => l.trim())
    .join("\n");
}

/**
 * Diferença só de espaço que é ruído estrutural (#11798) e não correção
 * (#11867): `to` muda a quantidade de quebras de linha (parágrafo inserido ou
 * juntado), ou a diferença fica só na borda das linhas (começo/fim do trecho,
 * indentação, espaço antes de `\n` que vira hard break no markdown).
 *
 * Espaço inserido/removido NO MEIO da linha é correção legítima e passa:
 * `afim de`→`a fim de`, `Porque`→`Por que`, `se não`→`senão`,
 * `a cerca de`→`acerca de`, `texto,outro`→`texto, outro`, `a  b`→`a b`.
 */
function isStructuralWhitespaceChange(from: string, to: string): boolean {
  if (countChar(to, "\n") !== countChar(from, "\n")) return true;
  return trimLines(from) === trimLines(to);
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

  if (stripWhitespace(from) === stripWhitespace(to)) {
    // Mesmos caracteres visíveis: ruído só se a mudança for estrutural
    // (#11867 — antes toda diferença de espaço era recusada, inclusive
    // `afim de`→`a fim de`). Sem caractere visível novo, não há injeção de
    // código a checar abaixo.
    return isStructuralWhitespaceChange(from, to) ? "whitespace_only" : null;
  }

  if (countChar(to, "\n") > countChar(from, "\n")) return "structural_injection";

  for (const ch of CODE_CHARS) {
    if (countChar(to, ch) > countChar(from, ch)) return "structural_injection";
  }

  return null;
}
