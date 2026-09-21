import { resolve as resolvePath } from "node:path";

const GUARDED = new Set(["commit", "merge", "cherry-pick", "revert", "am"]);
const PREFIXES = new Set(["env", "command", "sudo", "time", "nohup", "exec", "!"]);
const GLOBAL_WITH_ARG = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--super-prefix"]);
const RAW_RE = /\bgit\b.*?\b(commit|merge|cherry-pick|revert|am)\b/;

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

const cmd = 'bash -c "cd .claude/worktrees/x" && git commit -m y';
console.log(JSON.stringify(findGuardedOps(cmd, "/repo")));
