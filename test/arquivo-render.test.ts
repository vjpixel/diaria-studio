/**
 * test/arquivo-render.test.ts (#4105)
 *
 * Cobre `workers/arquivo/src/render-archive.ts` (buildArchiveHtml — grouping +
 * render puro, testável sem rede) e `workers/arquivo/src/index.ts` (fetch
 * handler completo, incluindo o caminho de falha de fetch/parse do sitemap
 * via mock de `globalThis.fetch`, sem chamada externa real).
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  buildArchiveHtml,
  displayTextFromLoc,
  esc,
} from "../workers/arquivo/src/render-archive.ts";
import type { SitemapEntry } from "../scripts/lib/fetch-sitemap.ts";
import worker from "../workers/arquivo/src/index.ts";

function entry(loc: string, lastmod: string | null): SitemapEntry {
  return { loc, lastmod };
}

describe("buildArchiveHtml (#4105)", () => {
  it("gera <a href> real pra cada entrada /p/*", () => {
    const html = buildArchiveHtml([
      entry("https://diar.ia.br/p/anthropic-lanca-claude", "2026-07-27"),
      entry("https://diar.ia.br/p/google-lanca-gemini", "2026-07-20"),
    ]);
    assert.match(
      html,
      /<a href="https:\/\/diar\.ia\.br\/p\/anthropic-lanca-claude">/,
    );
    assert.match(
      html,
      /<a href="https:\/\/diar\.ia\.br\/p\/google-lanca-gemini">/,
    );
  });

  it("exclui entradas que não são /p/* (home, archive, tags, subscribe, authors)", () => {
    const html = buildArchiveHtml([
      entry("https://diar.ia.br/", "2026-07-27"),
      entry("https://diar.ia.br/archive", "2026-07-27"),
      entry("https://diar.ia.br/tags", "2026-07-27"),
      entry("https://diar.ia.br/subscribe", "2026-07-27"),
      entry("https://diar.ia.br/authors/alguem", "2026-07-27"),
      entry("https://diar.ia.br/p/edicao-real", "2026-07-27"),
    ]);
    assert.match(html, /<a href="https:\/\/diar\.ia\.br\/p\/edicao-real">/);
    assert.doesNotMatch(html, /href="https:\/\/diar\.ia\.br\/"/);
    assert.doesNotMatch(html, /href="https:\/\/diar\.ia\.br\/archive"/);
    assert.doesNotMatch(html, /href="https:\/\/diar\.ia\.br\/tags"/);
    assert.doesNotMatch(html, /href="https:\/\/diar\.ia\.br\/subscribe"/);
    assert.doesNotMatch(html, /href="https:\/\/diar\.ia\.br\/authors\/alguem"/);
  });

  it("descarta entradas /p/* sem lastmod (não dá pra agrupar)", () => {
    const html = buildArchiveHtml([
      entry("https://diar.ia.br/p/sem-data", null),
      entry("https://diar.ia.br/p/com-data", "2026-07-27"),
    ]);
    assert.doesNotMatch(html, /sem-data/);
    assert.match(html, /com-data/);
  });

  it("agrupa por ano-mês e ordena meses do mais recente pro mais antigo", () => {
    const html = buildArchiveHtml([
      entry("https://diar.ia.br/p/edicao-maio", "2026-05-10"),
      entry("https://diar.ia.br/p/edicao-julho", "2026-07-15"),
      entry("https://diar.ia.br/p/edicao-junho", "2026-06-01"),
    ]);
    const idxJulho = html.indexOf("julho de 2026");
    const idxJunho = html.indexOf("junho de 2026");
    const idxMaio = html.indexOf("maio de 2026");
    assert.ok(idxJulho > -1 && idxJunho > -1 && idxMaio > -1, "os 3 meses aparecem");
    assert.ok(idxJulho < idxJunho, "julho vem antes de junho");
    assert.ok(idxJunho < idxMaio, "junho vem antes de maio");
  });

  it("dentro de um mês, ordena edições da mais recente pra mais antiga", () => {
    const html = buildArchiveHtml([
      entry("https://diar.ia.br/p/dia-05", "2026-07-05"),
      entry("https://diar.ia.br/p/dia-20", "2026-07-20"),
      entry("https://diar.ia.br/p/dia-10", "2026-07-10"),
    ]);
    const idx20 = html.indexOf("dia-20");
    const idx10 = html.indexOf("dia-10");
    const idx05 = html.indexOf("dia-05");
    assert.ok(idx20 < idx10 && idx10 < idx05, "dia 20 > dia 10 > dia 05");
  });

  it("lista vazia não quebra — retorna HTML válido com mensagem", () => {
    const html = buildArchiveHtml([]);
    assert.match(html, /<html/);
    assert.match(html, /Nenhuma edição encontrada/);
  });

  it("lista só com entradas não-/p/ produz 0 edições sem quebrar", () => {
    const html = buildArchiveHtml([
      entry("https://diar.ia.br/archive", "2026-07-27"),
      entry("https://diar.ia.br/tags", "2026-07-27"),
    ]);
    assert.match(html, /0 ediç/);
  });

  it("aceita lastmod datetime ISO completo (não só YYYY-MM-DD)", () => {
    const html = buildArchiveHtml([
      entry("https://diar.ia.br/p/com-hora", "2026-07-27T14:30:00Z"),
    ]);
    assert.match(html, /julho de 2026/);
    assert.match(html, /com-hora/);
  });
});

describe("displayTextFromLoc (#4105)", () => {
  it("troca hífen por espaço e capitaliza a 1ª letra", () => {
    assert.equal(
      displayTextFromLoc("https://diar.ia.br/p/anthropic-lanca-claude-opus-5"),
      "Anthropic lanca claude opus 5",
    );
  });

  it("não faz fetch nenhum — é puro, deriva só da URL", () => {
    // Se isso lançasse ou dependesse de rede, o teste falharia por timeout;
    // passar rápido comprova que é 100% derivado do slug.
    const text = displayTextFromLoc("https://diar.ia.br/p/slug-qualquer");
    assert.equal(text, "Slug qualquer");
  });
});

describe("esc (#4105)", () => {
  it("escapa <, >, &, aspas", () => {
    assert.equal(esc(`<a href="x">&'`), "&lt;a href=&quot;x&quot;&gt;&amp;&#39;");
  });
});

describe("workers/arquivo GET / — fetch handler (#4105)", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("sitemap ok → 200 com <a href> reais + Cache-Control de 1h", async () => {
    const fakeSitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://diar.ia.br/</loc><lastmod>2026-07-27</lastmod></url>
  <url><loc>https://diar.ia.br/p/edicao-de-teste</loc><lastmod>2026-07-27</lastmod></url>
</urlset>`;
    globalThis.fetch = (async () =>
      new Response(fakeSitemap, { status: 200 })) as unknown as typeof fetch;

    const res = await worker.fetch(new Request("https://arquivo.diar.ia.br/"));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("Cache-Control"), "public, max-age=3600");
    const body = await res.text();
    assert.match(body, /<a href="https:\/\/diar\.ia\.br\/p\/edicao-de-teste">/);
  });

  it("HTTP não-200 do sitemap → página de erro (502), nunca lança sem tratamento", async () => {
    globalThis.fetch = (async () =>
      new Response("nope", { status: 500 })) as unknown as typeof fetch;

    const res = await worker.fetch(new Request("https://arquivo.diar.ia.br/"));
    assert.equal(res.status, 502);
    assert.match(await res.text(), /indisponível/);
  });

  it("erro de rede (fetch rejeita) → página de erro (502), nunca lança sem tratamento", async () => {
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;

    const res = await worker.fetch(new Request("https://arquivo.diar.ia.br/"));
    assert.equal(res.status, 502);
    assert.match(await res.text(), /indisponível/);
  });

  it("sitemap XML malformado → página de erro (502), nunca lança sem tratamento", async () => {
    globalThis.fetch = (async () =>
      new Response("<not-xml>>", { status: 200 })) as unknown as typeof fetch;

    const res = await worker.fetch(new Request("https://arquivo.diar.ia.br/"));
    assert.equal(res.status, 502);
  });

  it("path != / → 404", async () => {
    globalThis.fetch = (async () => {
      throw new Error("não deveria fazer fetch nenhum pra path != /");
    }) as unknown as typeof fetch;

    const res = await worker.fetch(new Request("https://arquivo.diar.ia.br/outra-coisa"));
    assert.equal(res.status, 404);
  });
});
