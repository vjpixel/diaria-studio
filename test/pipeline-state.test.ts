import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  writeSentinel,
  sentinelExists,
  readSentinel,
  assertSentinel,
} from "../scripts/lib/pipeline-state.ts";

function mkEditionDir(): string {
  return mkdtempSync(join(tmpdir(), "diaria-sentinel-"));
}

describe("pipeline-state (#780)", () => {
  it("write → sentinelExists → true", () => {
    const dir = mkEditionDir();
    try {
      writeSentinel(dir, 1, ["01-categorized.md"]);
      assert.equal(sentinelExists(dir, 1), true);
      assert.equal(sentinelExists(dir, 2), false);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("readSentinel devolve shape correta", () => {
    const dir = mkEditionDir();
    try {
      writeSentinel(dir, 2, ["02-reviewed.md", "03-social.md"]);
      const s = readSentinel(dir, 2);
      assert.ok(s, "deve retornar sentinel");
      assert.equal(s!.step, 2);
      assert.deepEqual(s!.outputs, ["02-reviewed.md", "03-social.md"]);
      assert.ok(s!.completed_at, "completed_at deve estar presente");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("readSentinel → null se ausente", () => {
    const dir = mkEditionDir();
    try {
      assert.equal(readSentinel(dir, 1), null);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("assertSentinel → ok:true quando sentinel e outputs existem", () => {
    const dir = mkEditionDir();
    try {
      // Create the output file sentinel will reference
      writeFileSync(join(dir, "02-reviewed.md"), "content");
      writeSentinel(dir, 2, ["02-reviewed.md"]);
      const result = assertSentinel(dir, 2);
      assert.equal(result.ok, true);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("assertSentinel → sentinel_missing quando sentinel ausente", () => {
    const dir = mkEditionDir();
    try {
      const result = assertSentinel(dir, 1);
      assert.equal(result.ok, false);
      assert.equal((result as { reason: string }).reason, "sentinel_missing");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("assertSentinel → outputs_missing quando output deletado após write", () => {
    const dir = mkEditionDir();
    try {
      // Write sentinel referencing a file, then delete the file
      writeSentinel(dir, 1, ["01-categorized.md", "_internal/01-approved.json"]);
      const result = assertSentinel(dir, 1);
      assert.equal(result.ok, false);
      assert.equal((result as { reason: string }).reason, "outputs_missing");
      const missing = (result as { missingOutputs: string[] }).missingOutputs;
      assert.ok(missing.includes("01-categorized.md"));
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("writeSentinel cria _internal/ se não existir", () => {
    const dir = mkEditionDir();
    try {
      // _internal/ does not exist yet
      writeSentinel(dir, 3, []);
      assert.equal(sentinelExists(dir, 3), true);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("assertSentinel → outputs_missing lista só os ausentes", () => {
    const dir = mkEditionDir();
    try {
      writeFileSync(join(dir, "02-reviewed.md"), "x");
      // 03-social.md not created
      writeSentinel(dir, 2, ["02-reviewed.md", "03-social.md"]);
      const result = assertSentinel(dir, 2);
      assert.equal(result.ok, false);
      assert.equal((result as { reason: string }).reason, "outputs_missing");
      const missing = (result as { missingOutputs: string[] }).missingOutputs;
      assert.deepEqual(missing, ["03-social.md"]);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("outputs em _internal/ são resolvidos relativos a editionDir", () => {
    const dir = mkEditionDir();
    try {
      mkdirSync(join(dir, "_internal"), { recursive: true });
      writeFileSync(join(dir, "_internal", "01-approved.json"), "{}");
      writeSentinel(dir, 1, ["_internal/01-approved.json"]);
      const result = assertSentinel(dir, 1);
      assert.equal(result.ok, true);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
