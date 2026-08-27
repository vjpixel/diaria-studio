/**
 * test/site-home-page-6375.test.ts (#6375)
 *
 * Cobre o redesign da home (`workers/site/public/index.html`, Direção A ·
 * Edição diária) — miolo puro (`scripts/lib/site-home-page.ts`) com fixtures
 * em memória, e o arquivo COMMITTED (7 blocos esperados, form → /subscribe,
 * link do destaque do dia → um `/p/{slug}` real do cache).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildHomeFeed,
  buildIndexHtml,
  extractPageMeta,
  slugFromCanonicalUrl,
} from "../scripts/lib/site-home-page.ts";
import { buildSitemapXml } from "../scripts/lib/site-archive-pages.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC_DIR = resolve(ROOT, "workers", "site", "public");

function fakePageHtml(title: string, description: string): string {
  return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"><title>${title}</title><meta name="description" content="${description}"></head><body></body></html>`;
}

describe("slugFromCanonicalUrl", () => {
  it("extrai o slug de uma URL /p/{slug}", () => {
    assert.equal(slugFromCanonicalUrl("https://diar.ia.br/p/exemplo-de-slug"), "exemplo-de-slug");
  });

  it("devolve null pra URL fora do shape /p/{slug}", () => {
    assert.equal(slugFromCanonicalUrl("https://diar.ia.br/"), null);
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

describe("buildHomeFeed", () => {
  const sitemapXml = buildSitemapXml([
    { loc: "https://diar.ia.br/p/edicao-mais-recente", lastmod: "2026-08-26" },
    { loc: "https://diar.ia.br/p/edicao-anterior", lastmod: "2026-08-25" },
    { loc: "https://diar.ia.br/p/sem-pagina-gerada", lastmod: "2026-08-24" },
  ]);

  const pages: Record<string, string> = {
    "edicao-mais-recente": fakePageHtml("Edição mais recente", "Resumo da mais recente"),
    "edicao-anterior": fakePageHtml("Edição anterior", "Resumo da anterior"),
  };

  it("preserva a ordem do sitemap (mais recente primeiro)", () => {
    const feed = buildHomeFeed(sitemapXml, (slug) => pages[slug] ?? null);
    assert.equal(feed.length, 2);
    assert.equal(feed[0].slug, "edicao-mais-recente");
    assert.equal(feed[1].slug, "edicao-anterior");
  });

  it("pula slug sem página gerada em vez de quebrar o lote", () => {
    const feed = buildHomeFeed(sitemapXml, (slug) => pages[slug] ?? null);
    assert.ok(!feed.some((e) => e.slug === "sem-pagina-gerada"));
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
  };
  const archive = [
    {
      slug: "edicao-anterior",
      title: "Edição anterior",
      description: "Resumo anterior",
      url: "https://diar.ia.br/p/edicao-anterior",
      date: "2026-08-26",
    },
  ];
  const html = buildIndexHtml({ feature, archive });

  it("contém os 7 blocos esperados (Nav, Masthead, Feature, Specials, Archive, Faqs, Footer)", () => {
    for (const id of ["nav", "masthead", "feature", "specials", "archive", "faqs", "footer"]) {
      assert.match(html, new RegExp(`id="${id}"`), `bloco #${id} ausente`);
    }
  });

  it("form do masthead E do footer apontam pro /subscribe existente", () => {
    assert.match(html, /id="masthead-form"[^>]*href="\/subscribe"/);
    assert.match(html, /id="footer-form"[^>]*href="\/subscribe"/);
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

  it("form aponta pro /subscribe existente (masthead + footer)", () => {
    assert.match(html, /id="masthead-form"[^>]*href="\/subscribe"/);
    assert.match(html, /id="footer-form"[^>]*href="\/subscribe"/);
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
