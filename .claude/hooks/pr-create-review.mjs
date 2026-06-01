// PostToolUse hook — auto-trigger /code-review after a PR is created.
//
// Wired in .claude/settings.json under hooks.PostToolUse:
//   matcher "Bash", if "Bash(gh pr create*)", shell "bash".
//
// Gating (when this fires):
//   1. Platform: PostToolUse runs only after the Bash tool SUCCEEDS. A failed
//      `gh pr create` (e.g. "a pull request already exists", non-zero exit)
//      routes to PostToolUseFailure, not here — this is the real success gate.
//   2. `if` filter: restricts to `gh pr create*` so `gh pr view`/`gh pr list`
//      (which also print /pull/ URLs) never run it. It is a START-ANCHORED
//      prefix, so it only matches a STANDALONE `gh pr create …` call — NOT a
//      chained `git push && gh pr create …`. Create PRs with a standalone
//      `gh pr create` call so the hook fires.
//   3. This script then extracts the created PR's URL from the tool output and
//      only emits the instruction when one is present (skips `--help`, etc.).
//
// Output: a PostToolUse `additionalContext` payload instructing Claude to run
// the effort-aware /code-review at MAX effort with --comment on the new PR
// (NOT the lighter default, NOT cloud `ultra`). Never throws / never exits
// non-zero, so it can't block the Bash tool.

let data = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (data += chunk));
process.stdin.on("end", () => {
  try {
    const payload = JSON.parse(data || "{}");
    const resp =
      typeof payload.tool_response === "string"
        ? payload.tool_response
        : JSON.stringify(payload.tool_response ?? "");
    const match = resp.match(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/);
    if (match) {
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PostToolUse",
            additionalContext:
              `A pull request was just created: ${match[0]} — per project policy, run ` +
              "`/code-review max --comment` on it now, at ULTRACODE / maximum effort: the full multi-agent review " +
              "(many finder angles -> verify -> sweep, recall mode), posting findings as inline PR comments. " +
              "Do NOT downgrade to the lighter default effort. Do NOT use cloud `ultra` (it is user-triggered/billed and cannot be self-launched).",
          },
        }),
      );
    }
  } catch {
    // Swallow everything: a hook that errors must not block the PR creation.
  }
});
