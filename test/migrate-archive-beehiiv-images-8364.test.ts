/**
 * test/migrate-archive-beehiiv-images-8364.test.ts (#8364)
 *
 * Cobre o miolo puro/testável de `migrate-archive-beehiiv-images.ts` — o
 * script que baixa os bytes de `media.beehiiv.com` e os sobe pro KV `POLL`.
 * Sem rede real (`fetchImpl`/`uploadImpl` injetados, mesmo padrão de
 * `uploadPublicImages`/`UploadDeps` em `upload-images-public.ts`) — este
 * repo nunca deve gastar uma chamada de rede real durante `npm test`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  extractMediaBeehiivImageUrls,
  deriveArchiveImageKey,
  deriveArchiveImageAlt,
  runArchiveImageMigration,
} from "../scripts/migrate-archive-beehiiv-images.ts";

describe("extractMediaBeehiivImageUrls (#8364)", () => {
  it("extrai só src de <img>, deduplicado, ignora outros hosts", () => {
    const html =
      '<img src="https://media.beehiiv.com/a.jpg">' +
      '<img src="https://media.beehiiv.com/a.jpg">' + // duplicada
      '<img src="https://media.beehiiv.com/b.jpg">' +
      '<img src="https://poll.diaria.workers.dev/img/c.jpg">' +
      '<a href="https://media.beehiiv.com/nao-e-img.jpg">link</a>';
    assert.deepEqual(extractMediaBeehiivImageUrls(html), [
      "https://media.beehiiv.com/a.jpg",
      "https://media.beehiiv.com/b.jpg",
    ]);
  });

  it("html sem nenhuma imagem beehiiv devolve array vazio", () => {
    assert.deepEqual(extractMediaBeehiivImageUrls("<p>sem imagem</p>"), []);
  });

  it("aceita aspas simples", () => {
    assert.deepEqual(extractMediaBeehiivImageUrls("<img src='https://media.beehiiv.com/x.png'>"), [
      "https://media.beehiiv.com/x.png",
    ]);
  });
});

describe("deriveArchiveImageKey (#8364)", () => {
  it("é determinística — mesma URL sempre produz a mesma key", () => {
    const url = "https://media.beehiiv.com/uploads/asset/file/x/cover.jpg?t=123";
    assert.equal(deriveArchiveImageKey(url), deriveArchiveImageKey(url));
  });

  it("URLs diferentes produzem keys diferentes", () => {
    assert.notEqual(
      deriveArchiveImageKey("https://media.beehiiv.com/a.jpg"),
      deriveArchiveImageKey("https://media.beehiiv.com/b.jpg"),
    );
  });

  it("prefixo img-archive- evita colisão com keys por-edição (img-{AAMMDD}-...)", () => {
    assert.match(deriveArchiveImageKey("https://media.beehiiv.com/a.jpg"), /^img-archive-[0-9a-f]{16}\.jpg$/);
  });

  it("preserva a extensão real (png), normaliza jpeg->jpg, cai pra jpg sem extensão reconhecível", () => {
    assert.match(deriveArchiveImageKey("https://media.beehiiv.com/a.png"), /\.png$/);
    assert.match(deriveArchiveImageKey("https://media.beehiiv.com/a.jpeg"), /\.jpg$/);
    assert.match(deriveArchiveImageKey("https://media.beehiiv.com/a.gif"), /\.gif$/);
    assert.match(deriveArchiveImageKey("https://media.beehiiv.com/sem-extensao"), /\.jpg$/);
  });

  it("ignora a query string (?t=...) ao derivar a extensão", () => {
    assert.match(deriveArchiveImageKey("https://media.beehiiv.com/a.png?t=1773439090"), /\.png$/);
  });
});

describe("deriveArchiveImageAlt (#8364)", () => {
  it("avatar de autor", () => {
    assert.equal(
      deriveArchiveImageAlt("https://media.beehiiv.com/uploads/user/profile_picture/x/thumb.jpeg"),
      "Foto de perfil do autor da diar.ia.br",
    );
  });

  it("logo de anunciante do ad network", () => {
    assert.equal(
      deriveArchiveImageAlt("https://media.beehiiv.com/uploads/ad_network/advertiser/logo/x/deel.png"),
      "Logotipo do anunciante",
    );
  });

  it("capa de edição (filename com 'cover')", () => {
    assert.equal(
      deriveArchiveImageAlt("https://media.beehiiv.com/uploads/asset/file/x/260313_cover.jpg"),
      "Capa da edição diar.ia.br",
    );
  });

  it("genérico pra path desconhecido — nunca lança", () => {
    assert.equal(
      deriveArchiveImageAlt("https://media.beehiiv.com/uploads/asset/file/x/random-image.png"),
      "Imagem da edição diar.ia.br",
    );
  });
});

describe("runArchiveImageMigration (#8364) — sem rede real", () => {
  function withPagesDir(htmlBySlug: Record<string, string>): { dir: string; cleanup: () => void } {
    const dir = mkdtempSync(join(tmpdir(), "diaria-archive-migration-"));
    for (const [slug, html] of Object.entries(htmlBySlug)) {
      const slugDir = join(dir, slug);
      mkdirSync(slugDir);
      writeFileSync(join(slugDir, "index.html"), html, "utf8");
    }
    return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  }

  it("baixa + sobe cada URL nova e grava o mapa", async () => {
    const { dir, cleanup } = withPagesDir({
      "edicao-1": '<img src="https://media.beehiiv.com/a.jpg">',
      "edicao-2": '<img src="https://media.beehiiv.com/a.jpg"><img src="https://media.beehiiv.com/b.jpg">',
    });
    const mapDir = mkdtempSync(join(tmpdir(), "diaria-archive-migration-map-"));
    const mapPath = join(mapDir, "map.json");
    try {
      const fetched: string[] = [];
      const uploaded: { key: string }[] = [];
      const result = await runArchiveImageMigration({
        pagesDir: dir,
        mapPath,
        dryRun: false,
        fetchImpl: async (url) => {
          fetched.push(url);
          return new ArrayBuffer(8);
        },
        uploadImpl: async (_bytes, key) => {
          uploaded.push({ key });
        },
      });

      assert.equal(result.scanned, 2, "2 URLs únicas: a.jpg e b.jpg");
      assert.equal(result.alreadyMigrated, 0);
      assert.equal(result.newlyMigrated.length, 2);
      assert.equal(fetched.length, 2, "a.jpg baixada só 1 vez mesmo citada em 2 páginas");
      assert.equal(uploaded.length, 2);
      assert.equal(result.failed.length, 0);

      const written = JSON.parse(readFileSync(mapPath, "utf8"));
      assert.equal(Object.keys(written.map).length, 2);
      assert.ok(written.map["https://media.beehiiv.com/a.jpg"].key);
    } finally {
      cleanup();
      rmSync(mapDir, { recursive: true, force: true });
    }
  });

  it("skip forever — URL já no mapa nunca é rebaixada/reuploadada (#2886, mesma semântica)", async () => {
    const { dir, cleanup } = withPagesDir({ "edicao-1": '<img src="https://media.beehiiv.com/a.jpg">' });
    const mapDir = mkdtempSync(join(tmpdir(), "diaria-archive-migration-map-"));
    const mapPath = join(mapDir, "map.json");
    writeFileSync(
      mapPath,
      JSON.stringify({ map: { "https://media.beehiiv.com/a.jpg": { key: "img-archive-ja.jpg", alt: "já migrada" } } }),
    );
    try {
      let fetchCalls = 0;
      const result = await runArchiveImageMigration({
        pagesDir: dir,
        mapPath,
        dryRun: false,
        fetchImpl: async () => {
          fetchCalls++;
          return new ArrayBuffer(8);
        },
        uploadImpl: async () => {},
      });
      assert.equal(fetchCalls, 0, "URL já migrada não deveria ser baixada de novo");
      assert.equal(result.alreadyMigrated, 1);
      assert.equal(result.newlyMigrated.length, 0);
    } finally {
      cleanup();
      rmSync(mapDir, { recursive: true, force: true });
    }
  });

  it("--dry-run baixa (pra validar a URL) mas NUNCA sobe nem grava o mapa", async () => {
    const { dir, cleanup } = withPagesDir({ "edicao-1": '<img src="https://media.beehiiv.com/a.jpg">' });
    const mapDir = mkdtempSync(join(tmpdir(), "diaria-archive-migration-map-"));
    const mapPath = join(mapDir, "map.json");
    try {
      let uploadCalls = 0;
      const result = await runArchiveImageMigration({
        pagesDir: dir,
        mapPath,
        dryRun: true,
        fetchImpl: async () => new ArrayBuffer(8),
        uploadImpl: async () => {
          uploadCalls++;
        },
      });
      assert.equal(uploadCalls, 0, "dry-run nunca sobe bytes de verdade");
      assert.equal(result.newlyMigrated.length, 1, "ainda reporta o que faria");
      assert.equal(existsSync(mapPath), false, "dry-run nunca cria/sobrescreve o arquivo de mapa");
    } finally {
      cleanup();
      rmSync(mapDir, { recursive: true, force: true });
    }
  });

  it("falha de download de UMA url não impede as outras — reportada em failed[], nunca aborta o lote", async () => {
    const { dir, cleanup } = withPagesDir({
      "edicao-1": '<img src="https://media.beehiiv.com/ok.jpg"><img src="https://media.beehiiv.com/quebrada.jpg">',
    });
    const mapDir = mkdtempSync(join(tmpdir(), "diaria-archive-migration-map-"));
    const mapPath = join(mapDir, "map.json");
    try {
      const result = await runArchiveImageMigration({
        pagesDir: dir,
        mapPath,
        dryRun: false,
        fetchImpl: async (url) => {
          if (url.includes("quebrada")) throw new Error("404");
          return new ArrayBuffer(8);
        },
        uploadImpl: async () => {},
      });
      assert.equal(result.newlyMigrated.length, 1);
      assert.equal(result.failed.length, 1);
      assert.match(result.failed[0].url, /quebrada/);
    } finally {
      cleanup();
      rmSync(mapDir, { recursive: true, force: true });
    }
  });

  it("--limit corta o lote desta rodada, deixando o resto pra próxima (resumível)", async () => {
    const { dir, cleanup } = withPagesDir({
      "edicao-1": '<img src="https://media.beehiiv.com/a.jpg"><img src="https://media.beehiiv.com/b.jpg">',
    });
    const mapDir = mkdtempSync(join(tmpdir(), "diaria-archive-migration-map-"));
    const mapPath = join(mapDir, "map.json");
    try {
      const result = await runArchiveImageMigration({
        pagesDir: dir,
        mapPath,
        dryRun: false,
        limit: 1,
        fetchImpl: async () => new ArrayBuffer(8),
        uploadImpl: async () => {},
      });
      assert.equal(result.newlyMigrated.length, 1);
    } finally {
      cleanup();
      rmSync(mapDir, { recursive: true, force: true });
    }
  });
});
