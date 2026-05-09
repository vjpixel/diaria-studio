import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

/**
 * Test: knip não deve reportar findings (#1008).
 *
 * Lock-in: PR que adiciona unused export/import/file/dep falha aqui.
 * Forças remoção via grep ou whitelist explícito em knip.json.
 */

describe("knip baseline (#1008)", () => {
  it("repo atual não tem findings", () => {
    const projectRoot = resolve(import.meta.dirname, "..");
    const result = spawnSync("npx", ["knip", "--reporter", "compact"], {
      cwd: projectRoot,
      encoding: "utf8",
      shell: process.platform === "win32",
    });

    if (result.stdout.trim().length > 0) {
      throw new Error(
        `knip detectou findings:\n${result.stdout}\n\n` +
          `Pra fixar: remover dead code OU adicionar ignore em knip.json com comentário.`,
      );
    }
    // Knip retorna 0 quando clean, !=0 quando há findings
    assert.equal(
      result.status,
      0,
      `knip retornou status ${result.status}: ${result.stderr}`,
    );
  });
});
