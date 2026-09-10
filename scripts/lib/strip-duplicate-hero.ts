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

/** Extrai o `src` de uma tag `<img>`. */
export function srcOf(imgTag: string): string | null {
  return imgTag.match(/src="([^"]+)"/)?.[1] ?? null;
}

/** O hero (imagem antes do marcador) e as imagens do corpo, sem decidir nada. */
export interface HeroLayout {
  heroTag: string;
  heroStart: number;
  heroEnd: number;
  /** `src` de cada `<img>` com asset depois do marcador. */
  bodySrcs: string[];
}

/**
 * Localiza o hero e as imagens do corpo — puro, sem julgar se há duplicata.
 *
 * Existe separado de `stripDuplicateHeroImage` porque decidir "é a mesma
 * imagem?" às vezes exige **baixar e comparar o conteúdo**: o mesmo arquivo
 * reenviado ao Beehiiv ganha um asset id novo, e nomes de arquivo tanto
 * coincidem entre imagens distintas quanto divergem entre cópias idênticas
 * (ambos os casos medidos no acervo em 05/09/2026). Essa parte é I/O e fica
 * com o chamador; aqui só se faz o recorte do HTML.
 */
export function findHeroLayout(html: string): HeroLayout | null {
  const markerAt = html.indexOf(CONTENT_BLOCKS_MARKER);
  if (markerAt < 0) return null;

  const head = html.slice(0, markerAt);
  const imgsBefore = [...head.matchAll(/<img\b[^>]*>/g)].filter((m) => assetIdOf(m[0]));
  if (imgsBefore.length !== 1) return null;

  const bodySrcs = [...html.slice(markerAt).matchAll(/<img\b[^>]*>/g)]
    .filter((m) => assetIdOf(m[0]))
    .map((m) => srcOf(m[0]))
    .filter((s): s is string => s !== null);

  const heroTag = imgsBefore[0][0];
  return {
    heroTag,
    heroStart: imgsBefore[0].index!,
    heroEnd: imgsBefore[0].index! + heroTag.length,
    bodySrcs,
  };
}

/**
 * Remove o hero localizado, levando o wrapper junto quando ele existe e
 * contém só a imagem. Puro: quem chama já decidiu que deve remover.
 */
export function removeHero(
  html: string,
  hero: HeroLayout,
): { html: string; removedWrapper: boolean } {
  const wrapperStart = hero.heroStart - HERO_WRAPPER_OPEN.length;
  const wrapperIsExact =
    wrapperStart >= 0 && html.slice(wrapperStart, hero.heroStart) === HERO_WRAPPER_OPEN;
  const closesRightAfter = html.slice(hero.heroEnd, hero.heroEnd + 6) === "</div>";

  if (wrapperIsExact && closesRightAfter) {
    return {
      html: html.slice(0, wrapperStart) + html.slice(hero.heroEnd + 6),
      removedWrapper: true,
    };
  }
  return {
    html: html.slice(0, hero.heroStart) + html.slice(hero.heroEnd),
    removedWrapper: false,
  };
}

/**
 * Heros confirmados como duplicata POR HASH (#7499) — o asset id do topo
 * difere do da imagem do corpo, mas o conteúdo é byte-idêntico. A comparação
 * por hash exige rede, que o gerador do acervo não pode depender; o veredito
 * já medido fica gravado aqui por asset id (não por slug, que pode ser
 * corrigido por `applyLegacySlugCorrections`).
 */
export const HASH_VERIFIED_DUPLICATE_HERO_ASSETS: ReadonlySet<string> = new Set([
  "5f04e005-61e3-4dad-a357-73a44336054d",
  "9556b657-0ac8-4da9-a0a0-364f22eb2658",
  "dfed33e4-b2d4-4e17-9320-d1ddd125c2d0",
  "9bfcb447-7142-4a59-97dd-bbdd80b935e9",
  "282f6aa3-83fb-46b9-a8af-e828bd7672f6",
  "0f71b7f8-69bb-4f52-a35b-77fc03f26a66",
  "29f82609-14f4-47c3-a916-de20e9a7eaac",
  "7fe4c315-9cdc-4c9c-b43e-ea0402a7b586",
  "1b5dc687-587f-452d-b9ac-262372bb45d3",
  "e72a69eb-d252-4bb0-a67c-8e853c65429e",
  "9b286ad1-8035-4986-bec4-b319f9e82a75",
  "6bd9291c-f8b0-4a1c-8e81-dbfb313064d0",
  "a126c9be-d948-43ef-81bd-c10d866efcac",
  "190cc1ee-da54-408f-a171-247fe3c549ea",
  "eb5174c0-ebf9-4b05-87fb-66af3b7e127d",
  "2b396dc2-7b87-496f-9911-fef2a8a926cb",
  "d0ac3920-3cb2-4707-99cb-1aa93c59359e",
  "086cbbf3-cac9-43ba-86d0-67d3cb0a68bf",
  "c24e54d1-3150-4e01-842b-b00b06709fc4",
  "d4f8d565-df7f-4fff-b347-7972aa6b1868",
  "b87ba438-9c0a-44a1-acf7-3d9eb3b1a207",
  "fe718e29-0890-413d-898e-122837a239ba",
  // Varredura das páginas não corrigidas (10/09/2026): o D1 do corpo vem do
  // NOSSO host (`img-{AAMMDD}-04-d1-2x1-*.jpg`), não de `asset/file/`, então
  // nem o critério por id nem o hash da #7499 o viam. Hash exato também não
  // fecha (a Beehiiv recomprime via `cdn-cgi/image`); a confirmação foi
  // visual — 32x16 em cinza, distância média 0,1–0,2 contra ≥30 das demais.
  "a3d67398-8494-4479-b3c1-0ddf6f399142",
  "1c4f3339-5a82-481b-95ce-62609367dc49",
  "4c41ad4e-df05-4ee9-9142-2a3b779439d2",
  "0c179341-fb1b-4a2f-8823-2c2f0cea167f",
  "a02d7e74-5816-4b5d-b23f-1ff18404f5b7",
]);

/** Há alguma `<img>` (de qualquer host) depois do marcador do corpo? */
function hasAnyBodyImage(html: string): boolean {
  const at = html.indexOf(CONTENT_BLOCKS_MARKER);
  return at >= 0 && /<img\b/.test(html.slice(at));
}

/**
 * Remoção usada pelo GERADOR do acervo (`buildArchivePageHtml`) — o ponto
 * que faltava no #7412: a correção original só editou os arquivos gerados, e
 * a regeneração em massa do #7588 (a partir do cache Beehiiv, que segue com o
 * hero) trouxe as 135 duplicatas de volta. Cobre os dois critérios: asset id
 * repetido no corpo, ou hero na lista verificada por hash.
 */
export function stripArchiveHero(html: string): string {
  const byId = stripDuplicateHeroImage(html);
  if (byId.changed) return byId.html;
  const hero = findHeroLayout(html);
  // Qualquer host conta: a cópia do corpo pode vir do nosso próprio host.
  // Sem imagem nenhuma no corpo, o hero é a única imagem — nunca remover.
  if (!hero || !hasAnyBodyImage(html)) return html;
  const id = assetIdOf(hero.heroTag);
  if (!id || !HASH_VERIFIED_DUPLICATE_HERO_ASSETS.has(id)) return html;
  return removeHero(html, hero).html;
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
