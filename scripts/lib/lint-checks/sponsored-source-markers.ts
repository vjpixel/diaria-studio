/**
 * #10169: marcadores de publieditorial na página-fonte de um item.
 *
 * Decisão do editor (14/10/2026): lint WARN-only no resumo do gate 4 quando a
 * página-fonte tem marcador de publieditorial — nunca descarta o item no
 * Stage 1; a decisão final é do editor no gate. Lista de marcadores = a que o
 * editor nomeou na decisão (`/publicidade/`, "conteúdo de marca", "patrocinado",
 * "Pré-MBA"), mais as variantes ortográficas diretas ("publieditorial",
 * "conteúdo patrocinado"). Sem marcadores inventados além desses.
 *
 * Pure: recebe URL + HTML cacheado, devolve os rótulos que casaram.
 */

const URL_PATH_MARKERS: Array<{ label: string; re: RegExp }> = [
  { label: "URL contém /publicidade/", re: /\/publicidade(\/|$)/i },
  { label: "URL contém /publieditorial", re: /\/publieditorial/i },
];

const TEXT_MARKERS: Array<{ label: string; re: RegExp }> = [
  { label: "publieditorial", re: /publieditorial/i },
  { label: "conteúdo de marca", re: /conte[úu]do\s+de\s+marca/i },
  { label: "conteúdo patrocinado", re: /conte[úu]do\s+patrocinado/i },
  { label: "patrocinado", re: /\bpatrocinad[oa]s?\b/i },
  { label: "Pré-MBA", re: /\bpr[ée]-?\s?MBA/i },
];

const ENTITIES: Record<string, string> = {
  "&nbsp;": " ", "&amp;": "&", "&uacute;": "ú", "&eacute;": "é", "&Eacute;": "É", "&Uacute;": "Ú",
};

function decodeCodePoint(cp: number, original: string): string {
  try {
    return String.fromCodePoint(cp);
  } catch {
    return original; // fora do intervalo Unicode
  }
}

/**
 * #10215: quantos caracteres de HTML ANTES do bloco principal entram no escopo —
 * o selo "Conteúdo patrocinado"/"Publieditorial" costuma ficar num header logo
 * fora do `<article>`. Curto o bastante pra não puxar o menu/rodapé do portal.
 */
const PRE_ARTICLE_WINDOW = 1500;

/** Blocos `<article>`/`<main>` com fechamento casado por profundidade (aninhamento ok). */
function scopeBlocks(html: string): Array<{ start: number; end: number }> {
  const blocks: Array<{ start: number; end: number }> = [];
  const openRe = /<(article|main)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = openRe.exec(html))) {
    const tag = m[1].toLowerCase();
    const tagRe = new RegExp(`<(/?)${tag}\\b[^>]*>`, "gi");
    tagRe.lastIndex = m.index;
    let depth = 0;
    let t: RegExpExecArray | null;
    while ((t = tagRe.exec(html))) {
      depth += t[1] ? -1 : 1;
      if (depth === 0) {
        blocks.push({ start: m.index, end: t.index + t[0].length });
        break;
      }
    }
  }
  return blocks;
}

/**
 * Restringe ao bloco principal (evita rodapé/widgets de anúncio do portal).
 * #10215: o principal é o maior `<article>`/`<main>` que contém o `<h1>` (ou o
 * maior de todos, sem `<h1>` dentro de nenhum) — não o PRIMEIRO, que em muitos
 * portais é um card de conteúdo relacionado — mais uma janela antes dele, onde
 * costuma ficar o selo de patrocínio.
 */
function articleScope(html: string): string {
  const blocks = scopeBlocks(html);
  if (blocks.length === 0) return html;
  const h1 = html.search(/<h1\b/i);
  const withH1 = h1 >= 0 ? blocks.filter((b) => b.start <= h1 && h1 < b.end) : [];
  const pool = withH1.length > 0 ? withH1 : blocks;
  const main = pool.reduce((a, b) => (b.end - b.start > a.end - a.start ? b : a));
  let from = Math.max(0, main.start - PRE_ARTICLE_WINDOW);
  if (from > 0) {
    // Não começar no meio de uma tag (atributo viraria "texto visível").
    const nextTag = html.indexOf("<", from);
    from = nextTag >= 0 && nextTag < main.start ? nextTag : main.start;
  }
  return html.slice(from, main.end);
}

function visibleText(html: string): string {
  return articleScope(html)
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x([0-9a-f]+);/gi, (e, n) => decodeCodePoint(parseInt(n, 16), e))
    .replace(/&#(\d+);/g, (e, n) => decodeCodePoint(Number(n), e))
    .replace(/&[a-zA-Z]+;/g, (e) => ENTITIES[e] ?? e)
    .replace(/\s+/g, " ");
}

export function detectSponsoredMarkers(url: string, html: string | null): string[] {
  const found: string[] = [];
  let path = url;
  try {
    path = new URL(url).pathname;
  } catch {
    // URL malformada: testa a string crua
  }
  for (const m of URL_PATH_MARKERS) if (m.re.test(path)) found.push(m.label);
  if (html) {
    const text = visibleText(html);
    for (const m of TEXT_MARKERS) {
      if (m.label === "patrocinado" && found.includes("conteúdo patrocinado")) continue;
      if (m.re.test(text)) found.push(m.label);
    }
  }
  return found;
}
