/**
 * html-document.ts (#13055)
 *
 * Documento HTML completo (`<!doctype html>` + `<meta charset>` + viewport) para
 * as páginas de prévia que o editor abre no Artifact. Sem o doctype a página
 * renderiza em quirks mode (o Artifact avisa a cada publicação, pacote semanal
 * 26w46), e sem charset/viewport o acento e a largura no celular dependem do
 * navegador adivinhar.
 *
 * Duas entradas:
 * - `buildHtmlDocument` para quem monta a página do zero (prévia da Stack);
 * - `ensureHtmlDocument` para página já escrita (a prévia do LinkedIn, montada
 *   à mão no gate): idempotente, nunca mexe em documento que já abre com
 *   doctype.
 *
 * Pure, sem I/O. A CLI `scripts/ensure-html-document.ts` aplica o segundo em
 * arquivos no lugar.
 */

export const HTML_DOCTYPE = "<!doctype html>";
export const HTML_META_CHARSET = '<meta charset="utf-8">';
export const HTML_META_VIEWPORT = '<meta name="viewport" content="width=device-width, initial-scale=1">';

export interface HtmlDocumentParts {
  /** Conteúdo do `<head>` além de charset/viewport (`<title>`, `<style>`...). */
  head?: string;
  body: string;
  lang?: string;
}

/** Pure: documento completo a partir de head e body. */
export function buildHtmlDocument(parts: HtmlDocumentParts): string {
  const lang = parts.lang ?? "pt-BR";
  const head = parts.head?.trim() ? `\n${parts.head.trim()}` : "";
  return (
    `${HTML_DOCTYPE}\n<html lang="${lang}">\n<head>\n${HTML_META_CHARSET}\n${HTML_META_VIEWPORT}${head}\n</head>\n<body>\n` +
    `${parts.body.replace(/\n+$/, "")}\n</body>\n</html>\n`
  );
}

/** Pure: `true` quando o HTML já abre com `<!doctype html>` (sem caixa, espaço/BOM antes). */
export function hasHtmlDoctype(html: string): boolean {
  return /^﻿?\s*<!doctype\s+html\b/i.test(html);
}

/**
 * Pure: garante doctype + charset + viewport.
 * - Já tem doctype: devolve igual.
 * - Tem `<html>`: acrescenta o doctype e, no `<head>` (criado se faltar), o
 *   charset e o viewport que não existirem.
 * - Fragmento (sem `<html>`): embrulha num documento; `<title>`/`<style>`/
 *   `<meta>`/`<link>` do começo do fragmento vão para o `<head>`.
 */
export function ensureHtmlDocument(html: string, opts: { lang?: string } = {}): string {
  if (hasHtmlDoctype(html)) return html;
  const src = html.replace(/^﻿/, "");
  const metas = (head: string): string =>
    [/<meta\s[^>]*charset\s*=/i.test(head) ? "" : HTML_META_CHARSET, /<meta\s[^>]*name\s*=\s*["']?viewport/i.test(head) ? "" : HTML_META_VIEWPORT]
      .filter(Boolean)
      .join("\n");

  if (/<html[\s>]/i.test(src)) {
    const headMatch = /<head(\s[^>]*)?>([\s\S]*?)<\/head>/i.exec(src);
    let out: string;
    if (headMatch) {
      const add = metas(headMatch[2]);
      out = add ? src.replace(/<head(\s[^>]*)?>/i, (m) => `${m}\n${add}`) : src;
    } else {
      out = src.replace(/<html(\s[^>]*)?>/i, (m) => `${m}\n<head>\n${metas("")}\n</head>`);
    }
    return `${HTML_DOCTYPE}\n${out.replace(/^\s+/, "")}`;
  }

  // Fragmento: separa os elementos de cabeçalho do começo.
  const headRe = /^\s*(<title[\s>][\s\S]*?<\/title>|<style[\s>][\s\S]*?<\/style>|<meta\s[^>]*>|<link\s[^>]*>)/i;
  let rest = src;
  const head: string[] = [];
  for (let m = headRe.exec(rest); m; m = headRe.exec(rest)) {
    head.push(m[1]);
    rest = rest.slice(m[0].length);
  }
  // charset/viewport que o fragmento já traz ficam; só os que faltam entram.
  const headText = [metas(head.join("\n")), ...head].filter(Boolean).join("\n");
  const lang = opts.lang ?? "pt-BR";
  return `${HTML_DOCTYPE}\n<html lang="${lang}">\n<head>\n${headText}\n</head>\n<body>\n${rest.trim()}\n</body>\n</html>\n`;
}
