/**
 * test/monthly-public-images.test.ts (#14049)
 *
 * `missingImageKeys`/`EXPECTED_IMAGE_KEYS`/`readPublicImages` desceram de
 * `scripts/render-monthly-apoiadores-brevo.ts` (apagado no #14049) para
 * `scripts/lib/mensal/monthly-public-images.ts`. Os casos de
 * `missingImageKeys` vêm de `test/render-monthly-apoiadores-brevo.test.ts`
 * (#4510, achado silent-failure-hunter: chave de imagem ausente degradava em
 * silêncio).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { missingImageKeys, EXPECTED_IMAGE_KEYS, readPublicImages } from "../scripts/lib/mensal/monthly-public-images.ts";
import type { MonthlyPublicImage } from "../scripts/monthly-preview-cloudflare.ts";

const img = (url = "https://img/x.jpg"): MonthlyPublicImage => ({ url, filename: "x.jpg", mime_type: "image/jpeg" });

describe("#4510 — missingImageKeys", () => {
  it("manifest completo → nenhuma chave faltando", () => {
    const images: Record<string, MonthlyPublicImage> = {};
    for (const k of EXPECTED_IMAGE_KEYS) images[k] = img();
    assert.deepEqual(missingImageKeys(images), []);
  });

  it("manifest vazio → todas as 6 chaves faltando", () => {
    assert.deepEqual(missingImageKeys({}), [...EXPECTED_IMAGE_KEYS]);
  });

  it("enumera só as chaves ausentes (não as presentes)", () => {
    const images: Record<string, MonthlyPublicImage> = { d1: img(), d2: img(), eia_a: img() };
    assert.deepEqual(missingImageKeys(images), ["d3", "eia_b", "livros_promo"]);
  });

  it("chave presente mas sem url conta como ausente", () => {
    const images: Record<string, MonthlyPublicImage> = { d1: { url: "", filename: "x", mime_type: "image/jpeg" } };
    assert.ok(missingImageKeys(images).includes("d1"));
  });
});

describe("#14049 — readPublicImages", () => {
  it("lê `images` de _internal/public-images.json do ciclo", () => {
    const dir = mkdtempSync(join(tmpdir(), "monthly-public-images-14049-"));
    try {
      mkdirSync(join(dir, "_internal"));
      writeFileSync(join(dir, "_internal", "public-images.json"), JSON.stringify({ images: { d1: img("https://img/d1.jpg") } }));
      assert.equal(readPublicImages(dir).d1.url, "https://img/d1.jpg");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("manifest sem `images` → objeto vazio (não lança)", () => {
    const dir = mkdtempSync(join(tmpdir(), "monthly-public-images-14049-"));
    try {
      mkdirSync(join(dir, "_internal"));
      writeFileSync(join(dir, "_internal", "public-images.json"), "{}");
      assert.deepEqual(readPublicImages(dir), {});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
