/**
 * test/gen-archive-pages.test.ts (#467, regressão #633)
 *
 * Cobre o miolo puro (scripts/lib/site-archive-pages.ts) e o gerador
 * (scripts/gen-archive-pages.ts) com fixtures sintéticas — sem depender do
 * cache real de data/beehiiv-cache/posts/ (gitignored, indisponível em CI).
 *
 * Casos cobertos, ambos linkados no #467 como achados que este trabalho
 * resolve "de graça":
 *   - lang="pt-BR" injetado mesmo quando o HTML de origem não tem `lang`
 *     nenhum (#5101 item 1 — a versão SERVIDA pela Beehiiv injeta `en`,
 *     mas content.free.web cru não tem atributo algum).
 *   - meta description cai pra subtitle/preview_text quando
 *     meta_default_description vem null (#5101 item 2).
 *   - draft/slug placeholder ("new-post") nunca gera página.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ArchivePost,
  isPublishedPost,
  selectPublishedPosts,
  derivePageTitle,
  deriveMetaDescription,
  archiveUrlForSlug,
  buildArchivePageHtml,
  buildSitemapXml,
  sitemapEntriesForPosts,
} from "../scripts/lib/site-archive-pages.ts";
import { generateArchivePages, loadPosts } from "../scripts/gen-archive-pages.ts";

function makePost(overrides: Partial<ArchivePost> = {}): ArchivePost {
  return {
    slug: "exemplo-de-edicao",
    title: "Exemplo de edição",
    subtitle: "Subtítulo da edição",
    preview_text: "Preview text da edição",
    meta_default_title: null,
    meta_default_description: null,
    status: "confirmed",
    web_url: "https://diar.ia.br/p/exemplo-de-edicao",
    publish_date: 1755993600, // 2025-08-24T00:00:00Z
    content: {
      free: {
        web: "<!DOCTYPE html><html><head><style>body{color:#000}</style></head><body><h1>Exemplo</h1></body></html>",
      },
    },
    ...overrides,
  };
}

describe("isPublishedPost / selectPublishedPosts", () => {
  it("aceita status confirmed com slug real", () => {
    assert.equal(isPublishedPost(makePost()), true);
  });

  it("rejeita draft", () => {
    assert.equal(isPublishedPost(makePost({ status: "draft" })), false);
  });

  it("rejeita o slug placeholder 'new-post' mesmo se confirmed", () => {
    assert.equal(isPublishedPost(makePost({ slug: "new-post" })), false);
  });

  it("ordena por publish_date desc", () => {
    const older = makePost({ slug: "mais-velho", publish_date: 1000 });
    const newer = makePost({ slug: "mais-novo", publish_date: 2000 });
    const draft = makePost({ slug: "rascunho", status: "draft" });
    const selected = selectPublishedPosts([older, draft, newer]);
    assert.deepEqual(
      selected.map((p) => p.slug),
      ["mais-novo", "mais-velho"],
    );
  });
});

describe("derivePageTitle / deriveMetaDescription (#5101 item 2)", () => {
  it("usa meta_default_title quando presente", () => {
    assert.equal(derivePageTitle(makePost({ meta_default_title: "Título SEO" })), "Título SEO");
  });

  it("cai pro title do post quando meta_default_title é null", () => {
    assert.equal(derivePageTitle(makePost()), "Exemplo de edição");
  });

  it("usa meta_default_description quando presente", () => {
    assert.equal(
      deriveMetaDescription(makePost({ meta_default_description: "Description SEO" })),
      "Description SEO",
    );
  });

  it("cai pra subtitle quando meta_default_description é null", () => {
    assert.equal(deriveMetaDescription(makePost()), "Subtítulo da edição");
  });

  it("cai pra preview_text quando subtitle e meta_default_description faltam", () => {
    assert.equal(
      deriveMetaDescription(makePost({ subtitle: null })),
      "Preview text da edição",
    );
  });

  it("nunca fica vazio — cai pro título e depois pro fallback genérico", () => {
    const desc = deriveMetaDescription(
      makePost({ subtitle: null, preview_text: null, title: "" }),
    );
    assert.ok(desc.length > 0);
  });
});

describe("buildArchivePageHtml", () => {
  it("injeta lang=\"pt-BR\" quando o HTML de origem não tem lang nenhum", () => {
    const html = buildArchivePageHtml(makePost());
    assert.match(html, /<html lang="pt-BR">/);
  });

  it("substitui lang existente por pt-BR em vez de duplicar o atributo", () => {
    const post = makePost({
      content: {
        free: {
          web: '<!DOCTYPE html><html lang="en"><head></head><body>x</body></html>',
        },
      },
    });
    const html = buildArchivePageHtml(post);
    assert.match(html, /<html lang="pt-BR">/);
    assert.equal((html.match(/lang=/g) ?? []).length, 1);
  });

  it("injeta title, meta description e canonical no <head>", () => {
    const html = buildArchivePageHtml(makePost());
    assert.match(html, /<title>Exemplo de edição<\/title>/);
    assert.match(html, /<meta name="description" content="Subtítulo da edição">/);
    assert.match(html, /<link rel="canonical" href="https:\/\/diar\.ia\.br\/p\/exemplo-de-edicao">/);
  });

  it("escapa HTML na description pra não quebrar o atributo (aspas/&)", () => {
    const post = makePost({ subtitle: 'Preço "especial" & imposto' });
    const html = buildArchivePageHtml(post);
    assert.match(html, /content="Preço &quot;especial&quot; &amp; imposto"/);
  });

  it("escapa HTML no título — dado externo (API Beehiiv), sem isso vira XSS refletido em <title>", () => {
    const post = makePost({ meta_default_title: 'Preço "especial" & <script>alert(1)</script>' });
    const html = buildArchivePageHtml(post);
    assert.match(
      html,
      /<title>Preço &quot;especial&quot; &amp; &lt;script&gt;alert\(1\)&lt;\/script&gt;<\/title>/,
    );
    assert.doesNotMatch(html, /<title>[^<]*<script>/);
  });

  it("lança se o post não é publicado (status !== confirmed)", () => {
    const post = makePost({ status: "draft" });
    assert.throws(() => buildArchivePageHtml(post));
  });

  it("lança nomeando o slug se o HTML de origem não tem tag <html>", () => {
    const post = makePost({
      content: { free: { web: "<body><h1>sem html/head nenhum</h1></body>" } },
    });
    assert.throws(() => buildArchivePageHtml(post), /exemplo-de-edicao/);
  });

  it("preserva o resto do documento sem tocar (body intacto)", () => {
    const html = buildArchivePageHtml(makePost());
    assert.match(html, /<h1>Exemplo<\/h1>/);
  });

  it("lança se o post não tem content.free.web", () => {
    const post = makePost({ content: { free: { web: null } } });
    assert.throws(() => buildArchivePageHtml(post));
  });
});

describe("archiveUrlForSlug", () => {
  it("monta a URL /p/{slug} no apex", () => {
    assert.equal(archiveUrlForSlug("minha-edicao"), "https://diar.ia.br/p/minha-edicao");
  });
});

describe("buildSitemapXml / sitemapEntriesForPosts", () => {
  it("gera 1 <url> por post publicado, com lastmod derivado de publish_date", () => {
    const posts = [makePost({ slug: "a", publish_date: 1755993600 }), makePost({ slug: "b", status: "draft" })];
    const entries = sitemapEntriesForPosts(posts);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].loc, "https://diar.ia.br/p/a");
    assert.equal(entries[0].lastmod, "2025-08-24");

    const xml = buildSitemapXml(entries);
    assert.match(xml, /<loc>https:\/\/diar\.ia\.br\/p\/a<\/loc>/);
    assert.match(xml, /<lastmod>2025-08-24<\/lastmod>/);
    assert.doesNotMatch(xml, /\/p\/b</);
  });

  it("aceita publish_date em epoch MILISSEGUNDOS (branch > 1e12), não só segundos", () => {
    const posts = [makePost({ slug: "c", publish_date: 1755993600000 })]; // mesma data, em ms
    const entries = sitemapEntriesForPosts(posts);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].lastmod, "2025-08-24");
  });
});

describe("generateArchivePages (integração, tmpdir)", () => {
  it("escreve 1 index.html por post publicado + sitemap.xml, pulando drafts e posts sem HTML", () => {
    const tmp = mkdtempSync(join(tmpdir(), "archive-pages-test-"));
    try {
      const outDir = join(tmp, "p");
      const sitemapPath = join(tmp, "sitemap.xml");
      const posts = [
        makePost({ slug: "edicao-1" }),
        makePost({ slug: "edicao-2", publish_date: 999 }),
        makePost({ slug: "rascunho", status: "draft" }),
        makePost({ slug: "sem-html", content: { free: { web: null } } }),
      ];

      const result = generateArchivePages(posts, outDir, sitemapPath);

      assert.equal(result.written, 2);
      assert.equal(result.skipped.length, 1);
      assert.equal(result.skipped[0].slug, "sem-html");
      assert.equal(result.skipped[0].reason, "sem content.free.web");

      const dirs = readdirSync(outDir).sort();
      assert.deepEqual(dirs, ["edicao-1", "edicao-2"]);

      const html1 = readFileSync(join(outDir, "edicao-1", "index.html"), "utf8");
      assert.match(html1, /<html lang="pt-BR">/);

      const sitemap = readFileSync(sitemapPath, "utf8");
      assert.match(sitemap, /\/p\/edicao-1</);
      assert.match(sitemap, /\/p\/edicao-2</);
      assert.doesNotMatch(sitemap, /\/p\/rascunho</);
      assert.doesNotMatch(sitemap, /\/p\/sem-html</);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("é idempotente — rerodar remove órfãos de um slug que saiu do cache", () => {
    const tmp = mkdtempSync(join(tmpdir(), "archive-pages-test-"));
    try {
      const outDir = join(tmp, "p");
      const sitemapPath = join(tmp, "sitemap.xml");

      generateArchivePages([makePost({ slug: "vai-sumir" }), makePost({ slug: "fica" })], outDir, sitemapPath);
      assert.deepEqual(readdirSync(outDir).sort(), ["fica", "vai-sumir"]);

      generateArchivePages([makePost({ slug: "fica" })], outDir, sitemapPath);
      assert.deepEqual(readdirSync(outDir).sort(), ["fica"]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("slug duplicado: pula o 2º post em vez de sobrescrever o 1º silenciosamente", () => {
    const tmp = mkdtempSync(join(tmpdir(), "archive-pages-test-"));
    try {
      const outDir = join(tmp, "p");
      const sitemapPath = join(tmp, "sitemap.xml");
      const first = makePost({
        slug: "duplicado",
        publish_date: 2000,
        content: { free: { web: "<html><head></head><body><h1>primeiro</h1></body></html>" } },
      });
      const second = makePost({
        slug: "duplicado",
        publish_date: 1000,
        content: { free: { web: "<html><head></head><body><h1>segundo</h1></body></html>" } },
      });

      const result = generateArchivePages([first, second], outDir, sitemapPath);

      // written conta só 1 — a contagem reflete o que de fato existe em disco.
      assert.equal(result.written, 1);
      assert.equal(result.skipped.length, 1);
      assert.equal(result.skipped[0].slug, "duplicado");
      assert.match(result.skipped[0].reason, /slug duplicado/);

      const html = readFileSync(join(outDir, "duplicado", "index.html"), "utf8");
      assert.match(html, /primeiro/); // o 1º processado (mais recente) venceu, nunca sobrescrito

      const sitemap = readFileSync(sitemapPath, "utf8");
      // 1 <loc> só — nunca 2 <url> pro mesmo slug.
      assert.equal((sitemap.match(/<loc>/g) ?? []).length, 1);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("loadPosts (integração, tmpdir)", () => {
  it("carrega só arquivos post_*.json, ignorando outros arquivos no mesmo diretório", () => {
    const tmp = mkdtempSync(join(tmpdir(), "archive-pages-loadposts-"));
    try {
      writeFileSync(join(tmp, "post_1.json"), JSON.stringify(makePost({ slug: "a" })), "utf8");
      writeFileSync(join(tmp, "post_2.json"), JSON.stringify(makePost({ slug: "b" })), "utf8");
      writeFileSync(join(tmp, "README.md"), "não é um post", "utf8");
      writeFileSync(join(tmp, ".gitkeep"), "", "utf8");

      const posts = loadPosts(tmp);

      assert.equal(posts.length, 2);
      assert.deepEqual(
        posts.map((p) => p.slug).sort(),
        ["a", "b"],
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("post_*.json corrompido → erro nomeia o arquivo (achado do fleet review, #467)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "archive-pages-loadposts-corrupt-"));
    try {
      writeFileSync(join(tmp, "post_good.json"), JSON.stringify(makePost({ slug: "a" })), "utf8");
      writeFileSync(join(tmp, "post_bad.json"), "{ isto não é json válido", "utf8");

      assert.throws(() => loadPosts(tmp), /post_bad\.json tem JSON inválido/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
