/**
 * site-archive-pages.ts (#467, 1º item do checklist revisado)
 *
 * Miolo puro do gerador de páginas do acervo `/p/{slug}` a partir do cache
 * `data/beehiiv-cache/posts/post_*.json` (`content.free.web` — HTML completo
 * já renderizado pela Beehiiv via API oficial, `expand[]=free_web_content`).
 *
 * Escopo desta unidade: só o acervo EXISTENTE (258 posts em cache, 253
 * `status: "confirmed"`). NÃO cobre o passo de pipeline que publica a
 * página de uma edição NOVA (2º item do checklist, #467) nem `/`,
 * `/subscribe`, `/forms/*` (3º item) — ver PR desta unidade.
 *
 * Duas correções aplicadas no HTML gerado, ambas linkadas no #467
 * (resolvem "de graça" com este trabalho):
 *   - `<html lang="pt-BR">` — o cache não tem NENHUM atributo `lang` (a
 *     versão SERVIDA pela Beehiiv injeta `lang="en"` no template de
 *     request-time, bug de plataforma documentado em docs/seo-notes.md
 *     Fato 6/#5101 item 1 — não presente no HTML cru que a API devolve).
 *   - meta description por página — o cache não tem `<title>`/`<meta
 *     name="description">` nenhum; `meta_default_title`/
 *     `meta_default_description` costumam vir `null` (#5101 item 2), então
 *     o fallback usa `subtitle`/`preview_text` do post, nunca um genérico.
 */

import { escHtml } from "./html-escape.ts";
import { loadPublishDateOverrides } from "./beehiiv-publish-date.ts";
import type { UnifiedCachedPost } from "./shared/edition-cache-reader.ts";
import { editionCtaBlock } from "./edition-page-cta.ts";
import { stripArchiveHero } from "./strip-duplicate-hero.ts";
import { GEO_AUTHOR, type GeoAuthor } from "./shared/geo-faq.ts";
import { renderSeoMeta } from "./shared/seo-meta.ts";
import { COVER_IMAGE_WIDTH, COVER_IMAGE_HEIGHT } from "./shared/cover-image.ts";
import { loadArchiveImageMigrationMap, rewriteMigratedBeehiivImages } from "./archive-image-migration.ts"; // #8364

export interface ArchivePost {
  slug: string;
  title: string;
  subtitle?: string | null;
  preview_text?: string | null;
  meta_default_title?: string | null;
  meta_default_description?: string | null;
  status: string;
  web_url?: string | null;
  /**
   * Unix seconds — mesmo tipo de `publish_date` (#8336 corrige o tipo, era
   * `string | null` sem nenhum consumidor real; a fonte crua,
   * `RawBeehiivPostFile.displayed_date` em `shared/edition-cache-reader.ts`,
   * sempre foi `number | null`). Ver `resolvePublishTimestampMs` abaixo pra
   * como este campo entra na resolução de data — hoje nenhum script de
   * sync o popula (grep confirmado nesta PR), mas o tipo certo evita que um
   * futuro writer herde o bug em silêncio.
   */
  displayed_date?: number | null;
  publish_date?: number | null;
  /**
   * Imagem de capa 2:1 do post — mesmo campo já lido por
   * `scripts/generate-arquivo-titles.ts` (`RawCachedPost.thumbnail_url`,
   * #5131) pra alimentar `og:image`/`twitter:image` da raiz do acervo e dos
   * hubs. Reusado aqui pra og:image (#8352) — dimensão assumida fixa
   * (`COVER_IMAGE_WIDTH`/`COVER_IMAGE_HEIGHT`, 1600×800), mesma premissa que
   * os outros dois consumidores já fazem, porque a Beehiiv não expõe
   * dimensão de imagem na API. `undefined`/`null` (posts sem capa, ou o
   * lado Kit — `kitUnifiedPostToArchivePost` não tem equivalente) omite
   * `og:image`/`twitter:image` da página, igual a qualquer outro caller de
   * `renderSeoMeta` sem `image`.
   */
  thumbnail_url?: string | null;
  content?: {
    free?: {
      web?: string | null;
    } | null;
  } | null;
}

export const ARCHIVE_BASE_URL = "https://diar.ia.br";

/**
 * Só posts publicados de verdade entram no acervo — nunca rascunho (ex: o
 * `new-post` duplicado achado no cache). Type predicate (não só `boolean`)
 * pra `posts.filter(isPublishedPost)` estreitar o tipo de retorno —
 * `slug` deixa de ser opcional pro caller depois do filter.
 */
export function isPublishedPost(
  post: ArchivePost,
): post is ArchivePost & { status: "confirmed"; slug: string } {
  return post.status === "confirmed" && !!post.slug && post.slug !== "new-post";
}

/** Filtra + ordena (mais recente primeiro) — determinístico pro sitemap e pro teste.
 * Ordena pela mesma data "canônica" resolvida via override (#4796) que
 * `publishDateToIso` usa pro `<lastmod>` — sem isso, as 6 primeiras edições
 * (cujo `publish_date` bruto aponta pro dia do import em lote, não pro
 * envio real) podiam ficar fora de ordem cronológica real no acervo. */
export function selectPublishedPosts(posts: ArchivePost[]): ArchivePost[] {
  return posts
    .filter(isPublishedPost)
    .sort((a, b) => (resolvePublishTimestampMs(b) ?? 0) - (resolvePublishTimestampMs(a) ?? 0));
}

export function derivePageTitle(post: ArchivePost): string {
  return post.meta_default_title || post.title || post.slug;
}

/**
 * Tamanho-alvo de uma meta description pra SEO (~150-160 chars é o padrão —
 * acima disso o Google trunca o snippet de busca de qualquer forma).
 */
const META_DESCRIPTION_MAX_LENGTH = 155;

/**
 * Trunca em ~155 chars sem cortar no meio de palavra — corta no último
 * espaço antes do limite e acrescenta reticências. Só age quando o texto
 * já excede o limite; texto curto passa intacto.
 */
function truncateDescription(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= META_DESCRIPTION_MAX_LENGTH) return trimmed;
  const cut = trimmed.slice(0, META_DESCRIPTION_MAX_LENGTH);
  const lastSpace = cut.lastIndexOf(" ");
  const safe = (lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trimEnd();
  return `${safe}…`;
}

/**
 * Descreve a PRÓPRIA edição, não outras (#6281). `post.title` é sempre o
 * destaque D1 da edição; `post.subtitle`/`post.preview_text` são, por
 * construção editorial da diária, o teaser dos destaques D2/D3 da MESMA
 * edição (formato "D2 title | D3 title" — ver `stitch-newsletter.ts`) — não
 * o resumo de OUTRAS edições. Concatenar os dois dá os títulos dos até 3
 * destaques desta página, sempre começando pelo D1 (que é também o
 * `<title>` da página via `derivePageTitle` — description e title deixam de
 * divergir). Fallback de "os títulos dos destaques da própria edição
 * concatenados" (opção 2 do #6281), preferido sobre "D1 + 1ª frase do Por
 * que isso importa" porque não depende de parsear `content.free.web`
 * (estrutura já mudou de shape 3x nos últimos ~2 meses — ver comentários de
 * `buildArchivePageHtml` sobre o link de voto — regex sobre o corpo da
 * newsletter seria mais um ponto de fragilidade).
 */
function ownEditionDescription(post: ArchivePost): string | undefined {
  const title = post.title?.trim();
  if (!title) return undefined;
  const others = post.subtitle?.trim() || post.preview_text?.trim();
  return others ? `${title}. ${others}` : title;
}

/**
 * "Linha fina" da edição — SÓ D2 | D3 (`post.subtitle`/`post.preview_text`),
 * NUNCA o D1 (#7921). Diferente de `ownEditionDescription` (usada na `<meta
 * name="description">` de SEO, onde D1 + D2|D3 é intencional — #6281,
 * description alinhada com `<title>`), esta é a linha VISÍVEL abaixo do
 * título na home (`feature-dek`/`archive-dek`, `site-home-page.ts`) — ali o
 * D1 já está no `<h2>`/`<h3>` logo acima, então repeti-lo na linha fina é
 * puro eco. `undefined` quando a edição não tem D2/D3 (só D1, ou campos
 * ausentes) — o chamador decide o fallback (home hoje esconde a linha fina
 * vazia via CSS/condicional, nunca mostra "undefined").
 */
export function deriveDek(post: Pick<ArchivePost, "subtitle" | "preview_text">): string | undefined {
  return post.subtitle?.trim() || post.preview_text?.trim() || undefined;
}

/**
 * `meta_default_description` NÃO é priorizado (mudança do #6281, ver
 * histórico da issue original) — a premissa de que era sempre `null`
 * (#5101 item 2) só valia pro subconjunto amostrado ali. Medido ao vivo no
 * cache real completo (259 posts, #6281): 109 têm o campo POPULADO, e a
 * imensa maioria carrega o MESMO padrão de bug que motivou esta issue — o
 * teaser dos destaques D2/D3, sem nunca mencionar D1 (o assunto real da
 * página, e o `<title>` dela). Alguém/algum processo passado preencheu
 * `meta_default_description` copiando `subtitle`, então confiar nesse campo
 * reproduziria o bug pra quase metade do acervo mesmo depois desta correção.
 * `ownEditionDescription` é determinístico e sempre correto (deriva de
 * `title`, que é sempre o D1 real) — por isso vem primeiro. Se um dia a
 * Beehiiv passar a ter um campo de SEO genuinamente curado à mão que não
 * seja subtitle disfarçado, essa prioridade pode reabrir — não há sinal
 * disso nos dados de hoje.
 */
export function deriveMetaDescription(post: ArchivePost): string {
  const raw =
    ownEditionDescription(post) ||
    post.meta_default_description ||
    post.title ||
    "diar.ia.br — 5 minutos diários sobre inteligência artificial.";
  return truncateDescription(raw);
}

export function archiveUrlForSlug(slug: string): string {
  return `${ARCHIVE_BASE_URL}/p/${slug}`;
}

/**
 * #7280: mapa de correção pra 21 slugs históricos com acento corrompido.
 *
 * Achado (issue #7280, recontagem no comentário de correção — o número
 * original no título da issue, "107 de 259", estava inflado ~5×; um regex
 * ruim contava `-a-`/`-e-`/`-o-` — artigo/conjunção legítimos em português —
 * como acento destruído): 2 padrões de corrupção distintos no acervo
 * histórico — decomposição NFD sobrando hífen (`lanc-a`, `na-o`, `co-digo`)
 * e descarte do caractere acentuado (`amea-as`, `educa-o`, `m-s`). A causa
 * já não existe: `seoSlug`/`slugify` (`lib/slug.ts`) normaliza PT-BR
 * corretamente desde #1989, e o Stage 6 é gate-blocking contra qualquer
 * slug Beehiiv que divirja de `seoSlug(título)` desde #4570 — nenhuma
 * edição NOVA reproduz isto. Este mapa cobre só o RESÍDUO histórico: as 21
 * páginas publicadas antes dos dois mecanismos existirem.
 *
 * Decisão do editor (#7280, comentário `decisao-editor` de 04/09/2026):
 * "criar corretas e redirecionar as antigas — preserva link compartilhado,
 * corrige a URL pública". Cada valor abaixo é `seoSlug(título real do
 * post)`, conferido manualmente contra o cache real
 * (`data/beehiiv-cache/posts/*.json`) — ver PR que fecha #7280.
 *
 * Aplicado em `applyLegacySlugCorrections`, chamado por
 * `gen-archive-pages.ts` ANTES de gerar o acervo — a correção vive AQUI, não
 * editada dentro do JSON cacheado, então sobrevive a qualquer re-sync
 * (`beehiiv-sync.ts` sobrescreveria um `post.slug` editado à mão no cache
 * silenciosamente; este mapa não é tocado por esse fluxo).
 * `workers/site/public/_redirects` tem as 21 linhas old→new
 * correspondentes (redirect 301 pra preservar o link já compartilhado) —
 * os dois precisam ficar em sincronia; `test/gen-archive-pages.test.ts`
 * trava isso.
 */
export const LEGACY_SLUG_CORRECTIONS: Readonly<Record<string, string>> = Object.freeze({
  "90-das-pessoas-na-o-reconhecem-vi-deos-de-ia": "90-das-pessoas-nao-reconhecem-videos-de-ia",
  "90-dos-desenvolvedores-usam-ia-mas-na-o-confiam-totalmente":
    "90-dos-desenvolvedores-usam-ia-mas-nao-confiam-totalmente",
  "a-diar-ia-br-normalmente-te-conta-o-dia-hoje-ela-conta-o-m-s":
    "a-diar-ia-br-normalmente-te-conta-o-dia-hoje-ela-conta-o-mes",
  "ai-com-lanc-a-agentes-de-ia-auto-nomos": "ai-com-lanca-agentes-de-ia-autonomos",
  "alibaba-lanc-a-tre-s-modelos-de-open-source-e-quebra-32-recordes":
    "alibaba-lanca-tres-modelos-de-open-source-e-quebra-32",
  "altman-admite-a-ia-trar-amea-as": "altman-admite-a-ia-trara-ameacas",
  "anthropic-e-gates-200-mi-em-sa-de-e-educa-o": "anthropic-e-gates-200-mi-em-saude-e-educacao",
  "anthropic-expo-e-co-digo-do-claude-code-por-acidente":
    "anthropic-expoe-codigo-do-claude-code-por-acidente",
  "anthropic-lanc-a-plataforma-de-pesquisa-sociolo-gica":
    "anthropic-lanca-plataforma-de-pesquisa-sociologica",
  "brasil-70-da-gera-o-z-usa-chatgpt-todo-m-s": "brasil-70-da-geracao-z-usa-chatgpt-todo-mes",
  "brasil-fortalece-parceria-com-a-mala-sia-em-semicondutores-e-ia":
    "brasil-fortalece-parceria-com-a-malasia-em-semicondutores-e",
  "claude-code-afunda-ac-o-es-da-ibm": "claude-code-afunda-acoes-da-ibm",
  "governo-lanc-a-modelo-de-linguagem-100-nacional": "governo-lanca-modelo-de-linguagem-100-nacional",
  "ia-na-o-reduz-trabalho-ela-acelera-o-burnout": "ia-nao-reduz-trabalho-ela-acelera-o-burnout",
  "ia-nas-eleic-o-es-prepare-se-para-os-deepfakes": "ia-nas-eleicoes-prepare-se-para-os-deepfakes",
  "inscric-o-es-abertas-programa-da-openai-para-empreendedores":
    "inscricoes-abertas-programa-da-openai-para-empreendedores",
  "lanc-ado-o-comet-o-produto-de-ia-mais-desejado-do-ano": "lancado-o-comet-o-produto-de-ia-mais-desejado-do-ano",
  "modelos-se-replicam-sozinhos-diz-estudo-in-dito": "modelos-se-replicam-sozinhos-diz-estudo-inedito",
  "openai-lanc-a-gpt-5-5-com-foco-em-agentes": "openai-lanca-gpt-5-5-com-foco-em-agentes",
  "openai-lanc-a-instant-checkout-no-chatgpt": "openai-lanca-instant-checkout-no-chatgpt",
  "openai-lanc-a-sora-2": "openai-lanca-sora-2",
});

/**
 * Reescreve `post.slug` pra corrigido quando o slug bate com uma entrada de
 * `LEGACY_SLUG_CORRECTIONS` — pura, não muta os posts originais. Chamada
 * ANTES de `generateArchivePages` (ver `gen-archive-pages.ts`) — como
 * `buildArchivePageHtml`/`archiveUrlForSlug` derivam o diretório e o
 * `<link rel="canonical">` SEMPRE de `post.slug`, corrigir aqui é o único
 * ponto necessário: a página nasce direto no slug certo, sem passo extra.
 * Posts cujo slug não está no mapa passam intocados (mesma referência de
 * objeto, sem alocação nova).
 */
export function applyLegacySlugCorrections(posts: ArchivePost[]): ArchivePost[] {
  return posts.map((post) => {
    const corrected = post.slug ? LEGACY_SLUG_CORRECTIONS[post.slug] : undefined;
    return corrected ? { ...post, slug: corrected } : post;
  });
}

/**
 * Host antigo de `/img/{key}` (#7911) — servia as imagens de destaque/É IA?
 * ANTES do #7657 migrar essa rota pra ser servida também em
 * `diar.ia.br/img/{key}` (mesmo KV/namespace, `handleImage` em
 * `workers/poll/src/index.ts`). Hoje `diar-ia-poll.diaria.workers.dev/img/`
 * responde 404 pra qualquer key — o worker segue vivo (serve `/robots.txt`
 * etc), só a rota de imagem não é mais servida por ele. 5 páginas do acervo
 * importado (`content.free.web` cacheado ANTES da migração) ainda citam
 * esse host.
 */
const LEGACY_IMG_HOST_RE = /https:\/\/diar-ia-poll\.diaria\.workers\.dev\/img\//g;

/**
 * Reescreve toda referência ao host antigo de `/img/{key}` pro host atual
 * (`diar.ia.br`), preservando a key — troca cega de domínio, sempre segura
 * (ver `LEGACY_IMG_HOST_RE`). `html` sem nenhuma ocorrência passa intocado
 * (mesma string, sem alocação extra além do `.replace()` em si).
 */
export function rewriteLegacyImageHost(html: string): string {
  return html.replace(LEGACY_IMG_HOST_RE, `${ARCHIVE_BASE_URL}/img/`);
}

/**
 * #8364: `poll.diaria.workers.dev/img/` — host `workers.dev` de trabalho do
 * Worker `poll`, hoje servindo EXATAMENTE os mesmos bytes que
 * `diar.ia.br/img/{key}` (mesmo KV `POLL`, mesma key — `workers/site/
 * wrangler.toml` declara o mesmo namespace id). Hostname DIFERENTE do
 * `diar-ia-poll.diaria.workers.dev` que `rewriteLegacyImageHost`/
 * `LEGACY_IMG_HOST_RE` acima já cobrem (2 workers `workers.dev` legados
 * distintos, medidos separadamente na issue) — não é o mesmo bug, mas o
 * mesmo remédio: troca cega de host, sempre segura, porque a key não muda.
 *
 * Escopo estreito de propósito: só `/img/`. As outras rotas do MESMO host
 * (`/vote`, `/jogar`, `/leaderboard` — link do jogo É IA?, não imagem)
 * ficam de fora — `workers/site` não serve essas rotas, reescrevê-las
 * quebraria o link (ver `test/gen-archive-pages.test.ts`, "preserva o
 * domínio original").
 */
const LEGACY_POLL_WORKERS_DEV_IMG_RE = /https:\/\/poll\.diaria\.workers\.dev\/img\//g;

export function rewriteLegacyPollWorkersDevImageHost(html: string): string {
  return html.replace(LEGACY_POLL_WORKERS_DEV_IMG_RE, `${ARCHIVE_BASE_URL}/img/`);
}

/**
 * #8351: 2 boxes de rodapé (livros/cursos) do HTML capturado da Beehiiv
 * apontam pra paths que só existiam no host legado — `diaria.beehiiv.com`
 * só redireciona `/p/{slug}`, qualquer outro path é 404 genuíno (medido ao
 * vivo com UA de Googlebot). 258 ocorrências em 98 páginas (98 de 270 — os
 * outros 172 posts não citam os boxes, ou já saíram de uma versão do
 * template que não os incluía).
 *
 * Reescreve pro host de MARCA já no ar (`livros.diar.ia.br`/
 * `cursos.diar.ia.br` — a mesma substituição cega de host que
 * `rewriteLegacyImageHost` já faz pra imagens, mesmo ponto de injeção),
 * preservando o resto da URL (query string, UTM) intacto — o bug é o host
 * responder 404, não o UTM estar “errado”; trocar UTM é escopo separado, não
 * pedido pela issue. `/authors/angelo-pixel` (5 ocorrências, citado na
 * issue como "não verificado") FICA DE FORA: confirmado ao vivo (18/09/2026,
 * UA de Googlebot) que esse path responde 200 no host legado — não é 404,
 * fora do escopo desta correção.
 */
const LEGACY_BOOKS_LINK_RE = /https:\/\/diaria\.beehiiv\.com\/livros-sobre-ia/g;
const LEGACY_COURSES_LINK_RE = /https:\/\/diaria\.beehiiv\.com\/cursos-gratuitos-de-ia/g;

export function rewriteLegacyResourceLinks(html: string): string {
  return html
    .replace(LEGACY_BOOKS_LINK_RE, "https://livros.diar.ia.br")
    .replace(LEGACY_COURSES_LINK_RE, "https://cursos.diar.ia.br");
}

/**
 * Tier 1 do #7116: remove blocos `<style>` BYTE-IDÊNTICOS repetidos dentro
 * da MESMA página, mantendo só a 1ª ocorrência de cada um — a Beehiiv
 * carimba o mesmo CSS (global do tema + por bloco de conteúdo) várias vezes
 * no `content.free.web` de uma edição só. Medido no acervo real (255
 * páginas, #7112 fatia 4): 6.809 blocos `<style>` no total, mas só 13
 * conteúdos distintos por MD5 — a maior parte da redundância (5.792/6.809
 * ocorrências do bloco `p span[style*="font-size"]{line-height:1.6;}`,
 * ~23x por página) é intra-página, não cross-page.
 *
 * Escopo deliberadamente estreito — só remove o que é PROVADAMENTE inócuo:
 * um `<style>` cujo conteúdo (tag + atributos + corpo, byte a byte) já
 * apareceu antes na mesma página não pode mudar o resultado da cascata CSS
 * — as regras são idênticas às já aplicadas, então repeti-las ou não é
 * indiferente pro navegador. Não deduplica CROSS-page (isso é Tier 2 do
 * #7116 — extrair como CSS externo com `<link>`, escopo separado porque
 * exige servir um asset novo e checar cache do Worker/IndexNow) nem tenta
 * normalizar/minificar CSS (mudaria bytes dentro de um bloco mantido, que
 * não é o que foi medido/decidido aqui).
 *
 * Não mexe em nada fora de tags `<style>...</style>` — corpo, atributos de
 * outros elementos, `<link>`, `<script>` etc. passam intocados.
 */
export function dedupeStyleBlocksInPage(html: string): string {
  const seen = new Set<string>();
  return html.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, (block) => {
    if (seen.has(block)) return "";
    seen.add(block);
    return block;
  });
}

/**
 * #8354: hierarquia de headings — exatamente 1 `<h1>` por página (o título
 * da edição), destaques/radar/use-melhor como `<h2>`.
 *
 * Medido ao vivo (18/09/2026, 270 páginas): 182/270 (67%) sem exatamente 1
 * `<h1>` — 134 têm 4 (o caso dominante), porque o HTML capturado da Beehiiv
 * marca CADA título de bloco de conteúdo como `<h1>` (destaque, radar, use
 * melhor — templates diferentes, todos com o mesmo bug), não só o título da
 * edição. 11 páginas têm 0 (formato mais recente da newsletter,
 * `newsletter-render-html.ts`, que não tem nenhum `<h1>` — só h2/h3 no
 * corpo, sem nenhum título visível equivalente ao `<title>` da página).
 *
 * O título da EDIÇÃO é sempre o 1º `<h1>` do documento quando existe pelo
 * menos um (confirmado nos templates reais: 36px Poppins/Karla, sempre
 * primeiro, dentro do bloco `id='web-header'`) — nunca precisa ser
 * localizado por seletor/estilo, só por ORDEM. Qualquer `<h1>` depois do
 * primeiro é subseção do corpo (destaque/radar/use melhor) e vira `<h2>`,
 * preservando os atributos originais (`style=...`) intactos — só o nome da
 * tag muda. Assume que `<h1>` não aninha `<h1>` (nunca visto no corpus
 * real); se o documento não tiver `</h1>` correspondente ao(s) `<h1>`
 * encontrado(s) (HTML malformado — não visto no corpus real), devolve o
 * `html` sem tocar em nada, em vez de arriscar um split no lugar errado.
 *
 * Página SEM nenhum `<h1>` ganha um, visualmente oculto (padrão acessível
 * "sr-only" — presente pra leitor de tela/crawler, sem mudar o layout
 * capturado da Beehiiv, que essas 11 páginas nunca tiveram desde a origem),
 * logo após `<body...>`, com o título da própria edição — o MESMO texto que
 * já vai em `<title>` (`derivePageTitle`), então título visível (aba do
 * browser) e `<h1>` (SEO/acessibilidade) nunca divergem.
 */
export function normalizeHeadingHierarchy(html: string, pageTitle: string): string {
  const hasH1 = /<h1[\s>]/i.test(html);
  if (!hasH1) {
    const hiddenH1 =
      `<h1 style="position:absolute;width:1px;height:1px;padding:0;margin:-1px;` +
      `overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0;">${escHtml(pageTitle)}</h1>`;
    return html.replace(/<body[^>]*>/i, (full) => `${full}${hiddenH1}`);
  }

  const firstClose = html.match(/<\/h1\s*>/i);
  if (!firstClose || firstClose.index === undefined) return html;
  const splitAt = firstClose.index + firstClose[0].length;
  const head = html.slice(0, splitAt);
  const tail = html
    .slice(splitAt)
    .replace(/<h1(\b[^>]*)>/gi, "<h2$1>")
    .replace(/<\/h1\s*>/gi, "</h2>");
  return head + tail;
}

/**
 * Adapta 1 broadcast Kit já normalizado (`UnifiedCachedPost`,
 * `scripts/lib/shared/edition-cache-reader.ts`) pro shape `ArchivePost`
 * deste módulo — fecha o resíduo do #6184 (única peça da migração
 * Beehiiv → Kit que faltava: metadados+conteúdo do acervo).
 *
 * **Só usado pro lado Kit.** O lado Beehiiv continua lendo
 * `data/beehiiv-cache/posts/*.json` direto via `loadPosts`
 * (`gen-archive-pages.ts`), sem passar por este adaptador nem por
 * `UnifiedCachedPost` — routear o Beehiiv por aqui PERDERIA
 * `meta_default_title`/`meta_default_description`/`preview_text`
 * (`UnifiedCachedPost` não carrega esses campos SEO, só o vocabulário
 * comum às duas origens), degradando a qualidade de título/description do
 * acervo Beehiiv existente pra ganhar nada em troca (o Kit não os tem de
 * qualquer forma). "Caminho Beehiiv precisa continuar funcional e
 * idêntico" é requisito explícito desta unidade.
 *
 * Pro lado Kit, os 4 campos ficam `null` de propósito — `derivePageTitle`/
 * `deriveMetaDescription` já degradam pra `title`/`subtitle` sem lançar
 * (mesmo fallback que um post Beehiiv com esses campos ausentes já
 * exercita hoje, ver describe "#5101 item 2" no teste deste módulo), e o
 * Kit não tem um equivalente de qualquer forma (só `subject`, já mapeado
 * pra `title` por `normalizeKitBroadcast`).
 *
 * Devolve `null` quando o broadcast não tem `slug` resolvível
 * (`public_url` ausente/inválido — ver docstring de `normalizeKitBroadcast`)
 * — mesmo critério que `isPublishedPost` já aplica a um post Beehiiv sem
 * slug, então o caller pode simplesmente descartar `null`s e tratar o
 * resultado como qualquer outro `ArchivePost[]`.
 *
 * **Caller filtra `origin === "kit"` e `public === true` ANTES de chamar
 * isto** (mesmo discriminador de `collectAllCompletedKitPosts` em
 * `newsletter-read-source.ts`, #6362 item 2) — este adaptador só faz a
 * transformação de shape, não repete o filtro de "é edição real".
 */
export function kitUnifiedPostToArchivePost(u: UnifiedCachedPost): ArchivePost | null {
  if (!u.slug) return null;
  return {
    slug: u.slug,
    title: u.title ?? u.slug,
    subtitle: u.subtitle ?? null,
    preview_text: null,
    meta_default_title: null,
    meta_default_description: null,
    status: u.status ?? "unknown",
    web_url: u.web_url ?? null,
    displayed_date: null,
    publish_date: u.publish_date ?? null,
    thumbnail_url: u.thumbnail_url ?? null,
    content: u.content ?? null,
  };
}

/**
 * Uma edição vizinha (#8353 item 1) — só o necessário pra montar o link:
 * `slug` (pra `archiveUrlForSlug`) e `title` já derivado (`derivePageTitle`
 * do vizinho, resolvido pelo CALLER — este módulo não sabe navegar a lista
 * inteira de posts, só desenhar o link a partir de 1 vizinho já resolvido).
 */
export interface ArchiveNeighbor {
  slug: string;
  title: string;
}

/**
 * Nav prev/next por data (#8353 item 1) — link pra edição publicada
 * imediatamente ANTES (`prev`) e DEPOIS (`next`) da atual, na mesma ordem
 * cronológica que `selectPublishedPosts` já usa pro acervo/sitemap. `""`
 * quando os dois faltam (post mais antigo do acervo inteiro não tem `prev`;
 * o mais recente não tem `next` até a próxima edição sair) — nunca um `<nav>`
 * vazio.
 *
 * Marcado com `class="archive-nav"` de propósito: é o marcador que
 * `scripts/lib/site-archive-page-backfill.ts` usa pra detectar "esta página
 * já tem nav" e não duplicar numa 2ª passada (idempotência do backfill).
 */
export function buildArchiveNeighborNavHtml(prev?: ArchiveNeighbor, next?: ArchiveNeighbor): string {
  if (!prev && !next) return "";
  const prevLink = prev
    ? `<a href="${archiveUrlForSlug(prev.slug)}" rel="prev">← ${escHtml(prev.title)}</a>`
    : "";
  const nextLink = next
    ? `<a href="${archiveUrlForSlug(next.slug)}" rel="next">${escHtml(next.title)} →</a>`
    : "";
  return (
    `<nav class="archive-nav" aria-label="Navegação entre edições" ` +
    `style="display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap;` +
    `padding:12px 16px;font-family:Arial,Helvetica,sans-serif;font-size:14px;` +
    `color:#00A0A0;">${prevLink}${nextLink}</nav>`
  );
}

export interface BuildArchivePageHtmlOptions {
  /** #8353 item 1 — omitido (default) preserva o comportamento de antes: sem nav. */
  neighbors?: { prev?: ArchiveNeighbor; next?: ArchiveNeighbor };
}

/**
 * Injeta `lang="pt-BR"`, `<title>`, `<meta name="description">` e
 * `<link rel="canonical">` no HTML cru de `content.free.web` — que não tem
 * NENHUM desses (confirmado ao vivo nos 258 posts do cache, #467).
 * Preserva o resto do documento (estilos inline, corpo) sem tocar.
 */
export function buildArchivePageHtml(post: ArchivePost, opts: BuildArchivePageHtmlOptions = {}): string {
  if (!isPublishedPost(post)) {
    throw new Error(
      `post "${post.slug}" não é publicado (status="${post.status}") — buildArchivePageHtml não gera página pra rascunho`,
    );
  }

  const rawHtml = post.content?.free?.web;
  if (!rawHtml) {
    throw new Error(`post "${post.slug}" não tem content.free.web — não é gerável`);
  }

  const rawTitle = derivePageTitle(post);
  const rawDescription = deriveMetaDescription(post);
  const title = escHtml(rawTitle);
  const dek = deriveDek(post);
  const canonical = archiveUrlForSlug(post.slug);
  // #8336: dateline estruturado (datePublished/dateModified/author/publisher)
  // — undefined quando a data não resolve, omitido do <head> nesse caso (ver
  // docstring de buildArchiveNewsArticleJsonLd).
  const newsArticleJsonLd = buildArchiveNewsArticleJsonLd(post);
  // #8352: og:image/twitter:image a partir da MESMA capa que
  // generate-arquivo-titles.ts já usa pra raiz do acervo/hubs (#5131) —
  // undefined pra post sem thumbnail_url (nunca escreve og:image inválido).
  const coverImage = post.thumbnail_url
    ? { url: post.thumbnail_url, width: COVER_IMAGE_WIDTH, height: COVER_IMAGE_HEIGHT }
    : undefined;
  // Reusa o MESMO resolvedor de data do JSON-LD acima (nunca duas leituras
  // divergentes da data editorial da mesma página) — article:published_time
  // só é emitido quando a data resolve, mesmo fail-soft do JSON-LD.
  const articlePublishedTime = publishDateToIso(post);
  const seoMetaBlock = renderSeoMeta({
    title: rawTitle,
    description: rawDescription,
    url: canonical,
    image: coverImage,
    type: "article",
    articlePublishedTime,
  });

  let html = rawHtml;

  // Tier 1 do #7116 — dedup dos <style> byte-idênticos repetidos dentro da
  // MESMA página, ANTES de qualquer outra transformação. Ordem não importa
  // pro resultado (as demais transformações abaixo não tocam `<style>`),
  // mas rodar cedo mantém `html` menor pelo resto da função.
  html = dedupeStyleBlocksInPage(html);

  // #7412 — hero duplicado do acervo importado. Tem que morar AQUI, no
  // gerador: corrigir só os arquivos de saída foi desfeito pela primeira
  // regeneração em massa (#7588).
  html = stripArchiveHero(html);

  // #7911 — 5 páginas do acervo importado citavam
  // `diar-ia-poll.diaria.workers.dev/img/{key}`, host que hoje devolve 404
  // pra essa rota — o #7657 migrou `/img/{key}` pra ser servida também (e,
  // pro público, exclusivamente) em `diar.ia.br/img/{key}`, MESMO KV, só o
  // host mudou. Corrigir só os 5 arquivos gerados foi insuficiente
  // (mesma lição do #7412 acima): sem corrigir aqui, a próxima regeneração
  // em massa reintroduz o host morto a partir do HTML cru ainda cacheado.
  // Substituição cega de domínio é segura — a key depois de `/img/` não
  // muda, `handleImage` (workers/poll/src/index.ts) serve as duas origens
  // a partir do mesmo namespace.
  html = rewriteLegacyImageHost(html);

  // #8364: 2º host `workers.dev` legado de imagem, distinto do acima (ver
  // docstring de `rewriteLegacyPollWorkersDevImageHost`) — mesmo remédio.
  html = rewriteLegacyPollWorkersDevImageHost(html);

  // #8364: `<img>` do corpo/avatar que ainda apontam pra `media.beehiiv.com`
  // (terceiro, em migração de saída) são reescritos pro KV próprio SÓ
  // quando já migrados (`archive-image-migration.json` tem os bytes reais
  // no KV `POLL` — ver docstring do módulo). Mapa vazio (estado até alguém
  // rodar `migrate-archive-beehiiv-images.ts` com credenciais Cloudflare
  // reais) é um no-op puro: nenhuma URL não-migrada é tocada.
  html = rewriteMigratedBeehiivImages(html, loadArchiveImageMigrationMap().map, ARCHIVE_BASE_URL);

  // #8351 — 98 páginas citam os boxes de rodapé de livros/cursos apontando
  // pro host legado (`diaria.beehiiv.com/livros-sobre-ia`,
  // `.../cursos-gratuitos-de-ia`), que só redireciona `/p/{slug}` — qualquer
  // outro path é 404 genuíno. Mesma lição do #7412/#7911 acima: corrigir só
  // os arquivos de saída não sobrevive à próxima regeneração em massa.
  html = rewriteLegacyResourceLinks(html);

  // #8354 — hierarquia de <h1> quebrada (182/270 páginas sem exatamente 1).
  // Independente do guard de <html> logo abaixo (normalizeHeadingHierarchy só
  // depende de <body>/<h1>, nunca de <html>/<head>) — feito aqui, ao lado das
  // demais correções estruturais do HTML capturado, por coesão de leitura.
  html = normalizeHeadingHierarchy(html, rawTitle);

  // #8353 item 1 — nav prev/next logo após o <h1> (visível ou sr-only, ver
  // normalizeHeadingHierarchy acima). Omitido (post sem nenhum vizinho
  // resolvido pelo caller) preserva o HTML de antes byte a byte.
  const neighborNavHtml = buildArchiveNeighborNavHtml(opts.neighbors?.prev, opts.neighbors?.next);
  if (neighborNavHtml) {
    html = html.replace(/<body[^>]*>/i, (full) => `${full}${neighborNavHtml}`);
  }

  // Precisa haver <html ...> pra injetar lang + (no fallback abaixo) head —
  // sem essa tag, um .replace() vira no-op silencioso e a página sai sem
  // lang/title/description/canonical sem nenhum erro. Falha alto e nomeia o
  // slug em vez de degradar em silêncio.
  const HTML_TAG_PATTERN = /<html(\s[^>]*)?>/i;
  if (!HTML_TAG_PATTERN.test(html)) {
    throw new Error(
      `post "${post.slug}" não tem tag <html> no HTML de origem (content.free.web) — buildArchivePageHtml não consegue injetar lang/head`,
    );
  }

  // <html ...> → <html lang="pt-BR" ...> (o cache nunca tem `lang`; se um
  // dia vier a ter, substitui em vez de duplicar o atributo).
  html = html.replace(HTML_TAG_PATTERN, (full, attrs: string | undefined) => {
    if (attrs && /\blang\s*=/i.test(attrs)) {
      return full.replace(/lang\s*=\s*(["']).*?\1/i, 'lang="pt-BR"');
    }
    return `<html lang="pt-BR"${attrs ?? ""}>`;
  });

  const headInject =
    `<meta charset="utf-8">` +
    `<title>${title}</title>` +
    // #8352: `<meta name="description">`/`<link rel="canonical">` + favicon +
    // Open Graph + Twitter Card, via o MESMO helper que já serve
    // cursos/livros/hubs/poll (`renderSeoMeta`) — não mais construídos à mão
    // aqui. `description`/`canonical` continuam exatamente onde estavam
    // (1º/2º elemento do bloco, ver `renderSeoMeta`), então nenhum teste que
    // dependia da posição relativa desses dois quebra.
    seoMetaBlock +
    // #7921: "linha fina" pra consumo da HOME (site-home-page.ts,
    // extractPageDek) — SÓ D2 | D3, distinto de <meta name="description">
    // acima (que carrega D1 + D2|D3 de propósito, #6281). Omitido quando a
    // edição não tem D2/D3 (deriveDek devolve undefined) — o HOME trata a
    // ausência sem quebrar (ver extractPageDek/buildHomeFeed).
    (dek ? `<meta name="dek" content="${escHtml(dek)}">` : "") +
    (newsArticleJsonLd ?? "");

  if (/<head[^>]*>/i.test(html)) {
    html = html.replace(/<head[^>]*>/i, (full) => `${full}${headInject}`);
  } else {
    // Nunca visto no cache real (todo post tem <head>), mas não deixar a
    // página sair sem os metadados se algum post futuro vier sem.
    html = html.replace(/<html[^>]*>/i, (full) => `${full}<head>${headInject}</head>`);
  }

  // ORDEM IMPORTA, e ela estava invertida (hotfix da rodada overnight 260826).
  //
  // Sanitiza PRIMEIRO: `content.free.web` da Beehiiv contém `{{email}}` cru no
  // link de voto — é a merge tag PADRÃO desde o #4581, não um caso raro. Foi
  // medido: 91 dos 259 posts do cache real a contêm.
  //
  // Com o guard rodando antes deste replace, `buildArchivePageHtml` lançava
  // para esses 91 posts, quebrando `gen-archive-pages.ts` (acervo público
  // inteiro) e `publish-edition-site-page.ts` (#6202). O replace existia
  // justamente para tratar o caso que o guard rejeitava antes de ele agir.
  //
  // DECISÃO DO EDITOR (#6210, 26/08/2026): a página WEB do acervo não tem
  // identidade de assinante, então o link de voto não pode simplesmente
  // zerar `email=` (endpoint `/vote` exige identidade — o link ficaria
  // quebrado, exatamente a alternativa que o editor descartou). O clique
  // deve levar pro fluxo `/jogar?edition=...` — mesmo worker `poll`, já tem
  // gate próprio e identidade anônima (`WEB_TOKEN_DOMAIN`,
  // `isAnonymousWebIdentity` em workers/poll/src/lib.ts). Roda ANTES do
  // fallback genérico abaixo. As duas escolhas (A e B) da mesma edição
  // colapsam pro MESMO link — `/jogar` já apresenta as duas imagens e
  // captura o clique, não precisa (nem aceita) receber a escolha por query.
  //
  // As DUAS variantes de shape abaixo (legado query-string e o atual
  // path-based) descartam de propósito TUDO que vem depois de
  // `choice=[AB]`/`{{email}}` até o fechamento do atributo (`[^"'\s]*`
  // no fim de cada regex) — inclusive `utm_source`/`utm_medium`/
  // `utm_campaign`/`sig`. Achado do fleet review desta PR: as duas regexes
  // tratavam isso de forma ASSIMÉTRICA (legado descartava, path-based não
  // consumia e deixava o UTM da newsletter vazar pro link do acervo) — o
  // vazamento é o pior dos dois lados: um clique na página WEB (sem
  // contexto de e-mail) saindo com `utm_medium=newsletter` mente sobre a
  // origem do tráfego pra qualquer análise a jusante. Unificado: os dois
  // shapes agora descartam igual, e é a escolha certa aqui — o clique é de
  // OUTRA origem (arquivo público), então UTM de newsletter não pertence a
  // ele de jeito nenhum; se um dia o acervo precisar de UTM próprio, isso é
  // decisão nova, não reaproveitar o que veio grudado no HTML da Beehiiv.
  html = html.replace(
    /https?:\/\/([a-z0-9.-]+)\/vote\?email=\{\{email\}\}&edition=([^&"'\s]+)&choice=[AB][^"'\s]*/gi,
    (_match, domain: string, edition: string) => `https://${domain}/jogar?edition=${edition}`,
  );

  // Mesmo tratamento, shape de URL diferente: `/vote/{edition}/{A|B}?email=`
  // (path-based, não query-string) é o formato ATUAL de `buildVoteUrl` em
  // newsletter-render-html.ts (#5675 — edição/escolha saíram da query pra
  // evitar quoted-printable corromper `&` no envio da Beehiiv) — é o link
  // que `_internal/newsletter-final.html` carrega quando o passo de
  // pipeline do #6202 publica uma edição NOVA como página pública, então
  // precisa da mesma correção que o formato legado acima. `[^"'\s]*` no
  // fim consome o `&utm_source=...&utm_medium=...&utm_campaign=...` que
  // SEMPRE segue `{{email}}` neste shape no cache real (medido: 100% das
  // ocorrências) — sem isso, o UTM de newsletter sobrevivia grudado no
  // `/jogar?edition=...` resultante (ver nota acima).
  html = html.replace(
    /https?:\/\/([a-z0-9.-]+)\/vote\/([^/"'\s]+)\/[AB]\?email=\{\{email\}\}[^"'\s]*/gi,
    (_match, domain: string, edition: string) => `https://${domain}/jogar?edition=${edition}`,
  );

  // Guard ANTES do fallback genérico (achado do fleet review desta PR):
  // se sobrou um `/vote...{{email}}` que os dois padrões acima NÃO
  // reconheceram (shape novo — já mudou 3× nos últimos ~2 meses: #4581 →
  // #5675 → #6210 — ordem de query diferente, `choice` fora de A/B, etc.),
  // o fallback genérico abaixo zeraria `email=` e reproduziria em
  // SILÊNCIO o bug original do #6210: um `/vote?email=&...` sem
  // identidade, que o endpoint rejeita. Falha alto e nomeia o slug em vez
  // de deixar esse caso cair no fallback — mesmo padrão de
  // `verifyNoUnresolvedMergeTags` logo abaixo, só que aplicado ANTES do
  // replace que apagaria a evidência (a tag já estaria resolvida — pra
  // vazio — quando o guard de saída rodasse, então ele nunca pegaria isto).
  const staleVoteLink = html.match(/\/vote(?:\?|\/[^"'\s]*\?)[^"'\s]*\{\{email\}\}[^"'\s]*/i);
  if (staleVoteLink) {
    throw new UnresolvedMergeTagError(post.slug, [staleVoteLink[0]]);
  }

  // Fallback genérico — cobre `email={{email}}` fora de um link de voto
  // (confirmado no cache real: link de tracking de anúncio da Beehiiv,
  // `_bhiiv=opp_...`, e magic link `magic.beehiiv.com/v1/...`) e qualquer
  // shape futuro que o guard acima não pegue por não ter `/vote` no path.
  // Continua zerando o valor porque não há como saber, em geral, que o
  // destino é um link de voto que aceita /jogar — só os 2 padrões
  // explícitos acima têm essa garantia.
  html = html.replace(/email=\{\{email\}\}/gi, "email=");

  // `{{email_address_id}}` é o OUTRO identificador de assinante que a Beehiiv
  // deixa cru no HTML — e é o DOMINANTE: medido no cache real, 421 ocorrências
  // contra 186 de `{{email}}`. Aparece embutido em URL de rastreio, no formato
  // `..._SUBSCRIBER_ID_{{email_address_id}}`, e não em `chave={{tag}}` — por
  // isso não é coberto pelo replace acima.
  //
  // Vaza a mesma classe de dado que motivou o #6210 (identificador de
  // assinante numa página PÚBLICA), então recebe o mesmo tratamento: some.
  // Sem isto, o guard abaixo rejeita 74 dos 259 posts, e como
  // `generateArchivePages` não tem try/catch por post, o primeiro deles aborta
  // o lote inteiro — quebrando o deploy do acervo (.github/workflows/deploy-site.yml).
  html = html.replace(/\{\{email_address_id\}\}/gi, "");

  // Convite a assinar (#7576) — formulário no rodapé + modal a 50% de rolagem.
  // Injetado ANTES do guard abaixo de propósito: o bloco é HTML nosso, sem
  // merge tag nenhuma, mas passar por `verifyNoUnresolvedMergeTags` junto com
  // o resto garante que uma regressão futura nele (uma `{{...}}` que escape de
  // um template) seja pega pelo mesmo mecanismo, em vez de sair publicada.
  //
  // A Beehiiv injetava um modal equivalente em cada edição; ele se perdeu no
  // cutover do apex (#467) e essas páginas ficaram sendo a superfície mais
  // visitada do domínio sem nenhuma forma de virar assinante (medido em
  // 07/09/2026: 0 formulários contra 2 na versão Beehiiv da mesma edição).
  html = injectBeforeBodyEnd(html, editionCtaBlock(), post.slug);

  // Guard (#6210) DEPOIS: agora ele valida o HTML que de fato vai ser
  // publicado, e segue pegando toda merge tag não resolvida que o sanitize
  // acima NÃO cobre — que é exatamente o que o #6210 pediu.
  verifyNoUnresolvedMergeTags(html, post.slug);

  return html;
}

/**
 * Insere `block` imediatamente antes de `</body>`.
 *
 * Falha alto se a tag não existir, em vez de deixar o `.replace()` virar no-op
 * silencioso — mesma disciplina do guard de `<html>` no começo desta função, e
 * pela mesma razão: uma página publicada sem o convite, sem nenhum erro, é
 * exatamente o tipo de perda que ninguém percebe até alguém medir meses depois.
 */
export function injectBeforeBodyEnd(html: string, block: string, slug: string): string {
  // ÚLTIMO `</body>`, não o primeiro (achado do review da PR #7588).
  //
  // `String.replace` com regex não-global casa o PRIMEIRO. Numa edição que cite
  // HTML como texto — plausível numa newsletter sobre tecnologia — o primeiro
  // `</body>` seria o do exemplo, e o convite entraria no meio do artigo, com o
  // resto da edição caindo depois do fechamento. O navegador reabre o body por
  // recuperação de erro, então a página não quebra visivelmente: some em
  // silêncio dentro de 261 páginas indexadas. O último é sempre o real.
  const ocorrencias = [...html.matchAll(/<\/body\s*>/gi)];
  const ultima = ocorrencias.at(-1);
  if (!ultima?.index) {
    throw new Error(
      `post "${slug}": HTML sem </body> — não há onde injetar o bloco de cadastro (#7576). ` +
        `Publicar assim geraria uma página de edição sem nenhuma forma de assinar.`,
    );
  }
  return `${html.slice(0, ultima.index)}${block}
${html.slice(ultima.index)}`;
}

export interface SitemapEntry {
  loc: string;
  lastmod?: string;
}

export function sitemapEntriesForPosts(posts: ArchivePost[]): SitemapEntry[] {
  return selectPublishedPosts(posts).map((post) => ({
    loc: archiveUrlForSlug(post.slug),
    lastmod: publishDateToIso(post),
  }));
}

/**
 * #6454: monta a entrada de sitemap para uma única página — usada ao adicionar
 * uma edição nova sem regenerar o sitemap inteiro a partir do cache.
 */
export function sitemapEntryFromPost(post: ArchivePost): SitemapEntry {
  return { loc: archiveUrlForSlug(post.slug), lastmod: publishDateToIso(post) };
}

/**
 * #6454: adiciona uma entrada ao sitemap XML existente, sem duplicar.
 *
 * Idempotente: se a URL já estiver presente, retorna o XML inalterado.
 * Usa inclusão de string (não parseia o XML inteiro, que pode ter formato
 * levemente diferente do `buildSitemapXml` padrão). Se o XML for malformado,
 * a inclusão ainda funciona — é só uma string dentro de `</urlset>`.
 */
export function addSitemapEntry(existingXml: string, entry: SitemapEntry): string {
  // #7280 (achado do fleet review): `existingXml.includes(entry.loc)` era um
  // substring check — falso positivo sempre que `entry.loc` é PREFIXO da URL
  // de outra página já presente (ex: adicionar
  // `.../p/90-das-pessoas-nao-reconhecem-videos-de-ia` quando o sitemap já
  // tem `.../p/90-das-pessoas-nao-reconhecem-videos-de-ia-ec15971b8c4f589e`
  // — página DIFERENTE, slug só coincidentemente prefixado). O check achava
  // "já presente" e pulava a inserção em silêncio — a entrada nova nunca
  // entrava no sitemap, sem erro nem log. Comparação agora é contra a tag
  // `<loc>...</loc>` INTEIRA (mesmo formato que a inserção grava), que só
  // casa a URL exata.
  if (existingXml.includes(`<loc>${escXml(entry.loc)}</loc>`)) return existingXml;
  const lastmodLine = entry.lastmod ? `\n    <lastmod>${escXml(entry.lastmod)}</lastmod>` : '';
  const insertion = `  <url>\n    <loc>${escXml(entry.loc)}</loc>${lastmodLine}\n  </url>\n`;
  return existingXml.replace('</urlset>', insertion + '</urlset>');
}

/**
 * Data de publicação "canônica" em ms — consulta o override por slug
 * (`beehiiv-publish-date-overrides.json`, #4796) primeiro, porque
 * `publish_date` bruto MENTE pras 6 primeiras edições publicadas (aponta
 * pro dia do import em lote pro Beehiiv, não pro envio real por e-mail —
 * ver docstring de `beehiiv-publish-date.ts`). Cai pro `publish_date` bruto
 * do cache (epoch segundos ou, defensivamente, ms) pra toda edição fora do
 * override. Usado tanto pra ordenar `selectPublishedPosts` quanto pro
 * `<lastmod>` do sitemap — as duas leituras da mesma data precisam
 * concordar.
 */
function resolvePublishTimestampMs(post: ArchivePost): number | undefined {
  const overrides = loadPublishDateOverrides().overrides;
  if (post.slug && Object.hasOwn(overrides, post.slug)) {
    const ms = Date.parse(`${overrides[post.slug]}T00:00:00Z`);
    if (!Number.isNaN(ms)) return ms;
  }
  // #8336: `displayed_date` antes do `publish_date` cru — mesma precedência
  // de `editorialDate()` (`shared/edition-cache-reader.ts`, #7569). Sem
  // efeito prático hoje (nenhum script de sync popula este campo em
  // post_*.json, confirmado por grep nesta PR), mas fecha o gap se algum
  // dia a API Beehiiv passar a devolvê-lo — sem esperar uma entrada nova em
  // beehiiv-publish-date-overrides.json pra cada edição futura corrigida
  // dessa forma.
  if (post.displayed_date) {
    const ms = post.displayed_date > 1e12 ? post.displayed_date : post.displayed_date * 1000;
    if (!Number.isNaN(ms)) return ms;
  }
  const publishDate = post.publish_date;
  if (!publishDate) return undefined;
  // publish_date do cache Beehiiv vem em epoch segundos (ver
  // scripts/lib/beehiiv-publish-date.ts).
  const ms = publishDate > 1e12 ? publishDate : publishDate * 1000;
  return Number.isNaN(ms) ? undefined : ms;
}

/**
 * Exportada desde o #7578: `site-sitemap-orphans.ts` precisa da MESMA
 * resolução de data para o `<lastmod>` das órfãs que este módulo usa para o
 * sitemap normal. Reimplementar `displayed_date ?? publish_date` lá teria
 * ignorado `beehiiv-publish-date-overrides.json` (#4796) e escrito a data do
 * IMPORT em lote, não a do envio real, nas 6 edições mais antigas.
 */
export function publishDateToIso(post: ArchivePost): string | undefined {
  const ms = resolvePublishTimestampMs(post);
  if (ms === undefined) return undefined;
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString().slice(0, 10);
}

/**
 * JSON-LD `NewsArticle` pra cada página do acervo (#8336) — supre o
 * dateline ausente que nenhuma das 270 páginas de `/p/{slug}` carrega hoje
 * (0 `<script type="application/ld+json">` medido ao vivo). Escopo
 * DIFERENTE do contrato de prosa dos hubs (`shared/hub-page.ts`,
 * "Descartado pela auditoria, não reintroduzir"): aquele descarta a
 * EXPANSÃO de `FAQPage` nos HUBS (rich result de FAQ aposentado em
 * 07/05/2026, quasi-experimento da Ahrefs mediu −4,6% em AI Overviews) —
 * decisão que esta PR NÃO revoga. Este gerador é outra superfície (o
 * acervo de edições, não os hubs temáticos) e não emite `FAQPage` nenhum —
 * só um node `NewsArticle`, sem `@graph`.
 *
 * `datePublished`/`dateModified` vêm de `publishDateToIso(post)` — o MESMO
 * resolvedor que este módulo já usa pro `<lastmod>` do sitemap
 * (`sitemapEntriesForPosts`/`sitemapEntryFromPost`), não uma chamada direta
 * a `editorialDate()` (`shared/edition-cache-reader.ts`, #7569): aquela
 * função opera sobre `UnifiedCachedPost`, um shape diferente de
 * `ArchivePost`, e sua precedência (`displayed_date ?? publish_date`) seria
 * hoje um NO-OP puro — nenhum script de sync popula `displayed_date` em
 * `post_*.json` (confirmado por grep no repo inteiro nesta PR). O que de
 * fato corrige a mesma classe de bug que a issue descreve (`publish_date`
 * cru mentindo pras 6 edições mais antigas, importadas em bloco em
 * 04/09/2025) é `beehiiv-publish-date-overrides.json` (#4796, curado à mão
 * pelo editor a partir do Gmail) — já embutido em
 * `resolvePublishTimestampMs`, que agora TAMBÉM honra `displayed_date`
 * quando presente (ver comentário lá, #8336), fechando o gap pra quando a
 * API Beehiiv passar a devolvê-lo. Reaproveitar `publishDateToIso` aqui, em
 * vez de reescrever a resolução, garante que `<lastmod>` do sitemap e
 * `datePublished` do JSON-LD da MESMA página nunca divirjam.
 *
 * `dateModified` = `datePublished`: uma edição do acervo não tem rastro de
 * revisão pós-envio (o gerador é idempotente/sobrescreve o ARQUIVO, mas o
 * CONTEÚDO da edição publicada não muda depois) — usar `new Date()` em
 * runtime quebraria o congelamento contra o HTML committed toda vez que o
 * gerador rodasse de novo (mesma razão pela qual `geo-faq.ts` documenta
 * "datas estáticas, não wall-clock" pra livros/cursos).
 *
 * `undefined` quando a data não resolve (post sem `publish_date` nem
 * override) — nunca escreve `datePublished` inválido; `buildArchivePageHtml`
 * omite o `<script>` inteiro nesse caso, mesmo padrão fail-soft do
 * `<lastmod>` opcional no sitemap.
 */
export function buildArchiveNewsArticleJsonLd(post: ArchivePost, author: GeoAuthor = GEO_AUTHOR): string | undefined {
  const datePublished = publishDateToIso(post);
  if (!datePublished) return undefined;
  const canonical = archiveUrlForSlug(post.slug);
  const node = {
    "@context": "https://schema.org",
    "@type": "NewsArticle",
    headline: derivePageTitle(post),
    description: deriveMetaDescription(post),
    url: canonical,
    mainEntityOfPage: canonical,
    datePublished,
    dateModified: datePublished,
    author: { "@type": "Person", name: author.name, url: author.url },
    publisher: { "@type": "Organization", name: "diar.ia.br", url: ARCHIVE_BASE_URL },
    inLanguage: "pt-BR",
  };
  // </script>-safe embed — mesmo padrão de renderGeoJsonLd (shared/geo-faq.ts).
  const json = JSON.stringify(node).replaceAll("<", "\\u003c");
  return `<script type="application/ld+json">${json}</script>`;
}

function escXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function buildSitemapXml(entries: SitemapEntry[]): string {
  const urls = entries
    .map((entry) => {
      const lastmod = entry.lastmod ? `\n    <lastmod>${escXml(entry.lastmod)}</lastmod>` : "";
      return `  <url>\n    <loc>${escXml(entry.loc)}</loc>${lastmod}\n  </url>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

/**
 * Erro DEDICADO pra "merge tag desconhecida", separado de qualquer outro
 * jeito de `buildArchivePageHtml` falhar (post não publicado, sem
 * content.free.web, sem tag `<html>`) — #6256. É essa distinção de TIPO
 * (não de mensagem) que permite ao caller (`generateArchivePages`) degradar
 * SÓ este caso por post, sem abrir mão de abortar o lote pros demais, que
 * continuam sinal de problema estrutural (ver comentário em `loadPosts`,
 * `scripts/gen-archive-pages.ts`, sobre por que aquele caso é diferente
 * deste).
 *
 * `tags` já vem deduplicado (ordem de 1ª aparição) — é o que o relatório
 * agregado de fim de lote precisa pra listar "quais tags" sem repetição.
 */
export class UnresolvedMergeTagError extends Error {
  readonly slug: string;
  /** Todas as ocorrências cruas casadas no HTML, COM repetição. */
  readonly matches: string[];
  /** Ocorrências únicas, ordem de 1ª aparição — pro relatório. */
  readonly tags: string[];

  constructor(slug: string, matches: string[]) {
    super(
      `post "${slug}" contém merge tag não resolvida no HTML (${matches[0]} ... ${matches.length} ocorrências) — guard #6210 rejeitou`,
    );
    this.name = "UnresolvedMergeTagError";
    this.slug = slug;
    this.matches = matches;
    this.tags = [...new Set(matches)];
  }
}

/** Guard (#6210): rejeita HTML com merge tag não resolvida (ex: `{{email}}` literal).
 * O vazamento das 87 páginas do acervo vem do `content.free.web` da Beehiiv —
 * a tag chega crua, e sem esta verificação a página publica o template como texto.
 *
 * Lança `UnresolvedMergeTagError` (não `Error` genérico) — #6256 depende
 * desse tipo pra separar "tag desconhecida, degrada por post" de qualquer
 * outra falha de `buildArchivePageHtml`, que segue abortando o lote.
 */
export function verifyNoUnresolvedMergeTags(html: string, slug: string): void {
  // Qualquer `{{...}}` que não seja uma substituição já feita pelo gerador indica vazamento.
  const unresolved = html.match(/\{\{[^}]+\}\}/g);
  if (unresolved && unresolved.length > 0) {
    throw new UnresolvedMergeTagError(slug, unresolved);
  }
}
