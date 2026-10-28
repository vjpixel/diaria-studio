/**
 * conteudo-autentico-page.ts (#10510)
 *
 * Dado estruturado (JSON-LD) da página de venda
 * `workers/site/public/produto/conteudo-autentico/b/index.html` (a versão ativa; a A, em `/a`, fica com
 * noindex e sem JSON-LD).
 *
 * A página é HTML escrito à mão (não há gerador do corpo). Só o bloco
 * JSON-LD é derivado, e derivado da PRÓPRIA página: as perguntas do FAQPage
 * saem dos `<details>` visíveis e o preço da oferta sai do `<p class="price">`.
 * Assim o dado estruturado nunca diz uma coisa e a página outra. O bloco
 * fica entre os marcadores `JSONLD_START`/`JSONLD_END` no `<head>` e é
 * regravado por `scripts/build-conteudo-autentico-jsonld.ts`
 * (`--check` falha se o HTML commitado divergir do render fresco; o teste
 * `test/conteudo-autentico-seo-10510.test.ts` faz a mesma checagem no CI).
 *
 * O que NÃO sai da página e vive aqui como constante: a data de validade do
 * preço de pré-venda e a disponibilidade. Quando a oferta trocar (#10504,
 * 23/10: volta para R$ 57 na oferta lhwtb1jf), atualizar `OFFER` abaixo e
 * rodar o builder. O teste de paridade de preço acusa se a página mudar o
 * preço e o JSON-LD não for regerado.
 *
 * Contexto do ganho (corpo da #10510): o Google aposentou o rich result de
 * Course Info (06/2025) e só mostra FAQ para governo/saúde (08/2023). O que
 * se busca é extração por assistente (ChatGPT/Claude/Gemini/Perplexity),
 * não snippet.
 */
import { GEO_AUTHOR, buildGeoFaqPageNode, renderJsonLdGraphScript, type GeoFaqItem } from "./shared/geo-faq.ts";

export const PAGE_URL = "https://diar.ia.br/produto/conteudo-autentico/b";
export const SITE_URL = "https://diar.ia.br/";
export const COURSE_NAME = "Conteúdo Autêntico com IA";

export const JSONLD_START = "<!-- #10510 jsonld:start (gerado por scripts/build-conteudo-autentico-jsonld.ts, não editar à mão) -->";
export const JSONLD_END = "<!-- #10510 jsonld:end -->";

/** Oferta vigente. Preço vem da página (`extractVisiblePrice`); o resto é
 * constante porque a página não expõe em formato legível por máquina.
 * `availability` InStock desde o fim da pré-venda (#10504): a aula em vídeo
 * saiu em 22/10/2026 e tudo é liberado na compra. Sem `priceValidUntil`,
 * porque o preço cheio não tem data para acabar. */
export const OFFER: { priceCurrency: string; availability: string; priceValidUntil?: string } = {
  priceCurrency: "BRL",
  availability: "https://schema.org/InStock",
};

/** Lançamento da aula em vídeo (`hasCourseInstance.startDate`). */
export const COURSE_START_DATE = "2026-10-22";

/** Nome completo usado na página ("Quem ensina"). `GEO_AUTHOR.name` ("Pixel")
 * é o nome curto do byline das edições; os dois apontam para o MESMO perfil
 * (`GEO_AUTHOR.url`), que é o identificador que unifica a entidade. */
export const INSTRUCTOR_NAME = "Angelo Pixel";

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&nbsp;": " " };

function htmlToText(fragment: string): string {
  return fragment
    .replace(/<[^>]+>/g, "")
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (m) => ENTITIES[m] ?? m)
    .replace(/\s+/g, " ")
    .trim();
}

/** Perguntas e respostas dos `<details><summary>…</summary><p>…</p></details>`
 * da seção de dúvidas, na ordem da página. Lança se não achar nenhuma
 * (falha alta em vez de gerar um FAQPage vazio). */
export function extractFaqFromHtml(html: string): GeoFaqItem[] {
  const re = /<details>\s*<summary>([\s\S]*?)<\/summary>\s*<p>([\s\S]*?)<\/p>\s*<\/details>/g;
  const items: GeoFaqItem[] = [];
  for (const m of html.matchAll(re)) {
    items.push({ question: htmlToText(m[1]), answer: htmlToText(m[2]) });
  }
  if (items.length === 0) throw new Error("conteudo-autentico: nenhuma pergunta <details> encontrada na página");
  return items;
}

/** Preço da oferta mostrado no card `<p class="price">` (sem o preço riscado
 * em `<s>`), como string decimal com ponto ("39.90"). Lança se não achar. */
export function extractVisiblePrice(html: string): string {
  const m = /<p class="price">([\s\S]*?)<\/p>/.exec(html);
  if (!m) throw new Error('conteudo-autentico: <p class="price"> não encontrado');
  const text = htmlToText(m[1].replace(/<s\b[\s\S]*?<\/s>/g, ""));
  const p = /R\$\s*(\d+)(?:,(\d{2}))?/.exec(text);
  if (!p) throw new Error(`conteudo-autentico: preço ilegível em "${text}"`);
  return `${p[1]}.${p[2] ?? "00"}`;
}

/** Conteúdo de `<meta name="description">`. */
export function extractMetaDescription(html: string): string {
  const m = /<meta name="description" content="([^"]*)"/.exec(html);
  if (!m) throw new Error("conteudo-autentico: meta description não encontrada");
  return htmlToText(m[1]);
}

export function buildConteudoAutenticoGraph(html: string): Record<string, unknown>[] {
  const description = extractMetaDescription(html);
  const instructor = {
    "@type": "Person",
    "@id": `${SITE_URL}#pixel`,
    name: INSTRUCTOR_NAME,
    alternateName: GEO_AUTHOR.name,
    url: GEO_AUTHOR.url,
    sameAs: [GEO_AUTHOR.url],
    jobTitle: "Editor da diar.ia.br",
  };
  const provider = { "@type": "Organization", "@id": `${SITE_URL}#organization`, name: "diar.ia.br", url: SITE_URL };
  return [
    {
      "@type": "Course",
      "@id": `${PAGE_URL}#course`,
      name: COURSE_NAME,
      description,
      url: PAGE_URL,
      inLanguage: "pt-BR",
      image: `${PAGE_URL}/assets/og-conteudo-autentico.png`,
      provider,
      author: instructor,
      isAccessibleForFree: false,
      hasCourseInstance: {
        "@type": "CourseInstance",
        courseMode: "online",
        startDate: COURSE_START_DATE,
        instructor,
      },
      offers: {
        "@type": "Offer",
        category: "Paid",
        price: extractVisiblePrice(html),
        priceCurrency: OFFER.priceCurrency,
        ...(OFFER.priceValidUntil ? { priceValidUntil: OFFER.priceValidUntil } : {}),
        availability: OFFER.availability,
        url: PAGE_URL,
      },
    },
    buildGeoFaqPageNode(PAGE_URL, extractFaqFromHtml(html)),
    {
      "@type": "BreadcrumbList",
      "@id": `${PAGE_URL}#breadcrumb`,
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "diar.ia.br", item: SITE_URL },
        { "@type": "ListItem", position: 2, name: COURSE_NAME, item: PAGE_URL },
      ],
    },
  ];
}

/** Bloco completo (marcadores + `<script>`), pronto para o `<head>`. */
export function renderConteudoAutenticoJsonLdBlock(html: string): string {
  return `${JSONLD_START}\n    ${renderJsonLdGraphScript(buildConteudoAutenticoGraph(html))}\n    ${JSONLD_END}`;
}

/** Bloco atualmente commitado entre os marcadores, ou `null` se ausente. */
export function extractJsonLdBlock(html: string): string | null {
  const start = html.indexOf(JSONLD_START);
  const end = html.indexOf(JSONLD_END);
  if (start === -1 || end === -1 || end < start) return null;
  return html.slice(start, end + JSONLD_END.length);
}

/** Regrava o bloco entre os marcadores. Lança se os marcadores não existirem
 * (o builder não decide sozinho onde inserir). */
export function applyConteudoAutenticoJsonLd(html: string): string {
  const current = extractJsonLdBlock(html);
  if (current === null) throw new Error("conteudo-autentico: marcadores do JSON-LD ausentes no <head>");
  return html.replace(current, () => renderConteudoAutenticoJsonLdBlock(html));
}
