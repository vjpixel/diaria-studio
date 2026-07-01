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
// the effort-aware /code-review on the new PR. Effort is branch-aware (#2748):
// `overnight/*` branches get `low` (token-optimized — the overnight skill's own
// subagent already does an adversarial self-review pass per unit; a second full
// multi-agent `max` review on top was double-paying for depth on low-risk P3
// hardening PRs, the single biggest token sink observed in the 260630 session).
// Everything else (develop/manual PRs) keeps `max` — speed matters more than
// token count there, and `max` doesn't cost wall-clock time, just tokens.
// Never throws / never exits non-zero, so it can't block the Bash tool.

import { execFileSync } from "node:child_process";

/**
 * Resolve o headRefName de um PR e decide o effort de /code-review.
 * `execFn` é injetável (default = execFileSync real) pra ser testável sem gh live.
 * Fail-safe: qualquer erro (gh indisponível, PR não encontrado, timeout) → "max".
 */
export function resolveEffort(prUrl, execFn = execFileSync) {
  try {
    const num = prUrl.match(/\/pull\/(\d+)/)?.[1];
    if (!num) return "max";
    const branch = execFn(
      "gh",
      ["pr", "view", num, "--json", "headRefName", "--jq", ".headRefName"],
      { encoding: "utf8", timeout: 10_000 },
    ).trim();
    return branch.startsWith("overnight/") ? "low" : "max";
  } catch {
    return "max"; // fail-safe: unknown branch → keep the thorough default.
  }
}

/** Monta o additionalContext do hook a partir da URL do PR e do effort resolvido. Pure/testável. */
export function buildReviewInstruction(prUrl, effort) {
  const effortNote =
    effort === "low"
      ? "at LOW effort (overnight branch — token-optimized; fewer, high-confidence findings only)"
      : "at ULTRACODE / maximum effort: the full multi-agent review (many finder angles -> verify -> sweep, recall mode)";
  return (
    `A pull request was just created: ${prUrl} — per project policy, run ` +
    `\`/code-review ${effort} --comment\` on it now, ${effortNote}, ` +
    "posting findings as inline PR comments. Do NOT use cloud `ultra` (it is user-triggered/billed and cannot be self-launched)."
  );
}

// #2019: CLI guard — só roda o corpo do hook quando este arquivo é o entrypoint
// (nunca ao ser importado por test/pr-create-review-hook.test.ts).
const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
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
        const effort = resolveEffort(match[0]);
        process.stdout.write(
          JSON.stringify({
            hookSpecificOutput: {
              hookEventName: "PostToolUse",
              additionalContext: buildReviewInstruction(match[0], effort),
            },
          }),
        );
      }
    } catch {
      // Swallow everything: a hook that errors must not block the PR creation.
    }
  });
}
