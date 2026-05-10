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

/**
 * Regex pra linha que contém APENAS um markdown link bem-formado.
 * Aceita whitespace antes/depois, e wrapping em **negrito** (#590) —
 * `**[Título](URL)**` é equivalente a `[Título](URL)` pro parser.
 *
 * Exemplos válidos:
 *   "[Título](https://example.com)"
 *   "  [Título com espaços](https://x.com/path?q=1)  "
 *   "**[Título em negrito](https://x.com)**"
 *
 * Exemplos rejeitados (ficam pro fallback legacy):
 *   "Texto antes [Título](https://x.com)"
 *   "[Título](https://x.com) texto depois"
 *   "Linha solo de URL: https://x.com"
 *   "[título sem url]()"
 */
const INLINE_LINK_RE = /^\s*(?:\*\*)?\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)(?:\*\*)?\s*$/;

export interface InlineLink {
  title: string;
  url: string;
}

/**
 * Tenta parsear linha como `[título](URL)`. Retorna `null` se não bater
 * o pattern (caller decide fallback).
 *
 * Strippa wrappers `**...**` no título quando balanceados (#XXX) — o source
 * `02-reviewed.md` usa `[**Título**](url)` como convenção de h1, mas no HTML
 * renderizado o `font-weight:bold` já vem do CSS. Sem o strip, os asteriscos
 * vazariam literais na newsletter (visible regression nos 3 destaques).
 */
export function parseInlineLink(line: string): InlineLink | null {
  const m = line.match(INLINE_LINK_RE);
  if (!m) return null;
  let title = m[1].trim();
  const url = m[2].trim();
  if (!title || !url) return null;
  // Strip outer **...** se balanceado. Não tocar em unbalanced ou nested.
  if (title.length >= 4 && title.startsWith("**") && title.endsWith("**")) {
    title = title.slice(2, -2).trim();
  }
  if (!title) return null;
  return { title, url };
}

/**
 * Retorna `true` se a linha bate o pattern de inline link (título+URL na
 * mesma linha). Útil pros parsers que só precisam classificar a linha.
 */
export function isInlineLinkLine(line: string): boolean {
  return INLINE_LINK_RE.test(line);
}
