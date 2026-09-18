/**
 * test/site-home-hero-permutation-8360.test.ts (#8360)
 *
 * REGRESSÃO: a home elege o hero por DATA EDITORIAL — nunca pela posição da
 * entrada no documento do sitemap. `reconcile-site-sitemap.ts`,
 * `addSitemapEntry`, merges e edições manuais reordenam o XML; o diff parece
 * "só reordenação", mas antes do #8360 havia dois vazamentos de posição em
 * `buildHomeFeed`:
 *
 *   1. **Empate de `<lastmod>`** caía no stable sort do `Array.prototype.sort`,
 *      que mantém a ordem do documento — reordenar o XML mudava o hero.
 *   2. **Entrada sem `<lastmod>`** (publicação Kit, #7437) ordenava como a
 *      mais antiga possível (`-Infinity`). O #8358 mostrou o custo:
 *      `reconcile-site-sitemap.ts` religou 11 entradas Kit sem data e a home
 *      ficou presa numa edição de 03/09 enquanto a de 18/09 já estava no
 *      sitemap — a posição era o ÚNICO sinal que restava pra essas entradas.
 *
 * O contrato depois do #8360: data editorial = `<lastmod>` ?? data da
 * PRÓPRIA PÁGINA (`article:published_time`/JSON-LD `datePublished`, via
 * `extractPageDate`); empate de data quebra por `<loc>`; sem NENHUMA data
 * (nem no sitemap nem na página), `<loc>` decide — ordem TOTAL. Qualquer
 * permutação do sitemap produz exatamente o mesmo feed.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildHomeFeed, extractPageDate } from "../scripts/lib/site-home-page.ts";

interface TestEntry {
  slug: string;
  lastmod?: string;
  /** `article:published_time` embutido na página — presente nas páginas
   *  Beehiiv (#8352), ausente nas Kit (cenário #8358/#7437). */
  pageDate?: string;
}

function pageHtml(title: string, pageDate?: string): string {
  const meta = pageDate ? `<meta property="article:published_time" content="${pageDate}">` : "";
  return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8">${meta}<title>${title}</title><meta name="description" content="desc de ${title}"></head><body><p>corpo</p></body></html>`;
}

function sitemapXml(entries: TestEntry[]): string {
  const items = entries
    .map((e) =>
      e.lastmod
        ? `  <url><loc>https://diar.ia.br/p/${e.slug}</loc><lastmod>${e.lastmod}</lastmod></url>`
        : `  <url><loc>https://diar.ia.br/p/${e.slug}</loc></url>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${items}\n</urlset>`;
}

function readerFor(entries: TestEntry[]): (slug: string) => string | null {
  const pages = new Map(entries.map((e) => [e.slug, pageHtml(`Título ${e.slug}`, e.pageDate)]));
  return (slug) => pages.get(slug) ?? null;
}

function feedSlugs(xml: string, read: (slug: string) => string | null, todayBrt = "2026-09-18") {
  return buildHomeFeed(xml, read, 10, { todayBrt }).map((e) => e.slug);
}

describe("#8360 buildHomeFeed — o hero não depende da ordem do sitemap", () => {
  it("empate de data no topo: reordenar o sitemap não muda o hero", () => {
    const entries: TestEntry[] = [
      { slug: "b-mesmo-dia", lastmod: "2026-09-18" },
      { slug: "a-mesmo-dia", lastmod: "2026-09-18" },
      { slug: "velha", lastmod: "2026-09-01" },
    ];
    const read = readerFor(entries);
    // Duas ordens de documento possíveis para o mesmo sitemap (a real de hoje
    // e a de um sitemap reordenado pelo reconciler/merge).
    const feed1 = feedSlugs(sitemapXml(entries), read);
    const feed2 = feedSlugs(sitemapXml([...entries].reverse()), read);

    assert.deepEqual(feed1, feed2, "reordenar o sitemap não pode mudar o feed");
    assert.equal(feed1[0], "a-mesmo-dia", "empate de data quebra por <loc> (a < b), sempre");
  });

  it("entrada sem lastmod mas com data na página compete pelo hero (cenário #8358/#7437)", () => {
    // Shape real do incidente: a edição nova entra no sitemap SEM <lastmod>
    // (publicação Kit) enquanto as antigas têm data. A PÁGINA nova carrega a
    // data editorial (era Beehiiv) — ela tem de vencer, não a de 03/09.
    const entries: TestEntry[] = [
      { slug: "edicao-0309", lastmod: "2026-09-03" },
      { slug: "edicao-1809-kit", pageDate: "2026-09-18" },
    ];
    const read = readerFor(entries);
    for (const ordem of [entries, [...entries].reverse()]) {
      const feed = buildHomeFeed(sitemapXml(ordem), read, 10, { todayBrt: "2026-09-18" });
      assert.equal(
        feed[0]?.slug,
        "edicao-1809-kit",
        `hero tem de ser a edição de 18/09 (ordem do documento: ${ordem.map((e) => e.slug).join(",")})`,
      );
      assert.equal(feed[0]?.date, "2026-09-18", "a data do card vem da página quando o lastmod falta");
    }
  });

  it("permutações quaisquer do sitemap produzem exatamente o mesmo feed", () => {
    const entries: TestEntry[] = [
      { slug: "nova", lastmod: "2026-09-17" },
      { slug: "kit-sem-data", pageDate: "2026-09-18" },
      { slug: "antiga-a", lastmod: "2026-09-01" },
      { slug: "antiga-b", lastmod: "2026-09-01" },
      { slug: "orfa-total" },
    ];
    const read = readerFor(entries);
    const permutacoes = [
      entries,
      [...entries].reverse(),
      [entries[2], entries[0], entries[4], entries[1], entries[3]],
      [entries[4], entries[3], entries[2], entries[1], entries[0]],
    ].map((o) => sitemapXml(o));
    const feeds = permutacoes.map((xml) => buildHomeFeed(xml, read, 10, { todayBrt: "2026-09-18" }));

    assert.deepEqual(
      feeds[0],
      feeds[1],
      "reverso ≠ original",
    );
    assert.deepEqual(feeds[0], feeds[2], "permutação arbitrária ≠ original");
    assert.deepEqual(feeds[0], feeds[3], "reverso total ≠ original");
    assert.deepEqual(
      feeds[0].map((e) => e.slug),
      ["kit-sem-data", "nova", "antiga-a", "antiga-b", "orfa-total"],
      "kit-sem-data (18/09 pela página) é o hero; empate 01/09 quebra por <loc>; sem data nenhuma vai pro fim",
    );
  });

  it("sem data em lugar nenhum (Kit sem cache): ordem total por <loc>, permutação-invariante", () => {
    const entries: TestEntry[] = [
      { slug: "z-ultima-no-documento" },
      { slug: "a-primeira-no-documento" },
      { slug: "m-meio" },
    ];
    const read = readerFor(entries);
    const feed1 = feedSlugs(sitemapXml(entries), read);
    const feed2 = feedSlugs(sitemapXml([...entries].reverse()), read);

    assert.deepEqual(feed1, feed2);
    assert.deepEqual(feed1, ["a-primeira-no-documento", "m-meio", "z-ultima-no-documento"]);
  });

  it("data futura NA PÁGINA filtra igual ao lastmod futuro (#7686 estendido)", () => {
    const entries: TestEntry[] = [
      { slug: "kit-de-amanha", pageDate: "2026-09-19" },
      { slug: "hoje", lastmod: "2026-09-18" },
    ];
    const read = readerFor(entries);
    const feed = buildHomeFeed(sitemapXml(entries), read, 10, { todayBrt: "2026-09-18" });
    assert.deepEqual(
      feed.map((e) => e.slug),
      ["hoje"],
      "a edição de amanhã não aparece na home de hoje nem quando a data vem da página",
    );
  });
});

describe("#8360 extractPageDate — data editorial embutida na página", () => {
  it("lê <meta property=article:published_time> (era Beehiiv, #8352)", () => {
    assert.equal(extractPageDate(pageHtml("x", "2025-08-27")), "2025-08-27");
  });

  it("lê datePublished do JSON-LD quando a meta falta (#8336)", () => {
    const html = `<!doctype html><html><head><title>x</title></head><body><script type="application/ld+json">{"@type":"Article","datePublished":"2026-09-18T03:00:00.000Z"}</script></body></html>`;
    assert.equal(extractPageDate(html), "2026-09-18");
  });

  it("recorta datetime para YYYY-MM-DD e rejeita lixo", () => {
    assert.equal(extractPageDate(pageHtml("x", "2026-09-18T06:00:00Z")), "2026-09-18");
    assert.equal(extractPageDate(pageHtml("x")), null);
    assert.equal(extractPageDate("<p>sem head</p>"), null);
  });
});
