import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { checkUseMelhorSocialSource } from "../scripts/lib/invariant-checks/stage-4.ts";

test("fonte antiga no JSON e nova no ## um gera warning, ignorando links de outros blocos", () => {
  const dir = mkdtempSync(join(tmpdir(), "swap-um-"));
  try {
    mkdirSync(join(dir, "_internal"));
    writeFileSync(join(dir, "_internal/use-melhor-post.json"), JSON.stringify({ enabled: true, item: { url: "https://example.com/old" } }));
    const check = (text: string) => {
      writeFileSync(join(dir, "03-social.md"), text);
      return checkUseMelhorSocialSource(dir, { enabled: true, time: "07:45" });
    };
    assert.equal(check("# Social\n## um\nhttps://example.com/new\n## d1\nhttps://example.com/old")[0]?.severity, "warning");
    assert.deepEqual(check("# Social\n## um\n[Leia](https://www.example.com/old/?utm_source=teste#parte)"), []);
    assert.deepEqual(check("# Social\n## um\nTexto sem link"), []);
    assert.deepEqual(checkUseMelhorSocialSource(dir, { enabled: false, time: null }), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("CLI exige edição e URL antes de mutar", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/swap-use-melhor-post.ts"], { encoding: "utf8" });
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /--edition-dir.*--url/);
});
