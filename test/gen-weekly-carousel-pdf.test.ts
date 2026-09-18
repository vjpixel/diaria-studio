/**
 * test/gen-weekly-carousel-pdf.test.ts (#8055)
 *
 * O valor do script está em NÃO inventar slide: ele encaderna o que já foi
 * publicado, lendo os caches da semana. Os testes cobrem justamente as
 * formas de errar isso — cache ausente, cache pela metade, ordem trocada —
 * mais os tetos da Documents API do LinkedIn.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import sharp from "sharp";

import { resolveSlideUrlsFromCache, buildWeeklyCarouselPdf } from "../scripts/gen-weekly-carousel-pdf.ts";

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), "weekly-pdf-"));
}

function writeCaches(root: string, key: string, opts: { flat?: unknown; news?: unknown } = {}): string {
  const dir = resolve(root, "weekly", key, "_internal");
  mkdirSync(dir, { recursive: true });
  if (opts.flat !== undefined) writeFileSync(join(dir, "06-flat-cards.json"), JSON.stringify(opts.flat), "utf8");
  if (opts.news !== undefined) writeFileSync(join(dir, "06-news-cards.json"), JSON.stringify(opts.news), "utf8");
  return dir;
}

const FLAT_OK = { cover: { url: "https://x/cover.jpg" }, cta: { url: "https://x/cta.jpg" } };

describe("#8055 resolveSlideUrlsFromCache — ordem do carrossel e falhas honestas", () => {
  it("devolve capa -> notícias -> CTA, notícias em ordem cronológica (a chave começa pela data)", () => {
    const root = makeRoot();
    try {
      writeCaches(root, "260912-highlights", {
        flat: FLAT_OK,
        // De propósito fora de ordem no arquivo — a ordenação é do código.
        news: {
          "260911-d1-52": { url: "https://x/11.jpg" },
          "260908-d1-52": { url: "https://x/08.jpg" },
          "260910-d1-52": { url: "https://x/10.jpg" },
          "260909-d1-52": { url: "https://x/09.jpg" },
        },
      });
      const { urls } = resolveSlideUrlsFromCache(root, "260912-highlights");
      assert.deepEqual(urls, [
        "https://x/cover.jpg",
        "https://x/08.jpg",
        "https://x/09.jpg",
        "https://x/10.jpg",
        "https://x/11.jpg",
        "https://x/cta.jpg",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("semana não publicada (sem 06-flat-cards.json) falha nomeando o arquivo e o que rodar antes", () => {
    const root = makeRoot();
    try {
      assert.throws(() => resolveSlideUrlsFromCache(root, "260919-highlights"), /06-flat-cards\.json não existe.*publish-weekly-social/s);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("cache sem CTA falha — documento truncado é pior que documento nenhum", () => {
    const root = makeRoot();
    try {
      writeCaches(root, "k", { flat: { cover: { url: "https://x/c.jpg" } }, news: { a: { url: "https://x/a.jpg" } } });
      assert.throws(() => resolveSlideUrlsFromCache(root, "k"), /sem cover\/cta/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("sem nenhum card de notícia falha — capa + CTA não é conteúdo", () => {
    const root = makeRoot();
    try {
      writeCaches(root, "k", { flat: FLAT_OK, news: {} });
      assert.throws(() => resolveSlideUrlsFromCache(root, "k"), /nenhum card de notícia/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("entrada de notícia sem url falha nomeando a chave, em vez de virar página em branco", () => {
    const root = makeRoot();
    try {
      writeCaches(root, "k", { flat: FLAT_OK, news: { "260908-d1-52": {} } });
      assert.throws(() => resolveSlideUrlsFromCache(root, "k"), /"260908-d1-52".*sem url/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("#8055 buildWeeklyCarouselPdf — download + tetos da Documents API", () => {
  it("baixa cada slide na ordem recebida e produz um PDF com 1 página por slide", async () => {
    const jpeg = new Uint8Array(await sharp({ create: { width: 1080, height: 1350, channels: 3, background: "#123456" } }).jpeg().toBuffer());
    const seen: string[] = [];
    const pdf = await buildWeeklyCarouselPdf(["a", "b", "c"], async (url) => {
      seen.push(url);
      return jpeg;
    });
    assert.deepEqual(seen, ["a", "b", "c"], "ordem preservada — é a ordem do carrossel publicado");
    const s = Buffer.from(pdf).toString("latin1");
    assert.match(s, /\/Count 3\b/);
  });

  it("mais de 300 páginas falha ANTES de baixar — teto da Documents API", async () => {
    const urls = Array.from({ length: 301 }, (_, i) => `u${i}`);
    let downloads = 0;
    await assert.rejects(
      () =>
        buildWeeklyCarouselPdf(urls, async () => {
          downloads++;
          return new Uint8Array();
        }),
      /excede o teto de 300/,
    );
    assert.equal(downloads, 0, "recusa sem gastar banda");
  });

  it("erro HTTP no download propaga com a URL — nunca gera PDF com página faltando", async () => {
    await assert.rejects(
      () => buildWeeklyCarouselPdf(["https://x/some.jpg"], async () => { throw new Error("GET https://x/some.jpg -> 404 Not Found"); }),
      /404/,
    );
  });
});
