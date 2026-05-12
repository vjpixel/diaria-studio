import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  publicImageUrl,
  publicFileViewUrl,
  mimeTypeFor,
  sourceImageFor,
  imageSpecsFor,
} from "../scripts/upload-images-public.ts";

const __ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("upload-images-public env auto-load (regression #1157)", () => {
  it("chama loadProjectEnv() em scope top-level antes de outros imports", () => {
    const src = readFileSync(
      resolve(__ROOT, "scripts/upload-images-public.ts"),
      "utf8",
    );
    // Verifica import + chamada — guarda contra remoção acidental do loader.
    // Sem isso, chamada direta `npx tsx scripts/upload-images-public.ts`
    // falha com "CLOUDFLARE_ACCOUNT_ID undefined" mesmo com `.env` populado.
    assert.match(
      src,
      /import\s+\{\s*loadProjectEnv\s*\}\s+from\s+["']\.\/lib\/env-loader\.ts["']/,
      "scripts/upload-images-public.ts deve importar loadProjectEnv de lib/env-loader",
    );
    assert.match(
      src,
      /^loadProjectEnv\(\)/m,
      "scripts/upload-images-public.ts deve chamar loadProjectEnv() em scope top-level",
    );
  });
});

describe("publicImageUrl", () => {
  it("constrói URL com uc?id + export=view", () => {
    assert.equal(
      publicImageUrl("abc123"),
      "https://drive.google.com/uc?id=abc123&export=view",
    );
  });

  it("aceita IDs com caracteres válidos de Drive", () => {
    const id = "1a2b_-Xyz.ZZZ";
    assert.ok(publicImageUrl(id).includes(id));
  });
});

describe("publicFileViewUrl", () => {
  it("constrói URL formato /file/d/ID/view", () => {
    assert.equal(
      publicFileViewUrl("abc123"),
      "https://drive.google.com/file/d/abc123/view?usp=sharing",
    );
  });
});

describe("mimeTypeFor", () => {
  it("jpg/jpeg → image/jpeg", () => {
    assert.equal(mimeTypeFor("foo.jpg"), "image/jpeg");
    assert.equal(mimeTypeFor("foo.jpeg"), "image/jpeg");
    assert.equal(mimeTypeFor("FOO.JPG"), "image/jpeg");
  });

  it("png → image/png", () => {
    assert.equal(mimeTypeFor("foo.png"), "image/png");
  });

  it("webp → image/webp", () => {
    assert.equal(mimeTypeFor("foo.webp"), "image/webp");
  });

  it("gif → image/gif", () => {
    assert.equal(mimeTypeFor("foo.gif"), "image/gif");
  });

  it("desconhecido → octet-stream", () => {
    assert.equal(mimeTypeFor("foo.tif"), "application/octet-stream");
    assert.equal(mimeTypeFor("foo"), "application/octet-stream");
  });
});

describe("sourceImageFor", () => {
  it("d1 usa variante 1x1 (square) pra social", () => {
    assert.equal(sourceImageFor("d1"), "04-d1-1x1.jpg");
  });

  it("d2 usa variante 1x1 (#372)", () => {
    assert.equal(sourceImageFor("d2"), "04-d2-1x1.jpg");
  });

  it("d3 usa variante 1x1 (#372)", () => {
    assert.equal(sourceImageFor("d3"), "04-d3-1x1.jpg");
  });
});

describe("imageSpecsFor (#192 — runtime detection A/B vs legacy)", () => {
  function makeDir(): string {
    return mkdtempSync(join(tmpdir(), "diaria-imgspec-"));
  }

  function touch(path: string): void {
    writeFileSync(path, "x");
  }

  it("newsletter mode sem editionDir → default A/B", () => {
    const specs = imageSpecsFor("newsletter");
    const keys = specs.map((s) => s.key);
    assert.ok(keys.includes("eia_a"));
    assert.ok(keys.includes("eia_b"));
    assert.ok(!keys.includes("eia_real"));
  });

  it("newsletter mode NÃO inclui d2/d3 (#1121 — não usados pelo renderer)", () => {
    // Renderer (render-newsletter-html.ts) só substitui placeholders pra
    // cover D1 + È IA? A/B. D2/D3 não têm imagem inline na newsletter
    // (memory feedback_newsletter_only_d1_image.md).
    const specs = imageSpecsFor("newsletter");
    const keys = specs.map((s) => s.key);
    assert.ok(!keys.includes("d2"), "d2 não deve estar em newsletter mode");
    assert.ok(!keys.includes("d3"), "d3 não deve estar em newsletter mode");
    assert.deepEqual(
      keys.sort(),
      ["cover", "eia_a", "eia_b"].sort(),
      "newsletter = cover + eia_a + eia_b",
    );
  });

  it("newsletter mode com editionDir + 01-eia-A.jpg + 01-eia-B.jpg → eia_a/eia_b", () => {
    const dir = makeDir();
    try {
      touch(join(dir, "01-eia-A.jpg"));
      touch(join(dir, "01-eia-B.jpg"));
      const specs = imageSpecsFor("newsletter", dir);
      const keys = specs.map((s) => s.key);
      assert.ok(keys.includes("eia_a"));
      assert.ok(keys.includes("eia_b"));
      assert.ok(!keys.includes("eia_real"));
      const eiaA = specs.find((s) => s.key === "eia_a");
      assert.equal(eiaA?.filename, "01-eia-A.jpg");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("newsletter mode com editionDir + 01-eia-real.jpg (legacy) → eia_real/eia_ia", () => {
    const dir = makeDir();
    try {
      touch(join(dir, "01-eia-real.jpg"));
      touch(join(dir, "01-eia-ia.jpg"));
      // sem A/B
      const specs = imageSpecsFor("newsletter", dir);
      const keys = specs.map((s) => s.key);
      assert.ok(keys.includes("eia_real"));
      assert.ok(keys.includes("eia_ia"));
      assert.ok(!keys.includes("eia_a"));
      const eiaReal = specs.find((s) => s.key === "eia_real");
      assert.equal(eiaReal?.filename, "01-eia-real.jpg");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("newsletter mode com editionDir mas só 01-eia-A.jpg (sem B) → cai pra default A/B", () => {
    // Edge case: meio caminho. Default ainda é A/B; o consumer (loop)
    // vai falhar ao tentar ler 01-eia-B.jpg ausente.
    const dir = makeDir();
    try {
      touch(join(dir, "01-eia-A.jpg"));
      // sem B, sem real
      const specs = imageSpecsFor("newsletter", dir);
      const keys = specs.map((s) => s.key);
      assert.ok(keys.includes("eia_a"));
      assert.ok(keys.includes("eia_b"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("social mode não inclui specs eia (independente de editionDir)", () => {
    const dir = makeDir();
    try {
      touch(join(dir, "01-eia-A.jpg"));
      touch(join(dir, "01-eia-B.jpg"));
      const specs = imageSpecsFor("social", dir);
      const keys = specs.map((s) => s.key);
      assert.ok(!keys.includes("eia_a"));
      assert.ok(!keys.includes("eia_real"));
      assert.deepEqual(keys, ["d1", "d2", "d3"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("all mode inclui social + newsletter dedup'ado, com eia detectado", () => {
    const dir = makeDir();
    try {
      touch(join(dir, "01-eia-A.jpg"));
      touch(join(dir, "01-eia-B.jpg"));
      const specs = imageSpecsFor("all", dir);
      const keys = specs.map((s) => s.key);
      // social: d1, d2, d3
      assert.ok(keys.includes("d1"));
      assert.ok(keys.includes("d2"));
      assert.ok(keys.includes("d3"));
      // newsletter: cover, eia_a, eia_b (#1121: d2/d3 não vão mais aqui)
      assert.ok(keys.includes("cover"));
      assert.ok(keys.includes("eia_a"));
      assert.ok(keys.includes("eia_b"));
      // sem dups (d2/d3 só vêm de social agora — sem chance de dup)
      assert.equal(keys.filter((k) => k === "d2").length, 1);
      assert.equal(keys.filter((k) => k === "d3").length, 1);
      assert.equal(keys.length, new Set(keys).size, "sem keys duplicadas");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
