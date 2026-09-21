// PreToolUse hook (#8588) — recusa, para sessão CONTINUO (env
// DIARIA_SESSION_KIND=continuo, exportado por hermes/scripts/claude-delegate.sh),
// operações git que gravam commit/ref em master/main: commit, merge,
// cherry-pick, revert, am e `update-ref refs/heads/(master|main)`.
// Rodada overnight 260921: o continuo commitou 2x direto em `master` do
// checkout compartilhado do 300. O resgate pós-fato (rescue-continuo-
// orphaned-work.ts, #8615) preserva o trabalho; este guard impede na origem.
// Sessões interativas/overnight/develop não têm o marcador: nunca afetadas.
//
// Diretório efetivo: `cd X` prévio no mesmo comando e `git -C X` são
// resolvidos antes de checar a branch (worktree `.claude/worktrees/x` liberado).
// Parsing: pula flags globais do git (-C, -c, --no-pager, --git-dir=...),
// prefixos `(`, `{`, `env VAR=v`, `command`, `sudo`, `time`, `nohup`, e entra
// em `bash|sh -c "..."`. Aspas não fechadas: falha FECHADA (varre o texto cru).
//
// NÃO cobertas (documentado): `git push` de ref local para master remoto,
// `git reset`/`rebase`/`pull` que movem master, comandos via alias git,
// `eval`/`$(...)` dinâmicos, scripts que chamam git internamente, git em
// arquivo .sh executado. Fail-open em erro do hook.
import { execFileSync } from "node:child_process";
import { resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";

const GUARDED = new Set(["commit", "merge", "cherry-pick", "revert", "am"]);
const PREFIXES = new Set(["env", "command", "sudo", "time", "nohup", "exec", "!"]);
const GLOBAL_WITH_ARG = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--super-prefix"]);
const RAW_RE = /\bgit\b.*?\b(commit|merge|cherry-pick|revert|am)\b/;

/** Remove corpos de heredoc, preservando a linha de abertura. */
export function stripHeredocs(command) {
  const lines = command.split("\n");
  const out = [];
  let end = null;
  let dash = false;
  for (const line of lines) {
    if (end !== null) {
      if ((dash ? line.trim() : line) === end) end = null;
      continue;
    }
    out.push(line);
    const m = /<<(-?)\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/.exec(line);
    if (m) {
      dash = m[1] === "-";
      end = m[3];
    }
  }
  return out.join("\n");
}

/**
 * Tokeniza respeitando aspas; devolve segmentos (arrays de tokens sem aspas).
 * `null` quando há aspa não fechada (chamador falha fechado).
 */
export function tokenize(command) {
  const segs = [];
  let cur = [];
  let tok = "";
  let has = false;
  const push = () => {
    if (has) cur.push(tok);
    tok = "";
    has = false;
  };
  const endSeg = () => {
    push();
    if (cur.length) segs.push(cur);
    cur = [];
  };
  const n = command.length;
  for (let i = 0; i < n; i++) {
    const ch = command[i];
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < n && command[j] !== ch) {
        if (ch === '"' && command[j] === "\\") j++;
        j++;
      }
      if (j >= n) return null;
      tok += command.slice(i + 1, j);
      has = true;
      i = j;
    } else if (ch === "&" || ch === ";" || ch === "|" || ch === "\n") {
      endSeg();
    } else if (ch === "(" || ch === "{" || ch === ")" || ch === "}") {
      push();
    } else if (/\s/.test(ch)) {
      push();
    } else {
      tok += ch;
      has = true;
    }
  }
  endSeg();
  return segs;
}

function skipPrefixes(tokens) {
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (PREFIXES.has(t) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) i++;
    else break;
  }
  return tokens.slice(i);
}

/**
 * Operações git guardadas em `command`: `{ sub, dir }`, dir = diretório
 * efetivo (cd prévio / -C resolvidos contra `baseCwd`).
 */
export function findGuardedOps(command, baseCwd) {
  const ops = [];
  if (typeof command !== "string") return ops;
  const top = tokenize(stripHeredocs(command));
  if (top === null) {
    const m = RAW_RE.exec(command);
    if (m) ops.push({ sub: m[1], dir: baseCwd });
    return ops;
  }
  let dir = baseCwd;
  const walk = (segments) => {
    for (const raw of segments) {
      const tokens = skipPrefixes(raw);
      if (tokens.length === 0) continue;
      const head = tokens[0].split(/[\\/]/).pop();
      if (head === "cd" && tokens[1]) {
        dir = resolvePath(dir, tokens[1]);
        continue;
      }
      if ((head === "bash" || head === "sh" || head === "zsh") && tokens.includes("-c")) {
        const inner = tokens[tokens.indexOf("-c") + 1];
        if (inner) {
          const innerSegs = tokenize(stripHeredocs(inner));
          if (innerSegs) walk(innerSegs);
          else {
            const m = RAW_RE.exec(inner);
            if (m) ops.push({ sub: m[1], dir });
          }
        }
        continue;
      }
      if (head !== "git") continue;
      let eff = dir;
      let i = 1;
      while (i < tokens.length && tokens[i].startsWith("-")) {
        const f = tokens[i];
        if (f === "-C" && tokens[i + 1]) {
          eff = resolvePath(eff, tokens[i + 1]);
          i += 2;
        } else if (GLOBAL_WITH_ARG.has(f)) {
          i += 2;
        } else i++;
      }
      const sub = tokens[i]?.toLowerCase();
      if (!sub) continue;
      if (GUARDED.has(sub)) ops.push({ sub, dir: eff });
      else if (sub === "update-ref" && tokens.slice(i + 1).some((t) => /^refs\/heads\/(master|main)$/.test(t))) {
        ops.push({ sub, dir: eff });
      }
    }
  };
  walk(top);
  return ops;
}

export function commandHasGitCommit(command) {
  return findGuardedOps(command, ".").some((o) => o.sub === "commit");
}

export function isContinuoSession(env = process.env) {
  return env.DIARIA_SESSION_KIND === "continuo";
}

export function isProtectedBranch(branch) {
  return branch === "master" || branch === "main";
}

export function getHeadBranch(cwd) {
  try {
    const out = execFileSync("git", ["symbolic-ref", "--short", "-q", "HEAD"], {
      cwd,
      encoding: "utf8",
      timeout: 1000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

export const BLOCK_REASON =
  "`git commit` (ou merge/cherry-pick/revert/am/update-ref) bloqueado (#8588): sessão continuo não pode gravar direto em master/main. " +
  "Crie uma branch própria (`git checkout -b continuo/fix-N-slug`) ou, melhor, um worktree " +
  "(`.claude/worktrees/`) antes de commitar — commit em master do checkout compartilhado vira " +
  "commit órfão concorrente com outras sessões.";

export function decide(payload, env = process.env, headBranch = getHeadBranch) {
  if (!isContinuoSession(env)) return null;
  if (payload?.tool_name && payload.tool_name !== "Bash") return null;
  const base = typeof payload?.cwd === "string" && payload.cwd !== "" ? payload.cwd : process.cwd();
  for (const op of findGuardedOps(payload?.tool_input?.command, base)) {
    if (isProtectedBranch(headBranch(op.dir))) return BLOCK_REASON;
  }
  return null;
}

const _argv1 = process.argv[1];
if (_argv1 && import.meta.url === pathToFileURL(_argv1).href) {
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
