/**
 * scripts/lib/home-widget-probe.ts (#5545)
 *
 * Sondagem ESTÁTICA (sem navegador) do HTML servido pela home com uma query
 * string de teste — item 3 do escopo da #5545. A #5522 registrou que o
 * botão "Assinar grátis" é widget JS do Beehiiv, sem `href` no HTML, e por
 * isso **não dá pra provar por inspeção estática se ele carrega a query
 * string adiante**. Isso continua verdade aqui — este módulo reduz
 * superfície e serve de diagnóstico rápido (o script carrega? existe form
 * nativo além do widget? a query aparece ecoada em algum lugar do HTML,
 * caso exista SSR de algum tipo?), **nunca** como aprovação. O gate
 * continua sendo a passada real no navegador (`docs/roteiro-preflight-utm-3-canais.md`).
 */

export interface HomeWidgetProbeFinding {
  /** Marcação/script relacionado ao Beehiiv encontrado em algum lugar do HTML. */
  hasBeehiivMarkup: boolean;
  /** Existe um `<form>` nativo na página (fora do widget JS) associado a
   *  texto de assinatura ("assinar"/"subscribe") nas proximidades. */
  hasNativeSubscribeForm: boolean;
  /** `href`s de âncoras cujo texto ou destino sugere ser o link/botão de
   *  assinatura — normalmente vazio, já que o botão real é widget JS sem
   *  `href` (achado da #5522); presença aqui seria uma SURPRESA que vale
   *  investigar manualmente. */
  subscribeAnchorHrefs: string[];
  /** `true` se a query string usada na requisição aparece literalmente
   *  ecoada em algum lugar do HTML servido (indício fraco — a maioria dos
   *  widgets client-side não faz isso, então `false` aqui NÃO significa que
   *  o widget não vai carregar a query; é só um sinal a mais). */
  queryStringEchoedInHtml: boolean;
  /** Trecho de ~400 chars ao redor da primeira ocorrência de "assinar" no
   *  HTML — útil pra inspeção manual rápida sem baixar o arquivo inteiro. */
  snippetAroundAssinar: string | null;
}

const ANCHOR_RE = /<a\s+[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;

/**
 * Analisa o HTML servido pela home (já baixado) contra uma query string de
 * teste. Pura — não faz I/O; o caller busca o HTML separadamente.
 *
 * @param html         HTML bruto da resposta.
 * @param queryString  A query string usada na requisição (com ou sem `?`
 *                      inicial — normalizado aqui), usada só pra checar se
 *                      ela aparece ecoada no HTML.
 */
export function probeHomeWidgetHtml(html: string, queryString: string): HomeWidgetProbeFinding {
  const hasBeehiivMarkup = /beehiiv/i.test(html);

  const anchors: Array<{ href: string; text: string }> = [];
  let m: RegExpExecArray | null;
  ANCHOR_RE.lastIndex = 0;
  while ((m = ANCHOR_RE.exec(html))) {
    anchors.push({ href: m[1], text: m[2].replace(/<[^>]*>/g, " ").trim() });
  }
  const subscribeAnchorHrefs = anchors
    .filter((a) => /assinar|subscribe/i.test(a.text) || /assinar|subscribe/i.test(a.href))
    .map((a) => a.href);

  const hasNativeSubscribeForm = /<form[^>]*>/i.test(html) && /assinar|subscribe/i.test(html);

  const normalizedQuery = queryString.startsWith("?") ? queryString.slice(1) : queryString;
  const queryStringEchoedInHtml = normalizedQuery.length > 0 && html.includes(normalizedQuery);

  const idx = html.search(/assinar/i);
  const snippetAroundAssinar = idx >= 0 ? html.slice(Math.max(0, idx - 200), idx + 200) : null;

  return {
    hasBeehiivMarkup,
    hasNativeSubscribeForm,
    subscribeAnchorHrefs,
    queryStringEchoedInHtml,
    snippetAroundAssinar,
  };
}

/** Formata o achado como texto human-readable pra stdout, com o disclaimer
 *  de que isto é diagnóstico, não gate. @pure */
export function formatHomeWidgetProbeFinding(finding: HomeWidgetProbeFinding, url: string): string {
  const lines = [
    `Sondagem estática de: ${url}`,
    `  markup Beehiiv encontrado: ${finding.hasBeehiivMarkup ? "sim" : "não"}`,
    `  <form> nativo associado a "assinar": ${finding.hasNativeSubscribeForm ? "sim" : "não"}`,
    `  âncoras com href de assinatura: ${
      finding.subscribeAnchorHrefs.length > 0 ? finding.subscribeAnchorHrefs.join(", ") : "(nenhuma — esperado, o botão é widget JS sem href)"
    }`,
    `  query string ecoada no HTML: ${finding.queryStringEchoedInHtml ? "sim" : "não (esperado — widget client-side)"}`,
    finding.snippetAroundAssinar ? `  trecho ao redor de "assinar":\n    ${finding.snippetAroundAssinar.replace(/\s+/g, " ").trim()}` : `  "assinar" não encontrado no HTML`,
    "",
    "AVISO: isto é diagnóstico, NÃO é gate. A #5522 já registrou que o widget",
    "\"Assinar grátis\" é JS sem href — a inspeção estática não prova se ele",
    "carrega a query string adiante. O gate é a passada real no navegador",
    "(ver docs/roteiro-preflight-utm-3-canais.md).",
  ];
  return lines.join("\n");
}
