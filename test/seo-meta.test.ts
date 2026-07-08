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
    assert.match(html, /<meta property="og:site_name" content="Diar\.ia">/);
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
