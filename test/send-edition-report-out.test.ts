/**
 * test/send-edition-report-out.test.ts (#1579)
 *
 * Cobre o flag --out de send-edition-report.ts: escreve HTML em arquivo +
 * grava .edition-report-md5.txt no _internal/.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

function runCli(args: string[]): { status: number | null; stderr: string; stdout: string } {
  const projectRoot = join(import.meta.dirname, "..");
  const scriptPath = join(projectRoot, "scripts", "send-edition-report.ts");
  const r = spawnSync(
    process.execPath,
    ["--import", "tsx", scriptPath, ...args],
    { cwd: projectRoot, encoding: "utf8" },
  );
  return { status: r.status, stderr: r.stderr || "", stdout: r.stdout || "" };
}

describe("send-edition-report --out (#1579)", () => {
  function makeEditionDir(): { root: string; editionDir: string; editionRelPath: string } {
    const root = mkdtempSync(join(tmpdir(), "send-report-"));
    const editionRelPath = "data/editions/260529";
    const editionDir = join(root, editionRelPath);
    mkdirSync(join(editionDir, "_internal"), { recursive: true });
    return { root, editionDir, editionRelPath };
  }

  it("--out escreve HTML + grava manifest md5", () => {
    const { root, editionDir, editionRelPath } = makeEditionDir();
    try {
      // Setup minimal canonical data
      writeFileSync(
        join(editionDir, "_internal", "stage-status.json"),
        JSON.stringify({
          edition: "260529",
          rows: [],
          generated_at: new Date().toISOString(),
        }),
      );

      const htmlAbsPath = join(editionDir, "_internal", "edition-report.html");
      const r = runCli(
        [
          "--edition", "260529",
          "--edition-dir", editionDir,
          "--out", htmlAbsPath,
        ],
      );
      assert.equal(r.status, 0, r.stderr);

      assert.ok(existsSync(htmlAbsPath), "HTML file should exist");
      const html = readFileSync(htmlAbsPath, "utf8");
      assert.ok(html.length > 100, "HTML should be substantial");

      const manifestPath = join(editionDir, "_internal", ".edition-report-md5.txt");
      assert.ok(existsSync(manifestPath), "md5 manifest should exist");
      const manifestMd5 = readFileSync(manifestPath, "utf8").trim();
      const computedMd5 = createHash("md5").update(html).digest("hex");
      assert.equal(manifestMd5, computedMd5, "manifest md5 should match HTML md5");
    } finally {
      rmSync(root, { recursive: true });
    }
  });

  it("sem --out → ainda escreve em stdout (back-compat)", () => {
    const { root, editionDir } = makeEditionDir();
    try {
      writeFileSync(
        join(editionDir, "_internal", "stage-status.json"),
        JSON.stringify({
          edition: "260529",
          rows: [],
          generated_at: new Date().toISOString(),
        }),
      );

      const r = runCli(["--edition", "260529", "--edition-dir", editionDir]);
      assert.equal(r.status, 0, r.stderr);
      assert.ok(r.stdout.length > 100, "stdout should have HTML");
      // Manifest should NOT exist when --out not used
      assert.equal(
        existsSync(join(editionDir, "_internal", ".edition-report-md5.txt")),
        false,
        "manifest NÃO deve existir sem --out (orchestrator sabe que pode reconstruir)",
      );
    } finally {
      rmSync(root, { recursive: true });
    }
  });
});
