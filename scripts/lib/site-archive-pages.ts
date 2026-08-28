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

export interface ArchivePost {
  slug: string;
  title: string;
  subtitle?: string | null;
  preview_text?: string | null;
  meta_default_title?: string | null;
  meta_default_description?: string | null;
  status: string;
  web_url?: string | null;
  displayed_date?: string | null;
  publish_date?: number | null;
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
    content: u.content ?? null,
  };
}

/**
 * Injeta `lang="pt-BR"`, `<title>`, `<meta name="description">` e
 * `<link rel="canonical">` no HTML cru de `content.free.web` — que não tem
 * NENHUM desses (confirmado ao vivo nos 258 posts do cache, #467).
 * Preserva o resto do documento (estilos inline, corpo) sem tocar.
 */
export function buildArchivePageHtml(post: ArchivePost): string {
  if (!isPublishedPost(post)) {
    throw new Error(
      `post "${post.slug}" não é publicado (status="${post.status}") — buildArchivePageHtml não gera página pra rascunho`,
    );
  }

  const rawHtml = post.content?.free?.web;
  if (!rawHtml) {
    throw new Error(`post "${post.slug}" não tem content.free.web — não é gerável`);
  }

  const title = escHtml(derivePageTitle(post));
  const description = escHtml(deriveMetaDescription(post));
  const canonical = archiveUrlForSlug(post.slug);

  let html = rawHtml;

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
    `<meta name="description" content="${description}">` +
    `<link rel="canonical" href="${escHtml(canonical)}">`;

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

  // Guard (#6210) DEPOIS: agora ele valida o HTML que de fato vai ser
  // publicado, e segue pegando toda merge tag não resolvida que o sanitize
  // acima NÃO cobre — que é exatamente o que o #6210 pediu.
  verifyNoUnresolvedMergeTags(html, post.slug);

  return html;
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
  if (existingXml.includes(entry.loc)) return existingXml;
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
  const publishDate = post.publish_date;
  if (!publishDate) return undefined;
  // publish_date do cache Beehiiv vem em epoch segundos (ver
  // scripts/lib/beehiiv-publish-date.ts).
  const ms = publishDate > 1e12 ? publishDate : publishDate * 1000;
  return Number.isNaN(ms) ? undefined : ms;
}

function publishDateToIso(post: ArchivePost): string | undefined {
  const ms = resolvePublishTimestampMs(post);
  if (ms === undefined) return undefined;
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString().slice(0, 10);
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
