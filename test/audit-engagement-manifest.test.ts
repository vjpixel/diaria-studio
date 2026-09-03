/**
 * audit-engagement-manifest.test.ts (#7197)
 *
 * Cobre `readActualCounts` — o único helper de I/O do script, que traduz o
 * manifest + diretório em disco no `Map<post_id, count>` que alimenta
 * `reconcileManifestWithDisk` (lógica pura coberta em
 * `test/beehiiv-engagement-manifest.test.ts`). Sem exercitar `main()`
 * diretamente (mesmo padrão dos outros scripts deste módulo — I/O de CLI
 * fica sem teste unitário, só os helpers exportados).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { readActualCounts } from "../scripts/audit-engagement-manifest.ts";
import type { EngagementManifest } from "../scripts/lib/beehiiv-engagement-manifest.ts";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "audit-engagement-"));
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("readActualCounts", () => {
  it("conta linhas reais do .jsonl de cada post_id do manifest", () => {
    const outDir = setup();
    writeFileSync(resolve(outDir, "post_1.jsonl"), '{"subscriber_id":"a"}\n{"subscriber_id":"b"}\n');
    writeFileSync(resolve(outDir, "post_2.jsonl"), '{"subscriber_id":"c"}\n');
    const manifest: EngagementManifest = {
      generated_at: "t",
      posts: [
        { post_id: "post_1", status: "ok", count: 2 },
        { post_id: "post_2", status: "ok", count: 1 },
      ],
    };
    const counts = readActualCounts(manifest, outDir);
    assert.equal(counts.get("post_1"), 2);
    assert.equal(counts.get("post_2"), 1);
  });

  it("post_id sem .jsonl no disco conta como 0 (nunca lança)", () => {
    const outDir = setup();
    const manifest: EngagementManifest = {
      generated_at: "t",
      posts: [{ post_id: "post_fantasma", status: "ok", count: 40 }],
    };
    const counts = readActualCounts(manifest, outDir);
    assert.equal(counts.get("post_fantasma"), 0);
  });

  it("ignora linhas em branco no final do jsonl (mesma tolerância de countExistingLines)", () => {
    const outDir = setup();
    writeFileSync(resolve(outDir, "post_1.jsonl"), '{"a":1}\n{"a":2}\n\n');
    const manifest: EngagementManifest = { generated_at: "t", posts: [{ post_id: "post_1", status: "ok", count: 2 }] };
    assert.equal(readActualCounts(manifest, outDir).get("post_1"), 2);
  });
});
