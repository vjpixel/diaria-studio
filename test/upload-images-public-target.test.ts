/**
 * upload-images-public-target.test.ts (#1119)
 *
 * Cobre os helpers puros adicionados em #1119 pra distinguir target
 * Drive vs Cloudflare. Não testa upload real — função `uploadPublicImages`
 * faz network IO, fora do escopo. Cobertura focada em:
 * - `defaultTargetFor(mode)`: dispatch correto por modo.
 * - `cloudflareKvKey(editionDir, filename)`: key naming convention.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  defaultTargetFor,
  cloudflareKvKey,
  type UploadMode,
} from "../scripts/upload-images-public.ts";

describe("defaultTargetFor (#1119)", () => {
  it("newsletter → cloudflare (URLs estáveis pra email)", () => {
    assert.equal(defaultTargetFor("newsletter"), "cloudflare");
  });

  it("all → cloudflare (newsletter manda)", () => {
    assert.equal(defaultTargetFor("all"), "cloudflare");
  });

  it("social → drive (LinkedIn/Facebook OG preview)", () => {
    assert.equal(defaultTargetFor("social"), "drive");
  });

  it("é determinístico — chamadas repetidas retornam o mesmo target", () => {
    for (const m of ["social", "newsletter", "all"] as UploadMode[]) {
      const a = defaultTargetFor(m);
      const b = defaultTargetFor(m);
      assert.equal(a, b);
    }
  });
});

describe("cloudflareKvKey (#1119)", () => {
  it("formato img-{AAMMDD}-{filename}", () => {
    assert.equal(
      cloudflareKvKey("data/editions/260512", "04-d1-2x1.jpg"),
      "img-260512-04-d1-2x1.jpg",
    );
  });

  it("aceita trailing slash no editionDir", () => {
    assert.equal(
      cloudflareKvKey("data/editions/260512/", "01-eia-A.jpg"),
      "img-260512-01-eia-A.jpg",
    );
  });

  it("aceita Windows-style paths (backslash)", () => {
    assert.equal(
      cloudflareKvKey("data\\editions\\260512", "01-eia-B.jpg"),
      "img-260512-01-eia-B.jpg",
    );
  });

  it("fallback img-unknown- quando não há AAMMDD no path", () => {
    assert.equal(
      cloudflareKvKey("/some/random/path", "image.jpg"),
      "img-unknown-image.jpg",
    );
  });

  it("respeita filename exato (case-sensitive, sem normalização)", () => {
    // 01-eia-A.jpg ≠ 01-eia-a.jpg — Worker key é case-sensitive
    assert.notEqual(
      cloudflareKvKey("data/editions/260512", "01-eia-A.jpg"),
      cloudflareKvKey("data/editions/260512", "01-eia-a.jpg"),
    );
  });

  it("evita colisão entre edições diferentes", () => {
    const k1 = cloudflareKvKey("data/editions/260512", "04-d1-2x1.jpg");
    const k2 = cloudflareKvKey("data/editions/260513", "04-d1-2x1.jpg");
    assert.notEqual(k1, k2);
  });

  it("key é URL-safe (sem espaços, caracteres ASCII)", () => {
    const k = cloudflareKvKey("data/editions/260512", "04-d1-2x1.jpg");
    assert.match(k, /^[a-zA-Z0-9._-]+$/, "key deve ser URL-safe");
  });
});
