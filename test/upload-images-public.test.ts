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
  md5OfFile,
  shouldReuseCachedUpload,
  mergeBaseFromCache,
  type PublicImage,
} from "../scripts/upload-images-public.ts";

const __ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("mergeBaseFromCache — merge cross-mode preservado com --no-cache (#1865)", () => {
  function setup(images: Record<string, unknown>) {
    const dir = mkdtempSync(join(tmpdir(), "merge-base-"));
    const p = join(dir, "06-public-images.json");
    writeFileSync(p, JSON.stringify({ images }), "utf8");
    return { dir, p, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  }

  it("base = SEMPRE o arquivo existente (não {}), independente de --no-cache", () => {
    // newsletter mode gravou cover/eia_a/eia_b/d1.
    const { p, cleanup } = setup({
      cover: { file_id: "c", url: "u-cover", target: "cloudflare", cloudflare_url: "u-cover" },
      eia_a: { file_id: "a", url: "u-a", target: "cloudflare" },
      eia_b: { file_id: "b", url: "u-b", target: "cloudflare" },
      d1: { file_id: "d1c", url: "u-d1", target: "cloudflare", cloudflare_url: "u-d1" },
    });
    try {
      const base = mergeBaseFromCache(p);
      // Todas as chaves do newsletter mode presentes na base.
      assert.deepEqual(Object.keys(base).sort(), ["cover", "d1", "eia_a", "eia_b"]);

      // Simula o social mode (--no-cache) escrevendo por cima: spread sobre a base.
      const socialResult: Record<string, PublicImage> = {
        d1: { file_id: "d1d", url: "u-d1-drive", target: "drive", cloudflare_url: "u-d1" } as PublicImage,
        d2: { file_id: "d2d", url: "u-d2-drive", target: "drive" } as PublicImage,
        d3: { file_id: "d3d", url: "u-d3-drive", target: "drive" } as PublicImage,
      };
      const merged = { ...base, ...socialResult };
      // cover/eia_a/eia_b do newsletter NÃO somem (era o bug #1865).
      assert.ok(merged.cover, "cover preservada");
      assert.ok(merged.eia_a && merged.eia_b, "eia_a/eia_b preservadas");
      // d1/d2/d3 do social presentes.
      assert.ok(merged.d1 && merged.d2 && merged.d3, "d1/d2/d3 presentes");
      // cloudflare_url da cover/d1 preservada (não perdida pelo overwrite).
      assert.equal(merged.cover.cloudflare_url, "u-cover");
    } finally {
      cleanup();
    }
  });

  it("arquivo ausente → base vazia (sem crash)", () => {
    assert.deepEqual(mergeBaseFromCache(join(tmpdir(), "nao-existe-06.json")), {});
  });
});

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

  it("#1701: newsletter mode inclui d1/d2/d3 1x1 (Cloudflare KV pro social preview)", () => {
    // Renderer (render-newsletter-html.ts) só substitui placeholders pra cover
    // D1 + È IA? A/B no EMAIL. Mas o social preview (render-social-html) resolve
    // d1/d2/d3 via cloudflare_url — que só existe se o newsletter mode (CF, roda
    // antes do social/drive) os subir. #1583 cobriu d1; #1701 estende a d2/d3
    // (antes ficavam só no Drive → preview do gate quebrava).
    const specs = imageSpecsFor("newsletter");
    const keys = specs.map((s) => s.key);
    assert.ok(keys.includes("d1"), "d1 em newsletter mode");
    assert.ok(keys.includes("d2"), "d2 em newsletter mode (#1701)");
    assert.ok(keys.includes("d3"), "d3 em newsletter mode (#1701)");
    assert.deepEqual(
      keys.sort(),
      ["cover", "d1", "d2", "d3", "eia_a", "eia_b", "livros_promo"].sort(),
      "newsletter = cover + d1 + d2 + d3 + eia_a + eia_b + livros_promo",
    );
    // filenames 1x1 (square) — não o 2x1 do cover.
    assert.equal(specs.find((s) => s.key === "d2")!.filename, "04-d2-1x1.jpg");
    assert.equal(specs.find((s) => s.key === "d3")!.filename, "04-d3-1x1.jpg");
    // #1701: d2/d3 são best-effort (optional) — não bloqueiam newsletter-mode
    // standalone se ausentes; cover/d1/eia (usados pelo email) NÃO são optional.
    assert.equal(specs.find((s) => s.key === "d2")!.optional, true);
    assert.equal(specs.find((s) => s.key === "d3")!.optional, true);
    assert.ok(!specs.find((s) => s.key === "cover")!.optional);
    assert.ok(!specs.find((s) => s.key === "d1")!.optional);
  });

  it("#1808: newsletter mode inclui o slot livros_promo (optional, com md5 cache-bust)", () => {
    const specs = imageSpecsFor("newsletter");
    const lp = specs.find((s) => s.key === "livros_promo");
    assert.ok(lp, "livros_promo deve estar em newsletter mode (produtor do box)");
    assert.equal(lp!.filename, "04-livros-promo.jpg");
    // optional: nem toda edição tem o box → não bloqueia o upload se ausente.
    assert.equal(lp!.optional, true);
    // mantém md5 cache-bust (#1584) — não opta por noCacheBust (review #1815):
    // a chave é per-edição e o md5 evita promo stale no proxy do Gmail ao regerar.
    assert.ok(!lp!.noCacheBust, "livros_promo NÃO deve ter noCacheBust (mantém md5)");
  });

  it("#1583: newsletter mode inclui d1-1x1 → social preview funciona", () => {
    const specs = imageSpecsFor("newsletter");
    const d1Spec = specs.find((s) => s.key === "d1");
    assert.ok(d1Spec, "d1 spec deve estar em newsletter mode");
    assert.equal(d1Spec!.filename, "04-d1-1x1.jpg");
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

  it("#1704: specs do É IA? têm noCacheBust=true; cover/d1 não", () => {
    // O Worker /vote monta a URL do É IA? com convenção FIXA sem hash
    // (`/img/img-{edition}-01-eia-{A|B}.jpg`). Se o upload gravar a key com
    // sufixo md5 (#1584), o /vote dá 404. eia_a/eia_b precisam de noCacheBust.
    const specs = imageSpecsFor("newsletter");
    const eiaA = specs.find((s) => s.key === "eia_a");
    const eiaB = specs.find((s) => s.key === "eia_b");
    assert.equal(eiaA?.noCacheBust, true, "eia_a deve ter noCacheBust=true");
    assert.equal(eiaB?.noCacheBust, true, "eia_b deve ter noCacheBust=true");
    // cover + d1 (newsletter/social, vão pro email → cache agressivo do Gmail
    // proxy) continuam com cache-bust (noCacheBust ausente/falsy).
    const cover = specs.find((s) => s.key === "cover");
    const d1 = specs.find((s) => s.key === "d1");
    assert.ok(!cover?.noCacheBust, "cover deve manter cache-bust");
    assert.ok(!d1?.noCacheBust, "d1 deve manter cache-bust");
  });

  it("#1704: specs eia legacy (real/ia) também têm noCacheBust=true", () => {
    const dir = makeDir();
    try {
      touch(join(dir, "01-eia-real.jpg"));
      touch(join(dir, "01-eia-ia.jpg"));
      const specs = imageSpecsFor("newsletter", dir);
      const eiaReal = specs.find((s) => s.key === "eia_real");
      const eiaIa = specs.find((s) => s.key === "eia_ia");
      assert.equal(eiaReal?.noCacheBust, true);
      assert.equal(eiaIa?.noCacheBust, true);
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

describe("md5OfFile (#1418)", () => {
  it("calcula md5 hex consistente pros mesmos bytes", () => {
    const dir = mkdtempSync(join(tmpdir(), "md5-test-"));
    const path = join(dir, "a.bin");
    writeFileSync(path, "hello world");
    // md5("hello world") = 5eb63bbbe01eeed093cb22bb8f5acdc3
    assert.equal(md5OfFile(path), "5eb63bbbe01eeed093cb22bb8f5acdc3");
    rmSync(dir, { recursive: true, force: true });
  });

  it("md5 diferente quando bytes mudam", () => {
    const dir = mkdtempSync(join(tmpdir(), "md5-test-"));
    const path = join(dir, "a.bin");
    writeFileSync(path, "v1");
    const m1 = md5OfFile(path);
    writeFileSync(path, "v2");
    const m2 = md5OfFile(path);
    assert.notEqual(m1, m2);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("shouldReuseCachedUpload (#1418)", () => {
  function makeImageFile(bytes: string): { path: string; cleanup: () => void } {
    const dir = mkdtempSync(join(tmpdir(), "reuse-test-"));
    const path = join(dir, "img.jpg");
    writeFileSync(path, bytes);
    return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  }

  it("reuse OK quando md5 do cache bate com bytes locais", () => {
    const { path, cleanup } = makeImageFile("hello");
    const cached: PublicImage = {
      file_id: "k1",
      url: "u",
      mime_type: "image/jpeg",
      filename: "img.jpg",
      target: "cloudflare",
      md5: md5OfFile(path),
    };
    assert.equal(shouldReuseCachedUpload(cached, path, "cloudflare"), true);
    cleanup();
  });

  it("#1418: re-upload quando bytes locais mudaram (md5 não bate)", () => {
    const { path, cleanup } = makeImageFile("v1");
    const oldMd5 = md5OfFile(path);
    const cached: PublicImage = {
      file_id: "k1",
      url: "u",
      mime_type: "image/jpeg",
      filename: "img.jpg",
      target: "cloudflare",
      md5: oldMd5,
    };
    // Sobrescreve bytes locais (caso real: eia-compose --force regerou imagem)
    writeFileSync(path, "v2");
    assert.equal(shouldReuseCachedUpload(cached, path, "cloudflare"), false);
    cleanup();
  });

  it("re-upload quando entry pre-#1418 (cache sem md5 field) — força refresh", () => {
    const { path, cleanup } = makeImageFile("any");
    const cached: PublicImage = {
      file_id: "k1",
      url: "u",
      mime_type: "image/jpeg",
      filename: "img.jpg",
      target: "cloudflare",
      // md5 ausente
    };
    assert.equal(shouldReuseCachedUpload(cached, path, "cloudflare"), false);
    cleanup();
  });

  it("re-upload quando target mudou (drive ↔ cloudflare)", () => {
    const { path, cleanup } = makeImageFile("any");
    const cached: PublicImage = {
      file_id: "k1",
      url: "u",
      mime_type: "image/jpeg",
      filename: "img.jpg",
      target: "drive",
      md5: md5OfFile(path),
    };
    assert.equal(shouldReuseCachedUpload(cached, path, "cloudflare"), false);
    cleanup();
  });

  it("re-upload quando cache não tem file_id (upload anterior falhou)", () => {
    const { path, cleanup } = makeImageFile("any");
    const cached = undefined;
    assert.equal(shouldReuseCachedUpload(cached, path, "cloudflare"), false);
    cleanup();
  });

  it("default target=drive quando cached.target ausente (entries muito antigas)", () => {
    const { path, cleanup } = makeImageFile("any");
    const cached: PublicImage = {
      file_id: "k1",
      url: "u",
      mime_type: "image/jpeg",
      filename: "img.jpg",
      md5: md5OfFile(path),
      // target ausente
    };
    // target solicitado = drive → matches default
    assert.equal(shouldReuseCachedUpload(cached, path, "drive"), true);
    // target solicitado = cloudflare → não bate
    assert.equal(shouldReuseCachedUpload(cached, path, "cloudflare"), false);
    cleanup();
  });
});
