import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

describe("#8682", () => {
  it("scripts mortos não aparecem como comando npx tsx", () => {
    const t = readFileSync(".claude/agents/orchestrator-stage-1-research.md", "utf-8");
    for (const s of ["check-min-sections.ts","strip-verifier.ts","dedupe-intra-edition.ts","filter-evergreen.ts"]) {
      assert.strictEqual(t.indexOf("npx tsx scripts/" + s), -1);
    }
  });
  it("fase post-select-render documentada", () => {
    const t = readFileSync(".claude/agents/orchestrator-stage-1-research.md", "utf-8");
    assert.ok(t.indexOf("post-select-render") > -1);
  });
  it("scripts citados existem diretamente em scripts/", () => {
    const t = readFileSync(".claude/agents/orchestrator-stage-1-research.md", "utf-8");
    const missing: string[] = [];
    let i = t.indexOf("npx tsx scripts/");
    while (i !== -1) {
      const rest = t.slice(i + 13);
      const end = rest.search(/[\s\n`\)]/);
      const f = end === -1 ? rest.trim() : rest.slice(0, end).trim();
      if (!f.includes("/") && f.endsWith(".ts") && !existsSync(join("scripts", f))) missing.push(f);
      i = t.indexOf("npx tsx scripts/", i + 1);
    }
    assert.deepStrictEqual(missing, []);
  });
});
