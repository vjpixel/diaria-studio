import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { filesForPr, type RunResult } from "../scripts/lib/merge-train-discovery.ts";

describe("filesForPr (#13386)", () => {
  it("lista PR com mais de 300 arquivos pela API paginada", () => {
    const names = Array.from({ length: 309 }, (_, i) => `p/edicao-${i}.html`);
    let seen: string[] = [];
    const run = (args: string[]): RunResult => {
      seen = args;
      return { ok: true, stdout: names.join("\n") + "\n" };
    };
    const files = filesForPr(13359, "/tmp", run);
    assert.deepEqual(files, names);
    assert.equal(seen[0], "api");
    assert.match(seen[1], /pulls\/13359\/files$/);
    assert.ok(seen.includes("--paginate"));
    assert.ok(!seen.includes("diff"));
  });

  it("falha do gh propaga erro", () => {
    assert.throws(
      () => filesForPr(1, "/tmp", () => ({ ok: false, stdout: "", error: "boom" })),
      /PR #1.*boom/,
    );
  });
});
