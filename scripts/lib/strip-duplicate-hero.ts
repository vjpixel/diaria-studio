/**
 * Remove a imagem de hero duplicada das páginas do acervo (#7412).
 *
 * ## O dano, e de onde ele veio
 *
 * As 253 páginas do acervo (#6167) foram **importadas do Beehiiv**. Nas
 * edições em que o toggle "Show thumbnail on top in web" estava ligado, o
 * Beehiiv emitia a capa como hero full-width no topo — e o corpo logo abaixo
 * já abre o D1 com a MESMA imagem. O HTML importado carregou essa duplicação.
 *
 * Não é um bug do pipeline atual: `publish-edition-site-page.ts` monta a
 * página a partir de `_internal/newsletter-final.html`, que nós geramos.
 * Medido em 05/09/2026 — das 113 páginas com asset repetido, 113 servem
 * `media.beehiiv.com` (acervo importado) e 0 vêm do pipeline.
 *
 * ## A estrutura explorada
 *
 *     …</div><div style='padding-bottom:2rem;'><img … src="…/asset/file/{ID}…"></div>
 *     <div id='content-blocks'>… <img … src="…/asset/file/{ID}…"> …
 *      ^ marcador                              ^ mesma imagem, esta FICA
 *
 * O hero é a `<img>` que aparece **antes** de `id='content-blocks'`. Usar essa
 * fronteira estrutural — em vez de casar por `style=` — é o que garante que a
 * imagem do corpo nunca seja tocada.
 *
 * ## Condições para agir (todas obrigatórias)
 *
 * 1. A página tem o marcador `id='content-blocks'`.
 * 2. Existe exatamente UMA `<img>` com asset id antes do marcador.
 * 3. Esse MESMO asset id reaparece depois do marcador — ou seja, é de fato uma
 *    duplicata, não uma ilustração exclusiva do topo.
 *
 * Falhando qualquer uma, a função devolve o HTML intacto com o motivo. É
 * idempotente: numa página já corrigida a condição 3 não se sustenta.
 */

export type StripHeroResult =
  | { changed: true; html: string; assetId: string; removedWrapper: boolean }
  | { changed: false; html: string; reason: string };

const CONTENT_BLOCKS_MARKER = "id='content-blocks'";
const HERO_WRAPPER_OPEN = "<div style='padding-bottom:2rem;'>";
const ASSET_ID_RE = /asset\/file\/([0-9a-f-]{36})/;

/** Extrai o asset id de uma tag `<img>`, ou `null` se não houver. */
function assetIdOf(imgTag: string): string | null {
  return imgTag.match(ASSET_ID_RE)?.[1] ?? null;
}

export function stripDuplicateHeroImage(html: string): StripHeroResult {
  const markerAt = html.indexOf(CONTENT_BLOCKS_MARKER);
  if (markerAt < 0) {
    return { changed: false, html, reason: "sem marcador id='content-blocks'" };
  }

  const head = html.slice(0, markerAt);
  const body = html.slice(markerAt);

  const imgsBefore = [...head.matchAll(/<img\b[^>]*>/g)].filter((m) => assetIdOf(m[0]));
  if (imgsBefore.length === 0) {
    return { changed: false, html, reason: "nenhuma <img> com asset antes do marcador" };
  }
  if (imgsBefore.length > 1) {
    return {
      changed: false,
      html,
      reason: `${imgsBefore.length} <img> com asset antes do marcador — estrutura inesperada, nao tocar`,
    };
  }

  const heroMatch = imgsBefore[0];
  const heroTag = heroMatch[0];
  const assetId = assetIdOf(heroTag)!;

  if (!body.includes(assetId)) {
    return {
      changed: false,
      html,
      reason: "imagem do topo nao se repete no corpo — nao e duplicata",
    };
  }

  const heroStart = heroMatch.index!;
  const heroEnd = heroStart + heroTag.length;

  // Preferir remover o wrapper inteiro quando ele existe e contém SÓ o hero —
  // deixar um <div> vazio para trás preserva o espaçamento indesejado.
  const wrapperStart = heroStart - HERO_WRAPPER_OPEN.length;
  const wrapperIsExact =
    wrapperStart >= 0 && html.slice(wrapperStart, heroStart) === HERO_WRAPPER_OPEN;
  const closesRightAfter = html.slice(heroEnd, heroEnd + "</div>".length) === "</div>";

  if (wrapperIsExact && closesRightAfter) {
    return {
      changed: true,
      html: html.slice(0, wrapperStart) + html.slice(heroEnd + "</div>".length),
      assetId,
      removedWrapper: true,
    };
  }

  // Estrutura diferente da esperada: remover apenas a tag, nunca adivinhar
  // quais elementos ao redor também sairiam.
  return {
    changed: true,
    html: html.slice(0, heroStart) + html.slice(heroEnd),
    assetId,
    removedWrapper: false,
  };
}
