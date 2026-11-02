/**
 * doc-export-normalize.ts (#11786)
 *
 * Normaliza o markdown que volta do export `text/markdown` de um Google Doc
 * (round-trip MD → Doc → MD do `drive-sync.ts`), para que um pull sem edição
 * humana devolva o mesmo arquivo que o push subiu.
 *
 * Achado ao vivo em /diaria-mensal 2610-11 (01/11/2026), push seguido de pull
 * do `draft.md` sem nenhuma edição no Doc:
 *   1. escapes (`US$` → `US\$`) — tratado em `unescapeMarkdown` (#1188);
 *   2. espaços no fim de linha;
 *   3. linha em branco entre um rótulo terminado em `:` (`Curadorias:`,
 *      `Da diar.ia.br:`) e a lista logo abaixo — dispara FATAL em
 *      `lint-monthly-draft.ts` (#6881) e faz o render cair no rótulo genérico;
 *   4. imagem remota (`![alt](https://...)`) trocada por referência
 *      `![alt][image1]` com a definição `[image1]: <data:image/...;base64,...>`
 *      no fim do arquivo — o draft foi de 14 KB para 2,6 MB, e a imagem iria
 *      inline no e-mail (o Gmail corta acima de 102 KB).
 *
 * O item 4 só tem conserto quando o local de antes do pull traz as URLs
 * remotas na mesma quantidade (o Docs não guarda a URL de origem). Quando não
 * dá para restaurar, `unresolvedInlineImages > 0` e quem chama decide não
 * sobrescrever o local.
 */

import { unescapeMarkdown } from "./markdown-unescape.ts";

export interface DocExportNormalizeResult {
  /** Markdown normalizado. */
  text: string;
  /** Imagens restauradas para a URL remota do local de antes do pull. */
  restoredImages: number;
  /** Referências a imagem embutida (data URI) que não deu para restaurar. */
  unresolvedInlineImages: number;
}

/** Definição de referência com data URI: `[image1]: <data:image/png;base64,...>`. */
const DATA_URI_DEF_RE = /^\[([^\]\n]+)\]:\s*<?data:[^\s>]*>?[ \t]*$/;

/** Uso de imagem por referência: `![alt][image1]`. */
const IMAGE_REF_USE_RE = /!\[([^\]\n]*)\]\[([^\]\n]+)\]/g;

/** Imagem inline com URL remota: `![alt](https://...)`. */
const REMOTE_IMAGE_RE = /!\[[^\]\n]*\]\(https?:\/\/[^)\s]+(?:\s+"[^"\n]*")?\)/g;

/** Imagem inline já com data URI: `![alt](data:image/...)`. */
const INLINE_DATA_IMAGE_RE = /!\[[^\]\n]*\]\(<?data:[^)\s]*>?\)/g;

/** Item de lista (`- `, `* `, `+ `, `1. `). */
const LIST_ITEM_RE = /^\s*(?:[-*+]|\d+[.)])\s+\S/;

/**
 * Rótulo curto terminado em `:` (ex.: `Curadorias:`, `Da diar.ia.br:`).
 * Não casa heading, item de lista, citação nem frase longa — só o parágrafo
 * de uma linha que o pipeline usa como rótulo da lista seguinte.
 */
function isListLabel(line: string): boolean {
  const t = line.trim();
  if (!t.endsWith(":")) return false;
  if (t.length > 60) return false;
  if (/^(#|>|[-*+]\s|\d+[.)]\s)/.test(t)) return false;
  return true;
}

/** Remove espaços/tabs no fim de cada linha. */
export function stripTrailingWhitespace(text: string): string {
  return text.replace(/[ \t]+$/gm, "");
}

/**
 * Remove a(s) linha(s) em branco que o export do Docs insere entre um rótulo
 * terminado em `:` e a lista logo abaixo (#11786). O pipeline grava o rótulo
 * na linha IMEDIATAMENTE anterior à lista (#4968, #6881).
 */
export function collapseLabelListGap(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    out.push(lines[i]);
    if (!isListLabel(lines[i])) continue;
    let j = i + 1;
    while (j < lines.length && lines[j].trim() === "") j++;
    if (j > i + 1 && j < lines.length && LIST_ITEM_RE.test(lines[j])) {
      i = j - 1; // pula as linhas em branco
    }
  }
  return out.join("\n");
}

/**
 * Troca `![alt][imageN]` + definição com data URI pelas imagens remotas do
 * local de antes do pull, na ordem em que aparecem. Só restaura quando a
 * quantidade de usos casa com a de imagens remotas do local; senão deixa o
 * texto como está e conta as não resolvidas.
 */
export function restoreInlineImages(
  text: string,
  localBefore: string | undefined,
): { text: string; restored: number; unresolved: number } {
  const lines = text.split("\n");
  const dataDefs = new Set<string>();
  for (const line of lines) {
    const m = DATA_URI_DEF_RE.exec(line);
    if (m) dataDefs.add(m[1]);
  }

  const uses = [...text.matchAll(IMAGE_REF_USE_RE)].filter((m) => dataDefs.has(m[2]));
  const inlineData = text.match(INLINE_DATA_IMAGE_RE) ?? [];
  if (uses.length === 0 && inlineData.length === 0 && dataDefs.size === 0) {
    return { text, restored: 0, unresolved: 0 };
  }

  const remote = localBefore ? (localBefore.match(REMOTE_IMAGE_RE) ?? []) : [];
  // Inline com data URI também conta: ordem de aparição no texto.
  const totalEmbedded = uses.length + inlineData.length;
  if (totalEmbedded === 0 || remote.length !== totalEmbedded) {
    return { text, restored: 0, unresolved: Math.max(totalEmbedded, dataDefs.size) };
  }

  let idx = 0;
  const combined = new RegExp(
    `${IMAGE_REF_USE_RE.source}|${INLINE_DATA_IMAGE_RE.source}`,
    "g",
  );
  const replaced = text.replace(combined, (match: string, _alt?: string, ref?: string) => {
    // Referência a algo que não é data URI: não mexe.
    if (ref !== undefined && !dataDefs.has(ref)) return match;
    return remote[idx++] ?? match;
  });
  const withoutDefs = replaced
    .split("\n")
    .filter((line) => !DATA_URI_DEF_RE.test(line))
    .join("\n")
    .replace(/\n+$/, "\n");
  return { text: withoutDefs, restored: idx, unresolved: 0 };
}

/**
 * Normalização completa do export do Docs. `localBefore` é o conteúdo local
 * de antes do pull (fonte das URLs remotas das imagens).
 */
export function normalizeDocExportMarkdown(
  exported: string,
  localBefore?: string,
): DocExportNormalizeResult {
  const images = restoreInlineImages(exported, localBefore);
  let text = unescapeMarkdown(images.text);
  text = stripTrailingWhitespace(text);
  text = collapseLabelListGap(text);
  return {
    text,
    restoredImages: images.restored,
    unresolvedInlineImages: images.unresolved,
  };
}
