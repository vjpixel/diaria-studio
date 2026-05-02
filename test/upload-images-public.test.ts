import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  publicImageUrl,
  publicFileViewUrl,
  mimeTypeFor,
  sourceImageFor,
  imageSpecsFor,
} from "../scripts/upload-images-public.ts";

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
      // newsletter: cover, d2, d3 (dedup com social), eia_a, eia_b
      assert.ok(keys.includes("cover"));
      assert.ok(keys.includes("eia_a"));
      assert.ok(keys.includes("eia_b"));
      // dedup: d2 e d3 só aparecem uma vez
      assert.equal(keys.filter((k) => k === "d2").length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
