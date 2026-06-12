import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { assertCellsNotDropped } from "../scripts/clarice-split-cells.ts";

describe("assertCellsNotDropped (guard de re-split)", () => {
  it("não lança quando o sentinel .a-dropped.json está ausente", () => {
    const dir = mkdtempSync(join(tmpdir(), "cells-noguard-"));
    try {
      assert.doesNotThrow(() => assertCellsNotDropped(dir));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("lança quando o sentinel existe (protege CSVs editados à mão)", () => {
    const dir = mkdtempSync(join(tmpdir(), "cells-guard-"));
    try {
      writeFileSync(resolve(dir, ".a-dropped.json"), '{"reason":"test"}');
      assert.throws(() => assertCellsNotDropped(dir), /re-split abortado/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
