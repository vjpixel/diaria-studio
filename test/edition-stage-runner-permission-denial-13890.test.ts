import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runEditionStages, summarizePermissionDenials } from "../scripts/lib/edition-stage-runner.ts";

const denial = {
  tool_name: "Bash",
  tool_input: { command: "npx tsx scripts/gen-eia.ts 261124" },
  message: "PreToolUse: hook check-stage denied this command",
};
const stdout = JSON.stringify({ result: "unrelated output", permission_denials: [denial] });

it("#13890 preserves command and hook diagnostics for every denial without stage stdout", () => {
  const summary = summarizePermissionDenials(JSON.stringify({
    result: "PRIVATE STAGE OUTPUT",
    permission_denials: [denial, { tool_name: "Write", tool_input: { file_path: "/data/output" }, reason: "rule denied" }],
  }))!;
  assert.match(summary, /gen-eia.ts 261124/);
  assert.match(summary, /PreToolUse: hook check-stage/);
  assert.match(summary, /rule denied/);
  assert.doesNotMatch(summary, /PRIVATE STAGE OUTPUT/);
  assert.equal(summarizePermissionDenials("null"), null);
});

for (const throws of [false, true]) {
  it(`#13890 reports and logs denials on ${throws ? "nonzero exit" : "missing sentinel"}`, () => {
    const root = mkdtempSync(join(tmpdir(), "denials-13890-"));
    try {
      const result = runEditionStages({
        aammdd: "261124", editionDir: join(root, "edition"), repoRootAbs: root,
        plan: [{ stage: 3, skill: "diaria-3-imagens" }],
        resolveClaudeBin: () => "/bin/claude", env: {}, nowMs: () => 0,
        execFn: (() => {
          if (throws) throw Object.assign(new Error("failed"), { status: 1, stdout });
          return stdout;
        }) as never,
        assertSentinelFn: (() => ({ ok: false, reason: "sentinel_missing", missingOutputs: [] })) as never,
      });
      assert.equal(result.exitCode, 1);
      assert.match(result.outcomes[0].failureTail!, /gen-eia.ts 261124/);
      assert.match(result.outcomes[0].failureTail!, /hook check-stage/);
      const logs = readFileSync(join(root, "data/run-log.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
      const entry = logs.find((event) => event.agent === "edition-stage-runner");
      assert.equal(entry.edition, "261124");
      assert.equal(entry.stage, 3);
      assert.match(entry.message, /hook check-stage/);
      assert.match(entry.message, /gen-eia.ts 261124/);
      assert.doesNotMatch(entry.message, /unrelated output/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
