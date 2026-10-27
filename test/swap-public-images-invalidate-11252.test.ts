/**
 * #11252 — troca de destaque deixava `d3_2x1` stale em `06-public-images.json`.
 *
 * Edição 261027: `swap-destaques.ts --d3-url ...` apagou `04-d3-*` mas não
 * tocou o cache; `d3_2x1` seguiu com a URL/md5 da arte do destaque antigo e o
 * e-mail de teste do Kit saiu com a imagem de outro assunto. Cobre:
 *   1. a lista de chaves por posição (fonte única pros 3 scripts);
 *   2. `swap-destaques.ts` e `swap-destaque.ts` (CLI real) removendo TODAS as
 *      chaves da posição trocada e preservando as das outras;
 *   3. o invariante `public-images-md5-matches-local` (Stage 4 e 5) acusando o
 *      cenário exato da edição (cache com md5 da arte antiga, disco com a nova);
 *   4. o uploader recusando reuso do cache quando o md5 local difere.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import {
  publicImageKeysForPosition,
  invalidatePublicImagesForPositions,
  planPublicImagesInvalidation,
} from "../scripts/lib/public-images-invalidate.ts";
import { checkPublicImagesMd5MatchesLocal } from "../scripts/lib/public-images-md5-check.ts";
import { STAGE_4_RULES } from "../scripts/lib/invariant-checks/stage-4.ts";
import { STAGE_5_RULES } from "../scripts/lib/invariant-checks/stage-5.ts";
import { invalidatePublicImagesForReorder } from "../scripts/reorder-destaques.ts";
import { shouldReuseCachedUpload, md5OfFile } from "../scripts/upload-images-public.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function entry(key: string, md5 = "old-md5") {
  return { file_id: `img-261027-${key}`, url: `https://x.example/img/${key}.jpg`, target: "cloudflare", md5 };
}

/** Cache com as chaves das 3 posições + chaves de outras seções (não-destaque). */
function fullCache(): { images: Record<string, ReturnType<typeof entry>> } {
  const images: Record<string, ReturnType<typeof entry>> = {};
  for (const pos of [1, 2, 3]) for (const k of publicImageKeysForPosition(pos)) images[k] = entry(k);
  images.eia_a = entry("eia_a");
  images.livros_promo = entry("livros_promo");
  return { images };
}

const HIGHLIGHTS = [1, 2, 3].map((n) => ({
  rank: n,
  score: 90 - n,
  bucket: "radar",
  url: `https://example.com/d${n}`,
  title_options: [`Título D${n}`],
}));

function makeEdition(): string {
  const dir = mkdtempSync(join(tmpdir(), "swap-11252-"));
  const internal = join(dir, "_internal");
  mkdirSync(internal, { recursive: true });
  const approved = {
    highlights: HIGHLIGHTS,
    runners_up: [],
    lancamento: [],
    radar: [{ url: "https://example.com/radar-0", title: "Item RADAR 0" }],
    use_melhor: [],
    video: [],
  };
  writeFileSync(join(internal, "01-approved.json"), JSON.stringify(approved, null, 2));
  writeFileSync(join(dir, "06-public-images.json"), JSON.stringify(fullCache(), null, 2));
  writeFileSync(join(dir, "04-d3-2x1.jpg"), "arte-antiga-d3");
  return dir;
}

function runCli(script: string, args: string[]): { stdout: string; stderr: string; status: number } {
  try {
    const stdout = execFileSync(process.execPath, ["--import", "tsx", resolve(ROOT, "scripts", script), ...args], {
      encoding: "utf8",
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { stdout, stderr: "", status: 0 };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; status?: number };
    return { stdout: err.stdout ?? "", stderr: err.stderr ?? String(e), status: err.status ?? 1 };
  }
}

function cacheKeys(dir: string): string[] {
  return Object.keys(JSON.parse(readFileSync(join(dir, "06-public-images.json"), "utf8")).images).sort();
}

describe("publicImageKeysForPosition (#11252)", () => {
  it("D3 inclui o hero 2:1 do e-mail, o 4:5, os 4 slides e a chave base legada", () => {
    assert.deepEqual(publicImageKeysForPosition(3).sort(), [
      "d3",
      "d3_2x1",
      "d3_4x5",
      "d3_carousel_cta",
      "d3_carousel_p1",
      "d3_carousel_p2",
      "d3_carousel_p3",
    ]);
  });

  it("D1 usa `cover` (nunca d1_2x1) e inclui a cópia com convite d1_play", () => {
    const keys = publicImageKeysForPosition(1);
    assert.ok(keys.includes("cover"));
    assert.ok(keys.includes("d1_play"));
    assert.ok(!keys.includes("d1_2x1"));
  });

  it("invalidatePublicImagesForPositions remove só as posições pedidas", () => {
    const r = invalidatePublicImagesForPositions(fullCache(), [3]);
    assert.equal(r.changed, true);
    const left = Object.keys((r.data as { images: object }).images);
    assert.ok(left.every((k) => !k.startsWith("d3")), left.join(","));
    assert.ok(left.includes("cover") && left.includes("d2_2x1") && left.includes("eia_a"));
  });

  it("shape inesperado não lança e não muda nada", () => {
    assert.equal(invalidatePublicImagesForPositions(null, [1]).changed, false);
    assert.equal(invalidatePublicImagesForPositions({ images: [] }, [1]).changed, false);
  });

  it("reorder-destaques usa a mesma lista (d1_play sai junto com o cover)", () => {
    const r = invalidatePublicImagesForReorder(fullCache(), [2, 1, 3]);
    assert.ok(r.removedKeys.includes("d1_play"));
    assert.ok(r.removedKeys.includes("cover"));
    assert.ok(!r.removedKeys.some((k) => k.startsWith("d3")));
  });

  it("planPublicImagesInvalidation: JSON ilegível vira error, sem lançar", () => {
    const dir = mkdtempSync(join(tmpdir(), "swap-11252-bad-"));
    try {
      writeFileSync(join(dir, "06-public-images.json"), "{nope");
      const plan = planPublicImagesInvalidation(dir, [3]);
      assert.ok(plan.error);
      assert.equal(plan.content, undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("swap-destaques.ts / swap-destaque.ts invalidam o cache da posição (#11252)", () => {
  it("swap-destaques --d3-url (cenário da edição 261027) remove todas as chaves d3_* e mantém as demais", () => {
    const dir = makeEdition();
    try {
      const { status, stdout, stderr } = runCli("swap-destaques.ts", [
        "--edition", "261027", "--edition-dir", dir,
        "--d3-url", "https://example.com/ipo", "--d3-title", "IPO novo",
      ]);
      assert.equal(status, 0, stderr);
      const keys = cacheKeys(dir);
      assert.ok(!keys.some((k) => k === "d3" || k.startsWith("d3_")), keys.join(","));
      for (const k of ["cover", "d1_play", "d2_2x1", "d2_4x5", "eia_a", "livros_promo"]) {
        assert.ok(keys.includes(k), `${k} devia ficar`);
      }
      const parsed = JSON.parse(stdout);
      assert.ok(parsed.modified.rewritten.some((p: string) => p.endsWith("06-public-images.json")));
      assert.ok(parsed.warnings.some((w: string) => /#11252/.test(w)));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("swap-destaques --dry-run não toca o cache", () => {
    const dir = makeEdition();
    try {
      const before = readFileSync(join(dir, "06-public-images.json"), "utf8");
      const { status, stderr } = runCli("swap-destaques.ts", [
        "--edition", "261027", "--edition-dir", dir,
        "--d3-url", "https://example.com/ipo", "--d3-title", "IPO novo", "--dry-run",
      ]);
      assert.equal(status, 0, stderr);
      assert.equal(readFileSync(join(dir, "06-public-images.json"), "utf8"), before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("swap-destaque (item do pool) remove as chaves da posição rebaixada", () => {
    const dir = makeEdition();
    try {
      const { status, stderr } = runCli("swap-destaque.ts", [
        "--edition", "261027", "--edition-dir", dir,
        "--promote", "radar:0", "--demote", "d2",
      ]);
      assert.equal(status, 0, stderr);
      const keys = cacheKeys(dir);
      assert.ok(!keys.some((k) => k === "d2" || k.startsWith("d2_")), keys.join(","));
      assert.ok(keys.includes("d3_2x1") && keys.includes("cover"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("invariante public-images-md5-matches-local (#11252)", () => {
  function editionWithHero(cacheMd5ForD3: (localMd5: string) => string): string {
    const dir = mkdtempSync(join(tmpdir(), "md5-11252-"));
    mkdirSync(join(dir, "_internal"), { recursive: true });
    for (const f of ["04-d1-2x1.jpg", "04-d2-2x1.jpg", "04-d3-2x1.jpg"]) writeFileSync(join(dir, f), `arte-${f}`);
    const md5 = (f: string) => md5OfFile(join(dir, f));
    const images = {
      cover: entry("cover", md5("04-d1-2x1.jpg")),
      d2_2x1: entry("d2_2x1", md5("04-d2-2x1.jpg")),
      d3_2x1: entry("d3_2x1", cacheMd5ForD3(md5("04-d3-2x1.jpg"))),
    };
    writeFileSync(join(dir, "06-public-images.json"), JSON.stringify({ images }, null, 2));
    return dir;
  }

  it("acusa (error) d3_2x1 com md5 da arte antiga e o arquivo local já novo", () => {
    const dir = editionWithHero(() => "md5-da-imagem-microsoft");
    try {
      const v = checkPublicImagesMd5MatchesLocal(dir);
      assert.equal(v.length, 1);
      assert.equal(v[0].rule, "public-images-md5-matches-local");
      assert.equal(v[0].severity, "error");
      assert.match(v[0].message, /d3_2x1/);
      assert.doesNotMatch(v[0].message, /d2_2x1|cover/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("passa quando todos os md5 batem", () => {
    const dir = editionWithHero((m) => m);
    try {
      assert.deepEqual(checkPublicImagesMd5MatchesLocal(dir), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("arquivo local ausente, entry sem md5 ou cache ausente não viram violação aqui", () => {
    const dir = editionWithHero(() => "outro");
    try {
      rmSync(join(dir, "04-d3-2x1.jpg"));
      assert.deepEqual(checkPublicImagesMd5MatchesLocal(dir), []);
      writeFileSync(join(dir, "06-public-images.json"), JSON.stringify({ images: { cover: { url: "https://x/y.jpg" } } }));
      assert.deepEqual(checkPublicImagesMd5MatchesLocal(dir), []);
      rmSync(join(dir, "06-public-images.json"));
      assert.deepEqual(checkPublicImagesMd5MatchesLocal(dir), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("está registrado no Stage 4 (gate) e no Stage 5 pre-dispatch", () => {
    assert.ok(STAGE_4_RULES.some((r) => r.id === "public-images-md5-matches-local"));
    const s5 = STAGE_5_RULES.find((r) => r.id === "public-images-md5-matches-local");
    assert.ok(s5, "ausente do Stage 5");
    assert.ok(!(s5 as { postDispatchOnly?: boolean }).postDispatchOnly, "tem que rodar no pre-dispatch");
  });
});

describe("upload-images-public: md5 local diferente nunca reusa o cache (#11252 item 2)", () => {
  it("shouldReuseCachedUpload devolve false quando o md5 do cache é de outra arte", () => {
    const dir = mkdtempSync(join(tmpdir(), "reuse-11252-"));
    try {
      const img = join(dir, "04-d3-2x1.jpg");
      writeFileSync(img, "arte-nova-ipo");
      const local = md5OfFile(img);
      assert.equal(shouldReuseCachedUpload({ ...entry("d3_2x1", "md5-antigo"), mime_type: "image/jpeg", filename: "04-d3-2x1.jpg" } as never, img, "cloudflare", local), false);
      assert.equal(shouldReuseCachedUpload({ ...entry("d3_2x1", local), mime_type: "image/jpeg", filename: "04-d3-2x1.jpg" } as never, img, "cloudflare", local), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
