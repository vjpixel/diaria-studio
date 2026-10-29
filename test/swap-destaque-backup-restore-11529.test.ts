/**
 * #11529 — `swap-destaque.ts --demote dN` apagava prompt, rascunho e imagens
 * do destaque que saía, sem backup. Edição 261029: o D3 (Android) saiu e voltou
 * meia hora depois, e prompt, 3 imagens e carrossel foram refeitos do zero.
 *
 * Regressão: demover e promover de volta o mesmo item, seguido de
 * `--restore dN`, recupera rascunho, prompt, imagens e as chaves de
 * `06-public-images.json` byte a byte.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import {
  backupDemotedDestaque,
  brtStamp,
  findSwapBackupForUrl,
  listSwapBackups,
  restoreSwapBackup,
  swapBackupDirName,
} from "../scripts/lib/swap-destaque-backup.ts";
import { publicImageKeysForPosition } from "../scripts/lib/public-images-invalidate.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ANDROID = "https://example.com/android";

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
  const dir = mkdtempSync(join(tmpdir(), "swap-11529-"));
  mkdirSync(join(dir, "_internal"), { recursive: true });
  const highlights = [1, 2, 3].map((n) => ({
    rank: n,
    score: 90 - n,
    bucket: "radar",
    url: n === 3 ? ANDROID : `https://example.com/d${n}`,
    article: { url: n === 3 ? ANDROID : `https://example.com/d${n}`, title: n === 3 ? "Android" : `D${n}` },
    title_options: [n === 3 ? "Android" : `Título D${n}`],
  }));
  const approved = {
    highlights,
    runners_up: [],
    lancamento: [],
    radar: [{ url: "https://example.com/radar-0", title: "Item RADAR 0" }],
    use_melhor: [],
    video: [],
  };
  writeFileSync(join(dir, "_internal", "01-approved.json"), JSON.stringify(approved, null, 2));
  const images: Record<string, unknown> = { cover: entry("cover"), eia_a: entry("eia_a") };
  for (const k of publicImageKeysForPosition(3)) images[k] = entry(k);
  writeFileSync(join(dir, "06-public-images.json"), JSON.stringify({ images }, null, 2));
  for (const [rel, content] of Object.entries(D3_FILES)) writeFileSync(join(dir, rel), content);
  // Arte de outra posição não pode entrar no backup do D3.
  writeFileSync(join(dir, "04-d2-2x1.jpg"), "arte-d2");
  return dir;
}

function runSwap(args: string[]): { stdout: string; stderr: string; status: number } {
  try {
    const stdout = execFileSync(
      process.execPath,
      ["--import", "tsx", resolve(ROOT, "scripts", "swap-destaque.ts"), ...args],
      { encoding: "utf8", cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] },
    );
    return { stdout, stderr: "", status: 0 };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; status?: number };
    return { stdout: err.stdout ?? "", stderr: err.stderr ?? String(e), status: err.status ?? 1 };
  }
}

function radarIndexOf(dir: string, url: string): number {
  const approved = JSON.parse(readFileSync(join(dir, "_internal", "01-approved.json"), "utf8"));
  return (approved.radar as Array<{ url: string }>).findIndex((it) => it.url === url);
}

function publicImages(dir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dir, "06-public-images.json"), "utf8")).images;
}

describe("swap-destaque: backup do rebaixado e --restore (#11529)", () => {
  it("demover e promover de volta o mesmo item recupera rascunho, prompt, imagens e cache público", () => {
    const dir = makeEdition();
    try {
      // 1. D3 (Android) sai pro RADAR.
      const out = runSwap(["--edition", "261029", "--edition-dir", dir, "--promote", "radar:0", "--demote", "d3"]);
      assert.equal(out.status, 0, out.stderr);
      const result = JSON.parse(out.stdout);
      for (const rel of Object.keys(D3_FILES)) assert.ok(!existsSync(join(dir, rel)), `${rel} saiu da posição`);
      assert.ok(existsSync(join(dir, "04-d2-2x1.jpg")), "arte do D2 intocada");
      assert.ok(result.backup.dir, "backup criado");
      assert.match(result.backup.dir, /_internal[\\/]_forensic[\\/]swap-\d{6}-\d{4}-d3$/);
      const manifest = JSON.parse(readFileSync(join(result.backup.dir, "manifest.json"), "utf8"));
      assert.equal(manifest.url, ANDROID);
      assert.equal(manifest.title, "Android");
      assert.equal(manifest.source_bucket, "radar");
      assert.equal(manifest.demoted_to, "radar");
      assert.deepEqual([...manifest.files].sort(), Object.keys(D3_FILES).sort());
      assert.deepEqual(Object.keys(manifest.public_images).sort(), publicImageKeysForPosition(3).sort());
      assert.ok(!Object.keys(publicImages(dir)).some((k) => k.startsWith("d3")), "swap segue invalidando o cache (#11252)");
      // Compatibilidade: modified.deleted mantém os nomes sem prefixo.
      assert.ok(result.modified.deleted.includes("02-d3-prompt.md"));
      assert.ok(result.modified.deleted.includes("04-d3-2x1.jpg"));

      // 2. Android volta a D3 (agora está no RADAR).
      const idx = radarIndexOf(dir, ANDROID);
      assert.ok(idx >= 0);
      const back = runSwap(["--edition", "261029", "--edition-dir", dir, "--promote", `radar:${idx}`, "--demote", "d3"]);
      assert.equal(back.status, 0, back.stderr);

      // 3. --restore d3 acha o backup pela URL do D3 atual.
      const rest = runSwap(["--restore", "d3", "--edition-dir", dir]);
      assert.equal(rest.status, 0, rest.stderr);
      const r = JSON.parse(rest.stdout);
      assert.equal(r.url, ANDROID);
      for (const [rel, content] of Object.entries(D3_FILES)) {
        assert.equal(readFileSync(join(dir, rel), "utf8"), content, `${rel} restaurado`);
      }
      const imgs = publicImages(dir);
      for (const k of publicImageKeysForPosition(3)) assert.deepEqual(imgs[k], entry(k), `${k} restaurada`);
      assert.deepEqual(imgs.cover, entry("cover"), "chaves de outras posições preservadas");
      assert.ok(r.next_steps.some((s: string) => s.includes("02-d3-draft.md")));
      const after = JSON.parse(readFileSync(join(r.restored_from, "manifest.json"), "utf8"));
      assert.equal(after.restored_at.length, 1, "backup fica, com a restauração anotada");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--restore sem backup para o D3 atual sai 1 e lista os backups existentes", () => {
    const dir = makeEdition();
    try {
      assert.equal(runSwap(["--edition", "261029", "--edition-dir", dir, "--promote", "radar:0", "--demote", "d3"]).status, 0);
      // D3 agora é o radar-0, que não tem backup.
      const rest = runSwap(["--restore", "d3", "--edition-dir", dir]);
      assert.equal(rest.status, 1);
      assert.match(rest.stderr, /nenhum backup/);
      assert.match(rest.stderr, /example\.com\/android/);
      assert.ok(!existsSync(join(dir, "04-d3-2x1.jpg")), "nada restaurado");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("restore recusa sobrescrever arquivo existente sem force", () => {
    const dir = makeEdition();
    try {
      const b = backupDemotedDestaque({
        editionDir: dir,
        position: 3,
        url: ANDROID,
        title: "Android",
        sourceBucket: "radar",
        demotedTo: "radar",
        publicImages: {},
      });
      assert.ok(b.dir);
      writeFileSync(join(dir, "04-d3-2x1.jpg"), "arte-nova");
      const found = findSwapBackupForUrl(dir, 3, ANDROID);
      assert.ok(found);
      assert.throws(() => restoreSwapBackup(dir, found), /já existem/);
      assert.equal(readFileSync(join(dir, "04-d3-2x1.jpg"), "utf8"), "arte-nova");
      const r = restoreSwapBackup(dir, found, { force: true });
      assert.deepEqual(r.files_overwritten, ["04-d3-2x1.jpg"]);
      assert.equal(readFileSync(join(dir, "04-d3-2x1.jpg"), "utf8"), "arte-2x1-android");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("dois backups no mesmo minuto não se sobrescrevem; nada a guardar não cria diretório", () => {
    const dir = makeEdition();
    try {
      const now = new Date("2026-10-28T23:10:00Z");
      const a = backupDemotedDestaque({
        editionDir: dir, position: 3, url: ANDROID, title: "Android",
        sourceBucket: "radar", demotedTo: "radar", publicImages: {}, now,
      });
      writeFileSync(join(dir, "04-d3-2x1.jpg"), "outra");
      const b = backupDemotedDestaque({
        editionDir: dir, position: 3, url: "https://example.com/outro", title: "Outro",
        sourceBucket: "radar", demotedTo: null, publicImages: {}, now,
      });
      assert.notEqual(a.dir, b.dir);
      assert.match(b.dir ?? "", /-2$/);
      assert.equal(listSwapBackups(dir, 3).length, 2);
      const empty = backupDemotedDestaque({
        editionDir: dir, position: 3, url: ANDROID, title: "Android",
        sourceBucket: null, demotedTo: null, publicImages: {}, now,
      });
      assert.equal(empty.dir, null);
      assert.equal(readdirSync(join(dir, "_internal", "_forensic")).length, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("carimbo do diretório é em horário de Brasília", () => {
    assert.equal(brtStamp(new Date("2026-10-28T23:10:00Z")), "261028-2010");
    assert.equal(brtStamp(new Date("2026-10-29T02:05:00Z")), "261028-2305");
    assert.equal(swapBackupDirName(new Date("2026-10-28T23:10:00Z"), 3), "swap-261028-2010-d3");
  });
});
