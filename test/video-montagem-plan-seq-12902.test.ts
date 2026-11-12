import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../scripts/video-montagem.ts";

for (const seq of ["outras-redes", "guia"]) {
  it(`#12902: build --seq ${seq} com entradas novas recusa sem alterar plano, versões ou XML`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "plan-seq-12902-"));
    try {
      const files: Record<string, string> = {
        "blocks.json": JSON.stringify({ edition: "261112", blocks: { titulo: [{ text: "Título novo" }] } }),
        "source.json": "{}",
        "plan.json": JSON.stringify({
          hash: "anterior",
          plans: [{ spec: { target: "youtube", name: "Horizontal_V2", width: 1920, height: 1080 }, script: "Título anterior" }],
          builtAt: { youtube: 100 },
          xmlVersions: { youtube: { id: "horizontal-v2", since: 100 } },
        }),
        "Horizontal_V2.xml": "XML anterior",
      };
      for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
      await assert.rejects(main([
        "build", "261112", "--seq", seq, "--state-dir", dir,
        "--work-dir", dir, "--out-dir", dir, "--no-drive-api", "--drive-root", dir,
      ]), /build --seq recusado: as entradas mudaram.*rode build sem --seq.*#12902/);
      assert.deepEqual(readdirSync(dir).sort(), Object.keys(files).sort());
      for (const [name, content] of Object.entries(files)) assert.equal(readFileSync(join(dir, name), "utf8"), content, name);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

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
