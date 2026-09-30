import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const md = readFileSync(".claude/agents/orchestrator-stage-4.md", "utf8");
const line = md;

describe("orchestrator-stage-4 same_fact_warnings (#9216)", () => {
  it("lê o JSON do Stage 1 e é warn-only", () => {
    assert.ok(line, "linha same_fact_warnings ausente");
    assert.match(line, /01-highlight-theme-check\.json/);
    assert.match(line, /same_fact_warnings[^\n]*WARN-ONLY/);
    assert.match(line, /02-reviewed\.md/);
  });
  it("o artefato citado é o que o Stage 1 grava", () => {
    const s1 = readFileSync(".claude/agents/orchestrator-stage-1-research.md", "utf8");
    assert.match(s1, /--out-json \{EDITION_DIR\}\/_internal\/01-highlight-theme-check\.json/);
  });
});
