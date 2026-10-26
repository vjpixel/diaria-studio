/**
 * scripts/lib/site-destaque-anchors.ts (#11003)
 *
 * Âncoras por destaque nas páginas de edição do site (`diar.ia.br/p/{slug}`):
 * `#d1`, `#d2`, `#d3` levam direto à manchete de cada destaque, em vez do
 * topo da edição. O consumidor de origem é o post semanal da Stack
 * (`circle-stack-render.ts`, #10904), mas vale para qualquer link
 * compartilhado para um destaque específico.
 *
 * ## Por que no site e não no e-mail
 *
 * A issue sugeria pôr o `id` em `renderHeadlineInner` (HTML do e-mail). O id
 * entra aqui, na montagem da página (`buildArchivePageHtml`), por três razões:
 *
 *   1. Cliente de e-mail ignora `id`; a página é o único lugar onde ele serve.
 *   2. A MESMA função cobre o backfill das páginas já publicadas — elas não
 *      passam de novo pelo render do e-mail, só pelo HTML que já está em disco.
 *   3. O HTML do e-mail não muda, então nenhum snapshot de e-mail se mexe.
 *
 * ## Como o destaque é reconhecido
 *
 * Pela manchete `<a class="headline" ...>`, com título direto no link ou
 * dentro de `<h2 ...>` (render atual). Os destaques saem na ordem D1, D2,
 * D3, então a N-ésima manchete é o destaque N. Os comentários do render
 * não servem: o HTML servido pelo Kit chega sem comentários. O acervo
 * também contém páginas sem a classe `headline`, que não são reconhecidas.
 *
 * Fora do formato reconhecido a página fica intocada, nunca com âncora
 * chutada: zero manchetes (acervo Beehiiv, formato antigo) ou mais de 3 (algo
 * que a regra de 2–3 destaques, #3369, diz que não existe).
 *
 * ## Modal
 *
 * Âncora sem o ajuste do modal faria o convite abrir na chegada (`#d2`/`#d3`
 * caem no meio ou no fim da página, além dos 50% do gatilho). O ajuste vive
 * em `edition-page-cta.ts` (`editionCtaScript`). Por isso o backfill só põe
 * âncora numa página cujo script do modal consegue trocar pelo atual
 * (`backfillDestaqueAnchors`): âncora com o script antigo é exatamente o
 * pop-up na chegada que a decisão de 07/09/2026 (#7576) proíbe.
 */
import { editionCtaScript } from "./edition-page-cta.ts";

/**
 * Folga acima da manchete quando o navegador rola até a âncora. A barra de
 * navegação do site (`shared/site-nav.ts`) não é fixa, então não há nada a
 * compensar além de não colar o título na borda da tela.
 */
export const DESTAQUE_ANCHOR_SCROLL_MARGIN_PX = 16;

/** Máximo de destaques por edição (#3369). */
const MAX_DESTAQUES = 3;

/** `d1`, `d2`, `d3` — o fragmento que os links usam (`/p/{slug}#d2`). */
export function destaqueAnchorId(n: number): string {
  if (!Number.isInteger(n) || n < 1 || n > MAX_DESTAQUES) {
    throw new Error(`índice de destaque inválido: ${n} (esperado 1..${MAX_DESTAQUES})`);
  }
  return `d${n}`;
}

/** Manchete com h2 opcional: preserva o alvo h2 do render atual. */
const HEADLINE_RE = /<a\b([^>]*\bclass="headline"[^>]*)>(\s*)(?:<h2\b([^>]*)>)?/gi;

/** Qualquer elemento que já use um dos ids das âncoras. */
const ANCHOR_ID_PRESENT_RE = /\bid\s*=\s*["']d[1-3]["']/i;

/** A página já tem âncoras de destaque (ou algo usando os mesmos ids)? */
export function hasDestaqueAnchors(html: string): boolean {
  return ANCHOR_ID_PRESENT_RE.test(html);
}

/**
 * Pure: põe `id="dN"` (e a folga de rolagem) no `<h2>` de cada manchete,
 * ou no próprio `<a>` quando não há h2. Idempotente: página que já tem qualquer `id="d1|d2|d3"` volta
 * igual — nunca duplica id. Formato não reconhecido (0 ou mais de 3
 * manchetes) também volta igual.
 */
export function injectDestaqueAnchors(html: string): string {
  if (hasDestaqueAnchors(html)) return html;
  const count = [...html.matchAll(HEADLINE_RE)].length;
  if (count === 0 || count > MAX_DESTAQUES) return html;

  let n = 0;
  return html.replace(HEADLINE_RE, (_full, aAttrs: string, whitespace: string, h2Attrs: string | undefined) => {
    const attrs = h2Attrs ?? aAttrs;
    n += 1;
    const margin = `scroll-margin-top:${DESTAQUE_ANCHOR_SCROLL_MARGIN_PX}px;`;
    const styleRe = /\bstyle\s*=\s*"([^"]*)"/i;
    const withStyle = styleRe.test(attrs)
      ? attrs.replace(styleRe, (_m, css: string) => `style="${margin}${css}"`)
      : `${attrs} style="${margin}"`;
    return h2Attrs !== undefined
      ? `<a${aAttrs}>${whitespace}<h2 id="${destaqueAnchorId(n)}"${withStyle}>`
      : `<a id="${destaqueAnchorId(n)}"${withStyle}>${whitespace}`;
  });
}

/**
 * Localiza o `<script>` do modal de assinatura (o de `editionCtaScript`) numa
 * página já renderizada. Reconhecido pela linha que só ele tem.
 */
function findCtaScriptBlock(html: string): { start: number; end: number } | undefined {
  const marker = 'var modal = document.getElementById("diaria-cta-modal");';
  const at = html.indexOf(marker);
  if (at < 0) return undefined;
  const start = html.lastIndexOf("<script>", at);
  const close = html.indexOf("</script>", at);
  if (start < 0 || close < 0) return undefined;
  // Nenhum outro `<script` entre a abertura achada e o marcador: senão a
  // abertura é de outro bloco e a troca cortaria HTML alheio.
  if (html.slice(start + "<script>".length, at).includes("<script")) return undefined;
  return { start, end: close + "</script>".length };
}

export interface DestaqueAnchorBackfillResult {
  html: string;
  changed: boolean;
  /** Por que a página ficou como estava, quando ficou. */
  skipped?: "sem-manchetes" | "sem-script-do-modal" | "ja-atualizada";
}

/**
 * Pure: backfill de uma página já publicada. Aplica as âncoras E troca o
 * script do modal pelo atual, juntos ou nenhum dos dois — âncora com o
 * script antigo abre o modal na chegada (ver docstring do módulo).
 */
export function backfillDestaqueAnchors(html: string): DestaqueAnchorBackfillResult {
  const anchored = injectDestaqueAnchors(html);
  const hasAnchors = hasDestaqueAnchors(anchored);
  if (!hasAnchors) return { html, changed: false, skipped: "sem-manchetes" };

  const block = findCtaScriptBlock(anchored);
  if (!block) return { html, changed: false, skipped: "sem-script-do-modal" };

  const out = anchored.slice(0, block.start) + editionCtaScript() + anchored.slice(block.end);
  if (out === html) return { html, changed: false, skipped: "ja-atualizada" };
  return { html: out, changed: true };
}
