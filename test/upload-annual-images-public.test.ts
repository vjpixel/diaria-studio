/**
 * test/upload-annual-images-public.test.ts (#7587 item 4)
 *
 * `upload-images-public.ts` (diária) não serve a anual — formato 1x1,
 * `06-public-images.json` aninhado. Este é o equivalente pra N imagens 2:1
 * de tema, gravando `public-images.json` ACHATADO (URL -> filename), o
 * formato que `publish-annual-kit.ts` já lê. Testado sem rede via
 * `opts.uploaders` (mesmo seam que `uploadPublicImages` usa na diária).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  findThemeImages,
  annualKvKey,
  uploadAnnualImages,
  md5CachePathFor,
} from "../scripts/upload-annual-images-public.ts";

function withEditionDir(files: string[]): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "annual-images-"));
  for (const f of files) writeFileSync(join(dir, f), `bytes-of-${f}`);
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("findThemeImages — N variável, nunca fixo em 3", () => {
  it("acha só os arquivos 04-d{N}-2x1.jpg, ordenados por N", () => {
    const { dir, cleanup } = withEditionDir([
      "04-d3-2x1.jpg",
      "04-d1-2x1.jpg",
      "04-d2-2x1.jpg",
      "04-d1-1x1.jpg", // formato errado — não é imagem de tema anual
      "draft.md",
    ]);
    try {
      const out = findThemeImages(dir);
      assert.deepEqual(out.map((t) => t.index), [1, 2, 3]);
      assert.deepEqual(out.map((t) => t.filename), ["04-d1-2x1.jpg", "04-d2-2x1.jpg", "04-d3-2x1.jpg"]);
    } finally {
      cleanup();
    }
  });

  it("N=7 (teto da anual) é achado inteiro, sem corte", () => {
    const files = Array.from({ length: 7 }, (_, i) => `04-d${i + 1}-2x1.jpg`);
    const { dir, cleanup } = withEditionDir(files);
    try {
      assert.equal(findThemeImages(dir).length, 7);
    } finally {
      cleanup();
    }
  });

  it("diretório sem nenhuma imagem de tema devolve lista vazia, não lança", () => {
    const { dir, cleanup } = withEditionDir(["draft.md"]);
    try {
      assert.deepEqual(findThemeImages(dir), []);
    } finally {
      cleanup();
    }
  });
});

describe("annualKvKey", () => {
  it("é única por slug + arquivo + md5, com cache-bust", () => {
    const k1 = annualKvKey("2026-aniversario", "04-d1-2x1.jpg", "abcdef1234567890");
    const k2 = annualKvKey("2026-janeiro", "04-d1-2x1.jpg", "abcdef1234567890");
    assert.notEqual(k1, k2, "slugs diferentes não podem colidir na mesma key");
    assert.ok(k1.startsWith("img-annual-2026-aniversario-04-d1-2x1-"));
    assert.ok(k1.endsWith(".jpg"));
  });
});

describe("uploadAnnualImages — grava public-images.json achatado (URL -> filename)", () => {
  it("sobe cada tema e grava o mapa no formato que publish-annual-kit.ts lê", async () => {
    const { dir, cleanup } = withEditionDir(["04-d1-2x1.jpg", "04-d2-2x1.jpg"]);
    const cachePath = join(dir, "public-images.json");
    try {
      const uploaded: string[] = [];
      const result = await uploadAnnualImages({
        slug: "2026-aniversario",
        editionDir: dir,
        cachePath,
        uploaders: {
          uploadToCloudflare: async (path, key) => {
            uploaded.push(key);
            return `https://eia.diar.ia.br/img/${key}`;
          },
        },
      });
      assert.equal(result.themes_found, 2);
      assert.equal(result.uploaded, 2);
      assert.equal(uploaded.length, 2);

      const onDisk = JSON.parse(readFileSync(cachePath, "utf8"));
      const filenames = Object.values(onDisk).sort();
      assert.deepEqual(filenames, ["04-d1-2x1.jpg", "04-d2-2x1.jpg"]);
      for (const [url, filename] of Object.entries(onDisk) as [string, string][]) {
        assert.ok(url.startsWith("https://eia.diar.ia.br/img/"));
        assert.ok(url.includes(String(filename).replace(".jpg", "")));
      }
    } finally {
      cleanup();
    }
  });

  it("re-run com --no-cache equivalente (skipExisting=false) força re-upload", async () => {
    const { dir, cleanup } = withEditionDir(["04-d1-2x1.jpg"]);
    const cachePath = join(dir, "public-images.json");
    try {
      let calls = 0;
      const uploader = {
        uploadToCloudflare: async (path: string, key: string) => {
          calls++;
          return `https://eia.diar.ia.br/img/${key}`;
        },
      };
      await uploadAnnualImages({ slug: "2026-aniversario", editionDir: dir, cachePath, uploaders: uploader });
      assert.equal(calls, 1);

      // skipExisting=true (default) reusa — mesmo filename já no cache.
      const r2 = await uploadAnnualImages({ slug: "2026-aniversario", editionDir: dir, cachePath, uploaders: uploader });
      assert.equal(calls, 1, "reuse não deveria re-chamar o uploader");
      assert.equal(r2.reused, 1);

      // skipExisting=false força re-upload.
      await uploadAnnualImages({
        slug: "2026-aniversario",
        editionDir: dir,
        cachePath,
        skipExisting: false,
        uploaders: uploader,
      });
      assert.equal(calls, 2, "--no-cache deveria forçar novo upload");
    } finally {
      cleanup();
    }
  });

  it("#7618: md5 diferente com mesmo filename NÃO reusa — faz upload novo", async () => {
    const { dir, cleanup } = withEditionDir(["04-d1-2x1.jpg"]);
    const cachePath = join(dir, "public-images.json");
    try {
      let calls = 0;
      const uploader = {
        uploadToCloudflare: async (path: string, key: string) => {
          calls++;
          return `https://eia.diar.ia.br/img/${key}`;
        },
      };
      await uploadAnnualImages({ slug: "2026-aniversario", editionDir: dir, cachePath, uploaders: uploader });
      assert.equal(calls, 1);

      // Regenerar o arquivo local com o MESMO filename mas bytes diferentes —
      // o cenário de falha real da issue (imagem de tema reprocessada antes
      // de publicar, filename inalterado).
      writeFileSync(join(dir, "04-d1-2x1.jpg"), "bytes-completamente-diferentes-agora");

      const r2 = await uploadAnnualImages({ slug: "2026-aniversario", editionDir: dir, cachePath, uploaders: uploader });
      assert.equal(calls, 2, "md5 divergente deveria forçar re-upload, não reuse por filename");
      assert.equal(r2.uploaded, 1);
      assert.equal(r2.reused, 0);

      const md5CachePath = md5CachePathFor(cachePath);
      const md5s = JSON.parse(readFileSync(md5CachePath, "utf8"));
      assert.ok(md5s["04-d1-2x1.jpg"], "sidecar de md5 grava o hash real dos bytes atuais");

      // Achado do self-review do #7619: `images` é keyed por URL — sem podar
      // a entry antiga, a URL da 1ª upload (apontando pro blob KV stale)
      // ficava pra trás junto da nova, acumulando 1 URL morta por regeneração.
      const onDisk = JSON.parse(readFileSync(cachePath, "utf8"));
      const entriesForFile = Object.entries(onDisk).filter(([, f]) => f === "04-d1-2x1.jpg");
      assert.equal(entriesForFile.length, 1, "re-upload deve substituir a URL antiga, não acumular");
    } finally {
      cleanup();
    }
  });

  it("md5 idêntico com mesmo filename reusa (via sidecar), sem re-chamar o uploader", async () => {
    const { dir, cleanup } = withEditionDir(["04-d1-2x1.jpg"]);
    const cachePath = join(dir, "public-images.json");
    try {
      let calls = 0;
      const uploader = {
        uploadToCloudflare: async (path: string, key: string) => {
          calls++;
          return `https://eia.diar.ia.br/img/${key}`;
        },
      };
      await uploadAnnualImages({ slug: "2026-aniversario", editionDir: dir, cachePath, uploaders: uploader });
      assert.equal(calls, 1);

      // Bytes locais inalterados — reuse de verdade, não só filename.
      const r2 = await uploadAnnualImages({ slug: "2026-aniversario", editionDir: dir, cachePath, uploaders: uploader });
      assert.equal(calls, 1, "md5 idêntico deveria reusar sem re-upload");
      assert.equal(r2.reused, 1);
    } finally {
      cleanup();
    }
  });

  it("preserva entries de outros temas já no cache (merge, não sobrescrita)", async () => {
    const { dir, cleanup } = withEditionDir(["04-d1-2x1.jpg"]);
    const cachePath = join(dir, "public-images.json");
    writeFileSync(cachePath, JSON.stringify({ "https://eia.diar.ia.br/img/old-key.jpg": "04-d9-2x1.jpg" }));
    try {
      await uploadAnnualImages({
        slug: "2026-aniversario",
        editionDir: dir,
        cachePath,
        uploaders: { uploadToCloudflare: async (p, key) => `https://eia.diar.ia.br/img/${key}` },
      });
      const onDisk = JSON.parse(readFileSync(cachePath, "utf8"));
      assert.equal(onDisk["https://eia.diar.ia.br/img/old-key.jpg"], "04-d9-2x1.jpg", "entry antiga preservada");
      assert.equal(Object.keys(onDisk).length, 2);
    } finally {
      cleanup();
    }
  });
});
