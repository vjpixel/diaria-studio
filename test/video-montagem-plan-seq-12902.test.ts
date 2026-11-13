import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../scripts/video-montagem.ts";

// #12968: entradas mudadas não recusam mais o --seq (as outras sequências ficam
// no plano como defasadas): coberto em test/video-montagem-12968-12969.test.ts.

it("#12902: plano ilegível também recusa o build parcial antes de escrever", async () => {
  const dir = mkdtempSync(join(tmpdir(), "plan-seq-12902-"));
  try {
    writeFileSync(join(dir, "plan.json"), "{incompleto");
    await assert.rejects(main([
      "build", "261112", "--seq", "guia", "--state-dir", dir,
      "--work-dir", dir, "--out-dir", dir, "--no-drive-api", "--drive-root", dir,
    ]), /plan.json anterior ilegível.*rode build sem --seq/);
    assert.equal(readFileSync(join(dir, "plan.json"), "utf8"), "{incompleto");
    assert.deepEqual(readdirSync(dir), ["plan.json"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
