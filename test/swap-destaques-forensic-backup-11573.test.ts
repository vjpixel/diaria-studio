/**
 * #11573 — `swap-destaques.ts` (troca por URL fora do pool) apagava rascunho,
 * prompt e imagens do destaque substituído, sem backup. O `swap-destaque.ts`
 * já movia tudo para `_internal/_forensic/` desde o #11529.
 *
 * Regressão: trocar o D3 por uma URL externa, voltar atrás (trazer o item de
 * volta ao D3) e `swap-destaque.ts --restore d3` recupera rascunho, prompt,
 * imagens e as chaves de `06-public-images.json` byte a byte.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { publicImageKeysForPosition } from "../scripts/lib/public-images-invalidate.ts";
import { highlightSourceBucket } from "../scripts/swap-destaques.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ANDROID = "https://example.com/android";
const EXTERNA = "https://externo.example/novidade";

const D3_FILES: Record<string, string> = {
  "04-d3-2x1.jpg": "arte-2x1-android",
  "04-d3-1x1.jpg": "arte-1x1-android",
  "04-d3-4x5.jpg": "arte-4x5-android",
  "04-d3-carousel-p1-4x5.jpg": "slide-p1-android",
  "_internal/02-d3-prompt.md": "Van Gogh impasto, Android",
  "_internal/02-d3-draft.md": "**DESTAQUE 3 | ANDROID**\n\ntexto do android",
  "_internal/04-d3-generator.json": '{"generator":"x"}',
};

function entry(key: string) {
  return { file_id: `img-${key}`, url: `https://x.example/img/${key}.jpg`, target: "cloudflare", md5: `md5-${key}` };
}

function makeEdition(): string {
  const dir = mkdtempSync(join(tmpdir(), "swap-11573-"));
  mkdirSync(join(dir, "_internal"), { recursive: true });
  const highlights = [1, 2, 3].map((n) => ({
    rank: n,
    score: 90 - n,
    bucket: n === 3 ? "lancamento" : "radar",
    url: n === 3 ? ANDROID : `https://example.com/d${n}`,
    article: { url: n === 3 ? ANDROID : `https://example.com/d${n}`, title: n === 3 ? "Android" : `D${n}` },
    title_options: [n === 3 ? "Android" : `Título D${n}`],
  }));
  const approved = { highlights, runners_up: [], lancamento: [], radar: [], use_melhor: [], video: [] };
  writeFileSync(join(dir, "_internal", "01-approved.json"), JSON.stringify(approved, null, 2));
  const images: Record<string, unknown> = { cover: entry("cover"), d2: entry("d2") };
  for (const k of publicImageKeysForPosition(3)) images[k] = entry(k);
  writeFileSync(join(dir, "06-public-images.json"), JSON.stringify({ images }, null, 2));
  for (const [rel, content] of Object.entries(D3_FILES)) writeFileSync(join(dir, rel), content);
  writeFileSync(join(dir, "04-d2-2x1.jpg"), "arte-d2");
  writeFileSync(join(dir, "_internal", "02-d2-prompt.md"), "prompt-d2");
  return dir;
}

function run(script: string, args: string[]): { stdout: string; stderr: string; status: number } {
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

function publicImages(dir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dir, "06-public-images.json"), "utf8")).images;
}

describe("swap-destaques: backup do substituído (#11573)", () => {
  it("trocar o D3 por URL externa e voltar atrás recupera rascunho, prompt, imagens e cache público", () => {
    const dir = makeEdition();
    try {
      // 1. D3 (Android) é trocado por uma URL de fora do pool.
      const out = run("swap-destaques.ts", [
        "--edition", "261029", "--edition-dir", dir, "--d3-url", EXTERNA, "--d3-title", "Novidade externa",
      ]);
      assert.equal(out.status, 0, out.stderr);
      const result = JSON.parse(out.stdout);
      for (const rel of Object.keys(D3_FILES)) assert.ok(!existsSync(join(dir, rel)), `${rel} saiu da posição`);
      assert.ok(existsSync(join(dir, "04-d2-2x1.jpg")), "arte do D2 intocada");
      assert.ok(existsSync(join(dir, "_internal", "02-d2-prompt.md")), "prompt do D2 intocado");

      assert.equal(result.backups.length, 1);
      const b = result.backups[0];
      assert.equal(b.position, 3);
      assert.match(b.dir, /_internal[\\/]_forensic[\\/]swap-\d{6}-\d{4}-d3$/);
      const manifest = JSON.parse(readFileSync(join(b.dir, "manifest.json"), "utf8"));
      assert.equal(manifest.url, ANDROID);
      assert.equal(manifest.title, "Android");
      assert.equal(manifest.source_bucket, "lancamento");
      assert.equal(manifest.demoted_to, "radar");
      assert.deepEqual([...manifest.files].sort(), Object.keys(D3_FILES).sort());
      assert.deepEqual(Object.keys(manifest.public_images).sort(), publicImageKeysForPosition(3).sort());
      for (const [rel, content] of Object.entries(D3_FILES)) {
        assert.equal(readFileSync(join(b.dir, rel), "utf8"), content, `${rel} no backup`);
      }
      assert.ok(!Object.keys(publicImages(dir)).some((k) => k.startsWith("d3")), "cache segue invalidado (#11252)");
      assert.ok(result.modified.deleted.includes("02-d3-draft.md"), "modified.deleted sem prefixo _internal/");
      assert.ok(result.modified.deleted.includes("04-d3-2x1.jpg"));

      // 2. Editor volta atrás: Android (agora no RADAR) volta ao D3.
      const approved = JSON.parse(readFileSync(join(dir, "_internal", "01-approved.json"), "utf8"));
      const idx = (approved.radar as Array<{ url: string }>).findIndex((it) => it.url === ANDROID);
      assert.ok(idx >= 0, "Android foi pro RADAR");
      const back = run("swap-destaque.ts", [
        "--edition", "261029", "--edition-dir", dir, "--promote", `radar:${idx}`, "--demote", "d3",
      ]);
      assert.equal(back.status, 0, back.stderr);

      // 3. --restore d3 acha o backup criado pelo swap-destaques.
      const rest = run("swap-destaque.ts", ["--restore", "d3", "--edition-dir", dir]);
      assert.equal(rest.status, 0, rest.stderr);
      const r = JSON.parse(rest.stdout);
      assert.equal(r.url, ANDROID);
      for (const [rel, content] of Object.entries(D3_FILES)) {
        assert.equal(readFileSync(join(dir, rel), "utf8"), content, `${rel} restaurado`);
      }
      const imgs = publicImages(dir);
      for (const k of publicImageKeysForPosition(3)) assert.deepEqual(imgs[k], entry(k), `${k} restaurada`);
      assert.deepEqual(imgs.cover, entry("cover"), "chaves de outras posições preservadas");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--drop também guarda backup (demoted_to null) e cada slot trocado ganha o seu", () => {
    const dir = makeEdition();
    try {
      const out = run("swap-destaques.ts", [
        "--edition", "261029", "--edition-dir", dir,
        "--d2-url", "https://externo.example/a", "--d2-title", "A",
        "--d3-url", EXTERNA, "--d3-title", "B",
        "--drop",
      ]);
      assert.equal(out.status, 0, out.stderr);
      const result = JSON.parse(out.stdout);
      const byPos = new Map<number, { dir: string; files: string[] }>(
        result.backups.map((b: { position: number; dir: string; files: string[] }) => [b.position, b]),
      );
      const d2 = byPos.get(2);
      const d3 = byPos.get(3);
      assert.ok(d2?.dir && d3?.dir && d2.dir !== d3.dir);
      assert.deepEqual([...d2.files].sort(), ["04-d2-2x1.jpg", "_internal/02-d2-prompt.md"]);
      const m3 = JSON.parse(readFileSync(join(d3.dir, "manifest.json"), "utf8"));
      assert.equal(m3.demoted_to, null);
      assert.equal(m3.url, ANDROID);
      assert.ok(!existsSync(join(dir, "04-d2-2x1.jpg")));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("dry-run não cria backup", () => {
    const dir = makeEdition();
    try {
      const out = run("swap-destaques.ts", [
        "--edition", "261029", "--edition-dir", dir, "--d3-url", EXTERNA, "--d3-title", "B", "--dry-run",
      ]);
      assert.equal(out.status, 0, out.stderr);
      assert.ok(!existsSync(join(dir, "_internal", "_forensic")));
      assert.ok(existsSync(join(dir, "04-d3-2x1.jpg")));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("highlightSourceBucket (#11573)", () => {
  it("bucket do wrapper, senão article.category, senão null", () => {
    assert.equal(highlightSourceBucket({ bucket: "radar" }), "radar");
    assert.equal(highlightSourceBucket({ article: { category: "use_melhor" } }), "use_melhor");
    assert.equal(highlightSourceBucket({}), null);
    assert.equal(highlightSourceBucket(undefined), null);
  });
});
