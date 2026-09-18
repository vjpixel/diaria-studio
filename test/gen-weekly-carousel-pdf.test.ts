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

import { resolveSlideUrlsFromCache, buildWeeklyCarouselPdf, downloadJpeg } from "../scripts/gen-weekly-carousel-pdf.ts";

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), "weekly-pdf-"));
}

function writeCaches(root: string, key: string, opts: { flat?: unknown; news?: unknown; manifest?: unknown } = {}): string {
  const dir = resolve(root, "weekly", key, "_internal");
  mkdirSync(dir, { recursive: true });
  if (opts.flat !== undefined) writeFileSync(join(dir, "06-flat-cards.json"), JSON.stringify(opts.flat), "utf8");
  if (opts.news !== undefined) writeFileSync(join(dir, "06-news-cards.json"), JSON.stringify(opts.news), "utf8");
  if (opts.manifest !== undefined) writeFileSync(join(dir, "06-carousel-urls.json"), JSON.stringify(opts.manifest), "utf8");
  return dir;
}

const FLAT_OK = { cover: { url: "https://x/cover.jpg" }, cta: { url: "https://x/cta.jpg" } };

describe("#8305 resolveSlideUrlsFromCache — a ordem vem do manifesto, não de palpite", () => {
  it("manifesto presente MANDA, mesmo contrariando a ordem cronológica dos caches", () => {
    const root = makeRoot();
    try {
      writeCaches(root, "260912-clicked", {
        // A ordem REAL publicada — ranqueada por clique, nada cronológica.
        manifest: { urls: ["https://x/cover.jpg", "https://x/11.jpg", "https://x/08.jpg", "https://x/cta.jpg"] },
        flat: FLAT_OK,
        news: { "260808-d1-52": { url: "https://x/08.jpg" }, "260811-d1-52": { url: "https://x/11.jpg" } },
      });
      const { urls, source } = resolveSlideUrlsFromCache(root, "260912-clicked");
      assert.equal(source, "manifest");
      assert.deepEqual(urls, ["https://x/cover.jpg", "https://x/11.jpg", "https://x/08.jpg", "https://x/cta.jpg"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("modo 'clicked' SEM manifesto RECUSA — ordenar por data daria um documento com a sequência trocada", () => {
    const root = makeRoot();
    try {
      writeCaches(root, "260912-clicked", { flat: FLAT_OK, news: { "260908-d1-52": { url: "https://x/a.jpg" } } });
      assert.throws(
        () => resolveSlideUrlsFromCache(root, "260912-clicked"),
        /não é modo "highlights".*ordem real|ordem real.*não é recuperável/s,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("manifesto corrompido nomeia o arquivo em vez de vazar um SyntaxError pelado", () => {
    const root = makeRoot();
    try {
      const dir = resolve(root, "weekly", "k-highlights", "_internal");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "06-carousel-urls.json"), '{"urls": [', "utf8");
      assert.throws(() => resolveSlideUrlsFromCache(root, "k-highlights"), /06-carousel-urls\.json corrompido/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("manifesto sem lista de urls utilizável falha, em vez de montar documento vazio", () => {
    const root = makeRoot();
    try {
      writeCaches(root, "k-highlights", { manifest: { urls: [] } });
      assert.throws(() => resolveSlideUrlsFromCache(root, "k-highlights"), /sem uma lista de urls utilizável/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("#8055 resolveSlideUrlsFromCache — fallback cronológico (só highlights) e falhas honestas", () => {
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
      writeCaches(root, "k-highlights", { flat: { cover: { url: "https://x/c.jpg" } }, news: { a: { url: "https://x/a.jpg" } } });
      assert.throws(() => resolveSlideUrlsFromCache(root, "k-highlights"), /sem cover\/cta/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("sem nenhum card de notícia falha — capa + CTA não é conteúdo", () => {
    const root = makeRoot();
    try {
      writeCaches(root, "k-highlights", { flat: FLAT_OK, news: {} });
      assert.throws(() => resolveSlideUrlsFromCache(root, "k-highlights"), /nenhum card de notícia/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("entrada de notícia sem url falha nomeando a chave, em vez de virar página em branco", () => {
    const root = makeRoot();
    try {
      writeCaches(root, "k-highlights", { flat: FLAT_OK, news: { "260908-d1-52": {} } });
      assert.throws(() => resolveSlideUrlsFromCache(root, "k-highlights"), /"260908-d1-52".*sem url/);
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

describe("#8305 buildWeeklyCarouselPdf — teto de bytes e ligação página/imagem", () => {
  it("exatamente 300 páginas PASSA — o teto é 300, não 299", async () => {
    const jpeg = new Uint8Array(await sharp({ create: { width: 20, height: 25, channels: 3, background: "#111111" } }).jpeg().toBuffer());
    const urls = Array.from({ length: 300 }, (_, i) => `u${i}`);
    const pdf = await buildWeeklyCarouselPdf(urls, async () => jpeg);
    assert.match(Buffer.from(pdf).toString("latin1"), /\/Count 300 /);
  });

  it("aborta assim que os slides estouram o teto de bytes, SEM baixar o resto", async () => {
    // JPEG grande o bastante pra que poucos slides passem de 100MB — a
    // checagem tem que vir durante o download, não depois de montar tudo.
    const big = new Uint8Array(30 * 1024 * 1024);
    big.set([0xff, 0xd8]);
    let downloads = 0;
    await assert.rejects(
      () =>
        buildWeeklyCarouselPdf(["a", "b", "c", "d", "e", "f"], async () => {
          downloads++;
          return big;
        }),
      /acima do teto de 100MB|excede o teto/,
    );
    assert.ok(downloads < 6, `abortou no meio (baixou ${downloads} de 6), em vez de baixar tudo antes de reclamar`);
  });

  it("cada página do PDF embute o JPEG da SUA url — não só a contagem certa", async () => {
    const mk = async (hex: string) =>
      new Uint8Array(await sharp({ create: { width: 40, height: 50, channels: 3, background: hex } }).jpeg().toBuffer());
    const byUrl: Record<string, Uint8Array> = { a: await mk("#ff0000"), b: await mk("#00ff00"), c: await mk("#0000ff") };
    const pdf = await buildWeeklyCarouselPdf(["a", "b", "c"], async (u) => byUrl[u]);
    const buf = Buffer.from(pdf);
    // Ordem de aparição dos bytes no arquivo = ordem das páginas.
    const posA = buf.indexOf(Buffer.from(byUrl.a));
    const posB = buf.indexOf(Buffer.from(byUrl.b));
    const posC = buf.indexOf(Buffer.from(byUrl.c));
    assert.ok(posA >= 0 && posB >= 0 && posC >= 0, "os 3 JPEGs entraram");
    assert.ok(posA < posB && posB < posC, "na ordem das urls");
  });
});

describe("#8305 downloadJpeg — o caminho HTTP real, não o mock", () => {
  const origFetch = globalThis.fetch;
  function stub(res: Response): void {
    globalThis.fetch = (async () => res) as typeof fetch;
  }

  it("status não-2xx vira erro com a URL e o status", async () => {
    stub(new Response("nope", { status: 404, statusText: "Not Found" }));
    try {
      await assert.rejects(() => downloadJpeg("https://x/a.jpg"), /https:\/\/x\/a\.jpg -> 404/);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("corpo MENOR que o content-length anunciado acusa truncamento, nomeando a causa real", async () => {
    stub(new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-length": "999" } }));
    try {
      await assert.rejects(() => downloadJpeg("https://x/a.jpg"), /truncado.*999.*3|content-length/s);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("corpo vazio com 200 falha — CDN devolvendo nada não pode virar página em branco", async () => {
    stub(new Response(new Uint8Array(), { status: 200 }));
    try {
      await assert.rejects(() => downloadJpeg("https://x/a.jpg"), /corpo vazio/);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("resposta íntegra passa", async () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0x00, 0xff, 0xd9]);
    stub(new Response(bytes, { status: 200, headers: { "content-length": String(bytes.length) } }));
    try {
      assert.deepEqual(await downloadJpeg("https://x/a.jpg"), bytes);
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
