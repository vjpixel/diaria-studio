/**
 * test/site-archive-index-8353.test.ts (#8353 item 2)
 *
 * Índice paginado do acervo no apex (`/archive`, `/archive/{n}`) — a rota
 * que respondia 404 e deixava 40 das 270 edições sem nenhum referrer HTML.
 *
 * Cobre as 4 coisas que a issue pede explicitamente:
 *   1. paginação — primeira página, página do meio, última, página fora do range;
 *   2. ordenação por DATA EDITORIAL (incluindo o caso das edições importadas
 *      em bloco em 04/09/2025, que o `publish_date` cru dataria em setembro);
 *   3. a rota não é mais 404 — os arquivos existem em `workers/site/public/`
 *      e cada edição do sitemap aparece em exatamente uma página do índice;
 *   4. o Worker não confunde `/archive/{n}` com `/p/{slug}` (nada de 302
 *      pro Kit numa página de índice inexistente — 404 mesmo).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ARCHIVE_INDEX_PAGE_SIZE,
  archiveIndexFilePath,
  archiveIndexPageCount,
  archiveIndexPageEntries,
  archiveIndexPath,
  archiveIndexUrl,
  buildArchiveIndexFeed,
  buildArchiveIndexHtml,
  monthLabel,
} from "../scripts/lib/site-archive-index.ts";
import type { HomeFeedEntry } from "../scripts/lib/site-home-page.ts";
import { matchArchiveSlug } from "../workers/site/src/index.ts";
import { parseSitemap } from "../scripts/lib/fetch-sitemap.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC_DIR = resolve(ROOT, "workers", "site", "public");

function entry(slug: string, date: string | null, title = slug): HomeFeedEntry {
  return {
    slug,
    title,
    description: `dek de ${slug}`,
    url: `https://diar.ia.br/p/${slug}`,
    date,
    image: null,
  };
}

describe("paginação (#8353 item 2)", () => {
  const entries = Array.from({ length: 65 }, (_, i) => entry(`e${i}`, `2026-01-01`));

  it("conta páginas com a última parcial", () => {
    assert.equal(archiveIndexPageCount(65, 30), 3);
    assert.equal(archiveIndexPageCount(60, 30), 2);
    assert.equal(archiveIndexPageCount(1, 30), 1);
  });

  it("acervo vazio ainda rende 1 página (nunca 0)", () => {
    assert.equal(archiveIndexPageCount(0, 30), 1);
  });

  it("primeira página traz as N primeiras", () => {
    const page1 = archiveIndexPageEntries(entries, 1, 30);
    assert.equal(page1.length, 30);
    assert.equal(page1[0].slug, "e0");
    assert.equal(page1[29].slug, "e29");
  });

  it("página do meio não repete nem pula entrada", () => {
    const page2 = archiveIndexPageEntries(entries, 2, 30);
    assert.equal(page2.length, 30);
    assert.equal(page2[0].slug, "e30");
    assert.equal(page2[29].slug, "e59");
  });

  it("última página é parcial e fecha o acervo", () => {
    const page3 = archiveIndexPageEntries(entries, 3, 30);
    assert.equal(page3.length, 5);
    assert.equal(page3[4].slug, "e64");
  });

  it("toda entrada aparece em exatamente 1 página", () => {
    const seen = new Set<string>();
    for (let p = 1; p <= archiveIndexPageCount(entries.length, 30); p++) {
      for (const e of archiveIndexPageEntries(entries, p, 30)) {
        assert.ok(!seen.has(e.slug), `${e.slug} apareceu em mais de uma página`);
        seen.add(e.slug);
      }
    }
    assert.equal(seen.size, entries.length);
  });

  it("página fora do range devolve lista vazia (nunca repete a última)", () => {
    assert.deepEqual(archiveIndexPageEntries(entries, 4, 30), []);
    assert.deepEqual(archiveIndexPageEntries(entries, 99, 30), []);
    assert.deepEqual(archiveIndexPageEntries(entries, 0, 30), []);
    assert.deepEqual(archiveIndexPageEntries(entries, -1, 30), []);
  });

  it("buildArchiveIndexHtml recusa página fora do range em vez de emitir página vazia", () => {
    assert.throws(
      () => buildArchiveIndexHtml({ entries: [], page: 4, totalPages: 3, totalEditions: 65 }),
      /fora do range/,
    );
  });

  it("path/URL da página 1 não leva sufixo numérico", () => {
    assert.equal(archiveIndexPath(1), "/archive");
    assert.equal(archiveIndexPath(2), "/archive/2");
    assert.equal(archiveIndexUrl(1), "https://diar.ia.br/archive");
    assert.equal(archiveIndexFilePath(1), "archive/index.html");
    assert.equal(archiveIndexFilePath(3), "archive/3/index.html");
  });

  it("paginação linka TODAS as páginas (acervo a 2 cliques da raiz, não a N)", () => {
    const html = buildArchiveIndexHtml({
      entries: archiveIndexPageEntries(entries, 2, 30),
      page: 2,
      totalPages: 3,
      totalEditions: 65,
    });
    assert.match(html, /href="\/archive"/);
    assert.match(html, /href="\/archive\/3"/);
    assert.match(html, /rel="prev" href="\/archive"/);
    assert.match(html, /rel="next" href="\/archive\/3"/);
    // A página corrente é <span aria-current>, nunca link pra ela mesma.
    assert.match(html, /<span class="page-num page-num--current" aria-current="page">2<\/span>/);
    assert.equal(/href="\/archive\/2"/.test(html), false);
  });

  it("canonical/rel prev-next por página", () => {
    const first = buildArchiveIndexHtml({ entries: [entry("a", "2026-01-01")], page: 1, totalPages: 3, totalEditions: 65 });
    assert.match(first, /<link rel="canonical" href="https:\/\/diar\.ia\.br\/archive">/);
    assert.match(first, /<link rel="next" href="https:\/\/diar\.ia\.br\/archive\/2">/);
    assert.equal(/<link rel="prev"/.test(first), false);

    const last = buildArchiveIndexHtml({ entries: [entry("z", "2025-08-27")], page: 3, totalPages: 3, totalEditions: 65 });
    assert.match(last, /<link rel="canonical" href="https:\/\/diar\.ia\.br\/archive\/3">/);
    assert.match(last, /<link rel="prev" href="https:\/\/diar\.ia\.br\/archive\/2">/);
    assert.equal(/<link rel="next"/.test(last), false);
  });

  it("description não é a mesma string nas páginas (duplicate meta description)", () => {
    const d = (page: number) =>
      buildArchiveIndexHtml({ entries: [entry("a", "2026-01-01")], page, totalPages: 3, totalEditions: 65 }).match(
        /<meta name="description" content="([^"]*)"/,
      )?.[1];
    assert.notEqual(d(1), d(2));
    assert.notEqual(d(2), d(3));
  });
});

describe("ordenação por data editorial (#8353 item 2)", () => {
  /**
   * As 6 edições importadas em bloco pra Beehiiv em 04/09/2025 carregam a
   * data da IMPORTAÇÃO em `publish_date` — datar por ele joga agosto/2025
   * inteiro em setembro. O índice nunca lê `publish_date`: consome o feed
   * de `buildHomeFeed`, que resolve `<lastmod>` do sitemap (gravado por
   * `publishDateToIso`, que já honra `beehiiv-publish-date-overrides.json`)
   * ou, na falta dele, `article:published_time` da própria página.
   *
   * O sitemap desta fixture está em ordem de DOCUMENTO errada de propósito
   * (a edição de agosto no topo, como um append ingênuo produziria) — o
   * índice tem que reordenar por data, não confiar na posição.
   */
  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://diar.ia.br/p/importada-agosto</loc><lastmod>2025-08-27</lastmod></url>
  <url><loc>https://diar.ia.br/p/setembro-real</loc><lastmod>2025-09-08</lastmod></url>
  <url><loc>https://diar.ia.br/p/sem-lastmod</loc></url>
</urlset>`;

  const page = (title: string, iso?: string) =>
    `<html lang="pt-BR"><head><title>${title}</title><meta name="dek" content="dek ${title}">` +
    (iso ? `<meta property="article:published_time" content="${iso}">` : "") +
    `</head><body></body></html>`;

  const pages: Record<string, string> = {
    // A importada: `publish_date` cru diria 2025-09-04 (dia do import); o
    // que está gravado na PÁGINA (e no lastmod) é a data editorial real.
    "importada-agosto": page("Primeira edição", "2025-08-27"),
    "setembro-real": page("Edição de setembro", "2025-09-08"),
    "sem-lastmod": page("Sem lastmod no sitemap", "2025-09-12"),
  };

  it("ordena desc por data editorial, não pela posição no sitemap", () => {
    const feed = buildArchiveIndexFeed(sitemap, (slug) => pages[slug] ?? null, { todayBrt: "2026-09-19" });
    assert.deepEqual(
      feed.map((e) => e.slug),
      ["sem-lastmod", "setembro-real", "importada-agosto"],
    );
  });

  it("a edição importada fica em AGOSTO/2025, não empilhada em setembro", () => {
    const feed = buildArchiveIndexFeed(sitemap, (slug) => pages[slug] ?? null, { todayBrt: "2026-09-19" });
    const importada = feed.find((e) => e.slug === "importada-agosto");
    assert.equal(importada?.date, "2025-08-27");
    assert.equal(monthLabel(importada?.date ?? null), "agosto de 2025");
    const html = buildArchiveIndexHtml({ entries: feed, page: 1, totalPages: 1, totalEditions: feed.length });
    assert.match(html, /<h2 class="month">agosto de 2025<\/h2>/);
    assert.match(html, /<h2 class="month">setembro de 2025<\/h2>/);
    // Setembro (mais recente) vem ANTES de agosto no documento.
    assert.ok(html.indexOf("setembro de 2025") < html.indexOf("agosto de 2025"));
  });

  it("edição com data futura fica fora (mesmo corte da home, #7686)", () => {
    const feed = buildArchiveIndexFeed(sitemap, (slug) => pages[slug] ?? null, { todayBrt: "2025-09-01" });
    assert.deepEqual(
      feed.map((e) => e.slug),
      ["importada-agosto"],
    );
  });

  it("data malformada não vira 'undefined de NaN' no cabeçalho de mês", () => {
    assert.equal(monthLabel(null), null);
    assert.equal(monthLabel("2026-13-01"), null);
    assert.equal(monthLabel("lixo"), null);
    const html = buildArchiveIndexHtml({
      entries: [entry("sem-data", null)],
      page: 1,
      totalPages: 1,
      totalEditions: 1,
    });
    assert.equal(/undefined|NaN/.test(html), false);
    assert.match(html, /href="https:\/\/diar\.ia\.br\/p\/sem-data"/);
  });
});

describe("artefato commitado — /archive não é mais 404 (#8353 item 2)", () => {
  const sitemapXml = readFileSync(join(PUBLIC_DIR, "sitemap.xml"), "utf8");
  const locs = parseSitemap(sitemapXml).map((e) => e.loc);
  const editionLocs = locs.filter((loc) => /^https:\/\/diar\.ia\.br\/p\//.test(loc));
  const indexLocs = locs.filter((loc) => /^https:\/\/diar\.ia\.br\/archive(\/\d+)?$/.test(loc));

  it("public/archive/index.html existe (a rota que respondia 404)", () => {
    assert.ok(
      existsSync(join(PUBLIC_DIR, "archive", "index.html")),
      "workers/site/public/archive/index.html ausente — /archive voltaria a 404",
    );
  });

  it("todas as páginas do índice existem em disco", () => {
    const expected = archiveIndexPageCount(editionLocs.length, ARCHIVE_INDEX_PAGE_SIZE);
    for (let page = 1; page <= expected; page++) {
      assert.ok(
        existsSync(join(PUBLIC_DIR, archiveIndexFilePath(page))),
        `${archiveIndexFilePath(page)} ausente — ${archiveIndexPath(page)} daria 404`,
      );
    }
  });

  /**
   * A entrada de `/archive` (página 1) é a que o buscador precisa: dali a
   * paginação linka TODAS as outras. As entradas por página são um extra
   * que `gen-archive-index.ts` acrescenta quando roda com sitemap — o
   * `regen-home.yml` diário roda com `--no-sitemap` de propósito (ver o
   * comentário lá: evitar que a regeneração diária dispute o mesmo arquivo
   * com o PR da edição do Stage 6), então esta asserção NÃO exige contagem
   * exata; exige que nada no sitemap aponte pra um 404.
   */
  it("o sitemap tem /archive e nenhuma entrada de índice apontando pra 404", () => {
    assert.ok(indexLocs.includes(archiveIndexUrl(1)), "https://diar.ia.br/archive fora do sitemap");
    const broken = indexLocs.filter((loc) => {
      const n = loc === archiveIndexUrl(1) ? 1 : Number(loc.split("/").pop());
      return !existsSync(join(PUBLIC_DIR, archiveIndexFilePath(n)));
    });
    assert.deepEqual(broken, [], "entrada /archive* no sitemap sem arquivo correspondente");
  });

  it("cada edição do sitemap é linkada por exatamente 1 página do índice", () => {
    const linked = new Map<string, number>();
    const total = archiveIndexPageCount(editionLocs.length, ARCHIVE_INDEX_PAGE_SIZE);
    for (let page = 1; page <= total; page++) {
      const html = readFileSync(join(PUBLIC_DIR, archiveIndexFilePath(page)), "utf8");
      for (const loc of editionLocs) {
        if (html.includes(`href="${loc}"`)) linked.set(loc, (linked.get(loc) ?? 0) + 1);
      }
    }
    const missing = editionLocs.filter((loc) => !linked.has(loc));
    assert.deepEqual(missing, [], "edição sem link em nenhuma página do índice — continuaria órfã");
    const duplicated = [...linked.entries()].filter(([, n]) => n > 1).map(([loc]) => loc);
    assert.deepEqual(duplicated, [], "edição linkada em mais de uma página do índice");
  });

  it("página fora do range NÃO existe em disco e não é confundida com /p/{slug}", () => {
    const beyond = archiveIndexPageCount(editionLocs.length, ARCHIVE_INDEX_PAGE_SIZE) + 1;
    assert.equal(
      existsSync(join(PUBLIC_DIR, archiveIndexFilePath(beyond))),
      false,
      `${archiveIndexPath(beyond)} não deveria existir — o 404 do asset é a resposta certa`,
    );
    // O fallback #6429 só redireciona `/p/{slug}` pro Kit; uma página de
    // índice inexistente tem que morrer em 404, nunca virar 302 pra um
    // "post" que não existe lá.
    assert.equal(matchArchiveSlug("/archive"), null);
    assert.equal(matchArchiveSlug(`/archive/${beyond}`), null);
  });

  it("a home linka o índice (não só 6 das 270 edições)", () => {
    const home = readFileSync(join(PUBLIC_DIR, "index.html"), "utf8");
    assert.match(home, /href="\/archive"/);
  });
});
