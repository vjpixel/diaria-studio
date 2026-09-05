/**
 * test/site-home-feed-order-7436.test.ts (#7436)
 *
 * REGRESSÃO: `addSitemapEntry` (`scripts/lib/site-archive-pages.ts`) insere
 * a entrada nova sempre no FIM do XML (append), mas o sitemap é ordenado
 * newest-first — `buildHomeFeed` (`scripts/lib/site-home-page.ts`) cortava
 * em `limit` NA ORDEM DO DOCUMENTO, então a edição recém-publicada (a
 * última linha do XML) nunca aparecia nos primeiros `limit` cards da home,
 * mesmo sendo a mais recente de todas.
 *
 * Cobre o cenário real: sitemap já newest-first com 3 edições antigas +
 * `addSitemapEntry` grava a edição nova no fim (mesmo shape produzido pelo
 * caminho `--sitemap` de `publish-edition-site-page.ts`) → `buildHomeFeed`
 * com `limit=3` precisa incluir a edição nova entre os 3 primeiros.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildHomeFeed } from "../scripts/lib/site-home-page.ts";
import { buildSitemapXml, addSitemapEntry, sitemapEntryFromPost, type ArchivePost } from "../scripts/lib/site-archive-pages.ts";

function fakePageHtml(title: string): string {
  return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"><title>${title}</title><meta name="description" content="desc de ${title}"></head><body><p>corpo</p></body></html>`;
}

function fakePost(slug: string, publishDateEpochSec: number): ArchivePost {
  return {
    slug,
    title: `Título ${slug}`,
    subtitle: null,
    status: "confirmed",
    web_url: `https://diar.ia.br/p/${slug}`,
    publish_date: publishDateEpochSec,
    content: { free: { web: fakePageHtml(`Título ${slug}`) } },
  };
}

describe("#7436 buildHomeFeed — edição recém-inserida no fim do sitemap aparece nos primeiros N cards", () => {
  it("CENÁRIO REAL: addSitemapEntry no fim + buildHomeFeed(limit=3) inclui a entrada nova", () => {
    // 3 edições "antigas", já em ordem newest-first (como gen-archive-pages
    // grava de verdade).
    const antigas = [
      fakePost("edicao-260826", Date.parse("2026-08-26T09:00:00Z") / 1000),
      fakePost("edicao-260825", Date.parse("2026-08-25T09:00:00Z") / 1000),
      fakePost("edicao-260824", Date.parse("2026-08-24T09:00:00Z") / 1000),
    ];
    let sitemapXml = buildSitemapXml(antigas.map((p) => sitemapEntryFromPost(p)));

    // Edição NOVA, mais recente que todas as anteriores — inserida via
    // addSitemapEntry, que grava no FIM do XML (comportamento real, não
    // corrigido por este PR — #7436 corrige o consumo, não a inserção).
    const nova = fakePost("edicao-260905", Date.parse("2026-09-05T09:00:00Z") / 1000);
    sitemapXml = addSitemapEntry(sitemapXml, sitemapEntryFromPost(nova));

    const pages = new Map<string, string>([
      ["edicao-260826", fakePageHtml("Título edicao-260826")],
      ["edicao-260825", fakePageHtml("Título edicao-260825")],
      ["edicao-260824", fakePageHtml("Título edicao-260824")],
      ["edicao-260905", fakePageHtml("Título edicao-260905")],
    ]);

    const feed = buildHomeFeed(sitemapXml, (slug) => pages.get(slug) ?? null, 3);

    assert.equal(feed.length, 3);
    assert.ok(
      feed.some((entry) => entry.slug === "edicao-260905"),
      "a edição mais recente (inserida no fim do XML) precisa aparecer entre os 3 primeiros cards",
    );
    // E precisa vir PRIMEIRO — é a mais recente de todas.
    assert.equal(feed[0].slug, "edicao-260905");
    assert.deepEqual(
      feed.map((e) => e.slug),
      ["edicao-260905", "edicao-260826", "edicao-260825"],
    );
  });

  it("entrada sem lastmod (ex: publicação Kit, #7437) ordena por último, não quebra a comparação", () => {
    const comData = fakePost("com-data", Date.parse("2026-08-20T09:00:00Z") / 1000);
    let sitemapXml = buildSitemapXml([sitemapEntryFromPost(comData)]);
    // Entrada sem publish_date (publishDateToIso retorna undefined ⇒ sem <lastmod>).
    const semData: ArchivePost = { ...fakePost("sem-data", 0), publish_date: null };
    sitemapXml = addSitemapEntry(sitemapXml, sitemapEntryFromPost(semData));

    const pages = new Map<string, string>([
      ["com-data", fakePageHtml("Título com-data")],
      ["sem-data", fakePageHtml("Título sem-data")],
    ]);
    const feed = buildHomeFeed(sitemapXml, (slug) => pages.get(slug) ?? null, 10);

    assert.equal(feed.length, 2);
    assert.equal(feed[0].slug, "com-data", "entrada COM lastmod vem antes da que não tem");
    assert.equal(feed[1].slug, "sem-data");
  });
});
