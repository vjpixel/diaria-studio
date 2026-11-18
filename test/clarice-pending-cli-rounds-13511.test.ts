/**
 * #13511: validação de CLI de `--rounds` / `--spacing-ms` do clarice-pending.
 * Valor inválido sai com exit 1 antes de qualquer retomada (nada é spawnado).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function run(extra: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "clarice-pending-13511-"));
  try {
    const r = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/clarice-pending.ts", "resume", "--edition-dir", dir, ...extra],
      { encoding: "utf8", cwd: join(import.meta.dirname, ".."), timeout: 30000 },
    );
    return { status: r.status, stderr: r.stderr ?? "" };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("clarice-pending CLI: --rounds/--spacing-ms (#13511)", () => {
  for (const args of [
    ["--rounds", "0"],
    ["--rounds", "-1"],
    ["--rounds", "1.5"],
    ["--rounds", "abc"],
    ["--spacing-ms", "-1"],
    ["--spacing-ms", "2.5"],
    ["--spacing-ms", "abc"],
  ]) {
    it(`rejeita ${args.join(" ")} com exit 1`, () => {
      const r = run(args);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /--rounds precisa ser inteiro ≥ 1 e --spacing-ms inteiro ≥ 0/);
    });
  }
});
