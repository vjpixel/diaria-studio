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
  kvKeyForSpec,
  type UploadMode,
  type ImageSpec,
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

describe("cloudflareKvKey — md5 suffix (#1584)", () => {
  const MD5_HEX = "abcdef1234567890abcdef1234567890";

  it("sem md5 → formato legacy preservado", () => {
    assert.equal(
      cloudflareKvKey("data/editions/260529", "04-d1-1x1.jpg"),
      "img-260529-04-d1-1x1.jpg",
    );
  });

  it("com md5 → adiciona sufixo {md5short} antes da extensão", () => {
    assert.equal(
      cloudflareKvKey("data/editions/260529", "04-d1-1x1.jpg", MD5_HEX),
      "img-260529-04-d1-1x1-abcdef12.jpg",
    );
  });

  it("md5short é exatamente 8 chars (não a hash inteira)", () => {
    const key = cloudflareKvKey("data/editions/260529", "img.png", MD5_HEX);
    assert.match(key, /-abcdef12\.png$/);
  });

  it("filename sem extensão → md5 no fim, sem ponto", () => {
    assert.equal(
      cloudflareKvKey("data/editions/260529", "noext", MD5_HEX),
      "img-260529-noext-abcdef12",
    );
  });

  it("re-upload com md5 diferente gera key diferente (cache-bust)", () => {
    const k1 = cloudflareKvKey("data/editions/260529", "04-d1-1x1.jpg", "aaaa1111");
    const k2 = cloudflareKvKey("data/editions/260529", "04-d1-1x1.jpg", "bbbb2222");
    assert.notEqual(k1, k2);
  });

  it("key com md5 ainda URL-safe", () => {
    const k = cloudflareKvKey("data/editions/260529", "04-d1-1x1.jpg", MD5_HEX);
    assert.match(k, /^[a-zA-Z0-9._-]+$/);
  });
});

describe("cloudflareKvKey — É IA? sem hash bate com convenção do Worker (#1704)", () => {
  // O Worker `poll` monta a URL do /vote com convenção FIXA:
  //   /img/img-{AAMMDD}-01-eia-{A|B}.jpg  (workers/poll/src/index.ts:958)
  // O upload do É IA? usa noCacheBust → cloudflareKvKey é chamado SEM md5.
  // A key resultante DEVE bater exatamente com a URL que o Worker constrói,
  // senão o /vote dá 404 (bug #1704).
  for (const side of ["A", "B"] as const) {
    it(`eia-${side} sem md5 → img-{edition}-01-eia-${side}.jpg (sem sufixo)`, () => {
      assert.equal(
        cloudflareKvKey("data/editions/260602", `01-eia-${side}.jpg`),
        `img-260602-01-eia-${side}.jpg`,
      );
    });
  }

  it("regressão: COM md5 a key NÃO bateria (demonstra o bug original)", () => {
    const withHash = cloudflareKvKey(
      "data/editions/260602",
      "01-eia-A.jpg",
      "1e3bd6e6aaaaaaaaaaaaaaaaaaaaaaaa",
    );
    // Worker espera img-260602-01-eia-A.jpg — com hash não bate.
    assert.notEqual(withHash, "img-260602-01-eia-A.jpg");
  });
});

describe("kvKeyForSpec — wiring noCacheBust → key (#1704)", () => {
  // Testa o ponto onde o bug #1704 morava: a decisão hash vs no-hash POR SPEC
  // dentro do upload. Antes só as metades (imageSpecsFor seta noCacheBust;
  // cloudflareKvKey omite md5 sem o arg) eram testadas isoladas — o wiring não.
  const MD5 = "1e3bd6e6715367f984a785605a621926";

  it("spec do É IA? (noCacheBust) → key SEM hash, bate com convenção do /vote", () => {
    const spec: ImageSpec = { key: "eia_a", filename: "01-eia-A.jpg", noCacheBust: true };
    assert.equal(
      kvKeyForSpec("data/editions/260602", spec, MD5),
      "img-260602-01-eia-A.jpg",
    );
  });

  it("spec normal (cover/d1) → key COM hash (cache-bust preservado)", () => {
    const spec: ImageSpec = { key: "cover", filename: "04-d1-2x1.jpg" };
    assert.equal(
      kvKeyForSpec("data/editions/260602", spec, MD5),
      `img-260602-04-d1-2x1-${MD5.slice(0, 8)}.jpg`,
    );
  });

  it("self-heal: key eia legacy COM hash difere da esperada (sem hash) → força re-upload", () => {
    // Edição cacheada antes do noCacheBust: file_id = key COM hash.
    const legacyHashedKey = `img-260602-01-eia-A-${MD5.slice(0, 8)}.jpg`;
    const spec: ImageSpec = { key: "eia_a", filename: "01-eia-A.jpg", noCacheBust: true };
    const expectedNow = kvKeyForSpec("data/editions/260602", spec, MD5);
    // O guard de self-heal em uploadPublicImages compara cached.file_id vs isto.
    assert.notEqual(legacyHashedKey, expectedNow);
    assert.equal(expectedNow, "img-260602-01-eia-A.jpg");
  });
});
