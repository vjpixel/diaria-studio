// Detecção pura de escrita via Bash em caminho protegido (#12009).
//
// Incidente de origem: na rodada overnight 261103 (unidade #11990) o
// `dev-implementador` alterou `.claude/skills/diaria-video-montagem/SKILL.md`
// com um script Python no Bash. O Claude Code protege `.claude/` no Edit/Write
// (pergunta ao editor; no modo agendado sem TTY, nega), mas a checagem de
// caminho protegido não enxerga o que um `python3 -c`/`sed -i`/`>` faz dentro
// do Bash. Decisão do editor (briefing 261103): um hook PreToolUse no Bash
// detecta a escrita em caminho protegido e nega.
//
// Este arquivo é JS puro (ESM, sem dependência) de propósito: o hook
// `.claude/hooks/block-bash-protected-path-write.mjs` roda com o `node` cru do
// PATH do harness, que pode não ter type-stripping (#7836: um hook que
// importava `.ts` quebrou em produção num Node 20). Os testes importam este
// mesmo arquivo, então não há cópia a manter em sincronia.
//
// Princípio: só nega quando um caminho protegido aparece como ALVO de escrita.
// Leitura (`cat`, `grep`, `git diff`, `git show`, `sed -n`), texto citado
// (`git commit -m "..."`, `gh pr create --body "..."`) e corpo de heredoc de
// comando que não é interpretador (`cat > /tmp/corpo.md <<'EOF'`) seguem livres.
//
// O que conta como escrita:
//   - redirecionamento `>`, `>>`, `>|`, `&>`, `&>>`, `<>` (e `>&` com arquivo);
//   - `tee`, `sed -i`/`--in-place`, `perl -i`, `awk -i inplace`;
//   - `cp`/`install`/`ln`/`rsync` com destino protegido; `mv`, `rm`, `unlink`,
//     `rmdir`, `truncate`, `touch`, `mkdir`, `shred` com qualquer operando
//     protegido; `dd of=`;
//   - `find <caminho protegido> -delete|-exec <escritor>` e `... | xargs
//     <escritor>` quando o pipeline cita caminho protegido;
//   - código inline de interpretador (`python -c`, `node -e`, `perl -e`,
//     `ruby -e`, `tsx -e`, heredoc/here-string pro interpretador, e script em
//     arquivo FORA do projeto, como `/tmp/fix.py`) que cita caminho protegido
//     E usa API de escrita (`open(..., 'w')`, `write_text`, `writeFileSync`...);
//   - `bash -c`/`sh -c`/`eval`/`bash <<EOF`: analisados como shell, recursivo.
//
// LIMITES CONHECIDOS (aceitos): caminho montado em variável opaca
// (`f=.claude/x; echo > "$f"` passa — `$f` não é resolvido), script do próprio
// repo (`npx tsx scripts/x.ts`, de propósito: os scripts versionados passam
// por review), `git checkout/restore -- .claude/...`, `patch` lendo o alvo do
// diff, e interpretador que monta o caminho em partes não reconhecidas.
// Desde o #12780, caminho protegido citado só dentro de string de PROSA do
// código (ver `stripProseLiterals`) não conta como citação.

/**
 * Entradas protegidas logo abaixo de um segmento `.claude/`. É a lista única
 * deste guard: o Claude Code não expõe a dele, e a do `context/
 * overnight-dispatch-rules.md` item 34 (skills, agents, hooks, settings) é o
 * núcleo. `worktrees/` fica de fora (é onde moram os worktrees dos
 * subagentes; o `.claude/` ANINHADO dentro de um worktree volta a ser
 * protegido), assim como `projects/` (memória do usuário) e o resto.
 */
export const PROTECTED_CLAUDE_ENTRIES = Object.freeze([
  "skills",
  "agents",
  "hooks",
  "commands",
  "rules",
  "output-styles",
  "settings.json",
  "settings.local.json",
]);

/** Arquivos protegidos pelo nome, em qualquer diretório. */
export const PROTECTED_BASENAMES = Object.freeze([".mcp.json"]);

/** Entradas protegidas logo abaixo de um segmento `.git/`. */
export const PROTECTED_GIT_ENTRIES = Object.freeze(["hooks", "config"]);

const GLOB_RE = /[*?[]/;

function toPosix(p) {
  return String(p).replace(/\\/g, "/");
}

/** `a/./b/../c` → `a/c`, preservando o prefixo absoluto. */
function normalizePosix(p) {
  const abs = p.startsWith("/");
  const out = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length && out[out.length - 1] !== "..") out.pop();
      else if (!abs) out.push("..");
      continue;
    }
    out.push(seg);
  }
  return (abs ? "/" : "") + out.join("/");
}

/** Caminho que não deve ser juntado ao cwd (absoluto, `~`, variável, drive). */
function isAnchored(p) {
  return p.startsWith("/") || p.startsWith("~") || p.startsWith("$") || /^[A-Za-z]:\//.test(p);
}

/**
 * Resolve `p` contra `cwd` (quando relativo) e devolve os segmentos, ou `null`
 * quando `p` não parece caminho (vazio, só fd, opção).
 */
function pathSegments(p, cwd) {
  if (typeof p !== "string") return null;
  let s = toPosix(p.trim());
  if (s === "" || /^\d+$/.test(s) || s === "-") return null;
  if (s.startsWith("file://")) s = s.slice("file://".length);
  if (!isAnchored(s) && cwd) s = `${toPosix(cwd).replace(/\/+$/, "")}/${s}`;
  return normalizePosix(s).split("/").filter((x) => x !== "");
}

/** Os segmentos descrevem um caminho protegido? */
function segmentsProtected(segs) {
  if (!segs || segs.length === 0) return false;
  if (PROTECTED_BASENAMES.includes(segs[segs.length - 1])) return true;
  // `.git/hooks` e `.git/config`: vetores de execução de código. O resto de
  // `.git/` fica livre de propósito (`rm -f .git/index.lock` é limpeza
  // legítima de lock órfão).
  const gitIdx = segs.lastIndexOf(".git");
  if (gitIdx !== -1 && PROTECTED_GIT_ENTRIES.includes(segs[gitIdx + 1])) return true;
  const idx = segs.lastIndexOf(".claude");
  if (idx === -1) return false;
  const entry = segs[idx + 1];
  // O próprio `.claude/` como destino (`cp x .claude/`) cria arquivo nele.
  if (entry === undefined) return true;
  if (entry === "worktrees") return false;
  if (PROTECTED_CLAUDE_ENTRIES.includes(entry)) return true;
  return GLOB_RE.test(entry);
}

/**
 * `p` (relativo a `cwd`, quando relativo) é caminho protegido? Exportado para
 * o teste e para quem quiser reusar a mesma lista.
 */
export function isProtectedPath(p, cwd = "") {
  return segmentsProtected(pathSegments(p, cwd));
}

// ---------------------------------------------------------------------------
// Tokenizer de shell (aproximado, conservador)
// ---------------------------------------------------------------------------

function newCmd(pipeline) {
  return { words: [], redirects: [], stdin: [], pipeline };
}

/**
 * Quebra `src` em comandos simples: `{ words, redirects, stdin, pipeline }`.
 * `words` já vem sem aspas; `redirects` são `{ op, target }`; `stdin` são os
 * corpos de heredoc/here-string entregues ao comando; `pipeline` agrupa os
 * comandos ligados por `|`. Substituição de comando (`$(...)`, crase) e
 * subshell viram comandos próprios.
 */
export function tokenizeShell(src) {
  const cmds = [];
  if (typeof src !== "string") return cmds;
  let pipeline = 0;
  let cur = newCmd(pipeline);
  let word = null;
  let pendingRedirect = null;
  let pendingHeredoc = null;
  const heredocQueue = [];
  const n = src.length;

  const appendWord = (text) => {
    if (word === null) word = "";
    word += text;
  };
  const flushWord = () => {
    if (word === null) return;
    const text = word;
    word = null;
    if (pendingHeredoc) {
      heredocQueue.push({ cmd: cur, delim: text, strip: pendingHeredoc.strip });
      pendingHeredoc = null;
    } else if (pendingRedirect) {
      if (pendingRedirect === "<<<") cur.stdin.push(text);
      else cur.redirects.push({ op: pendingRedirect, target: text });
      pendingRedirect = null;
    } else {
      cur.words.push(text);
    }
  };
  const endCmd = (isPipe) => {
    flushWord();
    pendingRedirect = null;
    if (cur.words.length || cur.redirects.length || cur.stdin.length) cmds.push(cur);
    if (!isPipe) pipeline++;
    // Comando de heredoc ainda pendente segura a referência: o corpo é
    // anexado depois, no fim da linha.
    cur = newCmd(pipeline);
  };

  let i = 0;
  while (i < n) {
    const ch = src[i];
    if (ch === "\\") {
      if (src[i + 1] === "\n") {
        i += 2;
        continue;
      }
      if (i + 1 < n) appendWord(src[i + 1]);
      i += 2;
      continue;
    }
    if (ch === "$" && src[i + 1] === "'") {
      let j = i + 2;
      let text = "";
      while (j < n && src[j] !== "'") {
        if (src[j] === "\\" && j + 1 < n) {
          const nx = src[j + 1];
          text += nx === "n" ? "\n" : nx === "t" ? "\t" : nx;
          j += 2;
          continue;
        }
        text += src[j];
        j++;
      }
      appendWord(text);
      i = j + 1;
      continue;
    }
    if (ch === "'") {
      const j = src.indexOf("'", i + 1);
      const end = j === -1 ? n : j;
      appendWord(src.slice(i + 1, end));
      i = end + 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let text = "";
      while (j < n && src[j] !== '"') {
        if (src[j] === "\\" && j + 1 < n && '"\\$`\n'.includes(src[j + 1])) {
          if (src[j + 1] !== "\n") text += src[j + 1];
          j += 2;
          continue;
        }
        text += src[j];
        j++;
      }
      appendWord(text);
      i = j + 1;
      continue;
    }
    if (ch === "#" && word === null) {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\r") {
      flushWord();
      i++;
      continue;
    }
    if (ch === "\n") {
      endCmd(false);
      i++;
      // Corpos de heredoc começam na linha seguinte ao operador.
      while (heredocQueue.length) {
        const hd = heredocQueue.shift();
        const lines = [];
        let closed = false;
        while (i < n) {
          let e = src.indexOf("\n", i);
          if (e === -1) e = n;
          let line = src.slice(i, e);
          i = e + 1;
          if (line.endsWith("\r")) line = line.slice(0, -1);
          const cmp = hd.strip ? line.replace(/^\t+/, "") : line;
          if (cmp === hd.delim) {
            closed = true;
            break;
          }
          lines.push(line);
        }
        hd.cmd.stdin.push(lines.join("\n"));
        if (!closed) i = n;
      }
      continue;
    }
    if (ch === "$" && src[i + 1] === "(") {
      endCmd(false);
      i += 2;
      continue;
    }
    if (ch === "`" || ch === "(" || ch === ")" || ch === ";") {
      endCmd(false);
      i++;
      continue;
    }
    if (ch === "|") {
      if (src[i + 1] === "|") {
        endCmd(false);
        i += 2;
      } else {
        endCmd(true);
        i += src[i + 1] === "&" ? 2 : 1;
      }
      continue;
    }
    if (ch === "&") {
      if (src[i + 1] === ">") {
        flushWord();
        const append = src[i + 2] === ">";
        pendingRedirect = append ? "&>>" : "&>";
        i += append ? 3 : 2;
        continue;
      }
      endCmd(false);
      i += src[i + 1] === "&" ? 2 : 1;
      continue;
    }
    if (ch === ">" || ch === "<") {
      // `2>` / `10>`: o número colado é o descritor, não uma palavra.
      if (word !== null && /^\d+$/.test(word)) word = null;
      flushWord();
      let op;
      if (ch === ">") {
        const nx = src[i + 1];
        op = nx === ">" ? ">>" : nx === "|" ? ">|" : nx === "&" ? ">&" : ">";
      } else if (src.startsWith("<<<", i)) op = "<<<";
      else if (src.startsWith("<<-", i)) op = "<<-";
      else if (src.startsWith("<<", i)) op = "<<";
      else if (src.startsWith("<>", i)) op = "<>";
      else if (src.startsWith("<&", i)) op = "<&";
      else op = "<";
      i += op.length;
      if (op === "<<" || op === "<<-") pendingHeredoc = { strip: op === "<<-" };
      else pendingRedirect = op;
      continue;
    }
    appendWord(ch);
    i++;
  }
  endCmd(false);
  // Heredoc sem quebra de linha depois do operador: sem corpo.
  return cmds;
}

// ---------------------------------------------------------------------------
// Análise por comando
// ---------------------------------------------------------------------------

const ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
const KEYWORDS = new Set(["{", "}", "!", "then", "do", "else", "elif", "if", "while", "until", "time"]);
const WRAPPERS = new Set(["env", "command", "builtin", "exec", "sudo", "doas", "timeout", "nice", "ionice", "nohup", "stdbuf", "chronic"]);
/** Flags de wrapper que consomem a palavra seguinte. */
const WRAPPER_VALUE_FLAGS = new Set(["-u", "-g", "-n", "-s", "-k", "-C", "-o", "-c", "--signal", "--kill-after", "--user", "--group", "--chdir", "--adjustment"]);
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);
const WRITE_REDIRECTS = new Set([">", ">>", ">|", "&>", "&>>", "<>", ">&"]);

const basename = (w) => toPosix(w).split("/").pop();

/** Índice da palavra de comando, depois de atribuições, palavras-chave e wrappers. */
function headIndex(words) {
  let i = 0;
  let afterWrapper = false;
  while (i < words.length) {
    const w = words[i];
    if (ASSIGNMENT_RE.test(w) || KEYWORDS.has(w)) {
      i++;
      continue;
    }
    const b = basename(w);
    if (WRAPPERS.has(b)) {
      afterWrapper = b !== "command" && b !== "builtin" && b !== "exec";
      i++;
      continue;
    }
    if (afterWrapper && w.startsWith("-")) {
      i += WRAPPER_VALUE_FLAGS.has(w) ? 2 : 1;
      continue;
    }
    // duração do `timeout 30`/`timeout 5m`
    if (afterWrapper && /^\d+(\.\d+)?[smhd]?$/.test(w)) {
      i++;
      continue;
    }
    return i;
  }
  return -1;
}

function interpreterKind(head) {
  if (/^python(\d+(\.\d+)?)?$/.test(head) || head === "pypy3") return "python";
  if (head === "node" || head === "nodejs" || head === "tsx" || head === "ts-node" || head === "bun" || head === "deno") return "node";
  if (head === "perl") return "perl";
  if (head === "ruby") return "ruby";
  return null;
}

/** Operandos (não-opção) de uma lista de argumentos; `--` encerra as opções. */
function operands(args, valueFlags = new Set()) {
  const out = [];
  let opts = true;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (opts && a === "--") {
      opts = false;
      continue;
    }
    if (opts && a.startsWith("-") && a !== "-") {
      if (valueFlags.has(a)) i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

/** `cp`/`install`/`ln`/`rsync`: o destino (`-t DIR` ou o último operando). */
const COPY_VALUE_FLAGS = {
  cp: ["-S", "--suffix"],
  install: ["-S", "--suffix", "-m", "--mode", "-o", "--owner", "-g", "--group"],
  ln: ["-S", "--suffix"],
  rsync: ["-e", "--rsh", "--exclude", "--include", "-f", "--filter", "--exclude-from", "--include-from", "-B", "--block-size"],
  scp: ["-P", "-i", "-o", "-F", "-c", "-l", "-J", "-S"],
};

function copyDestination(head, args) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-t" || a === "--target-directory") return args[i + 1] ?? null;
    if (a.startsWith("--target-directory=")) return a.slice("--target-directory=".length);
    if (/^-t.+/.test(a)) return a.slice(2);
  }
  const ops = operands(args, new Set(COPY_VALUE_FLAGS[head] ?? []));
  return ops.length >= 2 ? ops[ops.length - 1] : null;
}

/** Argumentos de `sed` que são arquivo (pula o script quando não veio por `-e`/`-f`). */
function sedTargets(args) {
  let inPlace = false;
  let scriptGiven = false;
  const files = [];
  let opts = true;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (opts && a === "--") {
      opts = false;
      continue;
    }
    if (opts && a.startsWith("--")) {
      if (a.startsWith("--in-place")) inPlace = true;
      else if (a === "--expression" || a === "--file") {
        scriptGiven = true;
        i++;
      } else if (a.startsWith("--expression=") || a.startsWith("--file=")) scriptGiven = true;
      continue;
    }
    if (opts && a.startsWith("-") && a.length > 1) {
      const flags = a.slice(1);
      for (let k = 0; k < flags.length; k++) {
        const f = flags[k];
        if (f === "i") {
          inPlace = true;
          break; // o resto é sufixo de backup (`-i.bak`)
        }
        if (f === "e" || f === "f") {
          scriptGiven = true;
          if (k === flags.length - 1) i++;
          break;
        }
        if (f === "l") {
          if (k === flags.length - 1) i++;
          break;
        }
      }
      continue;
    }
    if (!scriptGiven) {
      scriptGiven = true; // 1º operando é o script
      continue;
    }
    files.push(a);
  }
  return inPlace ? files : [];
}

/** `perl -i`: arquivos editados no lugar (pula o código de `-e`). */
function perlInPlaceTargets(args) {
  let inPlace = false;
  let codeGiven = false;
  const files = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") continue;
    if (a.startsWith("-") && a.length > 1 && !a.startsWith("--")) {
      // Flags agrupadas, lidas na ordem: `i` engole o resto como sufixo de
      // backup (`-pi.bak`, e o clássico `-pie` = `-p -i` com sufixo "e");
      // `e`/`E` encerra o grupo e o código vem colado ou na palavra seguinte.
      const flags = a.slice(1);
      for (let k = 0; k < flags.length; k++) {
        const f = flags[k];
        if (f === "i") {
          inPlace = true;
          break;
        }
        if (f === "e" || f === "E") {
          codeGiven = true;
          if (k === flags.length - 1) i++;
          break;
        }
      }
      continue;
    }
    if (!codeGiven) {
      codeGiven = true; // script em arquivo
      continue;
    }
    files.push(a);
  }
  return inPlace ? files : [];
}

/** `awk -i inplace` / `gawk --include=inplace`: arquivos editados no lugar. */
function awkInPlaceTargets(args) {
  let inPlace = false;
  let programGiven = false;
  const files = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-i" || a === "--include") {
      if (/^inplace/.test(args[i + 1] ?? "")) inPlace = true;
      i++;
      continue;
    }
    if (a.startsWith("--include=")) {
      if (/^--include=inplace/.test(a)) inPlace = true;
      continue;
    }
    if (a === "-f" || a === "-v" || a === "-F") {
      if (a === "-f") programGiven = true;
      i++;
      continue;
    }
    if (a.startsWith("-")) continue;
    if (!programGiven) {
      programGiven = true;
      continue;
    }
    files.push(a);
  }
  return inPlace ? files : [];
}

const ALL_OPERAND_WRITERS = new Set(["mv", "rm", "unlink", "rmdir", "truncate", "touch", "mkdir", "shred"]);

/**
 * Comando simples escreve num caminho protegido por si só (sem interpretador)?
 * Devolve `{ kind, path }` ou `null`.
 */
function structuralWrite(head, args, cwd) {
  const prot = (p) => p != null && isProtectedPath(p, cwd);
  const first = (list) => list.find(prot);
  if (head === "tee") {
    const p = first(operands(args));
    return p ? { kind: "tee", path: p } : null;
  }
  if (head === "sed" || head === "gsed") {
    const p = first(sedTargets(args));
    return p ? { kind: "sed -i", path: p } : null;
  }
  if (head === "perl") {
    const p = first(perlInPlaceTargets(args));
    return p ? { kind: "perl -i", path: p } : null;
  }
  if (head === "awk" || head === "gawk") {
    const p = first(awkInPlaceTargets(args));
    return p ? { kind: "awk -i inplace", path: p } : null;
  }
  if (head === "cp" || head === "install" || head === "ln" || head === "rsync" || head === "scp") {
    const dest = copyDestination(head, args);
    return prot(dest) ? { kind: head, path: dest } : null;
  }
  if (ALL_OPERAND_WRITERS.has(head)) {
    const valueFlags = head === "truncate" ? new Set(["-s", "--size", "-r", "--reference"]) : head === "mkdir" ? new Set(["-m", "--mode"]) : new Set();
    const p = first(operands(args, valueFlags));
    return p ? { kind: head, path: p } : null;
  }
  if (head === "dd") {
    const of = args.find((a) => a.startsWith("of="));
    return of && prot(of.slice(3)) ? { kind: "dd of=", path: of.slice(3) } : null;
  }
  return null;
}

/** Comando que, executado por `find -exec`/`xargs`, escreve nos argumentos. */
function isWriterInvocation(words) {
  const hi = headIndex(words);
  if (hi === -1) return false;
  const head = basename(words[hi]);
  const args = words.slice(hi + 1);
  if (ALL_OPERAND_WRITERS.has(head) || head === "tee" || head === "cp" || head === "install") return true;
  if (head === "sed" || head === "gsed") return args.some((a) => /^-[a-zA-Z]*i/.test(a) || a.startsWith("--in-place"));
  if (head === "perl") return args.some((a) => /^-[a-zA-Z]*i/.test(a));
  if (SHELLS.has(head) || interpreterKind(head)) return true;
  return false;
}

/** `find <paths> ... -delete|-exec <escritor>` com algum ponto de partida protegido. */
function findWrite(args, cwd) {
  const starts = [];
  let k = 0;
  while (k < args.length && !/^[-(!]/.test(args[k])) starts.push(args[k++]);
  const expr = args.slice(k);
  const protStart = starts.find((p) => isProtectedPath(p, cwd));
  if (!protStart) return null;
  if (expr.includes("-delete")) return { kind: "find -delete", path: protStart };
  for (let j = 0; j < expr.length; j++) {
    if (["-exec", "-execdir", "-ok", "-okdir"].includes(expr[j])) {
      const sub = [];
      for (let m = j + 1; m < expr.length && expr[m] !== ";" && expr[m] !== "+"; m++) sub.push(expr[m]);
      if (isWriterInvocation(sub)) return { kind: "find -exec", path: protStart };
    }
  }
  return null;
}

/** Palavras do `xargs` depois das opções dele (o comando que ele roda). */
function xargsCommand(args) {
  const valueFlags = new Set(["-I", "-i", "-n", "-L", "-P", "-d", "-E", "-s", "-a", "--max-args", "--max-procs", "--delimiter", "--arg-file", "--replace"]);
  let i = 0;
  while (i < args.length && args[i].startsWith("-")) i += valueFlags.has(args[i]) ? 2 : 1;
  return args.slice(i);
}

// ---------------------------------------------------------------------------
// Código de interpretador
// ---------------------------------------------------------------------------

const CLAUDE_ENTRY_ALT = PROTECTED_CLAUDE_ENTRIES.map((e) => e.replace(/\./g, "\\.")).join("|");
/** Caminho protegido citado em texto livre (código). */
const PROTECTED_IN_TEXT_RES = [
  new RegExp(`(?:^|[^A-Za-z0-9_.-])\\.claude[\\\\/]+(?:${CLAUDE_ENTRY_ALT})(?![A-Za-z0-9_-])`),
  // `os.path.join(root, ".claude", "skills", ...)`, `join(".claude", "hooks")`
  new RegExp(`['"]\\.claude['"]\\s*,\\s*['"](?:${CLAUDE_ENTRY_ALT})['"]`),
  /(?:^|[^A-Za-z0-9_.-])\.mcp\.json\b/,
  /(?:^|[^A-Za-z0-9_.-])\.git[\\/]+(?:hooks|config)\b/,
];

/** API de escrita em arquivo, por linguagem (reconhecida em qualquer uma). */
const WRITE_API_RES = [
  // Python
  /\bopen\s*\([^)]*?,\s*(?:mode\s*=\s*)?[rbt]?['"][rbt]*[wax+]/,
  /\bopen\s*\([^)]*?\bmode\s*=\s*['"][rbt]*[wax+]/,
  /\.write_(?:text|bytes)\s*\(/,
  /\bshutil\.(?:copy\w*|move|rmtree)\s*\(/,
  /\bos\.(?:rename|replace|remove|unlink|rmdir|makedirs|mkdir|truncate)\s*\(/,
  /\.(?:unlink|touch|rmdir|mkdir|rename)\s*\(/,
  /\bfileinput\b[^\n]*\binplace\s*=\s*(?:True|1)/,
  // Node
  /\b(?:writeFile|appendFile|copyFile|rename|rm|unlink|mkdir|cp|truncate|symlink|link)(?:Sync)?\s*\(/,
  /\bcreateWriteStream\s*\(/,
  /\bopenSync\s*\([^)]*,\s*['"][wa]/,
  /\bDeno\.(?:writeTextFile|writeFile|remove|rename)\w*\s*\(/,
  /\bBun\.write\s*\(/,
  // Perl
  /\bopen\s*\(?\s*(?:my\s+)?[$\w]+\s*,\s*['"]\s*(?:\+?[<>]|>>)/,
  /\bopen\s*\(?\s*(?:my\s+)?[$\w]+\s*,\s*['"]\s*>/,
  // Ruby
  /\b(?:File|IO)\.(?:write|binwrite|open\s*\([^)]*['"][wa])/,
  /\bFileUtils\.\w+/,
  // Shell-out pra um escritor de shell (`os.system("sed -i ...")`)
  /\bsed\s+-[a-zA-Z]*i/,
];

/**
 * Verbo de comando de shell (PR #12811, review de segurança): string que, lida
 * como shell, começa um comando por um destes é comando passado a
 * `execSync`/`subprocess.run(..., shell=True)`/`os.system`, nunca prosa —
 * `git checkout master -- .claude/hooks/x`, `npx prettier --write .claude/…` e
 * `npx eslint --fix .claude/hooks` escrevem no protegido sem que o parser
 * reconheça a escrita. Casa a 1ª palavra de cada comando (após `;`, `&&`,
 * `||`, `|`, `(`), pelo basename, além de wrappers e shells.
 */
const SHELL_COMMAND_VERBS = new Set([
  "git", "gh", "npx", "npm", "pnpm", "yarn", "node", "deno", "bun", "tsx", "ts-node",
  "curl", "wget", "tar", "unzip", "zip", "gzip", "gunzip", "rsync", "scp",
  "python", "python2", "python3", "perl", "ruby", "php",
  "rm", "cp", "mv", "ln", "install", "touch", "mkdir", "rmdir", "unlink", "truncate", "shred",
  "chmod", "chown", "sed", "awk", "gawk", "patch", "tee", "dd", "cat", "echo", "printf",
  "find", "xargs", "make", "cd", "prettier", "eslint", "biome",
  ...SHELLS, ...WRAPPERS,
]);
const PYTHON_VERSIONED_RE = /^python\d+(?:\.\d+)*$/;

function startsShellCommand(body) {
  for (const segment of body.split(/&&|\|\||[;|&()\n]/)) {
    const words = segment.trim().split(/\s+/).filter((w) => w !== "" && !ASSIGNMENT_RE.test(w));
    if (words.length === 0) continue;
    const head = basename(words[0].replace(/^['"]|['"]$/g, ""));
    if (SHELL_COMMAND_VERBS.has(head) || PYTHON_VERSIONED_RE.test(head)) return true;
  }
  return false;
}

/** Literal de string de uma linha, `'…'` ou `"…"` (template literal fica de fora: pode ter `${}`). */
const STRING_LITERAL_RE = /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g;

/**
 * #12780: troca por literal vazio cada string de PROSA que cita caminho
 * protegido — o caso real foi um `node -e` gravando `data/.../plan.json` com
 * uma nota que dizia "corrigir em .claude/hooks/…". Prosa aqui é: o conteúdo
 * tem espaço entre palavras (caminho que o código abre não tem), a citação não
 * está na 1ª palavra (caminho com espaço no nome começa por ela), não usa API
 * de escrita (protege contra literal mal pareado que engoliu código), nenhum
 * comando dela começa por verbo de shell (`SHELL_COMMAND_VERBS`:
 * `execSync("git checkout master -- .claude/hooks/x")` continua contando) e,
 * lido como shell, não escreve em caminho protegido (`execSync("sed -i …
 * .claude/x")` continua contando). Qualquer outra string fica como está: `'.claude/hooks/x'`
 * sozinho, `os.path.join(".claude", "hooks")`, template literal.
 */
function stripProseLiterals(code, cwd, depth) {
  if (depth >= 4) return code;
  return code.replace(STRING_LITERAL_RE, (lit) => {
    const body = lit.slice(1, -1);
    if (!/\S\s+\S/.test(body)) return lit;
    if (!PROTECTED_IN_TEXT_RES.some((re) => re.test(body))) return lit;
    // Caminho com espaço no nome (`".claude/hooks/a b.mjs"`, `"/r/.claude/x y"`):
    // a citação abre a string, então é caminho, não prosa.
    const firstWord = body.trim().split(/\s+/)[0];
    if (PROTECTED_IN_TEXT_RES.some((re) => re.test(firstWord))) return lit;
    if (WRITE_API_RES.some((re) => re.test(body))) return lit;
    if (startsShellCommand(body)) return lit;
    if (findProtectedPathWrite(body.replace(/\\(.)/g, "$1"), { cwd }, depth + 1) !== null) return lit;
    return lit[0] + lit[0];
  });
}

/** Código que cita caminho protegido (fora de string de prosa, #12780) e usa alguma API de escrita. */
export function codeWritesProtectedPath(code, cwd = "", depth = 0) {
  if (typeof code !== "string" || code === "") return false;
  const outsideProse = stripProseLiterals(code, cwd, depth);
  const cites = PROTECTED_IN_TEXT_RES.some((re) => re.test(outsideProse)) || (cwd !== "" && isProtectedPath(".", cwd));
  if (!cites) return false;
  return WRITE_API_RES.some((re) => re.test(code));
}

/** Fontes de código de uma chamada de interpretador: inline, stdin e script. */
function interpreterCode(kind, args, stdin) {
  const inline = [];
  let scriptFile = null;
  const inlineFlags =
    kind === "python" ? new Set(["-c"]) : kind === "node" ? new Set(["-e", "--eval", "-p", "--print", "eval"]) : new Set(["-e", "-E"]);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (inlineFlags.has(a)) {
      if (args[i + 1] != null) inline.push(args[i + 1]);
      i++;
      continue;
    }
    if (kind === "python" && /^-c./.test(a)) {
      inline.push(a.slice(2));
      continue;
    }
    if (kind === "perl" && /^-[a-zA-Z]*[eE]$/.test(a)) {
      if (args[i + 1] != null) inline.push(args[i + 1]);
      i++;
      continue;
    }
    if (kind === "node" && (a.startsWith("--eval=") || a.startsWith("--print="))) {
      inline.push(a.slice(a.indexOf("=") + 1));
      continue;
    }
    if (a.startsWith("-")) {
      if (kind === "python" && a === "-m") break; // módulo: opaco
      continue;
    }
    if (inline.length === 0) scriptFile = a;
    break;
  }
  return { inline, stdin: inline.length === 0 ? stdin : [], scriptFile };
}

function isInside(dir, p) {
  if (!dir) return false;
  const d = normalizePosix(toPosix(dir)).replace(/\/+$/, "");
  const q = normalizePosix(toPosix(p));
  return q === d || q.startsWith(`${d}/`);
}

// ---------------------------------------------------------------------------
// Entrada principal
// ---------------------------------------------------------------------------

/**
 * Procura, em `command` (texto do Bash), uma escrita em caminho protegido.
 * Devolve `{ kind, path }` (o primeiro achado) ou `null`.
 *
 * `opts.cwd`: diretório do comando (payload do hook). `opts.projectDirs`:
 * raízes cujos scripts NÃO são lidos (repo e worktree — script versionado
 * passa por review). `opts.readFile(path)`: lê um script fora dessas raízes
 * (`/tmp/fix.py`) e devolve o texto ou `null`; sem ele, script em arquivo é
 * opaco.
 */
export function findProtectedPathWrite(command, opts = {}, depth = 0) {
  if (typeof command !== "string" || depth > 4) return null;
  let cwd = opts.cwd ?? "";
  const projectDirs = (opts.projectDirs ?? []).filter(Boolean);
  const cmds = tokenizeShell(command);
  for (const cmd of cmds) {
    // 1. Redirecionamento de escrita, em qualquer comando.
    for (const r of cmd.redirects) {
      if (!WRITE_REDIRECTS.has(r.op)) continue;
      if (r.op === ">&" && /^(\d+|-)$/.test(r.target)) continue;
      if (isProtectedPath(r.target, cwd)) return { kind: `redirect ${r.op}`, path: r.target };
    }
    const hi = headIndex(cmd.words);
    if (hi === -1) continue;
    let head = basename(cmd.words[hi]);
    let args = cmd.words.slice(hi + 1);
    // `npx [--yes] tsx -e ...`
    if (head === "npx" || head === "pnpx") {
      let k = 0;
      while (k < args.length && args[k].startsWith("-")) k += args[k] === "-p" || args[k] === "--package" ? 2 : 1;
      if (k >= args.length) continue;
      head = basename(args[k]);
      args = args.slice(k + 1);
    }
    if (head === "cd" || head === "pushd") {
      const target = args.find((a) => !a.startsWith("-"));
      if (target && target !== "-") cwd = isAnchored(toPosix(target)) || !cwd ? target : `${toPosix(cwd)}/${target}`;
      continue;
    }
    // 2. Escritores de shell.
    const s = structuralWrite(head, args, cwd);
    if (s) return s;
    if (head === "find") {
      const f = findWrite(args, cwd);
      if (f) return f;
    }
    if (head === "xargs") {
      const sub = xargsCommand(args);
      if (isWriterInvocation(sub)) {
        const sibling = cmds.find((c) => c.pipeline === cmd.pipeline && c !== cmd && c.words.some((w) => isProtectedPath(w, cwd)));
        const own = sub.slice(1).find((w) => isProtectedPath(w, cwd));
        if (sibling || own) return { kind: "xargs", path: own ?? sibling.words.find((w) => isProtectedPath(w, cwd)) };
      }
      // `xargs bash -c '...'`, `xargs sed -i ... .claude/x`
      const inner = findProtectedPathWrite(sub.map(shellQuote).join(" "), { ...opts, cwd }, depth + 1);
      if (inner) return inner;
      continue;
    }
    // 3. Shell aninhado.
    if (SHELLS.has(head) || head === "eval") {
      const scripts = [];
      if (head === "eval") scripts.push(args.join(" "));
      else {
        const ci = args.findIndex((a) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a));
        if (ci !== -1 && args[ci + 1] != null) scripts.push(args[ci + 1]);
        else {
          scripts.push(...cmd.stdin);
          const file = operands(args, new Set(["-o", "+o", "-O", "+O"]))[0];
          const text = file ? readOutsideScript(file, cwd, projectDirs, opts.readFile) : null;
          if (text) scripts.push(text);
        }
      }
      for (const sc of scripts) {
        const inner = findProtectedPathWrite(sc, { ...opts, cwd }, depth + 1);
        if (inner) return inner;
      }
      continue;
    }
    // 4. Interpretador com código.
    const kind = interpreterKind(head);
    if (kind) {
      const { inline, stdin, scriptFile } = interpreterCode(kind, args, cmd.stdin);
      const sources = [...inline, ...stdin];
      if (scriptFile && scriptFile !== "-") {
        const text = readOutsideScript(scriptFile, cwd, projectDirs, opts.readFile);
        if (text) sources.push(text);
      }
      if (sources.some((code) => codeWritesProtectedPath(code, cwd, depth))) {
        return { kind: `${head} (código)`, path: protectedRefIn(sources) ?? cwd };
      }
    }
  }
  return null;
}

function shellQuote(w) {
  return /^[A-Za-z0-9_./=:@%+,-]+$/.test(w) ? w : `'${w.replace(/'/g, "'\\''")}'`;
}

function protectedRefIn(sources) {
  for (const code of sources) {
    for (const re of PROTECTED_IN_TEXT_RES) {
      const m = code.match(re);
      if (m) return m[0].replace(/^[^.'"]/, "");
    }
  }
  return null;
}

/** Texto de um script em arquivo FORA das raízes do projeto, ou `null`. */
function readOutsideScript(file, cwd, projectDirs, readFile) {
  if (typeof readFile !== "function") return null;
  const p = toPosix(file);
  if (p.startsWith("$")) return null;
  const abs = isAnchored(p) ? p : `${toPosix(cwd)}/${p}`;
  const roots = [...projectDirs, cwd].filter(Boolean);
  if (roots.some((r) => isInside(r, abs))) return null;
  try {
    const text = readFile(abs);
    return typeof text === "string" ? text : null;
  } catch {
    return null;
  }
}

/** Decisão completa do hook: achado ou `null`. */
export function shouldBlockProtectedPathWrite(payload, opts = {}) {
  if (!payload || (payload.tool_name && payload.tool_name !== "Bash")) return null;
  const command = payload.tool_input?.command;
  return findProtectedPathWrite(command, { ...opts, cwd: opts.cwd ?? payload.cwd ?? "" });
}

export function protectedPathWriteReason(finding) {
  return (
    `Escrita via Bash em caminho protegido bloqueada (#12009): \`${finding.path}\` como alvo de ${finding.kind}. ` +
    "`.claude/{skills,agents,hooks,commands,rules,output-styles}`, `.claude/settings*.json`, `.mcp.json`, `.git/hooks` e `.git/config` " +
    "só se alteram pelo Edit/Write, que passam pela checagem de caminho protegido do Claude Code (prompt ao " +
    "editor; no modo agendado, negação). Use o Edit/Write. Se o Edit/Write foi negado, não contorne por " +
    "Bash/Python: entregue o resto com `REFS #N, NÃO CLOSES` e reporte ao coordenador os arquivos de `.claude/` " +
    "que faltaram (item 34 de context/overnight-dispatch-rules.md). Leitura (cat, grep, git diff/show) segue livre."
  );
}
