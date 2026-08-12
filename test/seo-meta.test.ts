/**
 * seo-meta.test.ts (#3106)
 *
 * Cobre `scripts/lib/shared/seo-meta.ts` — bloco <head> de SEO/compartilhamento
 * (description + Open Graph + Twitter card + canonical + favicon) reusado por
 * `build-cursos-page.ts` e `build-livros-page.ts`. Ver também
 * `test/build-cursos-page.test.ts` / `test/build-livros-page.test.ts` (integração)
 * e a regra do módulo sobre a ausência intencional de og:image/twitter:image.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderSeoMeta, FAVICON_DATA_URI } from "../scripts/lib/shared/seo-meta.ts";

describe("renderSeoMeta (#3106)", () => {
  const html = renderSeoMeta({
    title: "Título de Teste",
    description: "Uma descrição de teste com <tags> & \"aspas\".",
    url: "https://example.diaria.workers.dev/",
  });

  it("escapa HTML em title/description/url", () => {
    assert.match(html, /content="Uma descrição de teste com &lt;tags&gt; &amp; &quot;aspas&quot;\."/);
  });

  it("inclui description, og:title, og:description, og:url, og:type, og:site_name, og:locale", () => {
    assert.match(html, /<meta name="description" content="[^"]+">/);
    assert.match(html, /<meta property="og:type" content="website">/);
    assert.match(html, /<meta property="og:site_name" content="diar\.ia\.br">/);
    assert.match(html, /<meta property="og:locale" content="pt_BR">/);
    assert.match(html, /<meta property="og:title" content="Título de Teste">/);
    assert.match(html, /<meta property="og:description" content="[^"]+">/);
    assert.match(html, /<meta property="og:url" content="https:\/\/example\.diaria\.workers\.dev\/">/);
  });

  it("inclui canonical apontando pra URL passada", () => {
    assert.match(html, /<link rel="canonical" href="https:\/\/example\.diaria\.workers\.dev\/">/);
  });

  it("inclui favicon (link rel=icon) via data-URI", () => {
    assert.match(html, /<link rel="icon" href="data:image\/svg\+xml,/);
    assert.ok(html.includes(FAVICON_DATA_URI), "deve usar o FAVICON_DATA_URI exportado");
  });

  it("inclui twitter:card summary + title + description", () => {
    assert.match(html, /<meta name="twitter:card" content="summary">/);
    assert.match(html, /<meta name="twitter:title" content="Título de Teste">/);
    assert.match(html, /<meta name="twitter:description" content="[^"]+">/);
  });

  it("NÃO inclui og:image nem twitter:image (decisão documentada — data-URI não é buscável por unfurlers)", () => {
    assert.doesNotMatch(html, /property="og:image"/);
    assert.doesNotMatch(html, /name="twitter:image"/);
  });

  it("siteName/locale customizáveis via options", () => {
    const custom = renderSeoMeta({
      title: "T",
      description: "D",
      url: "https://x.example/",
      siteName: "Outra Marca",
      locale: "en_US",
    });
    assert.match(custom, /<meta property="og:site_name" content="Outra Marca">/);
    assert.match(custom, /<meta property="og:locale" content="en_US">/);
  });
});

describe("renderSeoMeta — image (#5131, decisão #3106 reaberta)", () => {
  it("sem `image`: comportamento idêntico a antes — sem og:image/twitter:image, twitter:card=summary", () => {
    const html = renderSeoMeta({ title: "T", description: "D", url: "https://x.example/" });
    assert.doesNotMatch(html, /property="og:image"/);
    assert.doesNotMatch(html, /name="twitter:image"/);
    assert.match(html, /<meta name="twitter:card" content="summary">/);
  });

  it("com `image`: emite og:image/twitter:image + width/height, twitter:card=summary_large_image", () => {
    const html = renderSeoMeta({
      title: "T",
      description: "D",
      url: "https://x.example/",
      image: { url: "https://eia.diar.ia.br/img/img-260812-04-d1-2x1-abc.jpg", width: 1600, height: 800 },
    });
    assert.match(html, /<meta property="og:image" content="https:\/\/eia\.diar\.ia\.br\/img\/img-260812-04-d1-2x1-abc\.jpg">/);
    assert.match(html, /<meta property="og:image:width" content="1600">/);
    assert.match(html, /<meta property="og:image:height" content="800">/);
    assert.match(html, /<meta name="twitter:image" content="https:\/\/eia\.diar\.ia\.br\/img\/img-260812-04-d1-2x1-abc\.jpg">/);
    assert.match(html, /<meta name="twitter:card" content="summary_large_image">/);
  });

  it("com `image` sem width/height: omite og:image:width/height, mas emite og:image", () => {
    const html = renderSeoMeta({
      title: "T",
      description: "D",
      url: "https://x.example/",
      image: { url: "https://x.example/capa.jpg" },
    });
    assert.match(html, /<meta property="og:image" content="https:\/\/x\.example\/capa\.jpg">/);
    assert.doesNotMatch(html, /og:image:width/);
    assert.doesNotMatch(html, /og:image:height/);
  });

  it("escapa a URL da imagem", () => {
    const html = renderSeoMeta({
      title: "T",
      description: "D",
      url: "https://x.example/",
      image: { url: "https://x.example/capa.jpg?a=1&b=2" },
    });
    assert.match(html, /content="https:\/\/x\.example\/capa\.jpg\?a=1&amp;b=2"/);
  });
});

describe("renderSeoMeta — feed (#5127)", () => {
  it("sem `feed`: comportamento idêntico a antes — sem link rel=alternate", () => {
    const html = renderSeoMeta({ title: "T", description: "D", url: "https://x.example/" });
    assert.doesNotMatch(html, /rel="alternate"/);
  });

  it("com `feed`: emite link rel=alternate type=application/rss+xml com o title default", () => {
    const html = renderSeoMeta({
      title: "T",
      description: "D",
      url: "https://arquivo.diar.ia.br/",
      feed: { url: "https://arquivo.diar.ia.br/feed.xml" },
    });
    assert.match(
      html,
      /<link rel="alternate" type="application\/rss\+xml" title="diar\.ia\.br — Feed RSS" href="https:\/\/arquivo\.diar\.ia\.br\/feed\.xml">/,
    );
  });

  it("com `feed.title` explícito, usa ele em vez do default", () => {
    const html = renderSeoMeta({
      title: "T",
      description: "D",
      url: "https://arquivo.diar.ia.br/",
      feed: { url: "https://arquivo.diar.ia.br/feed.xml", title: "Título Custom" },
    });
    assert.match(html, /title="Título Custom"/);
  });
});
