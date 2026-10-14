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
  { label: "Pré-MBA", re: /pr[ée]-?\s?MBA/i },
];

function visibleText(html: string): string {
  return html
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
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
    for (const m of TEXT_MARKERS) if (m.re.test(text)) found.push(m.label);
  }
  return found;
}
