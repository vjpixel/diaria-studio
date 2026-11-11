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
//   - `bash -c`/`sh -c`/`eval`/`bash <<EOF`: analisados como shell, recursivo;
//   - #12812: `curl -o`/`-O`/`--output-dir`, `wget -O`/`-P`, `tar -x` com `-C`
//     (ou cwd) protegido e `tar -c` com `-f` protegido, `unzip -d`, `git apply
//     --directory` e `git apply`/`patch` cujo patch (stdin, arquivo em qualquer
//     local, `cat x.patch |`) altera caminho protegido, `git rm`/`git mv`,
//     `git archive -o`, formatadores no lugar (`prettier --write`, `eslint
//     --fix`, `biome --write`...), editores (`vim -es`, `ed`, `sponge`...),
//     `docker cp`, `split`, `sh script.sh <alvo>`/`./x.sh <alvo>`, script de
//     interpretador FORA do projeto com caminho protegido como argumento (e
//     API de escrita no código, ou código ilegível), e flag de saída em
//     qualquer comando (`-o`, `--out`, `--output`, `--outfile`, `--outdir`...,
//     como em `npx tsx scripts/gen.ts --out .claude/hooks/x`).
//
// Argumento protegido para um script, por tipo (#12812):
//   - script de SHELL (`sh x.sh <alvo>`, `./x.sh <alvo>`): bloqueia em
//     qualquer local, inclusive versionado no repo (o que ele faz com `$1` é
//     opaco);
//   - script de INTERPRETADOR fora do projeto: bloqueia se o código usa API
//     de escrita ou não pôde ser lido;
//   - script de interpretador DO REPO com argumento posicional (`npx tsx
//     scripts/x.ts .claude/...`): passa (limite abaixo);
//   - flag de saída (`--out`, `--output`, `-o` fora de `grep`/`find`/`ssh`/
//     shells...) com valor protegido: bloqueia em qualquer comando, do repo ou
//     não.
//
// Patch (`git apply`/`git am`/`patch`): o arquivo é lido esteja onde estiver;
// patch ilegível (criado no mesmo comando, `git diff | git apply`) bloqueia só
// quando o texto do comando cita caminho protegido.
//
// Erro ao analisar um comando não libera os seguintes; o que crashou bloqueia
// se citar caminho protegido.
//
// LIMITES CONHECIDOS (aceitos): caminho montado em variável opaca
// (`f=.claude/x; echo > "$f"` passa — `$f` não é resolvido), script de
// interpretador do próprio repo com argumento posicional (`npx tsx
// scripts/x.ts .claude/...`, de propósito: os scripts versionados passam por
// review), `git checkout/restore -- .claude/...` (traz conteúdo já versionado,
// como merge/rebase; 24 usos legítimos medidos no #12812), formatador sobre
// diretório ancestral (`prettier --write .` na raiz), patch ilegível cujo
// comando não cita caminho protegido (`gh pr diff N | git apply`), e
// interpretador que monta o caminho em partes não reconhecidas.

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
// Tabelas indexadas pelo NOME do comando são `Map`: um objeto comum herda
// `valueOf`/`hasOwnProperty`/`__proto__`/`constructor` de `Object.prototype`,
// e um comando com esse nome (`valueOf; echo x > <protegido>`) lançava dentro
// do laço e o hook falhava aberto (review da PR #12846).
const COPY_VALUE_FLAGS = new Map(Object.entries({
  cp: ["-S", "--suffix"],
  install: ["-S", "--suffix", "-m", "--mode", "-o", "--owner", "-g", "--group"],
  ln: ["-S", "--suffix"],
  rsync: ["-e", "--rsh", "--exclude", "--include", "-f", "--filter", "--exclude-from", "--include-from", "-B", "--block-size"],
  scp: ["-P", "-i", "-o", "-F", "-c", "-l", "-J", "-S"],
}));

function copyDestination(head, args) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-t" || a === "--target-directory") return args[i + 1] ?? null;
    if (a.startsWith("--target-directory=")) return a.slice("--target-directory=".length);
    if (/^-t.+/.test(a)) return a.slice(2);
  }
  const ops = operands(args, new Set(COPY_VALUE_FLAGS.get(head) ?? []));
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
  return toolWrite(head, args, cwd);
}

// ---------------------------------------------------------------------------
// Escritores de ferramenta (#12812): baixadores, arquivadores, patch,
// formatadores, editores e flags de saída.
// ---------------------------------------------------------------------------

/**
 * Valores de uma opção em `args`: `--long V`, `--long=V`, `-x V` e, com
 * `cluster`, a letra no fim de um grupo de flags curtas (`-sSLo V`, `-sSLoV`).
 */
function optionValues(args, { short = [], long = [], cluster = false } = {}) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") break;
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const name = eq === -1 ? a : a.slice(0, eq);
      if (!long.includes(name)) continue;
      if (eq !== -1) out.push(a.slice(eq + 1));
      else if (args[i + 1] != null) out.push(args[++i]);
      continue;
    }
    if (!a.startsWith("-") || a.length < 2) continue;
    if (short.includes(a)) {
      if (args[i + 1] != null) out.push(args[++i]);
      continue;
    }
    if (!cluster) {
      // `-oVALOR` colado, só para a letra exata.
      const s = short.find((f) => f.length === 2 && a.startsWith(f) && a.length > 2);
      if (s) out.push(a.slice(2));
      continue;
    }
    const letters = a.slice(1);
    for (let k = 0; k < letters.length; k++) {
      if (!short.includes(`-${letters[k]}`)) continue;
      const rest = letters.slice(k + 1);
      if (rest) out.push(rest);
      else if (args[i + 1] != null) out.push(args[++i]);
      break;
    }
  }
  return out;
}

const hasFlag = (args, ...names) => args.some((a) => names.includes(a) || names.some((n) => n.startsWith("--") && a.startsWith(`${n}=`)));

/** Junta `dir` (relativo a `cwd`) e `p`. */
function joinPath(dir, p) {
  if (!dir) return p;
  const d = toPosix(dir).replace(/\/+$/, "");
  return isAnchored(toPosix(p)) ? p : `${d}/${p}`;
}

/** Flags de SAÍDA comuns a geradores/scripts (`npx tsx scripts/gen.ts --out X`, `esbuild --outfile=X`). */
const OUTPUT_FLAGS_LONG = [
  "--out",
  "--output",
  "--outfile",
  "--out-file",
  "--outFile",
  "--output-file",
  "--outdir",
  "--out-dir",
  "--outDir",
  "--output-dir",
  "--output-document",
  "--directory-prefix",
];

/** Arquivos que o `curl` grava, além do `-o`. */
const CURL_WRITE_LONG = ["--output", "--dump-header", "--cookie-jar", "--trace", "--trace-ascii", "--stderr", "--libcurl", "--etag-save", "--output-dir"];

/** Letras curtas do `tar` (GNU) que recebem valor. */
const TAR_VALUE_LETTERS = new Set(["f", "C", "b", "K", "N", "T", "X", "g", "L", "V", "H", "F", "I"]);

/** Modo e alvos de um `tar` (formato antigo `tar xzf a.tgz`, agrupado e longo). */
function tarWrite(args, cwd) {
  const prot = (p) => p != null && isProtectedPath(p, cwd);
  let mode = null;
  const fileArgs = [];
  const dirs = [];
  const members = [];
  let toStdout = false;
  const modeOf = (letters) => {
    if (/[x]/.test(letters)) return "extract";
    if (/[cruA]/.test(letters)) return "create";
    if (/[td]/.test(letters)) return "list";
    return null;
  };
  let i = 0;
  // Formato antigo: 1º argumento sem hífen são as letras de modo.
  if (args[0] && !args[0].startsWith("-") && /^[A-Za-z]+$/.test(args[0])) {
    const letters = args[0];
    mode = modeOf(letters);
    if (letters.includes("O")) toStdout = true;
    let next = 1;
    for (const l of letters) {
      if (!TAR_VALUE_LETTERS.has(l)) continue;
      const v = args[next++];
      if (v != null && (l === "f" || l === "C")) (l === "f" ? fileArgs : dirs).push(v);
    }
    i = next;
  }
  for (; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const [name, val] = a.includes("=") ? [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)] : [a, undefined];
      if (name === "--extract" || name === "--get") mode = "extract";
      else if (["--create", "--append", "--update", "--concatenate", "--catenate"].includes(name)) mode = "create";
      else if (name === "--list" || name === "--diff" || name === "--compare") mode = mode ?? "list";
      else if (name === "--to-stdout") toStdout = true;
      else if (name === "--file" || name === "--directory") {
        const v = val ?? args[++i];
        if (v != null) (name === "--file" ? fileArgs : dirs).push(v);
      }
      continue;
    }
    if (a.startsWith("-") && a.length > 1) {
      // Só as letras ANTES da 1ª que recebe valor são modo/flag: em
      // `-C<dir>` colado o resto é o diretório, e as letras dele (o `c` de
      // `.claude`) não podem virar "create" (review da PR #12846).
      const letters = a.slice(1);
      const vi = [...letters].findIndex((l) => TAR_VALUE_LETTERS.has(l));
      const flags = vi === -1 ? letters : letters.slice(0, vi);
      mode = modeOf(flags) ?? mode;
      if (flags.includes("O")) toStdout = true;
      if (vi !== -1) {
        const l = letters[vi];
        const v = letters.slice(vi + 1) || args[++i];
        if (v != null && (l === "f" || l === "C")) (l === "f" ? fileArgs : dirs).push(v);
      }
      continue;
    }
    members.push(a);
  }
  if (mode === "create") {
    const f = fileArgs.find(prot);
    return f ? { kind: "tar (arquivo criado)", path: f } : null;
  }
  if (mode === "extract" && !toStdout) {
    const d = dirs.find(prot);
    if (d) return { kind: "tar -C (extração)", path: d };
    const dest = dirs.length ? dirs[dirs.length - 1] : "";
    if (!dirs.length && isProtectedPath(".", cwd)) return { kind: "tar -x (extração no cwd)", path: cwd };
    const m = members.find((x) => isProtectedPath(joinPath(dest, x), cwd));
    if (m) return { kind: "tar -x (membro)", path: m };
  }
  return null;
}

/** Caminhos que um patch (texto unificado/git) altera. */
function patchTargets(text) {
  if (typeof text !== "string") return [];
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    let m = line.match(/^diff --git (?:"?a\/)?(\S+?)"? (?:"?b\/)?(\S+?)"?$/);
    if (m) {
      out.push(m[1], m[2]);
      continue;
    }
    m = line.match(/^(?:\+\+\+|---) (?:[ab]\/)?(\S+)/);
    if (m && m[1] !== "/dev/null") {
      out.push(m[1]);
      continue;
    }
    m = line.match(/^(?:rename|copy) (?:to|from) (\S+)/);
    if (m) out.push(m[1]);
  }
  return out;
}

/** `git <global opts> <sub> ...`: subcomando, args e o cwd efetivo (`-C`). */
function gitInvocation(args, cwd) {
  let i = 0;
  let dir = cwd;
  while (i < args.length && args[i].startsWith("-")) {
    const a = args[i];
    if (a === "-C") {
      const v = args[i + 1];
      if (v != null) dir = isAnchored(toPosix(v)) || !dir ? v : `${toPosix(dir)}/${v}`;
      i += 2;
      continue;
    }
    if (a === "-c" || a === "--git-dir" || a === "--work-tree" || a === "--namespace") {
      i += 2;
      continue;
    }
    i++;
  }
  return { sub: args[i] ?? "", rest: args.slice(i + 1), dir };
}

function gitWrite(args, cwd) {
  const { sub, rest, dir } = gitInvocation(args, cwd);
  const prot = (p) => p != null && isProtectedPath(p, dir);
  const first = (list) => list.find(prot);
  if (sub === "apply" || sub === "am") {
    if (sub === "apply" && hasFlag(rest, "--check", "--stat", "--numstat", "--summary") && !rest.includes("--apply")) return null;
    const d = first(optionValues(rest, { long: ["--directory"] }));
    if (d) return { kind: `git ${sub} --directory`, path: d };
    return { patchFiles: operands(rest, new Set(["-p", "-C", "--exclude", "--include", "--directory", "--whitespace"])), dir };
  }
  // `git checkout/restore -- <protegido>` fica livre de propósito: traz de
  // volta conteúdo já versionado (como `merge`/`rebase`/`pull`, que também
  // escrevem em `.claude/`), e é o caminho de reverter a própria mudança e
  // de resolver conflito (`--theirs`). Medido no #12812: 24 usos legítimos
  // nos transcripts, nenhum contorno.
  if (sub === "rm") {
    if (hasFlag(rest, "--cached", "-n", "--dry-run")) return null;
    const p = first(operands(rest, new Set(["--pathspec-from-file"])));
    return p ? { kind: "git rm", path: p } : null;
  }
  if (sub === "mv") {
    const p = first(operands(rest));
    return p ? { kind: "git mv", path: p } : null;
  }
  if (sub === "archive") {
    const o = first(optionValues(rest, { short: ["-o"], long: ["--output"] }));
    return o ? { kind: "git archive -o", path: o } : null;
  }
  return null;
}

const FORMATTER_WRITE = new Map(Object.entries({
  prettier: (args) => hasFlag(args, "--write", "-w"),
  eslint: (args) => hasFlag(args, "--fix"),
  biome: (args) => hasFlag(args, "--write", "--apply", "--apply-unsafe", "--fix", "--unsafe"),
  stylelint: (args) => hasFlag(args, "--fix"),
  black: (args) => !hasFlag(args, "--check", "--diff"),
  ruff: (args) => (args[0] === "format" && !hasFlag(args, "--check", "--diff")) || hasFlag(args, "--fix"),
  gofmt: (args) => hasFlag(args, "-w"),
  rustfmt: (args) => !hasFlag(args, "--check"),
  "clang-format": (args) => hasFlag(args, "-i"),
}));

/** O comando é um formatador que vai reescrever os arquivos no lugar? */
const formatterWrites = (head, args) => FORMATTER_WRITE.get(head)?.(args) === true;

const EDITORS = new Set(["vim", "vi", "nvim", "ex", "ed", "emacs", "nano", "sponge"]);

/** Comandos em que `-o` não é arquivo de saída (medido no #12812: `grep -o`; `bash -o pipefail`). */
const DASH_O_NOT_OUTPUT = new Set(["bash", "sh", "zsh", "dash", "ksh", "grep", "egrep", "fgrep", "rg", "ag", "ack", "find", "ls", "ps", "ssh", "scp", "sftp", "mount", "set", "shopt", "od", "xxd", "pgrep", "pkill", "tput", "stat"]);

/** Escritores de ferramenta (#12812); `null` quando nada protegido é alvo. */
function toolWrite(head, args, cwd) {
  const prot = (p) => p != null && isProtectedPath(p, cwd);
  const first = (list) => list.find(prot);
  if (head === "curl") {
    const o = first([...optionValues(args, { short: ["-o", "-D", "-c"], long: CURL_WRITE_LONG, cluster: true })]);
    if (o) return { kind: "curl -o", path: o };
    // `-O`/`--remote-name`: grava no cwd (ou em `--output-dir`).
    const remote = args.some((a) => a === "--remote-name" || a === "--remote-name-all" || (/^-[A-Za-z]+$/.test(a) && a.includes("O")));
    if (remote && !optionValues(args, { long: ["--output-dir"] }).length && isProtectedPath(".", cwd)) return { kind: "curl -O (cwd)", path: cwd };
    return null;
  }
  if (head === "wget") {
    const o = first(optionValues(args, { short: ["-O", "-P", "-o", "-a"], long: ["--output-document", "--directory-prefix", "--output-file", "--append-output"], cluster: true }));
    if (o) return { kind: "wget -O", path: o };
    const toStdout = optionValues(args, { short: ["-O"], long: ["--output-document"], cluster: true }).includes("-");
    if (!toStdout && !hasFlag(args, "--spider") && isProtectedPath(".", cwd)) return { kind: "wget (cwd)", path: cwd };
    return null;
  }
  if (head === "tar" || head === "bsdtar" || head === "gtar") return tarWrite(args, cwd);
  if (head === "unzip") {
    // Modo só-leitura, também agrupado (`-ql`, `-tq`).
    if (args.some((a) => /^-[A-Za-z]+$/.test(a) && /[lptvZz]/.test(a.slice(1)))) return null;
    const d = optionValues(args, { short: ["-d"] });
    const p = first(d);
    if (p) return { kind: "unzip -d", path: p };
    if (!d.length && isProtectedPath(".", cwd)) return { kind: "unzip (cwd)", path: cwd };
    return null;
  }
  if (head === "git") return gitWrite(args, cwd);
  if (head === "patch") {
    if (hasFlag(args, "--dry-run", "--check")) return null;
    const o = first(optionValues(args, { short: ["-o", "-d", "-r", "-B"], long: ["--output", "--directory", "--reject-file", "--prefix"] }));
    if (o) return { kind: "patch -o/-d", path: o };
    const ops = operands(args, new Set(["-p", "-i", "--input", "-o", "--output", "-d", "--directory", "-r", "-B", "-F", "-z", "-V", "-D"]));
    const p = first(ops);
    if (p) return { kind: "patch (arquivo)", path: p };
    if (isProtectedPath(".", cwd)) return { kind: "patch (cwd)", path: cwd };
    return { patchFiles: optionValues(args, { short: ["-i"], long: ["--input"] }), dir: cwd };
  }
  if (formatterWrites(head, args)) {
    const p = first(operands(args));
    if (p) return { kind: `${head} (formatação no lugar)`, path: p };
  }
  if (EDITORS.has(head)) {
    const p = first(operands(args, new Set(["-c", "-S", "-u", "-i", "--cmd"])));
    if (p) return { kind: head, path: p };
  }
  if ((head === "docker" || head === "podman") && args[0] === "cp") {
    const ops = operands(args.slice(1));
    const dest = ops.length >= 2 ? ops[ops.length - 1] : null;
    if (prot(dest)) return { kind: `${head} cp`, path: dest };
    return null;
  }
  if (head === "split" || head === "csplit") {
    const p = first(operands(args).slice(1).concat(optionValues(args, { short: ["-f"], long: ["--prefix"] })));
    if (p) return { kind: head, path: p };
  }
  // Flag de saída em qualquer comando (`npx tsx scripts/gen.ts --out X`, `sort -o X`).
  // `-o` é booleano/outra coisa em alguns (`grep -o`, `find -o`, `ssh -o`).
  const o = first(optionValues(args, { short: DASH_O_NOT_OUTPUT.has(head) ? [] : ["-o"], long: OUTPUT_FLAGS_LONG }));
  if (o) return { kind: `flag de saída (${head})`, path: o };
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
  // #12812: formatadores no lugar, editores, `git rm/mv`.
  if (formatterWrites(head, args) || EDITORS.has(head)) return true;
  if (head === "git" && ["rm", "mv"].includes(gitInvocation(args, "").sub)) return true;
  if (head === "npx" || head === "pnpx") {
    let k = 0;
    while (k < args.length && args[k].startsWith("-")) k += args[k] === "-p" || args[k] === "--package" ? 2 : 1;
    return isWriterInvocation(args.slice(k));
  }
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

/**
 * Palavras de um comando simples a partir do comando de fato executado:
 * pula atribuições, palavras-chave e wrappers (`env`, `command`, `exec`,
 * `timeout N`, `nice`, `sudo`...) e desce no `xargs`. `[]` quando não há
 * comando. Usado pelo hook de `--body-file` (#12746).
 */
export function resolveCommandWords(words, depth = 0) {
  if (!Array.isArray(words) || depth > 4) return [];
  const hi = headIndex(words);
  if (hi === -1) return [];
  const w = words.slice(hi);
  if (basename(w[0]) === "xargs") return resolveCommandWords(xargsCommand(w.slice(1)), depth + 1);
  return w;
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

/** Código que cita caminho protegido e usa alguma API de escrita. */
export function codeWritesProtectedPath(code, cwd = "") {
  if (typeof code !== "string" || code === "") return false;
  const cites = PROTECTED_IN_TEXT_RES.some((re) => re.test(code)) || (cwd !== "" && isProtectedPath(".", cwd));
  if (!cites) return false;
  return WRITE_API_RES.some((re) => re.test(code));
}

/** `finding.source` dos achados em código de interpretador (`isInterpreterCodeFinding`). */
const INTERPRETER_CODE_SOURCE = "interpreter-code";

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
    // Erro na análise de UM comando não pula os seguintes (review da PR
    // #12846: `valueOf; echo x > <protegido>` lançava no 1º e o hook liberava
    // tudo). O comando que crashou fica fail-closed quando cita caminho
    // protegido (ou roda com cwd protegido); sem isso, um bug do parser
    // travaria Bash legítimo que nem chega perto de `.claude/`.
    try {
      const r = analyzeCommand(cmd, cmds, command, cwd, projectDirs, opts, depth);
      if (r.finding) return r.finding;
      if (r.cwd !== undefined) cwd = r.cwd;
    } catch (err) {
      const words = [...cmd.words, ...cmd.redirects.map((x) => x.target)];
      const ref = words.find((w) => isProtectedPath(w, cwd)) ?? protectedRefIn([...words, ...cmd.stdin]) ?? (isProtectedPath(".", cwd) ? cwd : null);
      if (ref) {
        return { kind: `erro na análise do comando, bloqueado por precaução (${err?.message ?? err})`, path: ref };
      }
    }
  }
  return null;
}

/**
 * Analisa um comando simples. Devolve `{ finding }` quando acha escrita em
 * caminho protegido, `{ cwd }` quando o comando muda o diretório (`cd`), ou
 * `{}`.
 */
function analyzeCommand(cmd, cmds, command, cwd, projectDirs, opts, depth) {
  const found = (finding) => ({ finding });
  // 1. Redirecionamento de escrita, em qualquer comando.
  for (const r of cmd.redirects) {
    if (!WRITE_REDIRECTS.has(r.op)) continue;
    if (r.op === ">&" && /^(\d+|-)$/.test(r.target)) continue;
    if (isProtectedPath(r.target, cwd)) return found({ kind: `redirect ${r.op}`, path: r.target });
  }
  const hi = headIndex(cmd.words);
  if (hi === -1) return {};
  let head = basename(cmd.words[hi]);
  let args = cmd.words.slice(hi + 1);
  // `npx [--yes] tsx -e ...`
  if (head === "npx" || head === "pnpx") {
    let k = 0;
    while (k < args.length && args[k].startsWith("-")) k += args[k] === "-p" || args[k] === "--package" ? 2 : 1;
    if (k >= args.length) return {};
    head = basename(args[k]);
    args = args.slice(k + 1);
  }
  if (head === "cd" || head === "pushd") {
    const target = args.find((a) => !a.startsWith("-"));
    if (target && target !== "-") return { cwd: isAnchored(toPosix(target)) || !cwd ? target : `${toPosix(cwd)}/${target}` };
    return {};
  }
  // 2. Escritores de shell e de ferramenta.
  const s = structuralWrite(head, args, cwd);
  if (s && s.patchFiles) {
    const p = patchWrite(head, s, cmd, cmds, command, cwd, opts);
    if (p) return found(p);
  } else if (s) return found(s);
  if (head === "find") {
    const f = findWrite(args, cwd);
    if (f) return found(f);
  }
  if (head === "xargs") {
    const sub = xargsCommand(args);
    if (isWriterInvocation(sub)) {
      const sibling = cmds.find((c) => c.pipeline === cmd.pipeline && c !== cmd && c.words.some((w) => isProtectedPath(w, cwd)));
      const own = sub.slice(1).find((w) => isProtectedPath(w, cwd));
      if (sibling || own) return found({ kind: "xargs", path: own ?? sibling.words.find((w) => isProtectedPath(w, cwd)) });
    }
    // `xargs bash -c '...'`, `xargs sed -i ... <protegido>`
    const inner = findProtectedPathWrite(sub.map(shellQuote).join(" "), { ...opts, cwd }, depth + 1);
    return inner ? found(inner) : {};
  }
  // `./fix.sh <alvo>`: script de shell executado direto, mesmo critério do
  // `sh script.sh <alvo>` abaixo (#12812).
  if (/\.(?:sh|bash|zsh)$/.test(head)) {
    const protArg = args.find((a) => isProtectedPath(a, cwd));
    if (protArg) return found({ kind: `${head} (argumento)`, path: protArg });
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
        const shOps = operands(args, new Set(["-o", "+o", "-O", "+O"]));
        const file = shOps[0];
        // #12812: `sh script.sh <alvo>` — o script recebe o caminho
        // protegido como argumento; o que ele faz com `$1` é opaco, então o
        // argumento protegido basta, esteja o script onde estiver.
        const protArg = shOps.slice(1).find((a) => isProtectedPath(a, cwd));
        if (file && protArg) return found({ kind: `${head} script (argumento)`, path: protArg });
        const text = file ? readOutsideScript(file, cwd, projectDirs, opts.readFile) : null;
        if (text) scripts.push(text);
      }
    }
    for (const sc of scripts) {
      const inner = findProtectedPathWrite(sc, { ...opts, cwd }, depth + 1);
      if (inner) return found(inner);
    }
    return {};
  }
  // 4. Interpretador com código.
  const kind = interpreterKind(head);
  if (kind) {
    const { inline, stdin, scriptFile } = interpreterCode(kind, args, cmd.stdin);
    const sources = [...inline, ...stdin];
    // #12812: script FORA do projeto (`/tmp/fix.py <protegido>`) com
    // caminho protegido como argumento: o caminho chega por `sys.argv`, e o
    // código não o cita. Bloqueia quando o código usa API de escrita (ou não
    // pôde ser lido); script que só lê o argumento passa. Script versionado
    // do repo segue opaco (passa por review), como o código dele.
    if (scriptFile && scriptFile !== "-" && !insideProject(scriptFile, cwd, projectDirs)) {
      const after = args.slice(args.indexOf(scriptFile) + 1);
      const protArg = after.find((a) => isProtectedPath(a, cwd) || (a.includes("=") && isProtectedPath(a.slice(a.indexOf("=") + 1), cwd)));
      if (protArg) {
        const text = readOutsideScript(scriptFile, cwd, projectDirs, opts.readFile);
        if (text == null || WRITE_API_RES.some((re) => re.test(text))) {
          return found({ kind: `${head} script fora do projeto (argumento)`, path: protArg });
        }
      }
    }
    if (scriptFile && scriptFile !== "-") {
      const text = readOutsideScript(scriptFile, cwd, projectDirs, opts.readFile);
      if (text) sources.push(text);
    }
    if (sources.some((code) => codeWritesProtectedPath(code, cwd))) {
      return found({ kind: `${head} (código)`, path: protectedRefIn(sources) ?? cwd, source: INTERPRETER_CODE_SOURCE });
    }
  }
  return {};
}

/**
 * `git apply`/`git am`/`patch`: o alvo está no próprio patch — stdin
 * (heredoc), arquivo (dentro ou fora do projeto: patch não é script
 * versionado), `< x.patch` ou `cat x.patch |` no mesmo pipeline.
 *
 * Patch que não dá para ler (criado no mesmo comando, `git diff | git apply`,
 * `$VAR`) bloqueia quando o texto do comando cita caminho protegido
 * (`git diff -- <protegido> > p; git apply p`); sem citação, passa — bloquear
 * todo patch ilegível pegaria `git diff A B | git apply` e `gh pr diff N |
 * git apply`, usos de portar mudança entre worktrees (review da PR #12846).
 */
function patchWrite(head, s, cmd, cmds, command, cwd, opts) {
  const texts = [...cmd.stdin];
  const files = [...s.patchFiles];
  let unreadable = false;
  // `patch -p1 < /tmp/x.diff`: o patch chega por redirecionamento de entrada.
  if (!files.length) files.push(...cmd.redirects.filter((r) => r.op === "<").map((r) => r.target));
  if (!files.length && !texts.length) {
    for (const c of cmds) {
      if (c === cmd || c.pipeline !== cmd.pipeline) continue;
      const ci = headIndex(c.words);
      if (ci !== -1 && basename(c.words[ci]) === "cat") files.push(...operands(c.words.slice(ci + 1)));
      else unreadable = true; // produtor que não é `cat` (`git diff |`)
    }
  }
  for (const f of files) {
    const text = readPatchFile(f, s.dir, opts.readFile);
    if (text == null) unreadable = true;
    else texts.push(text);
  }
  for (const t of texts) {
    const p = patchTargets(t).find((x) => isProtectedPath(x, s.dir));
    if (p) return { kind: `${head} (patch)`, path: p };
  }
  if (unreadable) {
    const ref = protectedRefIn([command]) ?? cmds.flatMap((c) => c.words).find((w) => isProtectedPath(w, cwd));
    if (ref) return { kind: `${head} (patch ilegível; o comando cita caminho protegido)`, path: ref };
  }
  return null;
}

/** Texto de um patch em arquivo, esteja onde estiver; `null` se ilegível. */
function readPatchFile(file, dir, readFile) {
  if (typeof readFile !== "function") return null;
  const p = toPosix(file);
  if (p.startsWith("$") || p === "-") return null;
  const abs = isAnchored(p) || !dir ? p : `${toPosix(dir)}/${p}`;
  try {
    const text = readFile(abs);
    return typeof text === "string" ? text : null;
  } catch {
    return null;
  }
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

/** `file` (relativo a `cwd`) mora dentro de uma raiz do projeto ou do cwd? */
function insideProject(file, cwd, projectDirs) {
  const p = toPosix(file);
  // `$S/fix.py`: onde mora só se sabe ao rodar; não prova que é do projeto
  // (0 usos com argumento protegido nos transcripts, #12812).
  if (p.startsWith("$")) return false;
  const abs = isAnchored(p) ? p : `${toPosix(cwd)}/${p}`;
  return [...projectDirs, cwd].filter(Boolean).some((r) => isInside(r, abs));
}

/** Texto de um script em arquivo FORA das raízes do projeto, ou `null`. */
function readOutsideScript(file, cwd, projectDirs, readFile) {
  if (typeof readFile !== "function") return null;
  const p = toPosix(file);
  if (p.startsWith("$")) return null;
  const abs = isAnchored(p) ? p : `${toPosix(cwd)}/${p}`;
  if (insideProject(file, cwd, projectDirs)) return null;
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

/** O achado veio de código de interpretador (`node -e`, `python -c`, heredoc, script em /tmp)? */
export function isInterpreterCodeFinding(finding) {
  return finding?.source === INTERPRETER_CODE_SOURCE;
}

/**
 * #12780 (decisão do editor, 11/11/2026): o guard não afrouxa para texto
 * citado dentro do código — duas revisões acharam bypass ao descartar prosa.
 * A mensagem passa a dizer o contorno: o caminho sai do CÓDIGO e vai para um
 * arquivo de dados que o script lê.
 */
export const INTERPRETER_TEXT_WORKAROUND =
  "Se o alvo da escrita NÃO é um caminho protegido e o caminho só aparece como texto dentro do dado " +
  "(uma nota, o corpo de uma mensagem gravada em `plan.json`), o bloqueio dispara mesmo assim: o guard " +
  "lê o código inteiro e não separa alvo de texto (#12780, decisão de manter o guard). Contorno: grave o " +
  "script num arquivo no scratchpad da sessão e rode-o (`node <scratchpad>/x.cjs`), com o texto que cita o " +
  "caminho num arquivo de dados à parte (escrito pelo Write) que o script lê; o guard também lê scripts " +
  "fora do projeto, então o caminho não pode estar no código do script. Para um JSON pequeno, o próprio " +
  "Write/Edit no arquivo-alvo dispensa o script.";

export function protectedPathWriteReason(finding) {
  return (
    `Escrita via Bash em caminho protegido bloqueada (#12009): \`${finding.path}\` como alvo de ${finding.kind}. ` +
    "`.claude/{skills,agents,hooks,commands,rules,output-styles}`, `.claude/settings*.json`, `.mcp.json`, `.git/hooks` e `.git/config` " +
    "só se alteram pelo Edit/Write, que passam pela checagem de caminho protegido do Claude Code (prompt ao " +
    "editor; no modo agendado, negação). Use o Edit/Write. Se o Edit/Write foi negado, não contorne por " +
    "Bash/Python: entregue o resto com `REFS #N, NÃO CLOSES` e reporte ao coordenador os arquivos de `.claude/` " +
    "que faltaram (item 34 de context/overnight-dispatch-rules.md). Leitura (cat, grep, git diff/show) segue livre." +
    (isInterpreterCodeFinding(finding) ? ` ${INTERPRETER_TEXT_WORKAROUND}` : "")
  );
}
