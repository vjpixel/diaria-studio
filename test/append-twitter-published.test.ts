/**
 * append-twitter-published.test.ts (#3994)
 *
 * Testa append-twitter-published.ts via subprocess: grava a entry correta em
 * 06-social-published.json a partir dos argumentos de CLI, reusando o mesmo
 * store atômico (#758) dos demais canais.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";

const __ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = resolve(__ROOT, "scripts/append-twitter-published.ts");

function run(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", SCRIPT, ...args], {
    encoding: "utf8",
    cwd: __ROOT,
    timeout: 15_000,
  });
}

describe("append-twitter-published.ts", () => {
  it("grava entry 'published' com url e buffer-post-id", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "diaria-append-twitter-"));
    const publishedPath = join(tmpDir, "06-social-published.json");
    try {
      const r = run([
        "--published-path", publishedPath,
        "--destaque", "d1",
        "--status", "published",
        "--url", "https://x.com/diariabr/status/123",
        "--buffer-post-id", "abc123",
      ]);
      assert.equal(r.status, 0, `stderr: ${r.stderr}`);
      const data = JSON.parse(readFileSync(publishedPath, "utf8"));
      const entry = data.posts.find((p: any) => p.destaque === "d1");
      assert.ok(entry);
      assert.equal(entry.platform, "twitter");
      assert.equal(entry.status, "published");
      assert.equal(entry.url, "https://x.com/diariabr/status/123");
      assert.equal(entry.buffer_post_id, "abc123");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("grava entry 'failed' com reason, sem url", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "diaria-append-twitter-fail-"));
    const publishedPath = join(tmpDir, "06-social-published.json");
    try {
      const r = run([
        "--published-path", publishedPath,
        "--destaque", "d2",
        "--status", "failed",
        "--reason", "texto excede 280 chars",
      ]);
      assert.equal(r.status, 0, `stderr: ${r.stderr}`);
      const data = JSON.parse(readFileSync(publishedPath, "utf8"));
      const entry = data.posts.find((p: any) => p.destaque === "d2");
      assert.equal(entry.status, "failed");
      assert.equal(entry.url, null);
      assert.equal(entry.reason, "texto excede 280 chars");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejeita --status inválido", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "diaria-append-twitter-badstatus-"));
    const publishedPath = join(tmpDir, "06-social-published.json");
    try {
      const r = run([
        "--published-path", publishedPath,
        "--destaque", "d1",
        "--status", "bogus",
      ]);
      assert.notEqual(r.status, 0);
      assert.ok(!existsSync(publishedPath));
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("upsert: 2ª chamada pro mesmo destaque substitui a entry, não duplica", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "diaria-append-twitter-upsert-"));
    const publishedPath = join(tmpDir, "06-social-published.json");
    try {
      run(["--published-path", publishedPath, "--destaque", "d1", "--status", "draft"]);
      const r2 = run([
        "--published-path", publishedPath,
        "--destaque", "d1",
        "--status", "published",
        "--url", "https://x.com/diariabr/status/999",
      ]);
      assert.equal(r2.status, 0, `stderr: ${r2.stderr}`);
      const data = JSON.parse(readFileSync(publishedPath, "utf8"));
      const entries = data.posts.filter((p: any) => p.destaque === "d1");
      assert.equal(entries.length, 1);
      assert.equal(entries[0].status, "published");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
