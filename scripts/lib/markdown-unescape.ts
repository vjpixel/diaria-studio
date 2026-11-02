/**
 * markdown-unescape.ts (#1188)
 *
 * Reverte escapes adicionados pelo Google Docs no round-trip MD→Doc→MD.
 *
 * Quando `drive-sync.ts` faz upload de um `.md` com mime
 * `application/vnd.google-apps.document`, Drive converte pra Doc nativo.
 * No pull, o export `text/markdown` adiciona backslashes antes de chars
 * markdown-significativos pra "preservar literalidade" no MD exportado.
 * Resultado: hashtags viram `\#`, underscores viram `\_`, autolinks
 * viram `[url](url)` etc.
 *
 * Comportamento observado no Drive (edição 260513):
 *   `#InteligenciaArtificial` → `\#InteligenciaArtificial`
 *   `comment_diaria`           → `comment\_diaria`
 *   `{edition_url}`            → `{edition\_url}`
 *   `https://diar.ia.br`       → `[https://diar.ia.br](https://diar.ia.br)`
 *
 * Esta função desfaz esses escapes.
 *
 * Edge case: input legacy com `\\X` (literal backslash + special) é
 * tratado como escape — o segundo backslash + X vira X. Em prática, MD
 * source gerado pelo pipeline nunca tem `\\` literal antes de specials,
 * então o trade-off é aceitável.
 */

/**
 * Regex unescape: backslash seguido de char markdown-significativo.
 *
 * Char class inclui ` * _ { } [ ] ( ) # + - . ! | > (CommonMark + observação
 * empírica do Drive export). Note: `]` é escapado como `\]` e `-` como `\-`
 * dentro do char class pra evitar fim prematuro / range interpretation.
 *
 * #11786: `$` (o export escapa `US$ 2 bi` como `US\$ 2 bi`, e o `\$` ia parar
 * no HTML do e-mail mensal) e `~` (tachado GFM) entraram na classe.
 */
const UNESCAPE_RE = /\\([`*_{}[\]()#+\-.!|>$~])/g;

/**
 * Regex autolink: `[text](url)` onde text === url. Drive Docs export converte
 * URLs nuas (autolinks Markdown) pra forma explícita. Colapsamos de volta.
 */
const AUTOLINK_RE = /\[([^\]\n]+)\]\(([^)\n]+)\)/g;

/**
 * #1582: Drive Doc round-trip flips `**[Title](url)**` (bold-wraps-link, fonte
 * canônica do pipeline) pra `[**Title**](url)` (link-wraps-bold). Semanticamente
 * equivalente em CommonMark mas downstream parsers (lint determinístico,
 * extractor de destaque) podem tratar diferente — flag mecanicamente quebrava
 * lint multiline-links / counter de items em #1581.
 *
 * Normaliza de volta pra `**[Title](url)**` pós-pull. Conservativa: só inverte
 * quando o título inteiro está envolto em `**...**` balanceados.
 */
const BOLD_INSIDE_LINK_RE = /\[\*\*([^[\]\n]+?)\*\*\]\((https?:\/\/[^)\n]+)\)/g;

/**
 * Desfaz escapes Markdown adicionados pelo Google Docs no round-trip MD→Doc→MD.
 *
 * @param content - markdown bruto exportado do Drive (pulled)
 * @returns markdown sanitizado, equivalente ao que o push originalmente subiu
 */
export function unescapeMarkdown(content: string): string {
  return content
    .replace(UNESCAPE_RE, "$1")
    .replace(AUTOLINK_RE, (match, text: string, url: string) =>
      text === url ? url : match,
    )
    .replace(BOLD_INSIDE_LINK_RE, (_match, text: string, url: string) =>
      `**[${text}](${url})**`,
    );
}
