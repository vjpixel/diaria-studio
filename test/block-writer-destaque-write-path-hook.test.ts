import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
// @ts-expect-error -- hook .mjs sem .d.mts (TS7016); edição de .claude/hooks negada ao subagente.
import {
  isAllowedWriterDestaquePath,
  shouldBlockWrite,
} from "../.claude/hooks/block-writer-destaque-write-path.mjs";

// #9132 — Write do writer-destaque restrito aos 2 outputs do destaque.
const W = (agent_type: string | undefined, file_path: string) => ({
  tool_name: "Write",
  agent_type,
  tool_input: { file_path },
});

describe("block-writer-destaque-write-path (#9132)", () => {
  it("permite draft e prompt (nested, flat, absoluto)", () => {
    const root = process.cwd();
    for (const p of [
      "data/editions/2609/260930/_internal/02-d1-draft.md",
      "data/editions/260930/_internal/02-d3-prompt.md",
      `${root}/data/editions/2609/260930/_internal/02-d2-draft.md`,
    ]) assert.equal(shouldBlockWrite(W("writer-destaque", p)), false, p);
  });

  it("bloqueia outros paths do writer-destaque", () => {
    for (const p of [
      "data/editions/2609/260930/02-reviewed.md",
      "data/editions/2609/260930/_internal/01-approved.json",
      "data/editions/2609/260930/_internal/02-d4-draft.md",
      "data/editions/2609/260930/_internal/02-d1-draft.md/../../02-reviewed.md",
      "/tmp/data/editions/2609/260930/_internal/02-d1-draft.md",
      "/a/b/../data/editions/260930/_internal/02-d1-draft.md",
      "C:\\other\\data\\editions\\2609\\260930\\_internal\\02-d1-draft.md",
      "CLAUDE.md",
      ".claude/settings.json",
      "",
    ]) assert.equal(shouldBlockWrite(W("writer-destaque", p)), true, p);
  });

  it("não afeta outros agentes nem payload sem agent_type (fail-open)", () => {
    assert.equal(shouldBlockWrite(W("writer", "CLAUDE.md")), false);
    assert.equal(shouldBlockWrite(W(undefined, "CLAUDE.md")), false);
  });

  it("rejeita traversal", () => {
    assert.equal(
      isAllowedWriterDestaquePath("data/editions/2609/260930/_internal/../../x/_internal/02-d1-draft.md"),
      false,
    );
  });

  it("CLI emite deny e é silencioso quando permitido", () => {
    const run = (p: unknown) =>
      spawnSync("node", [".claude/hooks/block-writer-destaque-write-path.mjs"], {
        input: JSON.stringify(p), encoding: "utf8",
      }).stdout;
    assert.match(run(W("writer-destaque", "CLAUDE.md")), /"permissionDecision":"deny"/);
    assert.equal(run(W("writer-destaque", "data/editions/2609/260930/_internal/02-d1-draft.md")), "");
  });
});
