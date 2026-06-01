/**
 * inline-link.ts (#599)
 *
 * Helper compartilhado pra extrair `[título](URL)` (markdown link) de uma
 * linha. Usado pelos parsers de destaque/seção do `02-reviewed.md` durante
 * a transição de "URL em linha separada" pra "URL inline no título" (#599).
 *
 * Parsers aceitam ambos os formatos durante a transição — quando o caller
 * recebe `null`, deve usar o fallback legacy (linha solo de URL).
 */

export interface InlineLink {
  title: string;
  url: string;
}

export interface InlineLinkWithTrailing extends InlineLink {
  trailing: string;
}

/**
 * #1662: parseia um markdown link `[título](URL http(s))` que COMEÇA a linha
 * (após whitespace + `**` opcional), escaneando o destino com **balanceamento
 * de parênteses** — `(` aprofunda, `)` em depth 0 fecha — exatamente como
 * `processInlineLinks` (#1634). Sem isso, URLs com parênteses literais (ex.:
 * `.../GPT_(modelo)`, `.../file%20(1).pdf`) eram cortadas no primeiro `)`: o
 * regex antigo (`[^\s)]+`) parava cedo, e a linha caía no fallback (link
 * morto + título cru no email).
 *
 * Retorna `{ rawTitle, url, rest }`:
 *  - `rawTitle`: texto entre `[...]` (sem strip de `**`).
 *  - `url`: destino http(s) com parênteses balanceados.
 *  - `rest`: o que sobra após o `)` de fechamento, com um `**` de fechamento
 *    opcional já consumido.
 * `null` se a linha não começa com um link http(s) bem-formado.
 */
function parseLinkAtLineStart(
  line: string,
): { rawTitle: string; url: string; rest: string } | null {
  // `**` de abertura é opcional e independente do de fechamento (#590).
  const head = line.match(/^\s*(?:\*\*)?\[([^\]]+)\]\(/);
  if (!head) return null;
  const rawTitle = head[1];
  const destStart = head[0].length;
  // Destino precisa ser http(s) — rejeita `[t](example.com)` e `[t]()`.
  if (!/^https?:\/\//.test(line.slice(destStart))) return null;
  // Scan balanceando parênteses até o `)` de fechamento do markdown link.
  // Whitespace no destino encerra o scan SEM fechar → URL inválida (preserva o
  // gate `[^\s)]` do regex antigo: destino com espaço cru cai no fallback, não
  // vira href quebrado).
  let depth = 0;
  let j = destStart;
  let closed = false;
  for (; j < line.length; j++) {
    const ch = line[j];
    if (ch === "(") depth++;
    else if (ch === ")") {
      if (depth === 0) {
        closed = true;
        break;
      }
      depth--;
    } else if (/\s/.test(ch)) {
      break; // espaço no destino → não fechou com `)` → inválido
    }
  }
  if (!closed) return null; // sem `)` de fechamento (ou whitespace no meio)
  const url = line.slice(destStart, j);
  if (!url) return null;
  let rest = line.slice(j + 1);
  // `**` de fechamento opcional (independente do de abertura, #590).
  if (rest.startsWith("**")) rest = rest.slice(2);
  return { rawTitle, url, rest };
}

/**
 * Strip de `**...**` externo balanceado no título (#1051) — o source
 * `02-reviewed.md` usa `[**Título**](url)` como convenção de h1, mas no HTML
 * o `font-weight:bold` vem do CSS; sem o strip os asteriscos vazariam. Só
 * strippa quando ABRE e FECHA com `**` (não toca em unbalanced ou nested).
 * Retorna "" se o título ficar vazio após o strip.
 */
function normalizeTitle(rawTitle: string): string {
  let title = rawTitle.trim();
  if (title.length >= 4 && title.startsWith("**") && title.endsWith("**")) {
    title = title.slice(2, -2).trim();
  }
  return title;
}

/**
 * Tenta parsear linha como `[título](URL)` (link puro — nada depois do link).
 * Retorna `null` se não bater o pattern (caller decide fallback).
 *
 * Aceita wrapping em **negrito** (#590) — `**[Título](URL)**` é equivalente
 * a `[Título](URL)` — e strippa `**...**` interno balanceado no título (#1051).
 */
export function parseInlineLink(line: string): InlineLink | null {
  const m = parseLinkAtLineStart(line);
  if (!m) return null;
  if (m.rest.trim() !== "") return null; // texto após o link → não é link puro
  const title = normalizeTitle(m.rawTitle);
  const url = m.url.trim();
  if (!title || !url) return null;
  return { title, url };
}

/**
 * Retorna `true` se a linha é um inline link puro (título + URL na mesma
 * linha, sem texto depois). Útil pros parsers que só precisam classificar.
 */
export function isInlineLinkLine(line: string): boolean {
  return parseInlineLink(line) !== null;
}

/**
 * #1581: extrai inline link + trailing text quando a linha tem ambos.
 * Caso real: Drive pull (#1582) reformata `**[Title](url)**  \nsummary`
 * pra `[**Title**](url) summary` (link wraps bold, summary inline) —
 * `parseInlineLink` rejeita porque tem texto após o link.
 *
 * Retorna `null` se a linha não tem link ou se o link consome a linha toda
 * (caller usa `parseInlineLink` nesse caso).
 */
export function parseInlineLinkWithTrailing(
  line: string,
): InlineLinkWithTrailing | null {
  const m = parseLinkAtLineStart(line);
  if (!m) return null;
  // #1581: o trailing precisa ser separado por whitespace (preserva o `\s+` do
  // regex antigo) — `[T](url).` colado em pontuação NÃO é "link + summary".
  if (!/^\s/.test(m.rest)) return null;
  const trailing = m.rest.trim();
  if (trailing === "") return null; // sem trailing → caller usa parseInlineLink
  const title = normalizeTitle(m.rawTitle);
  const url = m.url.trim();
  if (!title || !url) return null;
  return { title, url, trailing };
}
