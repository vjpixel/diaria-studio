// PreToolUse hook (#8588) — recusa `git commit` quando a sessão é CONTINUO
// (env DIARIA_SESSION_KIND=continuo, exportado por hermes/scripts/
// claude-delegate.sh) e o HEAD do cwd é master/main. Rodada overnight 260921:
// o continuo commitou 2x direto em `master` do checkout compartilhado do
// servidor 300, produzindo commits órfãos concorrentes com a PR já aberta.
// O resgate pós-fato (rescue-continuo-orphaned-work.ts) preserva o trabalho;
// este guard impede o commit na origem. Sessões interativas/overnight/develop
// não têm o marcador e nunca são afetadas. Self-contained; fail-open.
import { execFileSync } from "node:child_process";

export function stripQuotedSpans(command) {
  let r = "";
  let i = 0;
  const n = command.length;
  while (i < n) {
    const ch = command[i];
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < n && command[j] !== ch) {
        if (ch === '"' && command[j] === "\\") j++;
        j++;
      }
      i = j + 1;
      continue;
    }
    r += ch;
    i++;
  }
  return r;
}

export function commandHasGitCommit(command) {
  if (typeof command !== "string") return false;
  return stripQuotedSpans(command)
    .split(/(?:&&|;|\|\||\||\n)/)
    .map((s) => s.trim().split(/\s+/).filter(Boolean))
    .some((t) => t[0]?.toLowerCase() === "git" && t[1]?.toLowerCase() === "commit");
}

export function isContinuoSession(env = process.env) {
  return env.DIARIA_SESSION_KIND === "continuo";
}

export function isProtectedBranch(branch) {
  return branch === "master" || branch === "main";
}

export function getHeadBranch(cwd) {
  try {
    const out = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd,
      encoding: "utf8",
      timeout: 1000,
      windowsHide: true,
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

export const BLOCK_REASON =
  "`git commit` bloqueado (#8588): sessão continuo não pode commitar direto em master/main. " +
  "Crie uma branch própria (`git checkout -b continuo/fix-N-slug`) ou, melhor, um worktree " +
  "(`.claude/worktrees/`) antes de commitar — commit em master do checkout compartilhado vira " +
  "commit órfão concorrente com outras sessões.";

export function decide(payload, env = process.env, headBranch = getHeadBranch) {
  if (!isContinuoSession(env)) return null;
  if (payload?.tool_name && payload.tool_name !== "Bash") return null;
  if (!commandHasGitCommit(payload?.tool_input?.command)) return null;
  const cwd = typeof payload.cwd === "string" && payload.cwd !== "" ? payload.cwd : process.cwd();
  const branch = headBranch(cwd);
  if (!isProtectedBranch(branch)) return null;
  return BLOCK_REASON;
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  let data = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (c) => (data += c));
  process.stdin.on("end", () => {
    try {
      const reason = decide(JSON.parse(data || "{}"));
      if (reason) {
        process.stdout.write(
          JSON.stringify({
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "deny",
              permissionDecisionReason: reason,
            },
          }),
        );
      }
    } catch {
      // fail-open
    }
  });
}
