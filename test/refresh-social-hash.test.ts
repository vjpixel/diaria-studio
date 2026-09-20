import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { refreshSocialHash } from "../scripts/refresh-social-hash.ts";
import { hashHighlights } from "../scripts/lib/social-source-hash.ts";

describe("refresh-social-hash (#8596)", () => {
  it("grava o carimbo esperado", () => {
    const dir = mkdtempSync(join(tmpdir(), "rsh-"));
    try {
      mkdirSync(join(dir, "_internal"));
      const highlights = [{ url: "https://a.com/x", title_options: ["Titulo A"] }];
      writeFileSync(join(dir, "_internal", "01-approved.json"), JSON.stringify({ highlights }));
      const r = refreshSocialHash(dir);
      const saved = JSON.parse(readFileSync(r.path, "utf8"));
      assert.equal(saved.hash, hashHighlights(highlights));
      assert.ok(!Number.isNaN(Date.parse(saved.generated_at)));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("approved ausente lança erro", () => {
    const dir = mkdtempSync(join(tmpdir(), "rsh-"));
    try {
      assert.throws(() => refreshSocialHash(dir), /01-approved\.json ausente/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("CLI sai com exit 1 quando approved ausente", () => {
    const dir = mkdtempSync(join(tmpdir(), "rsh-"));
    try {
      const r = spawnSync(
        process.execPath,
        ["--import", "tsx", "scripts/refresh-social-hash.ts", "--edition-dir", dir],
        { encoding: "utf8" },
      );
      assert.equal(r.status, 1);
      assert.match(r.stderr, /ausente/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
