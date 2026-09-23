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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
  checkArchiveIndexLinkConsistency,
  monthLabel,
  resolveArchiveIndexCover,
  resolveLastArchiveRegenTimestamp,
  resolvePagePublishedAt,
  isAfter,
} from "../scripts/lib/site-archive-index.ts";
import {
  brtDateString,
  buildHomeFeed,
  isKnownStaticSitemapPath,
  resolveEditorialDate,
  type HomeFeedEntry,
} from "../scripts/lib/site-home-page.ts";
import { findStaleIndexPages, main as genArchiveIndexMain } from "../scripts/gen-archive-index.ts";
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

  /**
   * #8688: desde o #8221 o Stage 6 publica a página `/p/{slug}` e a entrada
   * no sitemap na VÉSPERA do envio; a linha correspondente no índice só
   * chega no regen das 06:00 BRT (`regen-home.yml`). Uma edição com data
   * editorial > hoje presente no sitemap mas ainda sem link no índice é o
   * estado ESPERADO nesse intervalo, não uma edição órfã — `resolveDate` +
   * `checkArchiveIndexLinkConsistency` reproduzem o mesmo corte `todayBrt`
   * do #7686 (home/índice só com edição já enviada) pra não confundir os
   * dois casos. Regressão coberta explicitamente no describe abaixo
   * ("cada edição sitemap × índice, corte de data futura").
   */
  it("cada edição do sitemap é linkada por exatamente 1 página do índice", () => {
    const linked = new Map<string, number>();
    const total = archiveIndexPageCount(editionLocs.length, ARCHIVE_INDEX_PAGE_SIZE);
    for (let page = 1; page <= total; page++) {
      const html = readFileSync(join(PUBLIC_DIR, archiveIndexFilePath(page)), "utf8");
      for (const loc of editionLocs) {
        if (html.includes(`href="${loc}"`)) linked.set(loc, (linked.get(loc) ?? 0) + 1);
      }
    }
    const readPageHtml = (slug: string): string | null => {
      const path = join(PUBLIC_DIR, "p", slug, "index.html");
      return existsSync(path) ? readFileSync(path, "utf8") : null;
    };
    const sitemapEntries = parseSitemap(sitemapXml);
    const resolveDate = (loc: string): string | null => {
      const entry = sitemapEntries.find((e) => e.loc === loc);
      return entry ? resolveEditorialDate(entry, readPageHtml) : null;
    };
    const lastRegenAt = resolveLastArchiveRegenTimestamp(ROOT);
    const { missing, duplicated } = checkArchiveIndexLinkConsistency(
      editionLocs,
      resolveDate,
      (loc) => linked.get(loc) ?? 0,
      brtDateString(),
      lastRegenAt,
      (loc) => resolvePagePublishedAt(loc, ROOT),
    );
    assert.deepEqual(
      missing,
      [],
      "edição sem link em nenhuma página do índice — continuaria órfã (edições com data editorial " +
        "futura, publicadas na véspera pelo Stage 6 #8221, ou publicadas HOJE depois do regen das 06:00 " +
        "BRT já ter rodado, são ignoradas aqui até o PRÓXIMO regen reconciliar, #8688/#8734)",
    );
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

/**
 * #8688 — decisão do editor: manter o filtro #7686 (home/índice só com
 * edição já enviada) e ajustar o teste #8353 pra ignorar edições cuja data
 * editorial (BRT) é posterior a hoje. A entrada no sitemap na véspera
 * (#8221) é aceita; a linha do índice chega no regen das 06:00 BRT.
 *
 * Os 2 casos explícitos pedidos no comentário da decisão:
 *   (a) edição FUTURA presente no sitemap sem link no índice → não reprova;
 *   (b) edição PASSADA sem link no índice → continua reprovando (o
 *       comportamento que o #8353 original existia pra travar).
 */
describe("checkArchiveIndexLinkConsistency — corte de data futura (#8688)", () => {
  const TODAY = "2026-09-21";
  const past = "https://diar.ia.br/p/edicao-passada";
  const future = "https://diar.ia.br/p/edicao-futura";
  const dates: Record<string, string> = {
    [past]: "2026-09-18",
    [future]: "2026-09-22",
  };
  const resolveDate = (loc: string) => dates[loc] ?? null;

  it("edição futura no sitemap sem link no índice não reprova (#8688)", () => {
    const { missing, duplicated } = checkArchiveIndexLinkConsistency(
      [future],
      resolveDate,
      () => 0, // nenhuma página do índice ainda linka a edição de amanhã.
      TODAY,
    );
    assert.deepEqual(missing, []);
    assert.deepEqual(duplicated, []);
  });

  it("edição passada sem link no índice continua reprovando", () => {
    const { missing, duplicated } = checkArchiveIndexLinkConsistency(
      [past],
      resolveDate,
      () => 0, // órfã de verdade — nenhum regen linkou ainda.
      TODAY,
    );
    assert.deepEqual(missing, [past]);
    assert.deepEqual(duplicated, []);
  });

  it("as duas juntas: só a passada aparece como faltando", () => {
    const { missing, duplicated } = checkArchiveIndexLinkConsistency(
      [past, future],
      resolveDate,
      () => 0,
      TODAY,
    );
    assert.deepEqual(missing, [past]);
    assert.deepEqual(duplicated, []);
  });

  it("edição passada linkada normalmente não reprova nem duplica", () => {
    const { missing, duplicated } = checkArchiveIndexLinkConsistency([past], resolveDate, () => 1, TODAY);
    assert.deepEqual(missing, []);
    assert.deepEqual(duplicated, []);
  });

  it("edição linkada em mais de 1 página continua reprovando (duplicated), mesmo se futura", () => {
    const { missing, duplicated } = checkArchiveIndexLinkConsistency([future], resolveDate, () => 2, TODAY);
    assert.deepEqual(missing, []);
    assert.deepEqual(duplicated, [future]);
  });

  it("sem data (entrada sem lastmod e sem data na página) é tratada como devida, nunca futura", () => {
    const { missing } = checkArchiveIndexLinkConsistency(["https://diar.ia.br/p/sem-data"], () => null, () => 0, TODAY);
    assert.deepEqual(missing, ["https://diar.ia.br/p/sem-data"]);
  });
});

/**
 * #8734: caso real PR #8705 — página publicada HOJE (data editorial = hoje,
 * não futura, então o corte do #8688 sozinho NÃO a isenta), mas DEPOIS que o
 * regen das 06:00 BRT de hoje já rodou. `lastRegenAt` + `resolvePublishedAt`
 * cobrem esse caso comparando o commit timestamp da página contra o do
 * último regen, independente da data editorial.
 */
describe("checkArchiveIndexLinkConsistency — publicação same-day após o regen (#8734)", () => {
  const TODAY = "2026-09-23";
  const sameDayLate = "https://diar.ia.br/p/publicada-hoje-tarde";
  const sameDayEarly = "https://diar.ia.br/p/publicada-hoje-antes-do-regen";
  const pastNoResolver = "https://diar.ia.br/p/passada-sem-resolver";
  const dates: Record<string, string> = {
    [sameDayLate]: TODAY,
    [sameDayEarly]: TODAY,
    [pastNoResolver]: "2026-09-18",
  };
  const resolveDate = (loc: string) => dates[loc] ?? null;
  const lastRegenAt = "2026-09-23T09:12:00Z"; // 06:12 BRT
  const publishedAt: Record<string, string> = {
    [sameDayLate]: "2026-09-23T15:30:00Z", // depois do regen — ainda não reconciliada
    [sameDayEarly]: "2026-09-23T05:00:00Z", // antes do regen — já deveria estar linkada
  };
  const resolvePublishedAt = (loc: string) => publishedAt[loc] ?? null;

  it("publicada hoje DEPOIS do regen não reprova, mesmo com data editorial = hoje (não futura)", () => {
    const { missing } = checkArchiveIndexLinkConsistency([sameDayLate], resolveDate, () => 0, TODAY, lastRegenAt, resolvePublishedAt);
    assert.deepEqual(missing, []);
  });

  it("publicada hoje ANTES do regen e ainda sem link continua reprovando — o regen já deveria ter pegado", () => {
    const { missing } = checkArchiveIndexLinkConsistency([sameDayEarly], resolveDate, () => 0, TODAY, lastRegenAt, resolvePublishedAt);
    assert.deepEqual(missing, [sameDayEarly]);
  });

  it("sem resolvePublishedAt (parâmetro omitido) degrada pro corte de data puro do #8688 — compatibilidade retroativa", () => {
    const { missing } = checkArchiveIndexLinkConsistency([pastNoResolver], resolveDate, () => 0, TODAY);
    assert.deepEqual(missing, [pastNoResolver]);
  });

  it("lastRegenAt null (regen nunca resolvido) nunca isenta ninguém por publishedAt — só o corte de data vale", () => {
    const { missing } = checkArchiveIndexLinkConsistency([sameDayLate], resolveDate, () => 0, TODAY, null, resolvePublishedAt);
    assert.deepEqual(missing, [sameDayLate], "sem lastRegenAt confiável, cai no corte de data puro — não é futura, então reprova");
  });

  // Achado do review (#8734, P2): commits reais deste repo misturam offset
  // de timezone (Z de CI/bot vs -03:00 de commit local) — comparação
  // lexicográfica de string dava ordem cronológica ERRADA entre offsets
  // diferentes.
  it("REGRESSÃO (#8734): offsets de timezone mistos (Z vs -03:00) comparam pelo instante real, não pela string", () => {
    const mixedLoc = "https://diar.ia.br/p/publicada-offset-misto";
    const mixedDates: Record<string, string> = { [mixedLoc]: TODAY };
    const mixedResolveDate = (loc: string) => mixedDates[loc] ?? null;
    // 05:00 UTC = 02:00 BRT — ANTES do regen (09:00 UTC = 06:00 BRT).
    // Comparação de STRING erraria: "...T05:00:00Z" < "...T09:00:00-03:00"
    // por dígito, quando "0" (5h) < "9" (9h) já dá a ordem certa aqui — o
    // caso que a comparação de string erra de fato é o inverso.
    const publishedBeforeRegenUtc = "2026-09-23T05:00:00Z";
    const lastRegenLocalOffset = "2026-09-23T06:00:00-03:00"; // = 09:00 UTC, DEPOIS de 05:00 UTC
    const { missing } = checkArchiveIndexLinkConsistency(
      [mixedLoc],
      mixedResolveDate,
      () => 0,
      TODAY,
      lastRegenLocalOffset,
      () => publishedBeforeRegenUtc,
    );
    assert.deepEqual(missing, [mixedLoc], "publicada ANTES do regen (mesmo em offset diferente) deveria reprovar — o regen já deveria ter linkado");
  });

  it("REGRESSÃO (#8734): contra-exemplo que a comparação de STRING erra na direção oposta", () => {
    const mixedLoc = "https://diar.ia.br/p/publicada-offset-misto-2";
    const mixedDates: Record<string, string> = { [mixedLoc]: TODAY };
    const mixedResolveDate = (loc: string) => mixedDates[loc] ?? null;
    // Regen às 09:00 UTC. Página publicada 10:30 BRT = 13:30 UTC, DEPOIS do
    // regen — deveria ser isenta. Comparação de STRING: "...T10:30:00-03:00"
    // (dígito '1' na posição da hora) < "...T09:00:00Z" (dígito '0') seria
    // FALSO por string (perde), mas 13:30 UTC > 09:00 UTC é VERDADEIRO por
    // instante real — a comparação antiga (string) marcaria erroneamente
    // como "já deveria estar linkada" (reprova), quando na verdade ainda
    // está dentro da janela esperada de espera (não deveria reprovar).
    const lastRegenUtc = "2026-09-23T09:00:00Z";
    const publishedAfterRegenLocalOffset = "2026-09-23T10:30:00-03:00";
    const { missing } = checkArchiveIndexLinkConsistency(
      [mixedLoc],
      mixedResolveDate,
      () => 0,
      TODAY,
      lastRegenUtc,
      () => publishedAfterRegenLocalOffset,
    );
    assert.deepEqual(missing, [], "publicada DEPOIS do regen (instante real) não deveria reprovar, apesar da string comparar 'menor'");
  });
});

describe("isAfter (#8734) — comparação de timestamp por instante real, não por string", () => {
  it("true quando a é cronologicamente depois de b, mesmo offset", () => {
    assert.equal(isAfter("2026-09-23T10:00:00-03:00", "2026-09-23T09:00:00-03:00"), true);
  });

  it("false quando a é antes de b, mesmo offset", () => {
    assert.equal(isAfter("2026-09-23T08:00:00-03:00", "2026-09-23T09:00:00-03:00"), false);
  });

  it("compara corretamente entre offsets DIFERENTES (Z vs -03:00) — o achado do review", () => {
    // 10:30 BRT (-03:00) = 13:30 UTC, DEPOIS de 09:00 UTC — mas
    // lexicograficamente "10" < "09" na leitura ingênua de string por causa
    // do offset diferente confundir a posição.
    assert.equal(isAfter("2026-09-23T10:30:00-03:00", "2026-09-23T09:00:00Z"), true);
  });

  it("false quando qualquer um dos dois é null", () => {
    assert.equal(isAfter(null, "2026-09-23T09:00:00Z"), false);
    assert.equal(isAfter("2026-09-23T09:00:00Z", null), false);
    assert.equal(isAfter(null, null), false);
  });

  it("false quando qualquer um dos dois é malformado (Date.parse retorna NaN) — nunca lança", () => {
    assert.equal(isAfter("não-é-data", "2026-09-23T09:00:00Z"), false);
    assert.equal(isAfter("2026-09-23T09:00:00Z", "não-é-data"), false);
    assert.doesNotThrow(() => isAfter("lixo", "lixo"));
  });
});

describe("resolveLastArchiveRegenTimestamp (#8734)", () => {
  it("devolve o stdout do git log quando o comando resolve com sucesso", () => {
    const fakeGit = (args: string[]) => {
      assert.deepEqual(args, ["log", "-1", "--format=%cI", "--", "workers/site/public/archive"]);
      return { status: 0, stdout: "2026-09-23T09:12:00-03:00\n" };
    };
    assert.equal(resolveLastArchiveRegenTimestamp("/repo", fakeGit), "2026-09-23T09:12:00-03:00");
  });

  it("null quando o git log falha (status != 0)", () => {
    const fakeGit = () => ({ status: 1, stdout: "" });
    assert.equal(resolveLastArchiveRegenTimestamp("/repo", fakeGit), null);
  });

  it("null quando o stdout vem vazio (path nunca commitado)", () => {
    const fakeGit = () => ({ status: 0, stdout: "\n" });
    assert.equal(resolveLastArchiveRegenTimestamp("/repo", fakeGit), null);
  });

  it("resolve de verdade contra o repo real (sem mock) — path existe e tem histórico", () => {
    const result = resolveLastArchiveRegenTimestamp(ROOT);
    assert.notEqual(result, null, "workers/site/public/archive deveria ter pelo menos 1 commit no repo real");
  });
});

describe("resolvePagePublishedAt (#8734)", () => {
  it("extrai o slug de https://.../p/{slug} e roda git log só pro arquivo daquela página", () => {
    const fakeGit = (args: string[]) => {
      assert.deepEqual(args, [
        "log",
        "-1",
        "--first-parent",
        "--format=%cI",
        "--",
        "workers/site/public/p/minha-edicao/index.html",
      ]);
      return { status: 0, stdout: "2026-09-23T15:30:00-03:00\n" };
    };
    assert.equal(
      resolvePagePublishedAt("https://diar.ia.br/p/minha-edicao", "/repo", fakeGit),
      "2026-09-23T15:30:00-03:00",
    );
  });

  it("null para URL sem /p/{slug} (ex: /archive, /assinar)", () => {
    const fakeGit = () => ({ status: 0, stdout: "should-not-be-called\n" });
    assert.equal(resolvePagePublishedAt("https://diar.ia.br/archive", "/repo", fakeGit), null);
    assert.equal(resolvePagePublishedAt("https://diar.ia.br/assinar", "/repo", fakeGit), null);
  });

  it("null para URL malformada (nunca lança)", () => {
    const fakeGit = () => ({ status: 0, stdout: "x\n" });
    assert.doesNotThrow(() => resolvePagePublishedAt("não-é-uma-url", "/repo", fakeGit));
    assert.equal(resolvePagePublishedAt("não-é-uma-url", "/repo", fakeGit), null);
  });

  it("null quando o git log falha ou o path nunca foi commitado", () => {
    const fakeGit = () => ({ status: 1, stdout: "" });
    assert.equal(resolvePagePublishedAt("https://diar.ia.br/p/nunca-existiu", "/repo", fakeGit), null);
  });

  it("resolve de verdade contra o repo real (sem mock) — página existente no disco", () => {
    const result = resolvePagePublishedAt("https://diar.ia.br/p/claude-opus-5-5-chega-dias-apos-alerta-de-amodei", ROOT);
    assert.notEqual(result, null, "página publicada hoje deveria ter timestamp de commit resolvível");
  });
});

/**
 * Findings 1, 2 e 4 do self-review da PR #8399.
 */
describe("poda × sitemap nunca divergem (#8353, finding 1 da PR #8399)", () => {
  function fixture(editions: number): { dir: string; sitemap: string; pagesDir: string } {
    const dir = mkdtempSync(join(tmpdir(), "archive-index-8353-"));
    const pagesDir = join(dir, "p");
    const urls: string[] = [];
    for (let i = 0; i < editions; i++) {
      const slug = `edicao-${String(i).padStart(3, "0")}`;
      mkdirSync(join(pagesDir, slug), { recursive: true });
      writeFileSync(
        join(pagesDir, slug, "index.html"),
        `<html><head><title>${slug}</title><meta name="dek" content="dek ${slug}"></head><body></body></html>`,
        "utf8",
      );
      urls.push(
        `  <url>\n    <loc>https://diar.ia.br/p/${slug}</loc>\n    <lastmod>2025-01-${String(i + 1).padStart(2, "0")}</lastmod>\n  </url>`,
      );
    }
    const sitemap = join(dir, "sitemap.xml");
    writeFileSync(
      sitemap,
      `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`,
      "utf8",
    );
    return { dir, sitemap, pagesDir };
  }

  /** Roda `gen-archive-index.ts main()` contra o fixture, capturando os warns. */
  function run(fx: { dir: string; sitemap: string; pagesDir: string }, extra: string[]): string[] {
    const warns: string[] = [];
    const origWarn = console.warn;
    const origLog = console.log;
    console.warn = (...args: unknown[]) => void warns.push(args.join(" "));
    console.log = () => {};
    try {
      const code = genArchiveIndexMain([
        "--sitemap",
        fx.sitemap,
        "--pages-dir",
        fx.pagesDir,
        "--out-dir",
        fx.dir,
        ...extra,
      ]);
      assert.equal(code, 0, "gen-archive-index devia ter saído 0 no fixture");
    } finally {
      console.warn = origWarn;
      console.log = origLog;
    }
    return warns;
  }

  it("--no-sitemap NÃO poda (a <loc> ficaria apontando pra 404) e avisa quais páginas ficaram órfãs", () => {
    const fx = fixture(6);
    try {
      // 6 edições, 2 por página → 3 páginas, com as entradas no sitemap.
      run(fx, ["--page-size", "2"]);
      assert.ok(existsSync(join(fx.dir, "archive", "3", "index.html")), "/archive/3 devia existir");
      const withPages = readFileSync(fx.sitemap, "utf8");
      assert.ok(withPages.includes("<loc>https://diar.ia.br/archive/3</loc>"), "sitemap devia ter /archive/3");

      // Agora 6 por página → 1 página só. Com --no-sitemap, /archive/2 e
      // /archive/3 PERMANECEM em disco: podá-las sem poder tirar a <loc>
      // é exatamente a URL 404 declarada que o finding 1 aponta.
      const warns = run(fx, ["--page-size", "6", "--no-sitemap"]);
      assert.equal(readFileSync(fx.sitemap, "utf8"), withPages, "--no-sitemap não pode reescrever o sitemap");
      for (const n of ["2", "3"]) {
        assert.ok(
          existsSync(join(fx.dir, "archive", n, "index.html")),
          `/archive/${n} sumiu do disco com --no-sitemap, mas a <loc> continua no sitemap → 404 declarado`,
        );
      }
      assert.ok(
        warns.some((w) => w.includes("--no-sitemap") && w.includes("/archive/2") && w.includes("/archive/3")),
        `esperado warn nomeando as páginas órfãs mantidas; warns: ${JSON.stringify(warns)}`,
      );
    } finally {
      rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  it("sem a flag, poda e limpeza do sitemap acontecem na MESMA execução", () => {
    const fx = fixture(6);
    try {
      run(fx, ["--page-size", "2"]);
      run(fx, ["--page-size", "6"]);
      const xml = readFileSync(fx.sitemap, "utf8");
      for (const n of ["2", "3"]) {
        assert.equal(existsSync(join(fx.dir, "archive", n)), false, `/archive/${n} devia ter sido podada`);
        assert.ok(
          !xml.includes(`<loc>https://diar.ia.br/archive/${n}</loc>`),
          `<loc> de /archive/${n} continuou no sitemap depois da poda`,
        );
      }
      assert.ok(xml.includes("<loc>https://diar.ia.br/archive</loc>"), "/archive não podia sair do sitemap");
    } finally {
      rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  it("findStaleIndexPages nunca considera index.html nem diretório não-numerado", () => {
    const dir = mkdtempSync(join(tmpdir(), "archive-stale-8353-"));
    try {
      const archiveDir = join(dir, "archive");
      mkdirSync(join(archiveDir, "2"), { recursive: true });
      mkdirSync(join(archiveDir, "7"), { recursive: true });
      mkdirSync(join(archiveDir, "tema"), { recursive: true });
      writeFileSync(join(archiveDir, "index.html"), "<html></html>", "utf8");
      assert.deepEqual(findStaleIndexPages(archiveDir, 3), ["7"]);
      assert.ok(existsSync(join(archiveDir, "index.html")));
      assert.ok(existsSync(join(archiveDir, "tema")));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("og:image/twitter:card no índice (#8353, finding 2 da PR #8399)", () => {
  const entries = [entry("mais-recente", "2026-09-18"), entry("anterior", "2026-09-17")];

  it("com capa: og:image absoluto + twitter:card=summary_large_image", () => {
    const html = buildArchiveIndexHtml({
      entries,
      page: 1,
      totalPages: 2,
      totalEditions: 40,
      coverImage: "https://diar.ia.br/img/capa.jpg",
    });
    assert.match(html, /<meta property="og:image" content="https:\/\/diar\.ia\.br\/img\/capa\.jpg">/);
    assert.match(html, /<meta name="twitter:image" content="https:\/\/diar\.ia\.br\/img\/capa\.jpg">/);
    assert.match(html, /<meta name="twitter:card" content="summary_large_image">/);
    // O bloco veio do renderSeoMeta compartilhado — canonical e favicon juntos.
    assert.match(html, /<link rel="canonical" href="https:\/\/diar\.ia\.br\/archive">/);
    assert.match(html, /<link rel="icon" href="data:image\/svg\+xml/);
  });

  it("sem capa: nenhuma tag de imagem vazia, twitter:card=summary", () => {
    const html = buildArchiveIndexHtml({ entries, page: 1, totalPages: 1, totalEditions: 2 });
    assert.ok(!html.includes("og:image"), "og:image não devia existir sem capa");
    assert.match(html, /<meta name="twitter:card" content="summary">/);
  });

  it("resolveArchiveIndexCover absolutiza o /img/ relativo da edição mais recente", () => {
    const cover = resolveArchiveIndexCover(entries, (slug) =>
      slug === "mais-recente"
        ? '<html><body><img class="hero" src="/img/img-260918-04-d1-2x1.jpg"></body></html>'
        : null,
    );
    assert.equal(cover, "https://diar.ia.br/img/img-260918-04-d1-2x1.jpg");
  });

  it("edição mais recente sem hero → null (card só-texto, nunca URL vazia)", () => {
    assert.equal(resolveArchiveIndexCover(entries, () => "<html><body></body></html>"), null);
    assert.equal(resolveArchiveIndexCover([], () => null), null);
  });

  it("as páginas commitadas trazem og:image e twitter:card", () => {
    const html = readFileSync(join(PUBLIC_DIR, "archive", "index.html"), "utf8");
    assert.match(html, /<meta property="og:image" content="https:\/\/diar\.ia\.br\//);
    assert.match(html, /<meta name="twitter:card" content="summary_large_image">/);
  });
});

describe("entrada estática do sitemap é allowlist, não heurística (#8353, finding 4 da PR #8399)", () => {
  function feedWarns(loc: string): { warns: string[]; logs: string[] } {
    const warns: string[] = [];
    const logs: string[] = [];
    const origWarn = console.warn;
    const origLog = console.log;
    console.warn = (...a: unknown[]) => void warns.push(a.join(" "));
    console.log = (...a: unknown[]) => void logs.push(a.join(" "));
    try {
      buildHomeFeed(`<?xml version="1.0"?><urlset><url><loc>${loc}</loc></url></urlset>`, () => null, 10, {
        todayBrt: "2026-09-19",
      });
    } finally {
      console.warn = origWarn;
      console.log = origLog;
    }
    return { warns, logs };
  }

  it("path estático conhecido é console.log (não polui a geração diária)", () => {
    for (const loc of ["https://diar.ia.br/clarice", "https://diar.ia.br/archive", "https://diar.ia.br/archive/7"]) {
      const { warns, logs } = feedWarns(loc);
      assert.deepEqual(warns, [], `${loc} não devia gerar warn`);
      assert.ok(
        logs.some((l) => l.includes(loc)),
        `${loc} devia ser logado como esperado`,
      );
    }
  });

  it("shape novo de URL de edição continua WARN — é o silêncio perigoso do finding 4", () => {
    // Se a edição virasse /edicao/{slug}, a heurística antiga (`includes("/p/")`)
    // rebaixaria esta entrada quebrada a "estática, esperado".
    const { warns } = feedWarns("https://diar.ia.br/edicao/260918-titulo");
    assert.equal(warns.length, 1, `esperado warn pra shape desconhecido; warns: ${JSON.stringify(warns)}`);
    assert.ok(!warns[0].includes("esperado"));
  });

  it("URL de edição com shape quebrado (/p/ sem slug) continua WARN", () => {
    const { warns } = feedWarns("https://diar.ia.br/p/");
    assert.equal(warns.length, 1);
  });

  it("isKnownStaticSitemapPath tolera barra final e ignora path desconhecido", () => {
    assert.equal(isKnownStaticSitemapPath("https://diar.ia.br/archive/"), true);
    assert.equal(isKnownStaticSitemapPath("https://diar.ia.br/"), true);
    assert.equal(isKnownStaticSitemapPath("https://diar.ia.br/archive/12"), true);
    assert.equal(isKnownStaticSitemapPath("https://diar.ia.br/archive/tema/ia"), false);
    assert.equal(isKnownStaticSitemapPath("https://diar.ia.br/qualquer-coisa"), false);
  });
});
