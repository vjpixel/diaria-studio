import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readGlmLaneUnits } from "../scripts/check-glm-lane-gate.ts";

const dirs: string[] = [];
function tmpFile(content: string | null): string {
  const dir = mkdtempSync(join(tmpdir(), "glm-lane-gate-test-"));
  dirs.push(dir);
  const path = join(dir, "units.jsonl");
  if (content !== null) writeFileSync(path, content, "utf8");
  return path;
}
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("readGlmLaneUnits (#6930)", () => {
  it("arquivo ausente → lista vazia (estado inicial legítimo do piloto), nunca erro", () => {
    const path = join(tmpdir(), "glm-lane-gate-test-nonexistent", "units.jsonl");
    assert.deepEqual(readGlmLaneUnits(path), []);
  });

  it("arquivo com N linhas válidas → N registros, na ordem", () => {
    const path = tmpFile('{"issue":1,"prNumber":10}\n{"issue":2,"prNumber":null}\n');
    const records = readGlmLaneUnits(path);
    assert.equal(records.length, 2);
    assert.equal(records[0].issue, 1);
    assert.equal(records[1].issue, 2);
  });

  it("linhas em branco são ignoradas silenciosamente (não viram registro vazio)", () => {
    const path = tmpFile('{"issue":1}\n\n\n{"issue":2}\n');
    assert.equal(readGlmLaneUnits(path).length, 2);
  });

  it("linha malformada é IGNORADA, não derruba a leitura das demais", () => {
    const path = tmpFile('{"issue":1}\nnão é json{{{\n{"issue":2}\n');
    const records = readGlmLaneUnits(path);
    assert.equal(records.length, 2);
    assert.equal(records[0].issue, 1);
    assert.equal(records[1].issue, 2);
  });

  it("arquivo vazio → lista vazia", () => {
    const path = tmpFile("");
    assert.deepEqual(readGlmLaneUnits(path), []);
  });
});
