// Detector de `gh pr merge` compartilhado pelo guard do #5716
// (`block-gh-pr-merge-subagent.mjs`, PreToolUse) e pelo consumidor de
// concessão (`consume-merge-grant-on-merge.mjs`, PostToolUse) — #10681.
//
// ANTES (#5787/#5805/#8793): um regex sobre `stripQuotedSpans(command)` que só
// aceitava `gh pr merge` no início da string ou logo depois de `&&`/`;`/`|`/
// `||`/newline. Formas que o shell executa como merge e o regex não via, e por
// isso o guard nem rodava:
//   GH_REPO=x gh pr merge 5        (atribuição de env antes do comando)
//   env FOO=1 gh pr merge 5        (wrapper env/command/exec/sudo/timeout...)
//   command gh pr merge 5
//   /usr/bin/gh pr merge 5         (caminho do binário)
//   gh pr -R x merge 5             (flag antes do subcomando)
//   (gh pr merge 5) / $(gh pr merge 5) / bash -c 'gh pr merge 5'
//
// AGORA: um lexer pequeno separa o comando em COMANDOS SIMPLES (listas de
// palavras, com aspas e escapes já resolvidos), e cada comando é lido pela
// POSIÇÃO de comando: pula atribuições e wrappers conhecidos, exige que a
// palavra de comando seja `gh` (ou um caminho terminado em `/gh`), pula flags
// entre `gh`/`pr`/`merge` e só então reconhece o merge.
//
// Por que isso não aumenta falso positivo: `gh pr merge` citado dentro de
// aspas vira UMA palavra só (`echo "gh pr merge"` → [echo, "gh pr merge"]) e
// nunca ocupa a posição de comando; texto depois de `#` é comentário.
//
// LIMITES CONHECIDOS (documentados, não cobertos):
//   - alias/função de shell (`alias m='gh pr merge'`; `m 5`) e alias do gh
//     (`gh alias set m 'pr merge'`; `gh m 5`) — o nome não diz o que roda;
//   - merge pela API (`gh api -X PUT repos/o/r/pulls/5/merge`), por outra
//     ferramenta (curl, script) ou por um script em arquivo (`bash x.sh`);
//   - expansão de variável na posição de comando (`$GH pr merge 5`,
//     `"${cmd[@]}"`) — o valor só existe em tempo de execução;
//   - corpo de heredoc (`<<EOF`/`<<'EOF'`/`<<-EOF`) é pulado como TEXTO até
//     a linha do delimitador — `git commit -F - <<'EOF'` cuja mensagem cita
//     `gh pr merge` não é merge. Exceção fail-closed: delimitador sem aspas
//     com `$(`/crase no corpo (o shell executa) → o corpo é lido como
//     comandos. Heredoc sem a linha de fechamento vai até o fim do comando;
//   - wrappers fora da lista `WRAPPERS` abaixo (ex.: `chronic`, `doas`).
// Na dúvida o lexer fica do lado de VER o merge: flag desconhecida de wrapper
// é tratada como booleana (não engole a palavra seguinte).

/** Teto de aninhamento (subshell, `$(...)`, `bash -c`, `eval`). Além dele
 * o conteúdo não é inspecionado — limite contra entrada patológica. */
const MAX_DEPTH = 8;

/**
 * Lexer: devolve a lista PLANA de comandos simples de `src` — cada um é um
 * array de palavras já sem aspas/escapes. Subshell `(...)`, substituição
 * `$(...)`/`` `...` `` (inclusive dentro de aspas duplas) e process
 * substitution `<(...)`/`>(...)` viram comandos próprios na mesma lista.
 * Redirecionamentos (`>x`, `2>&1`, `<<EOF`, `<<<x`) saem da lista de
 * palavras junto com o alvo.
 */
export function parseShellCommands(src, depth = 0) {
  const commands = [];
  if (typeof src !== "string" || depth > MAX_DEPTH) return commands;
  scan(src, 0, null, commands, depth);
  return commands;
}

function scan(src, start, closer, commands, depth) {
  const n = src.length;
  let i = start;
  let words = [];
  let word = "";
  let inWord = false;
  let wordQuoted = false;
  let skipNext = false; // próxima palavra é alvo de redirecionamento
  let heredocOp = null; // `<<`/`<<-` visto: a próxima palavra é o delimitador
  const heredocs = []; // { delim, quoted, strip } pendentes até o fim da linha

  const endWord = () => {
    if (!inWord) return;
    if (heredocOp !== null) {
      heredocs.push({ delim: word, quoted: wordQuoted, strip: heredocOp === "<<-" });
      heredocOp = null;
    }
    if (skipNext) skipNext = false;
    else words.push(word);
    word = "";
    inWord = false;
    wordQuoted = false;
  };
  const endCommand = () => {
    endWord();
    if (words.length > 0) commands.push(words);
    words = [];
    skipNext = false;
    heredocOp = null;
  };
  /**
   * Corpo dos heredocs pendentes, a partir de `from` (logo depois do newline
   * que encerra a linha do `<<`). Devolve onde a leitura continua. Corpo é
   * TEXTO, nunca comando — `git commit -F - <<'EOF'` com uma linha
   * `gh pr merge 5` na mensagem não é um merge (#10681). Exceção fail-closed:
   * delimitador SEM aspas expande `$(...)`/crase no corpo, que o shell
   * executa — aí o corpo inteiro é lido como comandos.
   */
  const skipHeredocBodies = (from) => {
    let pos = from;
    for (const h of heredocs) {
      const bodyStart = pos;
      let bodyEnd = n;
      while (pos < n) {
        const nl = src.indexOf("\n", pos);
        const lineEnd = nl === -1 ? n : nl;
        let line = src.slice(pos, lineEnd).replace(/\r$/, "");
        if (h.strip) line = line.replace(/^\t+/, "");
        const next = nl === -1 ? n : nl + 1;
        if (line === h.delim) {
          bodyEnd = pos;
          pos = next;
          break;
        }
        pos = next;
      }
      if (!h.quoted && depth < MAX_DEPTH) {
        const body = src.slice(bodyStart, Math.min(bodyEnd, n));
        if (body.includes("$(") || body.includes("`")) scan(body, 0, null, commands, depth + 1);
      }
    }
    heredocs.length = 0;
    return pos;
  };
  const nested = (from, close) => {
    if (depth >= MAX_DEPTH) return n;
    return scan(src, from, close, commands, depth + 1);
  };

  while (i < n) {
    const ch = src[i];
    if (closer !== null && ch === closer) {
      endCommand();
      return i + 1;
    }
    if (ch === "\\") {
      if (i + 1 < n && src[i + 1] === "\n") {
        i += 2; // continuação de linha
        continue;
      }
      if (i + 1 < n) {
        word += src[i + 1];
        inWord = true;
        wordQuoted = true;
      }
      i += 2;
      continue;
    }
    if (ch === "$" && src[i + 1] === "'") {
      let j = i + 2;
      while (j < n && src[j] !== "'") {
        if (src[j] === "\\" && j + 1 < n) {
          word += src[j + 1];
          j += 2;
          continue;
        }
        word += src[j];
        j++;
      }
      inWord = true;
      wordQuoted = true;
      i = j + 1;
      continue;
    }
    if (ch === "'") {
      let j = i + 1;
      while (j < n && src[j] !== "'") j++;
      word += src.slice(i + 1, j);
      inWord = true;
      wordQuoted = true;
      i = j + 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      while (j < n && src[j] !== '"') {
        if (src[j] === "\\" && j + 1 < n) {
          // Dentro de aspas duplas a barra só escapa $ ` " \ e newline.
          const next = src[j + 1];
          if (next !== "\n") word += '$`"\\'.includes(next) ? next : `\\${next}`;
          j += 2;
          continue;
        }
        if (src[j] === "$" && src[j + 1] === "(") {
          j = nested(j + 2, ")");
          word += "\u0000"; // valor desconhecido em tempo de análise
          continue;
        }
        if (src[j] === "`") {
          j = nested(j + 1, "`");
          word += "\u0000";
          continue;
        }
        word += src[j];
        j++;
      }
      inWord = true;
      wordQuoted = true;
      i = j + 1;
      continue;
    }
    if (ch === "$" && src[i + 1] === "(") {
      i = nested(i + 2, ")");
      word += "\u0000";
      inWord = true;
      continue;
    }
    if (ch === "`") {
      i = nested(i + 1, "`");
      word += "\u0000";
      inWord = true;
      continue;
    }
    if ((ch === "<" || ch === ">") && src[i + 1] === "(") {
      endWord();
      i = nested(i + 2, ")");
      continue;
    }
    if (ch === "(" && !inWord) {
      endCommand();
      i = nested(i + 1, ")");
      continue;
    }
    if (ch === ")") {
      // `)` sem abertura correspondente neste nível: trata como separador.
      endCommand();
      i++;
      continue;
    }
    if (ch === "#" && !inWord) {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    if (ch === "\n" || ch === ";") {
      endCommand();
      i++;
      if (ch === "\n" && heredocs.length > 0) i = skipHeredocBodies(i);
      continue;
    }
    if (ch === "|") {
      endCommand();
      i += src[i + 1] === "|" || src[i + 1] === "&" ? 2 : 1;
      continue;
    }
    if (ch === "&") {
      if (src[i + 1] === ">") {
        // `&>` / `&>>`: redireciona stdout+stderr
        endWord();
        i += src[i + 2] === ">" ? 3 : 2;
        skipNext = true;
        continue;
      }
      endCommand();
      i += src[i + 1] === "&" ? 2 : 1;
      continue;
    }
    if (ch === "<" || ch === ">") {
      // Descritor colado (`2>`) não é palavra do comando.
      if (inWord && !wordQuoted && /^\d+$/.test(word)) {
        word = "";
        inWord = false;
      } else {
        endWord();
      }
      const op = /^(<<<|<<-|<<|<>|<&|>>|>&|>\||<|>)/.exec(src.slice(i, i + 3))[0];
      i += op.length;
      skipNext = true;
      if (op === "<<" || op === "<<-") heredocOp = op;
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\r") {
      endWord();
      i++;
      continue;
    }
    word += ch;
    inWord = true;
    i++;
  }
  endCommand();
  return n;
}

const ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=/;
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh", "mksh"]);
/** Palavras reservadas que podem anteceder um comando simples. */
const RESERVED_PREFIX = new Set(["!", "{", "}", "then", "do", "else", "elif", "if", "while", "until"]);

/**
 * Wrappers que executam o resto da linha como comando. `valueFlags` são as
 * flags que consomem a PRÓXIMA palavra (quando não vêm coladas, `-uX`/
 * `--user=X`); `positional` é quantas palavras não-flag o wrapper consome
 * antes do comando (ex.: a duração do `timeout`); `assignments` diz se o
 * wrapper aceita `X=y` antes do comando (o `env`).
 */
const WRAPPERS = {
  env: { valueFlags: new Set(["-u", "--unset", "-C", "--chdir", "-P", "-S", "--split-string"]), assignments: true },
  command: { valueFlags: new Set() },
  exec: { valueFlags: new Set(["-a"]) },
  builtin: { valueFlags: new Set() },
  nohup: { valueFlags: new Set() },
  nice: { valueFlags: new Set(["-n", "--adjustment"]) },
  time: { valueFlags: new Set(["-f", "--format", "-o", "--output"]) },
  timeout: { valueFlags: new Set(["-s", "--signal", "-k", "--kill-after"]), positional: 1 },
  sudo: {
    valueFlags: new Set([
      "-u", "--user", "-g", "--group", "-h", "--host", "-p", "--prompt",
      "-C", "--close-from", "-D", "--chdir", "-T", "--command-timeout",
      "-r", "--role", "-t", "--type", "-U", "--other-user",
    ]),
    assignments: true,
  },
  xargs: {
    valueFlags: new Set([
      "-a", "--arg-file", "-d", "--delimiter", "-E", "-I", "-L", "--max-lines",
      "-n", "--max-args", "-P", "--max-procs", "-s", "--max-chars",
    ]),
  },
  stdbuf: { valueFlags: new Set(["-i", "--input", "-o", "--output", "-e", "--error"]) },
};

const basename = (w) => w.split(/[\\/]/).pop() ?? w;

/** `gh` como palavra de comando: `gh`, `gh.exe`, ou caminho terminado nisso. */
function isGhWord(w) {
  return /^gh(\.exe)?$/i.test(basename(w));
}

/** Flags globais/persistentes do `gh` que consomem a palavra seguinte. */
const GH_VALUE_FLAGS = new Set(["-R", "--repo", "--hostname"]);

/** Flags de `gh pr merge` que consomem a palavra seguinte (não é o nº da PR). */
const MERGE_VALUE_FLAGS = new Set([
  "-b", "--body", "-F", "--body-file", "-t", "--subject", "-A", "--author-email",
  "--match-head-commit", "-R", "--repo",
]);

/**
 * Dado um comando simples (palavras), devolve os argumentos depois de
 * `merge` se ele for um `gh pr merge`, ou `null`. Desce por wrappers,
 * `bash -c '...'`, `eval ...` e `env -S '...'` (recursão em `depth`).
 */
function mergeArgsOf(words, depth, out) {
  let i = 0;
  for (;;) {
    while (i < words.length && (ASSIGNMENT_RE.test(words[i]) || RESERVED_PREFIX.has(words[i]))) i++;
    if (i >= words.length) return;
    const name = basename(words[i]);
    if (name === "eval") {
      collect(words.slice(i + 1).join(" "), depth + 1, out);
      return;
    }
    if (SHELLS.has(name)) {
      const script = shellDashCScript(words, i + 1);
      if (script !== null) collect(script, depth + 1, out);
      return;
    }
    const wrapper = Object.hasOwn(WRAPPERS, name) ? WRAPPERS[name] : null;
    if (wrapper === null) break;
    i++;
    let positional = wrapper.positional ?? 0;
    while (i < words.length) {
      const w = words[i];
      if (w === "--") {
        i++;
        break;
      }
      if (name === "command" && (w === "-v" || w === "-V")) return; // só consulta, não executa
      if (w.startsWith("-") && w.length > 1) {
        const flag = w.includes("=") ? w.slice(0, w.indexOf("=")) : w;
        // `env -S 'gh pr merge 5'` / `-S'...'` / `--split-string=...`: a
        // string vira o comando — analisada como um comando à parte.
        if (name === "env" && (flag === "--split-string" || w.startsWith("-S"))) {
          let value;
          if (flag === "--split-string") value = w.includes("=") ? w.slice(w.indexOf("=") + 1) : words[i + 1];
          else value = w === "-S" ? words[i + 1] : w.slice(2);
          if (typeof value === "string") collect(value, depth + 1, out);
        }
        if (wrapper.valueFlags.has(w) && !w.includes("=")) i += 2;
        else i++;
        continue;
      }
      if (wrapper.assignments && ASSIGNMENT_RE.test(w)) {
        i++;
        continue;
      }
      if (positional > 0) {
        positional--;
        i++;
        continue;
      }
      break;
    }
  }
  if (i >= words.length || !isGhWord(words[i])) return;
  i++;
  // Subcomando `pr`, depois `merge`, com flags permitidas no meio.
  for (const expected of ["pr", "merge"]) {
    while (i < words.length && words[i].startsWith("-") && words[i] !== "-") {
      if (GH_VALUE_FLAGS.has(words[i])) i += 2;
      else i++;
    }
    if (i >= words.length || words[i] !== expected) return;
    i++;
  }
  out.push(words.slice(i));
}

/** Script de `bash -c 'script'` (e `-lc`, `-ec`, ...), ou `null`. */
function shellDashCScript(words, from) {
  let hasC = false;
  let i = from;
  while (i < words.length) {
    const w = words[i];
    if (w === "-o" || w === "+o" || w === "-O" || w === "+O" || w === "--rcfile" || w === "--init-file") {
      i += 2;
      continue;
    }
    if (/^-[A-Za-z]+$/.test(w)) {
      if (w.includes("c")) hasC = true;
      i++;
      continue;
    }
    if (w.startsWith("--")) {
      i++;
      continue;
    }
    break;
  }
  return hasC && i < words.length ? words[i] : null;
}

function collect(command, depth, out) {
  if (depth > MAX_DEPTH) return;
  for (const words of parseShellCommands(command, depth)) mergeArgsOf(words, depth, out);
}

/**
 * Todas as invocações reais de `gh pr merge` em `command`, na ordem em que
 * aparecem; cada item é a lista de argumentos depois de `merge`.
 */
export function findGhPrMergeInvocations(command) {
  const out = [];
  if (typeof command !== "string") return out;
  collect(command, 0, out);
  return out;
}

/** `true` se `command` executa `gh pr merge` (ver limites no topo). */
export function isGhPrMergeCommand(command) {
  return findGhPrMergeInvocations(command).length > 0;
}

/**
 * Número da PR alvo da ÚLTIMA invocação de `gh pr merge` (#6303 Finding S):
 * o primeiro argumento todo-dígitos que não seja valor de uma flag
 * (`--body "100 dias"`, `--subject 5`). `undefined` quando a invocação não
 * traz número (o gh infere a PR pela branch) ou não há merge nenhum.
 */
export function extractGhPrMergeTargetPr(command) {
  const all = findGhPrMergeInvocations(command);
  if (all.length === 0) return undefined;
  const args = all[all.length - 1];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (MERGE_VALUE_FLAGS.has(a)) {
      i++;
      continue;
    }
    if (/^\d+$/.test(a)) {
      const n = Number(a);
      return Number.isFinite(n) ? n : undefined;
    }
  }
  return undefined;
}
