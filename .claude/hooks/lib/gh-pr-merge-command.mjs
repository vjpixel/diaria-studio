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
// DESDE O #10689 também contam como merge (ver `ghInvocation`):
//   - `gh api` com método de escrita (PUT/POST/…, explícito ou implícito por
//     `-f`/`-F`/`--input`) num endpoint `…/merge` (`repos/o/r/pulls/5/merge`,
//     `/repos/…`, `{owner}/{repo}`, URL `https://api.github.com/…`); GET/HEAD
//     (só consulta se a PR foi mergeada) não conta;
//   - `gh api graphql` com `mergePullRequest`/`enablePullRequestAutoMerge`/
//     `enqueuePullRequest` — ou com a query ilegível (`@arquivo`, `--input`,
//     `"$Q"`, `$(…)`): fail-closed;
//   - alias do gh (`gh m 5` com `m: pr merge` no `config.yml` do gh, ou
//     definido no próprio comando por `gh alias set`).
//
// LIMITES CONHECIDOS (documentados, não cobertos):
//   - alias/função de SHELL (`alias m='gh pr merge'`; `m 5`) — vive no
//     ambiente do shell, que o hook não vê; e alias do gh criado FORA do
//     comando depois que o hook leu o config (o config é relido a cada
//     processo do hook, então só uma corrida dentro do mesmo comando escapa
//     — e `gh alias set`/`import` no próprio comando são lidos);
//   - merge por outra ferramenta (curl, script) ou por um script em arquivo
//     (`bash x.sh`); variável opaca no MEIO de um endpoint cujo fim é
//     literal e não é de PR (`repos/$R/issues/5`);
//   - expansão de variável na posição de comando (`$GH pr merge 5`,
//     `"${cmd[@]}"`) — o valor só existe em tempo de execução;
//   - corpo de heredoc: FAIL-CLOSED, lido como comandos E como string entre
//     aspas duplas (`$(...)`/crase) — conta merge se qualquer leitura achar.
//     Quem alimenta um shell com o corpo é inenumerável (`| sh`, `bash -c
//     "$(cat <<…)"`, `while … eval`, `$SHELL <<…`, `ssh host <<…`), então
//     não há lista de "runners": o corpo só é pulado quando o comando INTEIRO
//     casa a whitelist de `isHeredocDataCommand` (git commit -F -/-m "$(cat
//     <<'D' …)", gh pr|issue create/comment --body "$(cat <<'D' …)").
//     Falso positivo fora dela (ex.: `cat <<'EOF' > nota.md` citando o merge
//     numa rodada) é aceito;
//   - wrappers fora da lista `WRAPPERS` abaixo (ex.: `chronic`, `doas`).
// Na dúvida o lexer fica do lado de VER o merge: flag desconhecida de wrapper
// é tratada como booleana (não engole a palavra seguinte).

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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
export function parseShellCommands(src, depth = 0, ctx = DEFAULT_CTX) {
  const commands = [];
  if (typeof src !== "string" || depth > MAX_DEPTH) return commands;
  scan(src, 0, null, commands, depth, ctx);
  return commands;
}

/** `skipHeredocData`: pular o corpo dos heredocs (só sob a whitelist). */
const DEFAULT_CTX = Object.freeze({ skipHeredocData: false });

/**
 * Corpo de heredoc lido como string entre aspas duplas: só `\`, `$(...)`,
 * crase e `$[...]` têm efeito — nunca o lexing completo de shell (um `#` ou
 * uma `'` solta no texto não podem esconder um `$(gh pr merge 5)`).
 */
function scanSubstitutionsOnly(body, commands, depth, ctx) {
  if (depth > MAX_DEPTH) return;
  let j = 0;
  while (j < body.length) {
    if (body[j] === "\\") j += 2;
    else if (body[j] === "$" && body[j + 1] === "(") j = scan(body, j + 2, ")", commands, depth, ctx);
    else if (body[j] === "`") j = scan(body, j + 1, "`", commands, depth, ctx);
    else j++;
  }
}

/** Fim de um `$[...]` (aritmética antiga) a partir do `[`, com aninhamento. */
function arithEnd(src, open) {
  let level = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === "[") level++;
    else if (src[j] === "]" && --level === 0) return j + 1;
  }
  return src.length;
}

function scan(src, start, closer, commands, depth, ctx = DEFAULT_CTX) {
  const n = src.length;
  let i = start;
  let words = [];
  let word = "";
  let inWord = false;
  let wordQuoted = false;
  let skipNext = false; // próxima palavra é alvo de redirecionamento
  let heredocOp = null; // `<<`/`<<-` visto: a próxima palavra é o delimitador
  const heredocs = []; // { delim, quoted, strip } pendentes até o fim da linha
  let hereString = false; // `<<<`: a próxima palavra é o texto do here-string
  let hereStrings = []; // textos de here-string do comando corrente

  const endWord = () => {
    if (!inWord) return;
    if (heredocOp !== null) {
      // Delimitador com substituição (`<<"$(x)"`): o valor só existe em
      // execução — o corpo nunca é pulado, segue lido como comandos inline.
      if (!word.includes("\u0000")) heredocs.push({ delim: word, quoted: wordQuoted, strip: heredocOp === "<<-" });
      heredocOp = null;
    }
    if (hereString) {
      hereStrings.push(word);
      hereString = false;
    }
    if (skipNext) skipNext = false;
    else words.push(word);
    word = "";
    inWord = false;
    wordQuoted = false;
  };
  const endCommand = () => {
    endWord();
    if (hereStrings.length > 0) {
      // `bash <<< 'gh pr merge 5'`: o texto vai pro stdin do comando — quem
      // decide se ele executa é `mergeArgsOf` (shell/source/eval sem -c).
      Object.defineProperty(words, "hereStrings", { value: hereStrings, enumerable: false });
    }
    if (words.length > 0) commands.push(words);
    words = [];
    hereStrings = [];
    hereString = false;
    skipNext = false;
    heredocOp = null;
  };
  /**
   * Corpo dos heredocs pendentes, a partir de `from` (logo depois do newline
   * que encerra a linha do `<<`). Devolve onde a leitura continua (depois da
   * linha do delimitador). FAIL-CLOSED: o corpo é lido de DUAS formas — como
   * comandos (alguém pode estar alimentando um shell com ele: `| sh`,
   * `bash -c "$(cat <<…)"`, `while … eval`, `$SHELL <<…`, …) e como string
   * entre aspas duplas (só `$(...)`/crase, que o shell expande num corpo de
   * delimitador sem aspas) — e conta merge se qualquer uma achar. A ÚNICA
   * exceção, em que o corpo é pulado, é o comando inteiro casar a whitelist
   * de `isHeredocDataCommand` (`ctx.skipHeredocData`).
   */
  const skipHeredocBodies = (from) => {
    let pos = from;
    for (const h of heredocs) {
      const bodyStart = pos;
      let bodyEnd = n;
      while (pos < n) {
        const nl = src.indexOf("\n", pos);
        const lineEnd = nl === -1 ? n : nl;
        const raw = src.slice(pos, lineEnd).replace(/\r$/, "");
        const lead = h.strip ? /^\t*/.exec(raw)[0].length : 0;
        const line = raw.slice(lead);
        const next = nl === -1 ? n : nl + 1;
        if (line === h.delim) {
          bodyEnd = pos;
          pos = next;
          break;
        }
        // Dentro de `$(...)` o bash também fecha o heredoc em `D)`/`D )`: a
        // leitura volta como comando a partir do `)` (que fecha este nível).
        if (closer === ")" && line.startsWith(h.delim)) {
          const gap = /^[ \t]*\)/.exec(line.slice(h.delim.length));
          if (gap) {
            bodyEnd = pos;
            pos = pos + lead + h.delim.length + gap[0].length - 1;
            break;
          }
        }
        pos = next;
      }
      if (!ctx.skipHeredocData && depth < MAX_DEPTH) {
        const body = src.slice(bodyStart, Math.min(bodyEnd, n));
        scan(body, 0, null, commands, depth + 1, ctx);
        scanSubstitutionsOnly(body, commands, depth + 1, ctx);
      }
    }
    heredocs.length = 0;
    return pos;
  };
  const nested = (from, close) => {
    if (depth >= MAX_DEPTH) return n;
    return scan(src, from, close, commands, depth + 1, ctx);
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
    if (ch === "$" && src[i + 1] === "[") {
      // `$[1<<2]`: aritmética antiga, um span só — o `<<` dali não é heredoc.
      i = arithEnd(src, i + 1);
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
      if (op === "<<<") hereString = true;
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
/** Palavra que faz um here-string (`<<<`) ser EXECUTADO (lido como comandos). */
const BODY_RUNNERS = new Set([...SHELLS, "source", ".", "eval"]);
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
function mergeArgsOf(words, depth, out, env) {
  // `bash <<< 'gh pr merge 5'` / `eval`/`source` com here-string: o texto
  // vai pro stdin de quem o executa. Fail-closed: qualquer palavra que seja
  // um shell/source/./eval, ou a palavra de comando vinda de expansão
  // (`$SHELL <<< …`), faz o here-string ser lido como comandos.
  if (Array.isArray(words.hereStrings) && words.hereStrings.length > 0) {
    const cmdWord = words.find((w) => !ASSIGNMENT_RE.test(w)) ?? "";
    const runs =
      cmdWord.startsWith("$") ||
      cmdWord.includes("\u0000") ||
      words.some((w) => BODY_RUNNERS.has(basename(w).replace(/\.exe$/i, "")));
    if (runs) for (const s of words.hereStrings) collect(s, depth + 1, out, DEFAULT_CTX, env);
  }
  let i = 0;
  let viaXargs = false;
  for (;;) {
    while (i < words.length && (ASSIGNMENT_RE.test(words[i]) || RESERVED_PREFIX.has(words[i]))) i++;
    if (i >= words.length) return;
    const name = basename(words[i]);
    if (name === "eval") {
      collect(words.slice(i + 1).join(" "), depth + 1, out, DEFAULT_CTX, env);
      return;
    }
    if (SHELLS.has(name)) {
      const script = shellDashCScript(words, i + 1);
      if (script !== null) collect(script, depth + 1, out, DEFAULT_CTX, env);
      return;
    }
    const wrapper = Object.hasOwn(WRAPPERS, name) ? WRAPPERS[name] : null;
    if (wrapper === null) break;
    if (name === "xargs") viaXargs = true;
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
        // Cluster de flags curtas com S (`env -iS 'gh pr merge 5'`): o S
        // consome o resto do cluster ou, vazio, a próxima palavra.
        const shortS = !w.startsWith("--") ? /^-[A-Za-z]*?S/.exec(w) : null;
        let sTakesNext = false;
        if (name === "env" && (flag === "--split-string" || shortS)) {
          let value;
          if (flag === "--split-string") value = w.includes("=") ? w.slice(w.indexOf("=") + 1) : words[i + 1];
          else {
            const rest = w.slice(shortS[0].length);
            sTakesNext = rest === "";
            value = sTakesNext ? words[i + 1] : rest;
          }
          if (typeof value === "string") collect(value, depth + 1, out, DEFAULT_CTX, env);
        }
        if (sTakesNext || (wrapper.valueFlags.has(w) && !w.includes("="))) i += 2;
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
  ghInvocation(words.slice(i + 1), depth, out, viaXargs, env);
}

/**
 * Argumentos depois da palavra `gh`. Reconhece como merge (#10681, #10689):
 *   - `gh pr merge …` (flags permitidas entre `gh`/`pr`/`merge`);
 *   - `gh api` com método de escrita num endpoint `…/merge` (`apiMergeArgs`);
 *   - `gh api graphql` com mutation de merge (`graphqlIsMerge`);
 *   - alias do gh (`gh m 5` com `m: pr merge` no config, ou definido no
 *     próprio comando por `gh alias set`) — expandido e lido de novo.
 */
function ghInvocation(args, depth, out, viaXargs, env) {
  if (depth > MAX_DEPTH) return;
  let i = 0;
  const skipFlags = () => {
    while (i < args.length && args[i].startsWith("-") && args[i] !== "-") {
      if (GH_VALUE_FLAGS.has(args[i])) i += 2;
      else i++;
    }
  };
  skipFlags();
  // `xargs … gh`: o xargs completa o comando com o que vier do stdin
  // (`pr merge 5`) — fail-closed, conta como merge.
  if (i >= args.length) {
    if (viaXargs) out.push([]);
    return;
  }
  const sub = args[i];
  i++;
  if (sub === "pr") {
    skipFlags();
    if (i >= args.length && viaXargs) {
      out.push([]);
      return;
    }
    if (i >= args.length || args[i] !== "merge") return;
    out.push(args.slice(i + 1));
    return;
  }
  if (sub === "api") {
    const merge = apiMergeArgs(args.slice(i), viaXargs);
    if (merge !== null) out.push(merge);
    return;
  }
  if (sub === "alias") {
    recordAliasDefinition(args.slice(i), env);
    return;
  }
  if (GH_BUILTINS.has(sub)) return;
  const expansion = lookupGhAlias(sub, env);
  if (expansion === undefined) return; // extensão do gh ou typo — não é alias
  if (expansion === null) {
    // Alias cuja expansão não dá pra ler (bloco YAML, `gh alias import` no
    // mesmo comando, valor vindo de expansão): fail-closed, conta como merge.
    out.push([]);
    return;
  }
  const rest = args.slice(i);
  if (expansion.startsWith("!")) {
    // Alias de shell do gh (`gh alias set --shell`): o resto roda num `sh -c`.
    collect(expansion.slice(1), depth + 1, out, DEFAULT_CTX, env);
    return;
  }
  const expanded = parseShellCommands(expansion, depth + 1)[0] ?? [];
  ghInvocation([...expanded, ...rest], depth + 1, out, viaXargs, env);
}

// ─── `gh api` (#10689) ───────────────────────────────────────────────────
// `gh api -X PUT repos/o/r/pulls/5/merge` mergeia exatamente como
// `gh pr merge 5`, e `gh api graphql -f query='mutation { mergePullRequest
// (…) }'` também. Os dois passam a contar como merge — e, por não casarem a
// whitelist estrita de `parseStrictMerge` (gh-target-repo.mjs), sempre caem
// no modo ESTRITO do guard: todo lock que o comando possa tocar é conferido
// e nenhuma concessão conta. A coordenadora continua podendo mergear por aí.

/** Flags de `gh api` que consomem a palavra seguinte. */
const API_VALUE_FLAGS = new Set([
  "-X", "--method", "-H", "--header", "-f", "--raw-field", "-F", "--field", "--input",
  "-q", "--jq", "-t", "--template", "--hostname", "--cache", "-p", "--preview",
]);
/** Letras de flag curta de `gh api` que consomem valor (o resto é booleano, ex.: `-i`). */
const API_SHORT_VALUE = new Set(["X", "H", "f", "F", "q", "t", "p"]);
/** Flags cujo valor é um campo do corpo da requisição (`chave=valor`). */
const API_FIELD_FLAGS = new Set(["-f", "--raw-field", "-F", "--field"]);
/** Métodos que só leem — `GET …/pulls/5/merge` só consulta se a PR foi mergeada. */
const READ_METHODS = new Set(["GET", "HEAD"]);
/** Mutations do GraphQL que mergeiam (ou enfileiram o merge de) uma PR. */
const GRAPHQL_MERGE_RE = /\b(?:mergePullRequest|enablePullRequestAutoMerge|enqueuePullRequest)\b/i;

/** Valor que só existe em execução: `$(…)`/crase (`\u0000`) ou uma referência `$VAR`. */
function isOpaque(v) {
  return typeof v !== "string" || v.includes("\u0000") || /\$/.test(v);
}

/**
 * Lê os argumentos depois de `gh api`. Devolve a lista de argumentos no
 * formato de `gh pr merge` (`["-R", "o/r", "5"]`, `["5"]` ou `[]` quando o nº
 * não é legível) se a chamada mergeia uma PR, ou `null`.
 */
function apiMergeArgs(args, viaXargs) {
  let method = null;
  let hasBody = false;
  let bodyFromFile = false;
  let endpoint = null;
  const fields = [];
  const take = (flag, value) => {
    if (flag === "-X" || flag === "--method") method = value ?? "\u0000";
    else if (API_FIELD_FLAGS.has(flag)) {
      hasBody = true;
      fields.push(value ?? "\u0000");
    } else if (flag === "--input") {
      hasBody = true;
      bodyFromFile = true;
    }
  };
  for (let k = 0; k < args.length; k++) {
    const w = args[k];
    if (w === "--") {
      if (endpoint === null && k + 1 < args.length) endpoint = args[k + 1];
      break;
    }
    if (w.startsWith("--") && w.length > 2) {
      const eq = w.indexOf("=");
      if (eq > 0) take(w.slice(0, eq), w.slice(eq + 1));
      else if (API_VALUE_FLAGS.has(w)) {
        take(w, args[k + 1]);
        k++;
      }
      continue;
    }
    if (w.startsWith("-") && w.length > 1) {
      // Cluster de flags curtas (`-iXPUT`, `-X=PUT`, `-fquery=…`): a 1ª letra
      // que consome valor leva o resto do cluster ou, vazio, a próxima palavra.
      for (let c = 1; c < w.length; c++) {
        if (!API_SHORT_VALUE.has(w[c])) continue;
        const rest = w.slice(c + 1).replace(/^=/, "");
        if (rest !== "") take(`-${w[c]}`, rest);
        else {
          take(`-${w[c]}`, args[k + 1]);
          k++;
        }
        break;
      }
      continue;
    }
    if (endpoint === null) endpoint = w;
  }
  // `xargs gh api …` sem endpoint: ele vem do stdin — fail-closed.
  if (endpoint === null) return viaXargs ? [] : null;
  const path = normalizeApiEndpoint(endpoint);
  if (path === "graphql" || path === "api/graphql") {
    return graphqlIsMerge(fields, bodyFromFile) ? [] : null;
  }
  // Sem `-X`, o gh usa POST quando há campos/corpo e GET quando não há.
  const effective = method === null ? (hasBody ? "POST" : "GET") : method;
  if (!isOpaque(effective) && READ_METHODS.has(effective.toUpperCase())) return null;
  return restMergeArgs(path);
}

/** Tira esquema/host (`https://api.github.com/`, GHE `/api/v3/`), barra inicial, query e fragmento. */
function normalizeApiEndpoint(endpoint) {
  let s = endpoint.trim();
  s = s.replace(/^https?:\/\/[^/]+/i, "");
  s = s.replace(/^\/+/, "");
  s = s.replace(/^api\/v3\//i, "");
  s = s.replace(/[?#].*$/s, "");
  return s.replace(/\/+$/, "").toLowerCase() === "graphql" ? "graphql" : s.replace(/\/+$/, "");
}

/**
 * Endpoint REST com método de escrita: é merge quando o último segmento é
 * `merge` (`PUT /repos/{o}/{r}/pulls/{n}/merge` — nenhum outro endpoint da
 * API termina assim; `/merges` e `/merge-upstream` são outros) ou quando o
 * fim do caminho só existe em execução e o caminho pode ser de PR
 * (`$URL`, `repos/o/r/pulls/$N`) — fail-closed.
 */
function restMergeArgs(path) {
  const segs = path.split("/");
  const last = segs[segs.length - 1] ?? "";
  if (last.toLowerCase() !== "merge") {
    // Só o fim opaco conta, e só em caminho que pode ser de PR: `repos/$R/
    // issues/$N` (PATCH de issue, comum) segue livre.
    const maybePr = segs.length === 1 || segs.some((s) => s.toLowerCase() === "pulls");
    return isOpaque(last) && maybePr ? [] : null;
  }
  const n = segs.length;
  const num = segs[n - 2];
  if (n < 3 || segs[n - 3].toLowerCase() !== "pulls" || !/^\d+$/.test(num ?? "")) return [];
  const isRepoWord = (s) => typeof s === "string" && /^[A-Za-z0-9._-]+$/.test(s);
  if (n >= 6 && segs[n - 6].toLowerCase() === "repos" && isRepoWord(segs[n - 5]) && isRepoWord(segs[n - 4])) {
    return ["-R", `${segs[n - 5]}/${segs[n - 4]}`, num];
  }
  return [num];
}

/**
 * `true` quando a query GraphQL mergeia uma PR — ou quando o texto dela não
 * dá pra ler (`-F query=@arquivo`, `--input`, `query="$Q"`, `$(…)`): fail-closed.
 */
function graphqlIsMerge(fields, bodyFromFile) {
  if (bodyFromFile) return true;
  for (const f of fields) {
    if (f.includes("\u0000")) return true;
    const eq = f.indexOf("=");
    const key = eq === -1 ? f : f.slice(0, eq);
    const value = eq === -1 ? "" : f.slice(eq + 1);
    if (key !== "query") continue;
    if (value.startsWith("@")) return true;
    if (/^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/.test(value)) return true;
    if (GRAPHQL_MERGE_RE.test(value)) return true;
  }
  return false;
}

// ─── Aliases do gh (#10689) ──────────────────────────────────────────────
// `gh alias set m 'pr merge'` + `gh m 5` mergeia sem a palavra `merge` na
// posição do `gh pr`. Lidos sem rede nem subprocesso: a seção `aliases:` do
// `config.yml` do gh (`$GH_CONFIG_DIR`, `$XDG_CONFIG_HOME/gh`, `%AppData%\GitHub
// CLI` no Windows, `~/.config/gh`), mais os `gh alias set` do próprio comando.
// Alias de SHELL (`alias m='gh pr merge'` no bash) segue fora de alcance: o
// hook só vê o texto do comando, nunca o ambiente do shell que o executa.

/** Comandos de topo do gh (`gh help`, gh 2.8x). Builtin nunca é alias. */
const GH_BUILTINS = new Set([
  "auth", "browse", "codespace", "cs", "gist", "issue", "org", "pr", "project", "release", "repo", "skill",
  "cache", "run", "workflow", "agent-task", "alias", "api", "attestation", "completion", "config", "copilot",
  "extension", "extensions", "ext", "gpg-key", "label", "licenses", "preview", "ruleset", "search", "secret",
  "ssh-key", "status", "variable", "help", "version",
]);

/** Caminho do `config.yml` do gh, na mesma ordem que o gh procura. */
function ghConfigPath(e = process.env) {
  if (e.GH_CONFIG_DIR) return join(e.GH_CONFIG_DIR, "config.yml");
  if (e.XDG_CONFIG_HOME) return join(e.XDG_CONFIG_HOME, "gh", "config.yml");
  if (process.platform === "win32" && e.AppData) return join(e.AppData, "GitHub CLI", "config.yml");
  if (process.platform === "win32" && e.APPDATA) return join(e.APPDATA, "GitHub CLI", "config.yml");
  return join(homedir(), ".config", "gh", "config.yml");
}

/**
 * Aliases da seção `aliases:` de um `config.yml` do gh: `Map<nome, expansão>`;
 * expansão `null` quando o valor não é um escalar de uma linha legível
 * (bloco `|`/`>`, aspas não fechadas) — quem consulta trata como merge.
 */
export function parseGhAliasesYaml(text) {
  const aliases = new Map();
  if (typeof text !== "string") return aliases;
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^aliases:\s*(#.*)?$/.test(l));
  if (start === -1) return aliases;
  for (let k = start + 1; k < lines.length; k++) {
    const line = lines[k];
    if (/^\s*(#.*)?$/.test(line)) continue;
    if (!/^\s/.test(line)) break; // próxima chave de topo
    const m = /^\s+("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^:\s][^:]*?):(?:\s+(.*))?$/.exec(line);
    if (!m) continue;
    const name = unquoteYaml(m[1]);
    const raw = (m[2] ?? "").trim();
    if (raw === "" || /^[|>]/.test(raw)) {
      aliases.set(name, null);
      continue;
    }
    aliases.set(name, unquoteYaml(raw.replace(/\s+#.*$/, "")));
  }
  return aliases;
}

function unquoteYaml(v) {
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'");
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) return v.slice(1, -1).replace(/\\(.)/g, "$1");
  if (v.startsWith("'") || v.startsWith('"')) return null;
  return v;
}

let aliasCache = null;
/** Aliases do config do gh (lidos uma vez por processo; config ausente → nenhum). */
export function loadGhAliases(e = process.env) {
  const path = ghConfigPath(e);
  if (aliasCache !== null && aliasCache.path === path) return aliasCache.aliases;
  let aliases = new Map();
  try {
    aliases = parseGhAliasesYaml(readFileSync(path, "utf8"));
  } catch {
    // Sem config (gh nunca configurado) não há alias.
  }
  aliasCache = { path, aliases };
  return aliases;
}

/** Expansão do alias `name` (`undefined` = não é alias; `null` = ilegível). */
function lookupGhAlias(name, env) {
  if (env.local.has(name)) return env.local.get(name);
  const fromConfig = env.aliases.get(name);
  if (fromConfig !== undefined) return fromConfig;
  // `gh alias import` no mesmo comando: qualquer nome desconhecido pode ter
  // virado alias — fail-closed.
  return env.importSeen ? null : undefined;
}

/** `gh alias set [--shell] [--clobber] NOME EXPANSÃO` e `gh alias import` do próprio comando. */
function recordAliasDefinition(args, env) {
  const sub = args[0];
  if (sub === "import") {
    env.importSeen = true;
    return;
  }
  if (sub !== "set") return;
  let shell = false;
  const positional = [];
  for (const w of args.slice(1)) {
    if (w === "-s" || w === "--shell") shell = true;
    else if (w.startsWith("-") && w !== "-") continue;
    else positional.push(w);
  }
  const [name, expansion] = positional;
  if (typeof name !== "string") return;
  if (typeof expansion !== "string" || expansion === "-" || expansion.includes("\u0000")) {
    env.local.set(name, null);
    return;
  }
  env.local.set(name, shell && !expansion.startsWith("!") ? `!${expansion}` : expansion);
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

function collect(command, depth, out, ctx, env) {
  if (depth > MAX_DEPTH) return;
  for (const words of parseShellCommands(command, depth, ctx ?? DEFAULT_CTX)) mergeArgsOf(words, depth, out, env);
}

// ─── Whitelist de heredoc-como-DADO ──────────────────────────────────────
// Fora daqui, todo corpo de heredoc é lido como comandos (fail-closed). As
// formas abaixo são as que as rodadas usam o tempo todo pra passar TEXTO
// (mensagem de commit, corpo de PR/issue/comentário) — o corpo nunca vai pra
// um shell. Casa o comando INTEIRO; qualquer desvio volta pro fail-closed.

/** Argumento simples: sem `$`, crase, `\`, metacaractere nem aspas abertas. */
const SIMPLE_ARG = String.raw`(?:[A-Za-z0-9_./:@=+,%-]+|"[^"$\x60\\\n]*"|'[^'\n]*')`;
const ARGS = `(?: ${SIMPLE_ARG})*`;
const DELIM = "'([A-Za-z_]+)'";
const GIT_PUSH = `(?: && git push${ARGS})?`;
const HEAD_FORMS = [
  // git commit [flags] -F - <<'D' [&& git push ...]  →  depois do D, nada.
  { re: new RegExp(`^git commit${ARGS} -F - <<${DELIM}${GIT_PUSH}$`), tail: /^\s*$/ },
  // git commit [flags] -m "$(cat <<'D'  …  D  )" [flags] [&& git push ...]
  { re: new RegExp(`^git commit${ARGS} -m "\\$\\(cat <<${DELIM}$`), tail: new RegExp(`^\\)"${ARGS}${GIT_PUSH}\\s*$`) },
  // gh pr create|pr comment|issue comment|issue create … --body "$(cat <<'D'  …  D  )" …
  {
    re: new RegExp(`^gh (?:pr create|pr comment|issue comment|issue create)${ARGS} --body "\\$\\(cat <<${DELIM}$`),
    tail: new RegExp(`^\\)"${ARGS}\\s*$`),
  },
];

/**
 * `true` quando o comando INTEIRO é uma das formas de `HEAD_FORMS`: 1ª linha
 * casando o cabeçalho, corpo até a PRIMEIRA linha igual ao delimitador
 * (aspado, `[A-Za-z_]+`, sem `<<-`) e, depois dela, só o fecho esperado.
 */
export function isHeredocDataCommand(command) {
  if (typeof command !== "string" || command.includes("\r")) return false;
  const lines = command.split("\n");
  for (const { re, tail } of HEAD_FORMS) {
    const m = re.exec(lines[0]);
    if (!m) continue;
    const close = lines.indexOf(m[1], 1);
    if (close === -1) return false;
    // Dentro de `$(...)` o bash também fecha o heredoc numa linha `D` seguida
    // de espaços/tabs e `)` (`D)"`, `D )"; gh pr merge 5`) — e a variante com
    // espaço no fim é ambígua entre shells. Qualquer linha dessas ANTES do
    // fecho exato tira o comando da whitelist (fail-closed).
    const delim = m[1];
    const early = new RegExp(`^${delim}[ \\t]*\\)`);
    for (let k = 1; k < close; k++) {
      if (early.test(lines[k]) || lines[k].replace(/[ \t]+$/, "") === delim) return false;
    }
    return tail.test(lines.slice(close + 1).join("\n"));
  }
  return false;
}

/**
 * Todas as invocações reais de merge em `command` (`gh pr merge`, `gh api`
 * de merge, alias do gh que expande pra um deles — #10689), na ordem em que
 * aparecem; cada item é a lista de argumentos no formato de `gh pr merge`
 * (o que vem depois de `merge`; pra `gh api`, `["-R", "o/r", "N"]`/`["N"]`
 * ou `[]` quando o nº não é legível).
 *
 * `opts.aliases`: `Map<nome, expansão>` dos aliases do gh — default: os do
 * `config.yml` do gh (`loadGhAliases`). Testes passam um Map explícito.
 */
export function findGhPrMergeInvocations(command, opts = {}) {
  const out = [];
  if (typeof command !== "string") return out;
  // Lazy: o consumidor de concessão roda depois de TODO Bash — o config do gh
  // só é lido quando aparece um `gh <subcomando não-builtin>`.
  let aliases = opts?.aliases instanceof Map ? opts.aliases : null;
  const env = {
    get aliases() {
      if (aliases === null) aliases = loadGhAliases();
      return aliases;
    },
    local: new Map(),
    importSeen: false,
  };
  collect(command, 0, out, { skipHeredocData: isHeredocDataCommand(command) }, env);
  return out;
}

/** `true` se `command` executa um merge de PR (ver limites no topo). */
export function isGhPrMergeCommand(command, opts = {}) {
  return findGhPrMergeInvocations(command, opts).length > 0;
}

/**
 * Número da PR alvo da ÚLTIMA invocação de `gh pr merge` (#6303 Finding S):
 * o primeiro argumento todo-dígitos que não seja valor de uma flag
 * (`--body "100 dias"`, `--subject 5`). `undefined` quando a invocação não
 * traz número (o gh infere a PR pela branch) ou não há merge nenhum.
 */
export function extractGhPrMergeTargetPr(command, opts = {}) {
  const all = findGhPrMergeInvocations(command, opts);
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
