/**
 * test/publishers-shared-loaders-14125.test.ts (#14125)
 *
 * `publish-facebook.ts`, `publish-instagram.ts` e `publish-threads.ts`
 * tinham cada um uma cópia de `loadPublished`, e Facebook e Threads uma de
 * `loadPublicImagesFile`. As cópias saíram: `loadPublished` virou
 * `readSocialPublished` (`lib/social-published-store.ts`) e
 * `loadPublicImagesFile` mora em `lib/public-images-file.ts`, re-exportada
 * pelos dois publishers com o mesmo nome.
 *
 * O teste prova que a troca não muda comportamento: as implementações
 * antigas, copiadas aqui como estavam, dão o mesmo resultado que as da lib
 * para arquivo ausente, válido e corrompido. E trava que as cópias não
 * voltam.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { readSocialPublished, type SocialPublished } from "../scripts/lib/social-published-store.ts";
import { loadPublicImagesFile } from "../scripts/lib/public-images-file.ts";
import { loadPublicImagesFile as fromFacebook } from "../scripts/publish-facebook.ts";
import { loadPublicImagesFile as fromThreads } from "../scripts/publish-threads.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Cópia literal da `loadPublished` que existia nos três publishers. */
function oldLoadPublished(path: string): SocialPublished {
  if (existsSync(path)) {
    return JSON.parse(readFileSync(path, "utf8"));
  }
  return { posts: [] };
}

/** Cópia literal da `loadPublicImagesFile` de Facebook e Threads. */
function oldLoadPublicImagesFile(publicImagesPath: string): { images?: Record<string, { url?: string }> } {
  if (!existsSync(publicImagesPath)) return {};
  try {
    return JSON.parse(readFileSync(publicImagesPath, "utf8")) as { images?: Record<string, { url?: string }> };
  } catch {
    return {};
  }
}

/** Roda `fn`, devolvendo `{ value }` ou `{ error }` (nome + mensagem). */
function outcome<T>(fn: () => T): { value?: T; error?: string } {
  try {
    return { value: fn() };
  } catch (e) {
    return { error: `${(e as Error).name}: ${(e as Error).message}` };
  }
}

function withTmp(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "loaders-14125-"));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("readSocialPublished = loadPublished antiga (#14125)", () => {
  it("arquivo ausente → { posts: [] } nos dois", () => {
    withTmp((dir) => {
      const p = join(dir, "06-social-published.json");
      assert.deepEqual(readSocialPublished(p), oldLoadPublished(p));
      assert.deepEqual(readSocialPublished(p), { posts: [] });
    });
  });

  it("arquivo válido → mesmo objeto, inclusive campos extras", () => {
    withTmp((dir) => {
      const p = join(dir, "06-social-published.json");
      const payload = { posts: [{ platform: "facebook", destaque: "d1", status: "scheduled" }], extra: 1 };
      writeFileSync(p, JSON.stringify(payload));
      assert.deepEqual(readSocialPublished(p), oldLoadPublished(p));
      assert.deepEqual(readSocialPublished(p), payload);
    });
  });

  it("arquivo corrompido → os dois lançam o mesmo erro (nenhum dos dois engole)", () => {
    withTmp((dir) => {
      const p = join(dir, "06-social-published.json");
      writeFileSync(p, "{ corrompido");
      const a = outcome(() => readSocialPublished(p));
      const b = outcome(() => oldLoadPublished(p));
      assert.ok(a.error, "readSocialPublished deveria lançar em JSON corrompido");
      assert.equal(a.error, b.error);
    });
  });
});

describe("loadPublicImagesFile da lib = cópia antiga (#14125)", () => {
  it("Facebook e Threads re-exportam a função da lib", () => {
    assert.equal(fromFacebook, loadPublicImagesFile);
    assert.equal(fromThreads, loadPublicImagesFile);
  });

  it("ausente, válido e corrompido dão o mesmo resultado da cópia antiga", () => {
    withTmp((dir) => {
      const p = join(dir, "06-public-images.json");
      assert.deepEqual(loadPublicImagesFile(p), oldLoadPublicImagesFile(p));
      assert.deepEqual(loadPublicImagesFile(p), {});

      const payload = { images: { d1_4x5: { url: "https://x/a.jpg" } } };
      writeFileSync(p, JSON.stringify(payload));
      assert.deepEqual(loadPublicImagesFile(p), oldLoadPublicImagesFile(p));
      assert.deepEqual(loadPublicImagesFile(p), payload);

      writeFileSync(p, "{ corrompido");
      const warn = console.warn;
      const warns: string[] = [];
      console.warn = (m: string) => warns.push(m);
      try {
        assert.deepEqual(loadPublicImagesFile(p), oldLoadPublicImagesFile(p));
        assert.deepEqual(loadPublicImagesFile(p), {});
      } finally {
        console.warn = warn;
      }
      assert.ok(warns.some((w) => w.includes("seguindo sem carrossel")), "JSON corrompido segue avisando em stderr");
    });
  });
});

describe("as cópias não voltam aos publishers (#14125)", () => {
  for (const f of ["publish-facebook.ts", "publish-instagram.ts", "publish-threads.ts"]) {
    it(`${f} não define loadPublished nem loadPublicImagesFile`, () => {
      const src = readFileSync(join(ROOT, "scripts", f), "utf8");
      assert.doesNotMatch(src, /function\s+loadPublished\s*\(/);
      assert.doesNotMatch(src, /function\s+loadPublicImagesFile\s*\(/);
    });
  }
});
