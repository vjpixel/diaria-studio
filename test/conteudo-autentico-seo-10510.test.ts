/**
 * conteudo-autentico-seo-10510.test.ts (#10510)
 *
 * SEO/GEO da página de venda /produto/conteudo-autentico: title, description
 * sem data, JSON-LD (Course + FAQPage + BreadcrumbList) válido e em dia com a
 * página, ficha da aula, autor, links internos, mockups fora da árvore de
 * acessibilidade e og:image:alt.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyConteudoAutenticoJsonLd,
  extractFaqFromHtml,
  extractJsonLdBlock,
  extractVisiblePrice,
  PAGE_URL,
} from "../scripts/lib/conteudo-autentico-page.ts";
import { renderGeoJsonLd } from "../scripts/lib/shared/geo-faq.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = join(ROOT, "workers/site/public");
const HTML = readFileSync(join(PUBLIC, "produto/conteudo-autentico/b/index.html"), "utf8");

function jsonLdGraph(html: string): Record<string, any>[] {
  const block = extractJsonLdBlock(html);
  assert.ok(block, "bloco JSON-LD com marcadores ausente");
  const m = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(block!);
  assert.ok(m, "<script type=application/ld+json> ausente dentro dos marcadores");
  const parsed = JSON.parse(m![1]);
  assert.equal(parsed["@context"], "https://schema.org");
  assert.ok(Array.isArray(parsed["@graph"]));
  return parsed["@graph"];
}

function node(graph: Record<string, any>[], type: string): Record<string, any> {
  const found = graph.filter((n) => n["@type"] === type);
  assert.equal(found.length, 1, `esperado exatamente 1 node ${type}`);
  return found[0];
}

test("title: 57 chars, cabe no corte de ~60 e cita ChatGPT", () => {
  const title = /<title>([^<]*)<\/title>/.exec(HTML)![1];
  assert.equal(title, "Conteúdo Autêntico com IA: assistente de posts no ChatGPT");
  assert.ok(title.length <= 60);
});

test("meta description: texto da issue, <= 160 chars, sem data nem preço (não vence em 22/10)", () => {
  const desc = /<meta name="description" content="([^"]*)"/.exec(HTML)![1];
  assert.equal(
    desc,
    "Monte no ChatGPT gratuito, sem programar, um assistente que aprende a voz da sua marca e escreve os posts de cada rede. Aula em vídeo com materiais prontos.",
  );
  assert.ok(desc.length <= 160, `description com ${desc.length} chars`);
  assert.doesNotMatch(desc, /\d{1,2}\/\d{1,2}|R\$|pré-venda/i);
});

test("JSON-LD: parseável, com Course, FAQPage e BreadcrumbList e campos obrigatórios", () => {
  const graph = jsonLdGraph(HTML);
  const course = node(graph, "Course");
  assert.equal(course.name, "Conteúdo Autêntico com IA");
  assert.ok(course.description.length > 0);
  assert.equal(course.url, PAGE_URL);
  assert.equal(course.provider["@type"], "Organization");
  assert.equal(course.provider.url, "https://diar.ia.br/");

  const instructor = course.hasCourseInstance.instructor;
  assert.equal(instructor["@type"], "Person");
  assert.equal(instructor.name, "Angelo Pixel");
  assert.ok(instructor.sameAs.includes("https://www.linkedin.com/in/vjpixel/"));
  assert.equal(course.hasCourseInstance.courseMode, "online");

  const offer = course.offers;
  assert.equal(offer["@type"], "Offer");
  assert.match(offer.price, /^\d+\.\d{2}$/);
  assert.equal(offer.priceCurrency, "BRL");
  if (offer.priceValidUntil !== undefined) assert.match(offer.priceValidUntil, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(offer.availability, /^https:\/\/schema\.org\/\w+$/);

  const crumbs = node(graph, "BreadcrumbList").itemListElement;
  assert.deepEqual(
    crumbs.map((c: any) => [c.position, c.item]),
    [
      [1, "https://diar.ia.br/"],
      [2, PAGE_URL],
    ],
  );
});

test("JSON-LD: FAQPage tem as 9 perguntas visíveis, na mesma ordem e com o mesmo texto", () => {
  const faq = node(jsonLdGraph(HTML), "FAQPage");
  const visible = extractFaqFromHtml(HTML);
  assert.equal(visible.length, 9);
  assert.deepEqual(
    faq.mainEntity.map((q: any) => [q.name, q.acceptedAnswer.text]),
    visible.map((q) => [q.question, q.answer]),
  );
});

test("JSON-LD: preço da oferta = preço visível no card da oferta", () => {
  const offer = node(jsonLdGraph(HTML), "Course").offers;
  assert.equal(offer.price, extractVisiblePrice(HTML));
});

test("JSON-LD commitado bate com o render fresco (rodar scripts/build-conteudo-autentico-jsonld.ts)", () => {
  assert.equal(applyConteudoAutenticoJsonLd(HTML), HTML);
});

test("extractVisiblePrice ignora o preço riscado", () => {
  assert.equal(extractVisiblePrice('<p class="price"><s class="price-old">R$ 57</s>R$ 39,90</p>'), "39.90");
  assert.equal(extractVisiblePrice('<p class="price">R$ 57</p>'), "57.00");
});

test("JSON-LD fica seguro contra </script> num texto do FAQ", () => {
  const html = HTML.replace("<summary>Preciso saber programar?</summary>", "<summary>Preciso saber programar? &lt;/script&gt;</summary>");
  const out = extractJsonLdBlock(applyConteudoAutenticoJsonLd(html))!;
  assert.equal(out.match(/<\/script>/g)?.length, 1);
});

test("refactor do geo-faq: renderGeoJsonLd segue com FAQPage + Article", () => {
  const out = renderGeoJsonLd({
    pageUrl: "https://x/",
    headline: "h",
    description: "d",
    datePublished: "2026-01-01",
    dateModified: "2026-01-01",
    faq: [{ question: "q", answer: "[a](https://y)" }],
  });
  const g = JSON.parse(/<script type="application\/ld\+json">([\s\S]*)<\/script>/.exec(out)![1])["@graph"];
  assert.deepEqual(g.map((n: any) => n["@type"]), ["FAQPage", "Article"]);
  assert.equal(g[0].mainEntity[0].acceptedAnswer.text, "a");
});

test("og:image:alt presente", () => {
  assert.match(HTML, /<meta property="og:image:alt" content="[^"]{20,}"/);
});

test("ficha da aula logo após o hero, com formato, liberação, acesso, preço, garantia e requisitos", () => {
  const heroEnd = HTML.indexOf('aria-labelledby="hero-title"');
  const ficha = HTML.indexOf('class="ficha"');
  const why = HTML.indexOf('aria-labelledby="why-title"');
  assert.ok(heroEnd < ficha && ficha < why, "ficha deve ficar entre o hero e a seção 2");
  const block = HTML.slice(ficha, why);
  for (const dt of ["Formato", "Liberação", "Acesso", "Preço", "Garantia", "Requisitos"]) {
    assert.ok(block.includes(`<dt>${dt}</dt>`), `ficha sem ${dt}`);
  }
  assert.ok(block.includes("Logo depois da compra"));
});

test("autor linka o LinkedIn e a página linka a home e a newsletter", () => {
  assert.match(HTML, /<a href="https:\/\/www\.linkedin\.com\/in\/vjpixel\/" target="_blank" rel="author me noopener">/);
  const footer = /<footer class="site-footer">([\s\S]*?)<\/footer>/.exec(HTML)![1];
  assert.match(footer, /<a href="\/" target="_blank" rel="noopener">/);
  assert.match(footer, /<a href="\/assinar" target="_blank" rel="noopener">/);
});

test("moldura falsa de rede social fora da árvore de acessibilidade", () => {
  for (const re of [/<div class="ph"(?![^>]*aria-hidden="true")/, /<div class="ph2"(?![^>]*aria-hidden="true")/, /<div class="act [^"]*"(?![^>]*aria-hidden="true")/, /<span class="count"(?![^>]*aria-hidden="true")/]) {
    assert.doesNotMatch(HTML, re);
  }
  assert.ok((HTML.match(/<div class="act [^"]*" aria-hidden="true">/g) ?? []).length >= 5);
});

test("links internos de entrada: home (render + HTML commitado) e /guia/agente-ia", () => {
  const home = readFileSync(join(PUBLIC, "index.html"), "utf8");
  assert.match(home, /<a href="\/produto\/conteudo-autentico">/);
  const tpl = readFileSync(join(ROOT, "scripts/lib/site-home-page.ts"), "utf8");
  assert.match(tpl, /<a href="\/produto\/conteudo-autentico">/);
  const guia = readFileSync(join(PUBLIC, "guia/agente-ia/index.html"), "utf8");
  assert.match(guia, /<a href="\/produto\/conteudo-autentico">/);
});

test("sem seta na copy nova (CLAUDE.md #9721)", () => {
  assert.doesNotMatch(HTML, /[→←]/);
});
