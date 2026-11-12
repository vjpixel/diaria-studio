import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../scripts/video-montagem.ts";

test("#12904: a segunda passada preserva o vocabulary no blocks.template.json", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vm-12904-"));
  const vocabulary = [{ pattern: "Cloud Code", replacement: "Claude Code" }];
  try {
    writeFileSync(join(dir, "source.json"), JSON.stringify({ path: "bruto.mp4", fps: 30, durationS: 10, width: 1920, height: 1080, mirrored: false }));
    writeFileSync(join(dir, "transcript.json"), JSON.stringify({ duration: 10, segments: [{ start: 0, end: 2, text: "Cloud Code", words: [{ start: 0, end: 1, text: "Cloud" }, { start: 1, end: 2, text: "Code" }] }] }));
    for (const vocab of [vocabulary, [], undefined]) {
      writeFileSync(join(dir, "decupagem-plan.json"), JSON.stringify({ edition: "261112", blocks: [{ key: "comentario", rows: [{ segments: [1], suggestion: "usar" }] }], vocabulary: vocab }));
      assert.equal(await main(["decupagem", "261112", "--state-dir", dir, "--no-drive-api"]), 0);
      const template = JSON.parse(readFileSync(join(dir, "blocks.template.json"), "utf8"));
      assert.deepEqual(template.vocabulary, vocab);
      assert.equal(Object.hasOwn(template, "vocabulary"), vocab !== undefined);
      assert.equal(template.blocks.comentario[0].text, vocab?.length ? "Claude Code" : "Cloud Code");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
