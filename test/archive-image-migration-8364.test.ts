/**
 * test/archive-image-migration-8364.test.ts (#8364)
 *
 * `media.beehiiv.com` responde por 630 das ~1.095 imagens do acervo
 * (`/p/{slug}`) — host de terceiro, em migração de saída (`publishing.
 * newsletter.backend` já é "kit", #7388). Este teste cobre o mecanismo que
 * reescreve `<img>` já migrados (bytes reais no KV `POLL`) para o host
 * próprio, e o guard anti-regressão: uma URL AUSENTE do mapa nunca é
 * tocada — nunca aponta pra uma key que não existe de fato no KV.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  loadArchiveImageMigrationMap,
  resetArchiveImageMigrationMapCache,
  rewriteMigratedBeehiivImages,
  type ArchiveImageMigrationEntry,
} from "../scripts/lib/archive-image-migration.ts";
import { buildArchivePageHtml, ARCHIVE_BASE_URL, type ArchivePost } from "../scripts/lib/site-archive-pages.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REAL_MAP_PATH = resolve(ROOT, "scripts", "lib", "archive-image-migration.json");

function makePost(overrides: Partial<ArchivePost> = {}): ArchivePost {
  return {
    slug: "post-teste",
    title: "Post de teste",
    subtitle: null,
    preview_text: null,
    meta_default_title: null,
    meta_default_description: null,
    status: "confirmed",
    web_url: "https://diaria.beehiiv.com/p/post-teste",
    displayed_date: null,
    publish_date: 1700000000,
    thumbnail_url: null,
    content: { free: { web: "<html><body><p>x</p></body></html>" } },
    ...overrides,
  };
}

describe("rewriteMigratedBeehiivImages (#8364) — pura", () => {
  const MAP: Record<string, ArchiveImageMigrationEntry> = {
    "https://media.beehiiv.com/uploads/asset/file/abc/cover.jpg": {
      key: "img-archive-deadbeef.jpg",
      alt: "Capa da edição diar.ia.br",
    },
  };

  it("reescreve src E alt de uma URL presente no mapa", () => {
    const html = `<img alt='Author' src="https://media.beehiiv.com/uploads/asset/file/abc/cover.jpg">`;
    const out = rewriteMigratedBeehiivImages(html, MAP, ARCHIVE_BASE_URL);
    assert.equal(out, `<img alt="Capa da edição diar.ia.br" src="https://diar.ia.br/img/img-archive-deadbeef.jpg">`);
  });

  it("injeta alt quando a tag original não tem nenhum", () => {
    const html = `<img src="https://media.beehiiv.com/uploads/asset/file/abc/cover.jpg">`;
    const out = rewriteMigratedBeehiivImages(html, MAP, ARCHIVE_BASE_URL);
    assert.match(out, /alt="Capa da edição diar\.ia\.br"/);
    assert.ok(out.includes("https://diar.ia.br/img/img-archive-deadbeef.jpg"));
  });

  it("NUNCA toca uma URL media.beehiiv.com AUSENTE do mapa — nunca aponta pra key que não existe no KV", () => {
    const html = `<img alt='Author' src="https://media.beehiiv.com/uploads/asset/file/outra/x.png">`;
    assert.equal(rewriteMigratedBeehiivImages(html, MAP, ARCHIVE_BASE_URL), html);
  });

  it("mapa vazio é no-op puro (mesma string, sem alocação)", () => {
    const html = `<img src="https://media.beehiiv.com/uploads/asset/file/abc/cover.jpg">`;
    assert.equal(rewriteMigratedBeehiivImages(html, {}, ARCHIVE_BASE_URL), html);
  });

  it("HTML sem <img> nenhum passa intacto", () => {
    const html = "<p>sem imagem aqui</p>";
    assert.equal(rewriteMigratedBeehiivImages(html, MAP, ARCHIVE_BASE_URL), html);
  });

  it("reescreve MÚLTIPLAS ocorrências, cada uma pra sua própria key", () => {
    const map: Record<string, ArchiveImageMigrationEntry> = {
      "https://media.beehiiv.com/a.jpg": { key: "img-archive-aaa.jpg", alt: "A" },
      "https://media.beehiiv.com/b.jpg": { key: "img-archive-bbb.jpg", alt: "B" },
    };
    const html =
      '<img src="https://media.beehiiv.com/a.jpg">' +
      '<img src="https://media.beehiiv.com/b.jpg">' +
      '<img src="https://media.beehiiv.com/c.jpg">'; // não mapeada
    const out = rewriteMigratedBeehiivImages(html, map, ARCHIVE_BASE_URL);
    assert.ok(out.includes("https://diar.ia.br/img/img-archive-aaa.jpg"));
    assert.ok(out.includes("https://diar.ia.br/img/img-archive-bbb.jpg"));
    assert.ok(out.includes("https://media.beehiiv.com/c.jpg"), "URL não mapeada deve sobreviver intacta");
  });

  it("aceita src com aspas simples", () => {
    const html = `<img alt='Author' src='https://media.beehiiv.com/uploads/asset/file/abc/cover.jpg' width='40'>`;
    const out = rewriteMigratedBeehiivImages(html, MAP, ARCHIVE_BASE_URL);
    assert.ok(out.includes("https://diar.ia.br/img/img-archive-deadbeef.jpg"));
    assert.ok(out.includes('width=\'40\'') || out.includes('width="40"'));
  });
});

describe("loadArchiveImageMigrationMap (#8364)", () => {
  let tmpDir: string;

  function withTmpFile(contents: string): string {
    tmpDir = mkdtempSync(join(tmpdir(), "diaria-archive-image-map-"));
    const path = join(tmpDir, "map.json");
    writeFileSync(path, contents, "utf8");
    return path;
  }

  it("arquivo ausente devolve mapa vazio, sem erro", () => {
    const result = loadArchiveImageMigrationMap(join(tmpdir(), "nao-existe-8364", "x.json"));
    assert.deepEqual(result, { map: {}, discarded: [] });
  });

  it("carrega entradas válidas", () => {
    const path = withTmpFile(
      JSON.stringify({ map: { "https://media.beehiiv.com/a.jpg": { key: "k1.jpg", alt: "A" } } }),
    );
    const result = loadArchiveImageMigrationMap(path);
    assert.deepEqual(result.map, { "https://media.beehiiv.com/a.jpg": { key: "k1.jpg", alt: "A" } });
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("descarta entrada malformada (sem key/alt) sem derrubar as demais", () => {
    const path = withTmpFile(
      JSON.stringify({
        map: {
          "https://media.beehiiv.com/ok.jpg": { key: "k1.jpg", alt: "ok" },
          "https://media.beehiiv.com/bad.jpg": { key: "" },
        },
      }),
    );
    const result = loadArchiveImageMigrationMap(path);
    assert.deepEqual(Object.keys(result.map), ["https://media.beehiiv.com/ok.jpg"]);
    assert.equal(result.discarded.length, 1);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("JSON malformado seta error e devolve mapa vazio (fail-soft, nunca lança)", () => {
    const path = withTmpFile("{ isto não é json");
    const result = loadArchiveImageMigrationMap(path);
    assert.deepEqual(result.map, {});
    assert.ok(result.error);
    rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe("buildArchivePageHtml — integração real com o mapa committed (#8364)", () => {
  it("acervo real: uma URL media.beehiiv.com AUSENTE do mapa committed passa intocada (a migração real já rodou — esta fixture usa uma URL sintética que nunca esteve no acervo, então segue fora do mapa de propósito)", () => {
    const post = makePost({
      content: {
        free: {
          web:
            '<html><body><img alt="Author" src="https://media.beehiiv.com/uploads/user/profile_picture/x/thumb.jpeg"></body></html>',
        },
      },
    });
    const html = buildArchivePageHtml(post);
    // Nada no mapa committed hoje (#8364 ainda não rodou a migração real) —
    // a URL sobrevive intacta, nunca aponta pra uma key inexistente no KV.
    assert.ok(html.includes("https://media.beehiiv.com/uploads/user/profile_picture/x/thumb.jpeg"));
  });

  it("end-to-end: com uma entrada REAL no mapa committed, buildArchivePageHtml reescreve o <img>", () => {
    const original = readFileSync(REAL_MAP_PATH, "utf8");
    try {
      writeFileSync(
        REAL_MAP_PATH,
        JSON.stringify({
          map: {
            "https://media.beehiiv.com/uploads/asset/file/teste-8364/cover.jpg": {
              key: "img-archive-teste8364.jpg",
              alt: "Capa de teste",
            },
          },
        }),
        "utf8",
      );
      resetArchiveImageMigrationMapCache();
      const post = makePost({
        content: {
          free: {
            web: '<html><body><img src="https://media.beehiiv.com/uploads/asset/file/teste-8364/cover.jpg"></body></html>',
          },
        },
      });
      const html = buildArchivePageHtml(post);
      assert.ok(html.includes("https://diar.ia.br/img/img-archive-teste8364.jpg"));
      assert.ok(!html.includes("media.beehiiv.com"));
      assert.match(html, /alt="Capa de teste"/);
    } finally {
      writeFileSync(REAL_MAP_PATH, original, "utf8");
      resetArchiveImageMigrationMapCache();
    }
  });
});
