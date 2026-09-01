/**
 * test/site-home-page-6375.test.ts (#6375)
 *
 * Cobre o redesign da home (`workers/site/public/index.html`, Direção A ·
 * Edição diária) — miolo puro (`scripts/lib/site-home-page.ts`) com fixtures
 * em memória, e o arquivo COMMITTED (7 blocos esperados, `<form>` de
 * inscrição inline no masthead/footer, `id`s próprios (#6976, antes
 * `<a href="/assinar">` — ver `test/site-home-signup-6976.test.ts` pro
 * mecanismo completo do form), link do destaque do dia → um `/p/{slug}`
 * real do cache).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildHomeFeed,
  buildIndexHtml,
  extractHeroImage,
  extractPageMeta,
  slugFromCanonicalUrl,
} from "../scripts/lib/site-home-page.ts";
import { buildSitemapXml, addSitemapEntry, sitemapEntryFromPost } from "../scripts/lib/site-archive-pages.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC_DIR = resolve(ROOT, "workers", "site", "public");

function fakePageHtml(title: string, description: string, heroSrc?: string): string {
  const hero = heroSrc
    ? `<img class="hero" src="${heroSrc}" alt="${title}" width="536" style="display:block;width:100%;height:auto;border-radius:6px;margin-top:24px;" border="0">`
    : "";
  return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"><title>${title}</title><meta name="description" content="${description}"></head><body>${hero}</body></html>`;
}

describe("slugFromCanonicalUrl", () => {
  it("extrai o slug de uma URL /p/{slug}", () => {
    assert.equal(slugFromCanonicalUrl("https://diar.ia.br/p/exemplo-de-slug"), "exemplo-de-slug");
  });

  it("devolve null pra URL fora do shape /p/{slug}", () => {
    assert.equal(slugFromCanonicalUrl("https://diar.ia.br/"), null);
  });

  it("extrai o slug mesmo com barra final, query string ou fragment (regex suporta, mas não era testado)", () => {
    assert.equal(slugFromCanonicalUrl("https://diar.ia.br/p/exemplo-de-slug/"), "exemplo-de-slug");
    assert.equal(slugFromCanonicalUrl("https://diar.ia.br/p/exemplo-de-slug?utm_source=x"), "exemplo-de-slug");
    assert.equal(slugFromCanonicalUrl("https://diar.ia.br/p/exemplo-de-slug#secao"), "exemplo-de-slug");
  });
});

describe("extractPageMeta", () => {
  it("lê title e description, decodificando entidades", () => {
    const html = fakePageHtml("Título &amp; assunto", "Descrição com &quot;aspas&quot;");
    const meta = extractPageMeta(html);
    assert.equal(meta.title, "Título & assunto");
    assert.equal(meta.description, 'Descrição com "aspas"');
  });
});

describe("extractHeroImage", () => {
  it("extrai o src do primeiro img.hero", () => {
    const html = fakePageHtml("T", "D", "https://eia.diar.ia.br/img/img-260729-04-d1-2x1-x.jpg");
    assert.equal(extractHeroImage(html), "https://eia.diar.ia.br/img/img-260729-04-d1-2x1-x.jpg");
  });

  it("devolve o PRIMEIRO img.hero quando há vários (D1, não D2/D3)", () => {
    const html = `<!DOCTYPE html><html><body>
      <img class="hero" src="https://eia.diar.ia.br/img/d1.jpg" alt="d1">
      <img class="hero" src="https://eia.diar.ia.br/img/d2.jpg" alt="d2">
    </body></html>`;
    assert.equal(extractHeroImage(html), "https://eia.diar.ia.br/img/d1.jpg");
  });

  it("devolve null quando não há img.hero", () => {
    assert.equal(extractHeroImage(fakePageHtml("T", "D")), null);
  });

  it("devolve null pra src vazio (não vaza string vazia)", () => {
    const html = `<!DOCTYPE html><html><body><img class="hero" src="" alt="x"></body></html>`;
    assert.equal(extractHeroImage(html), null);
  });

  it("nunca lança em HTML malformado", () => {
    assert.doesNotThrow(() => extractHeroImage("<img class=hero src=broken"));
  });
});

describe("buildHomeFeed", () => {
  const sitemapXml = buildSitemapXml([
    { loc: "https://diar.ia.br/p/edicao-mais-recente", lastmod: "2026-08-26" },
    { loc: "https://diar.ia.br/p/edicao-anterior", lastmod: "2026-08-25" },
    { loc: "https://diar.ia.br/p/sem-pagina-gerada", lastmod: "2026-08-24" },
  ]);

  const pages: Record<string, string> = {
    "edicao-mais-recente": fakePageHtml(
      "Edição mais recente",
      "Resumo da mais recente",
      "https://eia.diar.ia.br/img/img-x-04-d1-2x1-x.jpg",
    ),
    "edicao-anterior": fakePageHtml("Edição anterior", "Resumo da anterior"),
  };

  it("preserva a ordem do sitemap (mais recente primeiro)", () => {
    const feed = buildHomeFeed(sitemapXml, (slug) => pages[slug] ?? null);
    assert.equal(feed.length, 2);
    assert.equal(feed[0].slug, "edicao-mais-recente");
    assert.equal(feed[1].slug, "edicao-anterior");
  });

  it("popula image quando a página tem img.hero", () => {
    const feed = buildHomeFeed(sitemapXml, (slug) => pages[slug] ?? null);
    assert.equal(feed[0].image, "https://eia.diar.ia.br/img/img-x-04-d1-2x1-x.jpg");
  });

  it("image é null (nunca pula a entrada) quando a página não tem img.hero", () => {
    const feed = buildHomeFeed(sitemapXml, (slug) => pages[slug] ?? null);
    assert.equal(feed[1].slug, "edicao-anterior");
    assert.equal(feed[1].image, null);
  });

  it("pula slug sem página gerada em vez de quebrar o lote", () => {
    const feed = buildHomeFeed(sitemapXml, (slug) => pages[slug] ?? null);
    assert.ok(!feed.some((e) => e.slug === "sem-pagina-gerada"));
  });

  it("pula página sem <title> extraível (não só página ausente)", () => {
    const sitemap = buildSitemapXml([{ loc: "https://diar.ia.br/p/sem-titulo", lastmod: "2026-08-26" }]);
    const feed = buildHomeFeed(sitemap, () => `<!DOCTYPE html><html><head></head><body></body></html>`);
    assert.equal(feed.length, 0);
  });

  it("limit 0 devolve feed vazio", () => {
    const feed = buildHomeFeed(sitemapXml, (slug) => pages[slug] ?? null, 0);
    assert.equal(feed.length, 0);
  });

  it("respeita o limit", () => {
    const feed = buildHomeFeed(sitemapXml, (slug) => pages[slug] ?? null, 1);
    assert.equal(feed.length, 1);
    assert.equal(feed[0].slug, "edicao-mais-recente");
  });
});

describe("buildIndexHtml", () => {
  const feature = {
    slug: "destaque-do-dia",
    title: "Destaque do dia",
    description: "Resumo do destaque",
    url: "https://diar.ia.br/p/destaque-do-dia",
    date: "2026-08-27",
    image: "https://eia.diar.ia.br/img/img-x-04-d1-2x1-x.jpg",
  };
  const archive = [
    {
      slug: "edicao-anterior",
      title: "Edição anterior",
      description: "Resumo anterior",
      url: "https://diar.ia.br/p/edicao-anterior",
      date: "2026-08-26",
      image: null,
    },
  ];
  const html = buildIndexHtml({ feature, archive });

  it("renderiza a capa do destaque (#6978 item 1) quando feature.image existe", () => {
    assert.match(html, /<div class="feature-grid">/);
    assert.match(
      html,
      /<img src="https:\/\/eia\.diar\.ia\.br\/img\/img-x-04-d1-2x1-x\.jpg" alt="Destaque do dia" loading="lazy">/,
    );
  });

  it("degrada pro layout só-texto sem quebrar quando feature.image é null", () => {
    const noImage = buildIndexHtml({
      feature: { ...feature, image: null },
      archive,
    });
    assert.ok(
      !noImage.includes('<div class="feature-grid">'),
      "não deve montar o grid de imagem sem capa",
    );
    assert.match(noImage, /<h2 class="feature-title">Destaque do dia<\/h2>/);
  });

  it("contém os 7 blocos esperados (Nav, Masthead, Feature, Specials, Archive, Faqs, Footer)", () => {
    for (const id of ["nav", "masthead", "feature", "specials", "archive", "faqs", "footer"]) {
      assert.match(html, new RegExp(`id="${id}"`), `bloco #${id} ausente`);
    }
  });

  it("masthead E footer são <form> reais (não mais <a> disfarçado, #6976)", () => {
    assert.match(html, /<form class="signup"[^>]*id="masthead-form"[^>]*action="https:\/\/eia\.diar\.ia\.br\/jogar\/subscribe"/);
    assert.match(html, /<form class="signup signup--dark"[^>]*id="footer-form"[^>]*action="https:\/\/eia\.diar\.ia\.br\/jogar\/subscribe"/);
  });

  it("link do destaque do dia aponta pra a URL real da feature", () => {
    assert.match(html, /href="https:\/\/diar\.ia\.br\/p\/destaque-do-dia"/);
  });

  it("arquivo lista a edição anterior com link pra /p/{slug}", () => {
    assert.match(html, /href="https:\/\/diar\.ia\.br\/p\/edicao-anterior"/);
  });

  it("degrada sem quebrar quando não há feature (acervo vazio)", () => {
    const empty = buildIndexHtml({ feature: null, archive: [] });
    assert.match(empty, /<html lang="pt-BR">/);
  });

  it("escapa HTML no título/description da feature e do arquivo (nunca injeta markup cru)", () => {
    const dirty = buildIndexHtml({
      feature: {
        slug: "destaque-perigoso",
        title: `<script>alert(1)</script> & "aspas"`,
        description: `<img src=x onerror=alert(1)>`,
        url: "https://diar.ia.br/p/destaque-perigoso",
        date: "2026-08-27",
        image: null,
      },
      archive: [
        {
          slug: "arquivo-perigoso",
          title: `</h3><script>alert(2)</script>`,
          description: "ok",
          url: "https://diar.ia.br/p/arquivo-perigoso",
          date: "2026-08-26",
          image: null,
        },
      ],
    });
    // #6427: buildIndexHtml passou a incluir 1 <script> LEGÍTIMO, próprio
    // (repasse de query string pros CTAs de /assinar — nunca deriva de
    // input do caller), então a checagem de escape não pode mais banir
    // QUALQUER `<script>` no documento — teria que ser o PAYLOAD do
    // atacante especificamente que não vazasse cru.
    assert.ok(!dirty.includes("<script>alert(1)"), "payload malicioso da feature vazou como <script> cru");
    assert.ok(!dirty.includes("<script>alert(2)"), "payload malicioso do arquivo vazou como <script> cru");
    assert.ok(!dirty.includes("<img src=x"), "tag <img> crua vazou pro HTML renderizado (escapada, viraria texto inerte)");
    assert.match(dirty, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.match(dirty, /&lt;img src=x onerror=alert\(1\)&gt;/);
    assert.match(dirty, /&lt;\/h3&gt;&lt;script&gt;alert\(2\)&lt;\/script&gt;/);
  });

  it("exclui do arquivo qualquer entrada com o mesmo slug da feature (defensivo, mesmo se o caller passar sobreposição)", () => {
    const overlapping = buildIndexHtml({
      feature,
      archive: [feature, ...archive],
    });
    // A URL da feature deve aparecer só 1x no bloco #feature — nunca duplicada dentro de #archive.
    const archiveSection = overlapping.match(/<section class="archive" id="archive">[\s\S]*?<\/section>/)?.[0] ?? "";
    assert.ok(
      !archiveSection.includes(feature.url),
      "a feature apareceu duplicada dentro do bloco #archive",
    );
    assert.match(archiveSection, /edicao-anterior/);
  });

  it("data fora de faixa (mês inválido) degrada pra string vazia em vez de vazar 'undefined'", () => {
    const badDate = buildIndexHtml({
      feature,
      archive: [
        {
          slug: "data-invalida",
          title: "Edição com data ruim",
          description: "ok",
          url: "https://diar.ia.br/p/data-invalida",
          date: "2026-13-40",
          image: null,
        },
      ],
    });
    assert.ok(!badDate.includes("undefined"), "mês/dia fora de faixa vazou 'undefined' pro HTML");
  });
});

describe("workers/site/public/index.html — committed (#6375)", () => {
  const indexPath = resolve(PUBLIC_DIR, "index.html");
  const html = readFileSync(indexPath, "utf8");

  it("index.html existe", () => {
    assert.ok(existsSync(indexPath));
  });

  it("mantém <title>diar.ia.br</title> e a tagline oficial (guard de regressão do #6359)", () => {
    assert.match(html, /<title>diar\.ia\.br<\/title>/);
    assert.match(
      html,
      /<meta name="description" content="5 minutos diários pra se manter atualizado e usar melhor as IAs\.">/,
    );
  });

  it("contém os 7 blocos da Direção A (V1Landing)", () => {
    for (const id of ["nav", "masthead", "feature", "specials", "archive", "faqs", "footer"]) {
      assert.match(html, new RegExp(`id="${id}"`), `bloco #${id} ausente`);
    }
  });

  it("masthead E footer são <form> reais (não mais <a> disfarçado, #6976)", () => {
    assert.match(html, /<form class="signup"[^>]*id="masthead-form"[^>]*action="https:\/\/eia\.diar\.ia\.br\/jogar\/subscribe"/);
    assert.match(html, /<form class="signup signup--dark"[^>]*id="footer-form"[^>]*action="https:\/\/eia\.diar\.ia\.br\/jogar\/subscribe"/);
  });

  it("V1Specials linka pros hubs reais já existentes (livros/cursos)", () => {
    assert.match(html, /href="https:\/\/livros\.diar\.ia\.br\/"/);
    assert.match(html, /href="https:\/\/cursos\.diar\.ia\.br\/"/);
  });

  it("o destaque do dia aponta pra um /p/{slug} que de fato existe no acervo committed", () => {
    const featureLinkMatch = html.match(
      /<section class="feature" id="feature">[\s\S]*?<a class="feature-title-link" href="(https:\/\/diar\.ia\.br\/p\/[^"]+)"/,
    );
    assert.ok(featureLinkMatch, "nenhum link de destaque do dia encontrado em #feature");
    const slug = featureLinkMatch![1].replace("https://diar.ia.br/p/", "");
    const pageDir = resolve(PUBLIC_DIR, "p", slug);
    assert.ok(existsSync(pageDir), `slug do destaque "${slug}" não tem página gerada em public/p/`);
  });

  it("edições anteriores listadas realmente existem em public/p/", () => {
    const archiveMatches = [...html.matchAll(/class="archive-title"><a href="(https:\/\/diar\.ia\.br\/p\/[^"]+)"/g)];
    assert.ok(archiveMatches.length > 0, "nenhuma edição anterior listada em #archive");
    for (const m of archiveMatches) {
      const slug = m[1].replace("https://diar.ia.br/p/", "");
      assert.ok(existsSync(resolve(PUBLIC_DIR, "p", slug)), `slug "${slug}" do arquivo não existe em public/p/`);
    }
  });
});

describe("#6454 addSitemapEntry — atualiza sitemap sem regenerar o inteiro", () => {
  it("adiciona uma nova entrada ao sitemap existente", () => {
    const existing = buildSitemapXml([{ loc: "https://diar.ia.br/p/edicao-antiga", lastmod: "2026-08-26" }]);
    const result = addSitemapEntry(existing, { loc: "https://diar.ia.br/p/edicao-nova", lastmod: "2026-08-27" });
    assert.ok(result.includes("edicao-nova"));
    assert.ok(result.includes("edicao-antiga"));
    assert.ok(result.includes("2026-08-27"));
  });

  it("idempotente: não duplica entrada já present", () => {
    const existing = buildSitemapXml([{ loc: "https://diar.ia.br/p/ja-existe", lastmod: "2026-08-26" }]);
    const result = addSitemapEntry(existing, { loc: "https://diar.ia.br/p/ja-existe", lastmod: "2026-08-27" });
    const count = (result.match(/ja-existe/g) || []).length;
    assert.equal(count, 1, "URL deve aparecer apenas uma vez");
  });

  it("entry sem lastmod: adiciona sem linha de lastmod", () => {
    const existing = buildSitemapXml([{ loc: "https://diar.ia.br/p/x", lastmod: "2026-01-01" }]);
    const result = addSitemapEntry(existing, { loc: "https://diar.ia.br/p/sem-data" });
    assert.ok(result.includes("sem-data"));
    assert.ok(!result.match(/sem-data[\s\S]*?<lastmod/), "não deve ter lastmod pra entry sem data");
  });

  it("mantém o XML well-formed (abre e fecha urlset)", () => {
    const existing = buildSitemapXml([{ loc: "https://diar.ia.br/p/a", lastmod: "2026-01-01" }]);
    const result = addSitemapEntry(existing, { loc: "https://diar.ia.br/p/b", lastmod: "2026-01-02" });
    assert.ok(result.startsWith('<?xml'));
    assert.ok(result.endsWith('</urlset>\n'));
  });

  it("sitemapEntryFromPost monta a entrada corretamente", () => {
    const post = {
      slug: "meu-slug",
      title: "Título",
      status: "confirmed",
      publish_date: Math.floor(Date.parse("2026-08-27T09:00:00Z") / 1000),
      content: { free: { web: "<html></html>" } },
    };
    const entry = sitemapEntryFromPost(post as any);
    assert.equal(entry.loc, "https://diar.ia.br/p/meu-slug");
    assert.equal(entry.lastmod, "2026-08-27");
  });
});
