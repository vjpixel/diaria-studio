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
 *      `texto,outro`→`texto, outro` são correções reais e passam. Continua
 *      ruído quando a quebra muda de lugar (#11876) ou quando o espaço cai
 *      dentro de URL/domínio/markup markdown (#11875: `openai. com`,
 *      `** negrito**`, `-item`, `##Título`).
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
 * Quebra de linha que muda de LUGAR (#11876): com a mesma quantidade de `\n`,
 * cada linha precisa conter os mesmos caracteres visíveis. `a b\nc`→`a\nb c`
 * desloca a fronteira de parágrafo sem mudar a contagem.
 */
function linesShifted(from: string, to: string): boolean {
  const a = from.split("\n");
  const b = to.split("\n");
  return a.some((line, i) => stripWhitespace(line) !== stripWhitespace(b[i] ?? ""));
}

/**
 * Para cada caractere visível `k` (índice no texto sem espaços), o espaço que
 * vem antes dele. `gaps[n]` é o espaço depois do último caractere visível.
 */
function whitespaceGaps(s: string): { chars: string[]; gaps: string[] } {
  const chars: string[] = [];
  const gaps: string[] = [];
  let pending = "";
  for (const c of s) {
    if (/\s/.test(c)) {
      pending += c;
    } else {
      gaps.push(pending);
      chars.push(c);
      pending = "";
    }
  }
  gaps.push(pending);
  return { chars, gaps };
}

/**
 * Palavra (sequência de caracteres visíveis) que encosta no ponto `k`, em uma
 * das versões: o que vem antes até o espaço anterior, e o que vem depois até
 * o próximo espaço. `atLineStart` diz se a parte da esquerda começa no início
 * de linha (ou do trecho, que pode ser início de linha no texto inteiro).
 */
function tokenAround(
  chars: string[],
  gaps: string[],
  k: number,
): { left: string; right: string; atLineStart: boolean } {
  let i = k - 1;
  while (i > 0 && gaps[i] === "") i--;
  let j = k + 1;
  while (j < chars.length && gaps[j] === "") j++;
  const left = chars.slice(Math.max(i, 0), k).join("");
  const right = chars.slice(k, j).join("");
  const atLineStart = i <= 0 || gaps[i].includes("\n");
  return { left, right, atLineStart };
}

/** Marcador de bloco markdown no início da linha: lista, lista numerada, título, citação. */
const LINE_MARKER = /^(?:[-*+]|\d+[.)]|#{1,6}|>)/;
/** URL, link markdown ou domínio (`openai.com` — TLD minúsculo, pra não pegar `fim.Começo`). */
const URL_LIKE = /:\/\/|\]\(|www\.|[A-Za-z0-9-]\.[a-z]{2,}/;
/** Ênfase/markup inline: negrito, itálico, tachado, tabela, título. */
const INLINE_MARKUP = /[*_~|#]/;

/**
 * Diferença de espaço DENTRO de URL ou de markup markdown (#11875): a Clarice
 * aplica "falta espaço depois da pontuação" a `openai.com` (→`openai. com`),
 * a caminho dentro de link, ou cola/descola o marcador de negrito, lista e
 * título (`** negrito**`, `-item`, `##Título`). Olha só a palavra que encosta
 * em cada ponto onde o espaço mudou, nas duas versões, pra que uma correção
 * real no mesmo trecho que um link não seja recusada à toa.
 */
function touchesUrlOrMarkup(from: string, to: string): boolean {
  const f = whitespaceGaps(from);
  const t = whitespaceGaps(to);
  for (let k = 1; k < f.chars.length; k++) {
    if (f.gaps[k] === t.gaps[k]) continue;
    for (const v of [f, t]) {
      const { left, right, atLineStart } = tokenAround(v.chars, v.gaps, k);
      const word = left + right;
      if (URL_LIKE.test(word) || INLINE_MARKUP.test(word)) return true;
      if (atLineStart && LINE_MARKER.test(word)) return true;
    }
  }
  return false;
}

/**
 * Diferença só de espaço que é ruído estrutural (#11798) e não correção
 * (#11867): `to` muda a quantidade de quebras de linha (parágrafo inserido ou
 * juntado), muda a quebra de lugar (#11876), a diferença fica só na borda das
 * linhas (começo/fim do trecho, indentação, espaço antes de `\n` que vira
 * hard break no markdown) ou cai dentro de URL/markup (#11875).
 *
 * Espaço inserido/removido NO MEIO da linha, em texto corrido, é correção
 * legítima e passa: `afim de`→`a fim de`, `Porque`→`Por que`, `se não`→`senão`,
 * `a cerca de`→`acerca de`, `texto,outro`→`texto, outro`, `a  b`→`a b`.
 */
function isStructuralWhitespaceChange(from: string, to: string): boolean {
  if (countChar(to, "\n") !== countChar(from, "\n")) return true;
  if (linesShifted(from, to)) return true;
  if (trimLines(from) === trimLines(to)) return true;
  return touchesUrlOrMarkup(from, to);
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
