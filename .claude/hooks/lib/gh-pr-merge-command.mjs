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
// entre `gh`/`pr`/`merge` e só então reconhece o merge. Palavras reservadas
// que antecedem o comando (`!`, `{`, `if`, `while`, …, e desde o #10777
// `function NOME` e `coproc [NOME]`) também são puladas.
//
// Por que isso não aumenta falso positivo: `gh pr merge` citado dentro de
// aspas vira UMA palavra só (`echo "gh pr merge"` → [echo, "gh pr merge"]) e
// nunca ocupa a posição de comando; texto depois de `#` é comentário.
//
// DESDE O #10689 também contam como merge (ver `ghInvocation`):
//   - `gh api` com método de escrita (PUT/POST/…, explícito ou implícito por
//     `-f`/`-F`/`--input`, ou possível por uma expansão que pode trazer flags:
//     `gh api $F …`, `"$@"`, `xargs` sem `-I`) num endpoint `…/pulls/N/merge`
//     (`/repos/…`, `{owner}/{repo}`, URL `https://api.github.com/…`, GHE,
//     `merg%65`, `$'merg\x65'`, `merge/.`), `repos/o/r/merges`, escrita (não
//     DELETE) em `git/refs/heads/*`, ou de fim OPACO (`"$URL"`, `"$P/$E"`,
//     `repos/$R/$P`, `{}` do `xargs -I`/`find -exec`); GET/HEAD não conta;
//   - `gh api graphql` com `mergePullRequest`/`enablePullRequestAutoMerge`/
//     `enqueuePullRequest`/`mergeBranch`/`updateRef(s)` — ou com a query
//     ilegível (`@arquivo`, `--input`, qualquer `$` que o shell expande:
//     `"$Q"`, `"$A$B"`, `"…${M}…"`, `$(…)`): fail-closed. `$var` entre aspas
//     SIMPLES é variável do GraphQL e o texto é lido normalmente;
//   - alias do gh (`gh m 5` com `m: pr merge` no `config.yml` do gh, ou
//     definido no próprio comando por `gh alias set [--shell[=true]]`), com
//     fail-closed quando o config não é confiável (ilegível, linha não
//     entendida, ou o comando redefine `GH_CONFIG_DIR`/`XDG_CONFIG_HOME`/
//     `APPDATA`/`HOME`/`USERPROFILE`) e em alias que volta a si mesmo;
//   - subcomando do gh opaco (`gh $S merge 5`, `gh pr $M 5`) e aninhamento
//     além de `MAX_DEPTH`.
// Invocação cujo REPO não dá pra saber (GraphQL, caminho/`-R`/URL opaco,
// alias ilegível) sai como `api-graphql`, `opaque` ou `api-rest` de repo
// `unknown` (#10751, ver a união logo abaixo): o modo estrito do guard confere
// o lock de todo repo de `issue_repos` (`mergeTargetHints`).
//
// LIMITES CONHECIDOS (documentados, não cobertos):
//   - alias/função de SHELL (`alias m='gh pr merge'`; `m 5`) — vive no
//     ambiente do shell, que o hook não vê; e alias do gh criado FORA do
//     comando depois que o hook leu o config (o config é relido a cada
//     processo do hook, então só uma corrida dentro do mesmo comando escapa
//     — e `gh alias set`/`import` no próprio comando são lidos); variável de
//     config herdada do AMBIENTE (não redefinida no comando) é a do processo
//     do hook, que é o mesmo ambiente do Bash;
//   - merge por outra ferramenta (curl, script) ou por um script em arquivo
//     (`bash x.sh`); variável opaca no MEIO de um endpoint cujo fim é
//     literal e não é de merge (`repos/$R/issues/5`, `"$BASE"/comments`);
//     variável sem aspas no MEIO de um endpoint de início literal
//     (`repos/o/r/pulls/$N` com `N="5 -X PUT"`) — o word splitting só é
//     considerado quando a palavra COMEÇA pela expansão;
//   - expansão de variável na posição de comando (`$GH pr merge 5`,
//     `"${cmd[@]}"`) — o valor só existe em tempo de execução;
//   - corpo de heredoc: FAIL-CLOSED, lido como comandos E como string entre
//     aspas duplas (`$(...)`/crase) — conta merge se qualquer leitura achar.
//     Quem alimenta um shell com o corpo é inenumerável (`| sh`, `bash -c
//     "$(cat <<…)"`, `while … eval`, `$SHELL <<…`, `ssh host <<…`), então
//     não há lista de "runners": o corpo só é pulado quando o comando INTEIRO
//     casa a whitelist de `isHeredocDataCommand` (git commit -F -/-m "$(cat
//     <<'D' …)", gh pr|issue create/comment --body "$(cat <<'D' …)", com
//     `cd <caminho simples> && ` opcional antes — #10777; desde o #11325
//     também `cat <<'D' > arq` / `cat > arq <<'D'` seguido no máximo de um
//     consumidor de texto, e `gh pr|issue comment … --body-file - <<'D'`).
//     Falso positivo fora dela (ex.: `cat <<'EOF' | tee nota.md` citando o
//     merge) é aceito;
//   - wrappers fora da lista `WRAPPERS` abaixo (ex.: `chronic`, `doas`).
// Na dúvida o lexer fica do lado de VER o merge: flag desconhecida de wrapper
// é tratada como booleana (não engole a palavra seguinte).

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Teto de aninhamento (subshell, `$(...)`, `bash -c`, `eval`, alias). Além
 * dele o conteúdo não é inspecionado — e conta como merge (#10689 N): entrada
 * patológica nunca passa livre só por ser funda demais. */
const MAX_DEPTH = 8;

// Marcadores internos que o lexer põe nas palavras (nunca aparecem num
// comando digitado de verdade; se aparecerem, só deixam a palavra mais opaca).
/** `$(...)`/crase FORA de aspas: valor desconhecido E sujeito a word splitting. */
const SUBST = "\u0000";
/** `$(...)`/crase DENTRO de aspas duplas: valor desconhecido, palavra única. */
const SUBST_Q = "\u0004";
/** Antes de um `$VAR` FORA de aspas: o shell expande (e pode quebrar em várias palavras). */
const EXP_U = "\u0001";
/** Antes de um `$VAR` DENTRO de aspas duplas: o shell expande, palavra única. */
const EXP_Q = "\u0003";
/** Sentinela de comando: aninhamento além de `MAX_DEPTH` — lido como merge. */
const DEPTH_EXCEEDED = "\u0002";
/** Caractere que, logo depois de `$`, abre uma expansão de parâmetro. */
const PARAM_START_RE = /[A-Za-z_{0-9@*#?$!-]/;
const MARKER_RE = /[\u0000-\u0004]/;

/** A palavra tem algo que o SHELL expande em execução (`$VAR` fora de aspas simples, `$(…)`, crase). */
function isExpanded(v) {
  return typeof v !== "string" || MARKER_RE.test(v);
}

/** Conservador: expansão do shell OU um `$` literal (ex.: `'…/$N'` entre aspas simples). */
function isOpaque(v) {
  return isExpanded(v) || v.includes("$");
}

// ─── Resultado do detector: união discriminada (#10751) ─────────────────
// Cada invocação de merge encontrada é UM destes objetos (campo `via`):
//   { via: "pr-merge", args }        — `gh pr merge …` literal (inclusive o que
//                                      um alias legível expande): `args` é o
//                                      que vem depois de `merge`, precedido do
//                                      `-R` global se houver. `args` sem número
//                                      = o gh infere a PR pela branch.
//   { via: "api-rest", repo, pr }    — `gh api` REST de merge. `repo.kind`:
//                                      "literal" (`repos/o/r/…`, `repo.slug`),
//                                      "cwd" (`{owner}/{repo}` = repo do
//                                      diretório) ou "unknown". `pr` = nº de
//                                      `pulls/N/merge`, ou `null`.
//   { via: "api-graphql" }           — mutation de merge (ou query ilegível).
//   { via: "opaque", reason, args }  — o shell completa o comando em execução
//                                      ou o alvo não dá pra ler. `reason`:
//                                      "xargs", "endpoint", "subcommand",
//                                      "alias-unreadable", "alias-import",
//                                      "alias-loop", "depth". `args` = o que
//                                      deu pra ler, no formato de `pr-merge`.
// ANTES do #10751 era `string[][]` com `targetUnknown` não-enumerável, e `[]`
// tinha seis sentidos indistinguíveis. Só `pr-merge` pode sair do modo
// ESTRITO do guard (`requiresStrict`).

const prMergeInvocation = (args) => ({ via: "pr-merge", args });
const opaqueInvocation = (reason, args = []) => ({ via: "opaque", reason, args });
const GRAPHQL_INVOCATION = Object.freeze({ via: "api-graphql" });

/**
 * `true` quando a invocação NÃO é um `gh pr merge` literal — toda outra forma
 * (REST, GraphQL, opaca) cai no modo ESTRITO do guard: nenhuma concessão conta
 * e todo lock que o comando possa tocar é conferido (#10751).
 */
export function requiresStrict(inv) {
  return inv?.via !== "pr-merge";
}

/**
 * Corpo de `$'...'` (ANSI-C quoting) decodificado como o bash faz (#10689 G):
 * `\xHH`, `\uHHHH`, `\UHHHHHHHH`, octal, `\cX` e os escapes de uma letra. Um
 * `\0` decodificado trunca a palavra (o bash corta no NUL). Devolve o texto e
 * o índice logo depois do `'` de fecho.
 */
function decodeAnsiC(src, from) {
  const n = src.length;
  const simple = { a: "\x07", b: "\b", e: "\x1b", E: "\x1b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v", "\\": "\\", "'": "'", '"': '"', "?": "?" };
  let j = from;
  let text = "";
  let truncated = false;
  const put = (s) => {
    if (!truncated) text += s;
  };
  while (j < n && src[j] !== "'") {
    if (src[j] !== "\\" || j + 1 >= n) {
      put(src[j]);
      j++;
      continue;
    }
    const c = src[j + 1];
    j += 2;
    if (Object.hasOwn(simple, c)) {
      put(simple[c]);
      continue;
    }
    const digits = (re, max) => {
      const m = re.exec(src.slice(j, j + max));
      return m ? m[0] : "";
    };
    let code;
    if (c === "x" || c === "u" || c === "U") {
      const max = c === "x" ? 2 : c === "u" ? 4 : 8;
      const h = digits(new RegExp(`^[0-9A-Fa-f]{1,${max}}`), max);
      if (h === "") {
        put(`\\${c}`);
        continue;
      }
      code = parseInt(h, 16);
      j += h.length;
    } else if (/[0-7]/.test(c)) {
      const more = digits(/^[0-7]{1,2}/, 2);
      code = parseInt(c + more, 8) & 0xff;
      j += more.length;
    } else if (c === "c" && j < n) {
      code = src.charCodeAt(j) & 0x1f;
      j++;
    } else {
      put(`\\${c}`);
      continue;
    }
    if (code === 0) {
      truncated = true;
      continue;
    }
    try {
      put(String.fromCodePoint(code));
    } catch {
      put("�");
    }
  }
  return { text, end: j + 1 };
}

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
  if (typeof src !== "string") return commands;
  if (depth > MAX_DEPTH) return [[DEPTH_EXCEEDED]];
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
  if (depth > MAX_DEPTH) {
    commands.push([DEPTH_EXCEEDED]);
    return;
  }
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
      if (!word.includes(SUBST) && !word.includes(SUBST_Q)) {
        // `<<$X`: o bash não expande o delimitador — tira os marcadores.
        heredocs.push({ delim: word.replace(/[\u0001\u0003]/g, ""), quoted: wordQuoted, strip: heredocOp === "<<-" });
      }
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
      } else if (!ctx.skipHeredocData) {
        commands.push([DEPTH_EXCEEDED]);
      }
    }
    heredocs.length = 0;
    return pos;
  };
  const nested = (from, close) => {
    if (depth >= MAX_DEPTH) {
      commands.push([DEPTH_EXCEEDED]);
      return n;
    }
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
      const { text, end } = decodeAnsiC(src, i + 2);
      word += text;
      inWord = true;
      wordQuoted = true;
      i = end;
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
          word += SUBST_Q; // valor desconhecido em tempo de análise
          continue;
        }
        if (src[j] === "`") {
          j = nested(j + 1, "`");
          word += SUBST_Q;
          continue;
        }
        if (src[j] === "$" && PARAM_START_RE.test(src[j + 1] ?? "")) word += EXP_Q; // #10689 H
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
      word += SUBST;
      inWord = true;
      continue;
    }
    if (ch === "$" && src[i + 1] === "[") {
      // `$[1<<2]`: aritmética antiga, um span só — o `<<` dali não é heredoc.
      i = arithEnd(src, i + 1);
      word += SUBST;
      inWord = true;
      continue;
    }
    if (ch === "`") {
      i = nested(i + 1, "`");
      word += SUBST;
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
    if (ch === "$" && PARAM_START_RE.test(src[i + 1] ?? "")) word += EXP_U; // #10689 H
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
  // Aninhamento além do teto (#10689 N): acusa em vez de aceitar.
  if (depth > MAX_DEPTH || words[0] === DEPTH_EXCEEDED) {
    out.push(opaqueInvocation("depth"));
    return;
  }
  // `bash <<< 'gh pr merge 5'` / `eval`/`source` com here-string: o texto
  // vai pro stdin de quem o executa. Fail-closed: qualquer palavra que seja
  // um shell/source/./eval, ou a palavra de comando vinda de expansão
  // (`$SHELL <<< …`), faz o here-string ser lido como comandos.
  if (Array.isArray(words.hereStrings) && words.hereStrings.length > 0) {
    const cmdWord = words.find((w) => !ASSIGNMENT_RE.test(w)) ?? "";
    const runs =
      cmdWord.startsWith("$") ||
      isExpanded(cmdWord) ||
      words.some((w) => BODY_RUNNERS.has(basename(w).replace(/\.exe$/i, "")));
    if (runs) for (const s of words.hereStrings) collect(s, depth + 1, out, DEFAULT_CTX, env);
  }
  let i = 0;
  let viaXargs = false;
  /** String de substituição do `xargs -I`/`-i`/`--replace` (#10689 E). */
  let xargsReplace = null;
  for (;;) {
    for (;;) {
      if (i < words.length && (ASSIGNMENT_RE.test(words[i]) || RESERVED_PREFIX.has(words[i]))) i++;
      // #10777: `function f { gh pr merge 5; }` — `function` + o NOME da
      // função antecedem o corpo (a forma `function f() {…}` já se quebra no
      // `)` e o `{` cai no RESERVED_PREFIX).
      else if (words[i] === "function") i += 2;
      // #10777: `coproc gh pr merge 5` (comando simples, sem nome) e
      // `coproc NOME { …; }`/`coproc NOME while …` (composto: o nome vem antes
      // da palavra reservada). `coproc NOME ( … )` já vira subshell no lexer.
      else if (words[i] === "coproc") i += RESERVED_PREFIX.has(words[i + 2]) && !RESERVED_PREFIX.has(words[i + 1]) ? 2 : 1;
      else break;
    }
    if (i >= words.length) return;
    const name = basename(words[i]);
    if (name === "find") {
      findExecCommands(words, i + 1, depth, out, env);
      return;
    }
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
      if (name === "xargs") {
        if (w === "-I") xargsReplace = words[i + 1] ?? "{}";
        else if (w.startsWith("-I")) xargsReplace = w.slice(2);
        else if (w === "-i" || w === "--replace") xargsReplace = "{}";
        else if (/^-i[^-]/.test(w)) xargsReplace = w.slice(2);
        else if (w.startsWith("--replace=")) xargsReplace = w.slice(10) || "{}";
      }
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
  let ghArgs = words.slice(i + 1);
  // `xargs -I{} gh api -X PUT {}`: o `{}` vira o que vier do stdin — opaco.
  if (viaXargs && xargsReplace) ghArgs = ghArgs.map((a) => (a.includes(xargsReplace) ? a.split(xargsReplace).join(SUBST) : a));
  // Sem `-I`, o xargs ANEXA o stdin ao fim do comando (inclusive flags).
  ghInvocation(ghArgs, depth, out, { appends: viaXargs && !xargsReplace, env, chain: [] });
}

/** Ações do `find` que executam um comando (`-exec … ;`/`+`). */
const FIND_EXEC = new Set(["-exec", "-execdir", "-ok", "-okdir"]);

/** `find . -exec gh pr merge 5 \;` — cada `-exec` é um comando à parte; `{}` é opaco. */
function findExecCommands(words, from, depth, out, env) {
  for (let k = from; k < words.length; k++) {
    if (!FIND_EXEC.has(words[k])) continue;
    const sub = [];
    let m = k + 1;
    while (m < words.length && words[m] !== ";" && words[m] !== "+") {
      sub.push(words[m].split("{}").join(SUBST));
      m++;
    }
    if (sub.length > 0) mergeArgsOf(sub, depth + 1, out, env);
    k = m;
  }
}

/**
 * Argumentos depois da palavra `gh`. Reconhece como merge (#10681, #10689):
 *   - `gh pr merge …` (flags permitidas entre `gh`/`pr`/`merge`);
 *   - `gh api` com método de escrita num endpoint `…/merge` (`apiMergeArgs`);
 *   - `gh api graphql` com mutation de merge (`graphqlIsMerge`);
 *   - alias do gh (`gh m 5` com `m: pr merge` no config, ou definido no
 *     próprio comando por `gh alias set`) — expandido e lido de novo.
 */
function ghInvocation(args, depth, out, ctx) {
  const { appends, env, chain } = ctx;
  if (depth > MAX_DEPTH) {
    out.push(opaqueInvocation("depth"));
    return;
  }
  let i = 0;
  // `-R`/`--repo` global (`gh -R o/r m 5`, `gh pr -R o/r merge 5`): vai junto
  // na invocação, pra `mergeTargetHints` saber o repo (#10689 M).
  const repoArgs = [];
  const skipFlags = () => {
    while (i < args.length && args[i].startsWith("-") && args[i] !== "-") {
      const a = args[i];
      if (a === "-R" || a === "--repo") {
        repoArgs.push("-R", args[i + 1] ?? SUBST);
        i += 2;
      } else if (a.startsWith("--repo=")) {
        repoArgs.push("-R", a.slice(7));
        i++;
      } else if (/^-R./.test(a)) {
        repoArgs.push("-R", a.slice(2).replace(/^=/, ""));
        i++;
      } else if (GH_VALUE_FLAGS.has(a)) i += 2;
      else i++;
    }
  };
  skipFlags();
  // `xargs … gh`: o xargs completa o comando com o que vier do stdin
  // (`pr merge 5`) — fail-closed, conta como merge.
  if (i >= args.length) {
    if (appends) out.push(opaqueInvocation("xargs", [...repoArgs]));
    return;
  }
  const sub = args[i];
  i++;
  // `gh $S merge 5`: o subcomando só existe em execução (#10689 O).
  if (isExpanded(sub)) {
    out.push(opaqueInvocation("subcommand", [...repoArgs]));
    return;
  }
  if (sub === "pr") {
    skipFlags();
    if (i >= args.length) {
      if (appends) out.push(opaqueInvocation("xargs", [...repoArgs]));
      return;
    }
    if (isExpanded(args[i])) {
      out.push(opaqueInvocation("subcommand", [...repoArgs, ...args.slice(i + 1)])); // `gh pr $M 5` (#10689 O)
      return;
    }
    if (args[i] !== "merge") return;
    out.push(prMergeInvocation([...repoArgs, ...args.slice(i + 1)]));
    return;
  }
  if (sub === "api") {
    const merge = apiMergeArgs(args.slice(i), appends);
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
  if (expansion === null || chain.includes(sub)) {
    // Alias cuja expansão não dá pra ler (bloco YAML, `gh alias import` no
    // mesmo comando, valor vindo de expansão, config ilegível) ou que volta
    // a si mesmo: fail-closed, conta como merge, repo indeterminado.
    out.push(opaqueInvocation(opaqueAliasReason(sub, env, chain), [...repoArgs]));
    return;
  }
  const rest = args.slice(i);
  if (expansion.startsWith("!")) {
    // Alias de shell do gh (`gh alias set --shell`): o resto roda num `sh -c`.
    collect(expansion.slice(1), depth + 1, out, DEFAULT_CTX, env);
    return;
  }
  const expanded = parseShellCommands(expansion, depth + 1)[0] ?? [];
  ghInvocation([...repoArgs, ...expanded, ...rest], depth + 1, out, { appends, env, chain: [...chain, sub] });
}

// ─── `gh api` (#10689) ───────────────────────────────────────────────────
// `gh api -X PUT repos/o/r/pulls/5/merge` mergeia exatamente como
// `gh pr merge 5`, e `gh api graphql -f query='mutation { mergePullRequest
// (…) }'` também. Os dois passam a contar como merge — e, por não casarem a
// whitelist estrita de `parseStrictMerge` (gh-target-repo.mjs), sempre caem
// no modo ESTRITO do guard: todo lock que o comando possa tocar é conferido
// e nenhuma concessão conta. A coordenadora continua podendo mergear por aí.

/** Flags LONGAS de `gh api` que consomem a palavra seguinte (as curtas: `API_SHORT_VALUE`). */
const API_VALUE_FLAGS = new Set([
  "--method", "--header", "--raw-field", "--field", "--input", "--jq", "--template", "--hostname", "--cache", "--preview",
]);
/** Letras de flag curta de `gh api` que consomem valor (o resto é booleano, ex.: `-i`). */
const API_SHORT_VALUE = new Set(["X", "H", "f", "F", "q", "t", "p"]);
/** Flags cujo valor é um campo do corpo da requisição (`chave=valor`). */
const API_FIELD_FLAGS = new Set(["-f", "--raw-field", "-F", "--field"]);
/** Métodos que só leem — `GET …/pulls/5/merge` só consulta se a PR foi mergeada. */
const READ_METHODS = new Set(["GET", "HEAD"]);
/**
 * Mutations do GraphQL que mergeiam uma PR (ou enfileiram o merge), mergeiam
 * duas branches (`mergeBranch`) ou movem a ponta de uma branch (`updateRef`/
 * `updateRefs`, #10689 K). `\b` deixa de fora as parecidas que não mergeiam
 * (`disablePullRequestAutoMerge`, `dequeuePullRequest`, `updatePullRequestBranch`).
 */
const GRAPHQL_MERGE_RE = /\b(?:mergePullRequest|enablePullRequestAutoMerge|enqueuePullRequest|mergeBranch|updateRefs?)\b/i;

/** Começa com uma expansão (`"$URL"`, `$F`, `$(…)`): pode até virar flags. */
const startsWithExpansion = (w) => /^[\u0000-\u0004]/.test(w);
/** Expansão FORA de aspas no início: sujeita a word splitting (`$F` = `-X PUT`). */
const splitsIntoWords = (w) => /^[\u0000\u0001]/.test(w);
/** `"$@"`, `$*`, `"${arr[@]}"`: vira várias palavras mesmo entre aspas. */
const isMultiWordExpansion = (w) => /[\u0001\u0003]\$(?:[@*]|\{[^}]*\[[@*]\]\})/.test(w);

/**
 * Lê os argumentos depois de `gh api`. Devolve a invocação (`api-rest`,
 * `api-graphql`, ou `opaque` com `reason: "endpoint"` quando o endpoint vem do
 * stdin do xargs) se a chamada mergeia — ou pode mergear — uma PR, ou `null`.
 *
 * `appends`: o comando veio de um `xargs` sem `-I`, que ANEXA o stdin (inclusive
 * flags como `-X PUT`) ao fim — o método nunca é dado como só-leitura.
 */
function apiMergeArgs(args, appends) {
  let method = null;
  let hasBody = false;
  let bodyFromFile = false;
  /** Alguma palavra pode virar flag/método/campo em execução (#10689 C). */
  let uncertain = appends;
  const positional = [];
  const fields = [];
  const take = (flag, value) => {
    if (flag === "-X" || flag === "--method") method = value ?? SUBST;
    else if (API_FIELD_FLAGS.has(flag)) {
      hasBody = true;
      fields.push(value ?? SUBST);
    } else if (flag === "--input") {
      hasBody = true;
      bodyFromFile = true;
    }
  };
  for (let k = 0; k < args.length; k++) {
    const w = args[k];
    if (w === "--") {
      positional.push(...args.slice(k + 1));
      break;
    }
    if (w.startsWith("--") && w.length > 2) {
      const eq = w.indexOf("=");
      const flag = eq > 0 ? w.slice(0, eq) : w;
      if (isExpanded(flag)) uncertain = true; // `--$F=…`
      if (eq > 0) take(flag, w.slice(eq + 1));
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
        if (MARKER_RE.test(w[c]) || w[c] === "$") {
          uncertain = true; // `-$F`: a letra da flag só existe em execução
          break;
        }
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
    positional.push(w);
  }
  // O endpoint é o 1º posicional LITERAL; uma expansão em outra posição (ou
  // que se quebra em palavras) pode estar trazendo `-X PUT`/campos (#10689 C):
  // `gh api $F repos/o/r/pulls/5/merge`, `gh api "$@"`. Um único `"$URL"`
  // entre aspas continua sendo só o endpoint (GET livre).
  let endIdx = positional.findIndex((w) => !startsWithExpansion(w));
  if (endIdx === -1) endIdx = positional.length > 0 ? 0 : -1;
  positional.forEach((w, idx) => {
    if (isMultiWordExpansion(w)) uncertain = true;
    else if (idx !== endIdx && startsWithExpansion(w)) uncertain = true;
    else if (idx === endIdx && splitsIntoWords(w)) uncertain = true;
  });
  // `xargs gh api …` sem endpoint: ele vem do stdin — fail-closed.
  if (endIdx === -1) return uncertain ? opaqueInvocation("endpoint") : null;
  const segs = normalizeApiPath(positional[endIdx]);
  const lower = segs.map((s) => s.toLowerCase());
  if ((segs.length === 1 && lower[0] === "graphql") || (segs.length === 2 && lower[0] === "api" && lower[1] === "graphql")) {
    return graphqlIsMerge(fields, bodyFromFile || uncertain) ? GRAPHQL_INVOCATION : null;
  }
  // Sem `-X`, o gh usa POST quando há campos/corpo e GET quando não há.
  const effective = method === null ? (hasBody ? "POST" : "GET") : method;
  if (!uncertain && !isOpaque(effective) && READ_METHODS.has(effective.toUpperCase())) return null;
  return restMergeArgs(segs, isOpaque(effective) ? SUBST : effective.toUpperCase());
}

/**
 * Segmentos do caminho de um endpoint: sem esquema/host (`https://api.github.com`,
 * GHE `/api/v3/`), query e fragmento; percent-encoding decodificado uma vez,
 * como o servidor faz (`merg%65`, `5%2Fmerge` — #10689 P); `.`/`..` e barras
 * repetidas resolvidos (`merge/.`).
 */
function normalizeApiPath(endpoint) {
  let s = endpoint.trim();
  s = s.replace(/^https?:\/\/[^/]+/i, "");
  s = s.replace(/^\/+/, "");
  s = s.replace(/^api\/v3\//i, "");
  s = s.replace(/[?#].*$/s, "");
  if (s.includes("%")) {
    try {
      s = decodeURIComponent(s).replace(/[?#].*$/s, "");
    } catch {
      // `%` malformado: o servidor recusa (400) — fica literal.
    }
  }
  const out = [];
  for (const seg of s.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return out;
}

/** Nome de owner/repo legível num caminho da API. */
const isRepoWord = (s) => typeof s === "string" && /^[A-Za-z0-9._-]+$/.test(s);

/**
 * Coleções da API que NÃO levam a um merge: um caminho com uma delas literal
 * e o fim opaco (`repos/$REPO/issues/$N`, `pulls/comments/$ID`) segue livre.
 */
const NON_MERGE_COLLECTIONS = new Set([
  "issues", "comments", "reviews", "requested_reviewers", "files", "commits", "labels", "assignees",
  "milestones", "releases", "actions", "runs", "jobs", "workflows", "contents", "statuses", "check-runs",
  "check-suites", "hooks", "collaborators", "deployments", "environments", "branches", "tags", "events",
  "notifications", "search", "users", "user", "orgs", "teams", "gists", "projects", "secrets", "variables",
  "pages", "forks", "topics", "keys", "invitations", "compare", "readme", "languages", "contributors",
]);

/** Segmentos literais que levam a um caminho de merge (`pulls/N/merge`, `merges`, `git/refs/heads`). */
const MERGE_PATH_WORDS = new Set(["pulls", "merges", "git"]);

/** `…/git/refs/heads/<branch>` com os três segmentos literais. */
function isBranchRefPath(lower, opaque) {
  for (let g = 0; g + 3 < lower.length; g++) {
    if (lower[g] === "git" && lower[g + 1] === "refs" && lower[g + 2] === "heads" && !opaque[g] && !opaque[g + 1] && !opaque[g + 2]) {
      return true;
    }
  }
  return false;
}

/** Texto literal depois da última expansão de um segmento (`merg$E` → ``). */
function literalSuffix(seg) {
  let end = 0;
  for (const m of seg.matchAll(/[\u0000\u0002\u0004]|[\u0001\u0003]?\$(?:\{[^}]*\}|[A-Za-z_][A-Za-z0-9_]*|[0-9@*#?$!-])?/g)) {
    end = m.index + m[0].length;
  }
  return seg.slice(end);
}

/**
 * Endpoint REST com método de escrita. É merge quando o caminho é:
 *   - `…/pulls/{n}/merge` (o único endpoint da API que termina em `merge`);
 *   - `repos/{o}/{r}/merges` (merge de branch) ou escrita (não DELETE) em
 *     `…/git/refs/heads/<branch>` (#10689 K) — sem nº de PR;
 *   - de fim OPACO (`$URL`, `"$P/$E"`, `repos/$R/$P`, `pul$X/5/merg$E`, `{}`
 *     do xargs — #10689 D/E), salvo quando uma coleção literal que não leva a
 *     merge vem depois de tudo que poderia levar (`repos/$REPO/issues/$N`).
 * `repo` da invocação: `{ kind: "literal", slug: "o/r" }` quando `repos/{o}/{r}`
 * é literal; `{ kind: "cwd" }` pra `{owner}/{repo}` (o repo do diretório);
 * `{ kind: "unknown" }` pra qualquer outra forma.
 */
function restMergeArgs(segs, method) {
  const n = segs.length;
  if (n === 0) return null;
  const lower = segs.map((s) => s.toLowerCase());
  const opaque = segs.map(isOpaque);
  let repo = { kind: "unknown" };
  if (n >= 3 && lower[0] === "repos" && !opaque[1] && !opaque[2]) {
    if (segs[1] === "{owner}" && segs[2] === "{repo}") repo = { kind: "cwd" };
    else if (isRepoWord(segs[1]) && isRepoWord(segs[2])) repo = { kind: "literal", slug: `${segs[1]}/${segs[2]}` };
  }
  const result = (pr = null) => ({ via: "api-rest", repo, pr });
  const last = n - 1;
  if (!opaque[last]) {
    if (lower[last] === "merge") {
      const num = segs[n - 2];
      if (n >= 3 && lower[n - 3] === "pulls" && /^\d+$/.test(num ?? "")) {
        const pr = Number(num);
        return result(Number.isFinite(pr) ? pr : null);
      }
      return result();
    }
    if (lower[last] === "merges") return result();
    if (method !== "DELETE" && isBranchRefPath(lower, opaque)) return result();
    return null;
  }
  if (method !== "DELETE" && isBranchRefPath(lower, opaque)) return result();
  const suffix = literalSuffix(segs[last]).toLowerCase();
  if (suffix !== "" && !"merge".endsWith(suffix) && !"merges".endsWith(suffix)) return null;
  // Última coleção literal que não leva a merge; se nenhum `pulls`/`merges`/
  // `git` literal vem depois dela, o fim opaco é dela (`issues/$N`).
  let anchor = -1;
  for (let k = 0; k < last; k++) if (!opaque[k] && NON_MERGE_COLLECTIONS.has(lower[k])) anchor = k;
  if (anchor !== -1 && !lower.some((s, k) => k > anchor && !opaque[k] && MERGE_PATH_WORDS.has(s))) return null;
  return result();
}

/**
 * `true` quando a query GraphQL mergeia — ou quando o texto dela não dá pra
 * ler (`-F query=@arquivo`, `--input`, flags vindas de expansão). #10689 H:
 * `$` que o SHELL expande (fora de aspas simples: `query="$Q"`, `"$A$B"`,
 * `"mutation { ${M}(…) }"`) torna a query opaca; `$owner`/`$endCursor`
 * literais (entre aspas simples) são variáveis do GraphQL e o texto é lido.
 * Campos que não são `query` (variáveis) nunca mudam a operação.
 */
function graphqlIsMerge(fields, unreadable) {
  if (unreadable) return true;
  for (const f of fields) {
    const eq = f.indexOf("=");
    const key = eq === -1 ? f : f.slice(0, eq);
    const value = eq === -1 ? "" : f.slice(eq + 1);
    if (isExpanded(key)) return true; // `-f "$K=…"` pode ser a própria query
    if (key !== "query") continue;
    if (value.startsWith("@")) return true;
    if (isExpanded(value)) return true;
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
//
// FAIL-CLOSED quando a leitura não é confiável: config que existe mas não abre
// (EACCES, EISDIR, lock no Windows — #10689 I), seção `aliases:` com linha que
// o parser não entende (flow style, anchor, chave ilegível — J), ou o próprio
// comando redefinindo de onde o gh lê o config (`GH_CONFIG_DIR=…`, `HOME=…`,
// `env -i` — F). Nesses casos todo subcomando que não é builtin conta como
// alias de merge de repo indeterminado.

/** Comandos de topo do gh (`gh help`, gh 2.8x). Builtin nunca é alias. */
const GH_BUILTINS = new Set([
  "auth", "browse", "codespace", "cs", "gist", "issue", "org", "pr", "project", "release", "repo", "skill",
  "cache", "run", "workflow", "agent-task", "alias", "api", "attestation", "completion", "config", "copilot",
  "extension", "extensions", "ext", "gpg-key", "label", "licenses", "preview", "ruleset", "search", "secret",
  "ssh-key", "status", "variable", "help", "version",
]);

/** Variáveis que decidem de onde o gh lê o `config.yml` (ver `ghConfigPath`). */
const GH_CONFIG_VARS = "GH_CONFIG_DIR|XDG_CONFIG_HOME|APPDATA|LOCALAPPDATA|HOME|USERPROFILE";
/** O comando redefine/apaga uma delas (prefixo, `export`, `env`, `unset`, `env -u`, `env -i`). */
const CONFIG_OVERRIDE_RES = [
  new RegExp(`(?:^|[^A-Za-z0-9_$])(?:${GH_CONFIG_VARS})\\+?=`, "i"),
  new RegExp(`\\bunset\\b[^;&|\\n]*\\b(?:${GH_CONFIG_VARS})\\b`, "i"),
  new RegExp(`(?:\\s-u\\s*|\\s--unset[=\\s])['"]?(?:${GH_CONFIG_VARS})\\b`, "i"),
  /\benv\b(?:\s+-[A-Za-z]*i[A-Za-z]*|\s+--ignore-environment|\s+-)(?=\s|$)/,
];

/**
 * Caminho do `config.yml` do gh, na mesma ordem que o gh procura:
 * `GH_CONFIG_DIR` > `XDG_CONFIG_HOME/gh` > (Windows) `%AppData%\GitHub CLI` >
 * `~/.config/gh` (home de `HOME`, ou `USERPROFILE` no Windows).
 */
export function ghConfigPath(e = process.env, platform = process.platform) {
  if (e.GH_CONFIG_DIR) return join(e.GH_CONFIG_DIR, "config.yml");
  if (e.XDG_CONFIG_HOME) return join(e.XDG_CONFIG_HOME, "gh", "config.yml");
  if (platform === "win32") {
    const appData = e.AppData || e.APPDATA;
    if (appData) return join(appData, "GitHub CLI", "config.yml");
  }
  const home = (platform === "win32" ? e.USERPROFILE || e.HOME : e.HOME) || homedir();
  return join(home, ".config", "gh", "config.yml");
}

/** Indentação (espaços/tabs iniciais) de uma linha. */
const indentOf = (line) => /^[ \t]*/.exec(line)[0].length;

/**
 * Aliases da seção `aliases:` de um `config.yml` do gh: `Map<nome, expansão>`;
 * expansão `null` quando o valor não é um escalar de uma linha legível
 * (bloco `|`/`>`, aspas não fechadas, anchor/tag/flow) — quem consulta trata
 * como merge. Linha da seção que o parser não entende (flow style na própria
 * chave `aliases:`, chave ilegível, `<<`, continuação de escalar) vai pra
 * propriedade não-enumerável `unparsed` do Map (#10689 J): com ela, qualquer
 * nome desconhecido conta como alias ilegível.
 */
export function parseGhAliasesYaml(text) {
  const aliases = new Map();
  if (typeof text !== "string") return aliases;
  const unparsed = [];
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  const keyRe = /^["']?aliases["']?[ \t]*:/;
  const start = lines.findIndex((l) => keyRe.test(l));
  if (start !== -1) {
    const head = lines[start].replace(keyRe, "").replace(/\s+#.*$/, "").trim();
    if (head !== "") unparsed.push(lines[start]); // `aliases: {m: pr merge}`, `aliases: &a`, `aliases: *a`
    let keyIndent = -1; // indentação da chave anterior
    let skipDeeper = false; // linhas mais indentadas pertencem a um valor de bloco
    let lastName = null;
    for (let k = start + 1; k < lines.length; k++) {
      const line = lines[k];
      if (/^\s*(#.*)?$/.test(line)) continue;
      if (!/^\s/.test(line)) break; // próxima chave de topo
      const ind = indentOf(line);
      if (keyIndent !== -1 && ind > keyIndent) {
        // Continuação: corpo de bloco (`blk: |`) é esperado; depois de um
        // escalar de uma linha é continuação de plain scalar — ilegível.
        if (!skipDeeper && lastName !== null) aliases.set(lastName, null);
        continue;
      }
      const m = /^\s+("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^:\s][^:]*?):(?:\s+(.*))?$/.exec(line);
      if (!m) {
        unparsed.push(line);
        continue;
      }
      const name = unquoteYaml(m[1]);
      if (name === null || name === "<<") {
        unparsed.push(line);
        continue;
      }
      keyIndent = ind;
      lastName = name;
      const raw = (m[2] ?? "").trim();
      if (raw === "" || /^[|>&*!{[]/.test(raw)) {
        aliases.set(name, null);
        skipDeeper = true;
        continue;
      }
      skipDeeper = false;
      aliases.set(name, unquoteYaml(raw.replace(/\s+#.*$/, "")));
    }
  }
  if (unparsed.length > 0) Object.defineProperty(aliases, "unparsed", { value: unparsed, enumerable: false });
  return aliases;
}

function unquoteYaml(v) {
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'");
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) return v.slice(1, -1).replace(/\\(.)/g, "$1");
  if (v.startsWith("'") || v.startsWith('"')) return null;
  return v;
}

let aliasCache = null;
/**
 * Aliases do config do gh, lidos uma vez por processo (cache por caminho).
 * Config AUSENTE (`ENOENT`/`ENOTDIR`, gh nunca configurado) → nenhum alias.
 * Qualquer outro erro de leitura (#10689 I) → Map vazio com a propriedade
 * não-enumerável `loadError` (`{ code, message }`): quem consulta trata todo
 * nome desconhecido como alias ilegível, e o guard loga o erro.
 */
export function loadGhAliases(e = process.env, platform = process.platform) {
  const path = ghConfigPath(e, platform);
  if (aliasCache !== null && aliasCache.path === path) return aliasCache.aliases;
  let aliases;
  try {
    aliases = parseGhAliasesYaml(readFileSync(path, "utf8"));
  } catch (err) {
    aliases = new Map();
    const code = err && typeof err === "object" && "code" in err ? String(err.code) : "unknown";
    if (code !== "ENOENT" && code !== "ENOTDIR") {
      const message = err instanceof Error ? err.message : String(err);
      Object.defineProperty(aliases, "loadError", { value: { code, message, path }, enumerable: false });
    }
  }
  aliasCache = { path, aliases };
  return aliases;
}

/** O Map de aliases não é confiável (config ilegível ou com linha não entendida). */
const aliasesUnreliable = (aliases) => Boolean(aliases.loadError || aliases.unparsed);

/** Expansão do alias `name` (`undefined` = não é alias; `null` = ilegível). */
function lookupGhAlias(name, env) {
  if (env.local.has(name)) return env.local.get(name);
  // `GH_CONFIG_DIR=/x gh m 5`: o gh vai ler OUTRO config — nada do que foi
  // lido aqui vale (#10689 F).
  if (env.configOverridden) return null;
  const fromConfig = env.aliases.get(name);
  if (fromConfig !== undefined) return fromConfig;
  // `gh alias import` no mesmo comando (ou nome de alias opaco), ou config
  // que não deu pra ler inteiro: qualquer nome desconhecido pode ser alias.
  return env.importSeen || aliasesUnreliable(env.aliases) ? null : undefined;
}

/**
 * `reason` da invocação opaca de um alias ilegível (só informativo — toda
 * variante opaca tem o mesmo tratamento). Roda depois de `lookupGhAlias`, que
 * já leu o config quando precisava.
 */
function opaqueAliasReason(name, env, chain) {
  if (chain.includes(name)) return "alias-loop";
  if (env.local.has(name) || env.configOverridden) return "alias-unreadable";
  if (env.aliases.get(name) !== undefined) return "alias-unreadable";
  return env.importSeen ? "alias-import" : "alias-unreadable";
}

/** Valor de `--shell`/`-s` (`--shell=false` desliga; ausente = ligado). */
function shellFlagValue(w) {
  const eq = w.indexOf("=");
  if (eq === -1) return true;
  const v = w.slice(eq + 1);
  if (isExpanded(v)) return true; // ilegível: o lado que acusa
  return !/^(?:false|f|0)$/i.test(v);
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
    // #10689 B: `--shell=true`/`-s=true` também ligam o modo shell.
    if (/^(?:--shell|-s)(?:=|$)/.test(w)) shell = shellFlagValue(w);
    else if (w.startsWith("-") && w !== "-") continue;
    else positional.push(w);
  }
  const [name, expansion] = positional;
  if (typeof name !== "string") return;
  if (isExpanded(name)) {
    // `gh alias set "$N" 'pr merge'`: o nome só existe em execução.
    env.importSeen = true;
    return;
  }
  // #10689 A: expansão vinda do shell (`"$X"`, `$X`, `$(…)`) é ilegível.
  if (typeof expansion !== "string" || expansion === "-" || isExpanded(expansion)) {
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
  if (depth > MAX_DEPTH) {
    out.push(opaqueInvocation("depth")); // #10689 N: fundo demais conta como merge
    return;
  }
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
// #10777: `cd <worktree> && ` antes do comando — a forma padrão dos
// subagentes (o cwd é resetado a cada chamada). O caminho é um SIMPLE_ARG
// (sem `$`, crase, `\` nem aspas abertas): o `cd` não executa nada além de
// trocar de diretório. Wrapper/env (`env X=1 git commit …`) segue fora da
// whitelist (fail-closed: o corpo é lido como comandos).
const CD_PREFIX = `(?:cd ${SIMPLE_ARG} && )?`;
/** #11325: destino de `cat > …` — um SIMPLE_ARG terminado em `.md`/`.txt`. */
const TEXT_FILE = String.raw`(?:[A-Za-z0-9_./:@=+,%-]+\.(?:md|txt)|"[^"$\x60\\\n]*\.(?:md|txt)"|'[^'\n]*\.(?:md|txt)')`;
// #11501: o caso real do falso positivo — `S=<scratchpad>; cat > $S/x.md <<'EOF'`
// seguido de `gh issue create … --body-file $S/x.md`, com o corpo citando
// `gh pr merge` entre crases. Aceita, SÓ nas formas `cat` (o corpo vai pra um
// ARQUIVO), (1) atribuições literais antes (`NOME=<SIMPLE_ARG>; ` ou ` && `:
// valor sem `$`/crase, só define variável) e (2) referência simples a
// variável (`$NOME`, `${NOME}`, nunca `$(`, `${x:-…}` nem crase) no caminho
// do arquivo e nos argumentos do consumidor. Expansão de variável não executa
// nada: no redirect vira só o nome do arquivo (`.md`/`.txt` continua exigido)
// e no consumidor (que só LÊ texto) vira argumento.
const VAR_REF = String.raw`\$(?:[A-Za-z_][A-Za-z0-9_]*|\{[A-Za-z_][A-Za-z0-9_]*\})`;
// Review da #11510: uma atribuição é uma variável de shell ANTES do consumidor —
// `GIT_EDITOR='sh x.md'; cat > x.md <<'EOF' … EOF` + `git commit` faria o git
// executar o corpo do heredoc. Por isso (1) nomes que mudam o que um
// consumidor executa (GIT_*, GH_*, LD_*, EDITOR, VISUAL, PATH, HOME,
// NODE_OPTIONS, BASH_ENV, ENV, IFS, SHELL, CDPATH) nunca casam, e (2) com
// atribuição presente o único consumidor aceito é `gh (pr|issue) …
// --body-file` (`catTail(true)`), nunca `git commit` nem `npx tsx`.
const SAFE_ASSIGN_NAME = String.raw`(?!(?:GIT_|GH_|LD_)|(?:EDITOR|VISUAL|PATH|HOME|NODE_OPTIONS|BASH_ENV|ENV|IFS|SHELL|CDPATH)=)[A-Za-z_][A-Za-z0-9_]*`;
const ASSIGN_PREFIX = `(?:${SAFE_ASSIGN_NAME}=${SIMPLE_ARG}(?:; | && ))+`;
const VAR_TEXT_FILE = String.raw`(?:(?:[A-Za-z0-9_./:@=+,%-]|${VAR_REF})+\.(?:md|txt)|"(?:[^"$\x60\\\n]|${VAR_REF})*\.(?:md|txt)"|'[^'\n]*\.(?:md|txt)')`;
const VAR_ARG = String.raw`(?:(?:[A-Za-z0-9_./:@=+,%-]|${VAR_REF})+|"(?:[^"$\x60\\\n]|${VAR_REF})*"|'[^'\n]*')`;
const VAR_ARGS = `(?: ${VAR_ARG})*`;
const HEAD_FORMS = [
  // git commit [flags] -F - <<'D' [&& git push ...]  →  depois do D, nada.
  { re: new RegExp(`^${CD_PREFIX}git commit${ARGS} -F - <<${DELIM}${GIT_PUSH}$`), tail: /^\s*$/ },
  // git commit [flags] -m "$(cat <<'D'  …  D  )" [flags] [&& git push ...]
  { re: new RegExp(`^${CD_PREFIX}git commit${ARGS} -m "\\$\\(cat <<${DELIM}$`), tail: new RegExp(`^\\)"${ARGS}${GIT_PUSH}\\s*$`) },
  // gh pr create|pr comment|issue comment|issue create … --body "$(cat <<'D'  …  D  )" …
  {
    re: new RegExp(`^${CD_PREFIX}gh (?:pr create|pr comment|issue comment|issue create)${ARGS} --body "\\$\\(cat <<${DELIM}$`),
    tail: new RegExp(`^\\)"${ARGS}\\s*$`),
  },
  // #11325: gh pr|issue comment|create|edit … --body-file - <<'D'  →  depois do D, nada.
  {
    re: new RegExp(`^${CD_PREFIX}gh (?:pr|issue) (?:comment|create|edit)${ARGS} --body-file - <<${DELIM}$`),
    tail: /^\s*$/,
  },
  // #11325: cat <<'D' > ARQ  /  cat > ARQ <<'D'  (também `>>`) — o corpo vai
  // pra um ARQUIVO, nunca pra um shell. Depois do D: nada, ou UM consumidor
  // de texto (abaixo). Executar o arquivo na mesma chamada (`bash ARQ`,
  // `. ARQ`, `| sh`) não casa e segue fail-closed. ARQ só `.md`/`.txt`: os
  // consumidores executam código do repo (`scripts/*.ts`, hooks do git,
  // `tsconfig.json`/`package.json`) — sobrescrever um deles e rodá-lo na
  // mesma chamada seria bypass.
  // #11501: `$NOME` no caminho (ver VAR_REF); `NOME=valor; ` antes só com
  // consumidor `gh … --body-file` (ver SAFE_ASSIGN_NAME).
  { re: new RegExp(`^${CD_PREFIX}cat <<${DELIM} ?>>? ?${VAR_TEXT_FILE}$`), tail: catTail(false) },
  { re: new RegExp(`^${CD_PREFIX}cat ?>>? ?${VAR_TEXT_FILE} <<${DELIM}$`), tail: catTail(false) },
  { re: new RegExp(`^${ASSIGN_PREFIX}${CD_PREFIX}cat <<${DELIM} ?>>? ?${VAR_TEXT_FILE}$`), tail: catTail(true) },
  { re: new RegExp(`^${ASSIGN_PREFIX}${CD_PREFIX}cat ?>>? ?${VAR_TEXT_FILE} <<${DELIM}$`), tail: catTail(true) },
];

/**
 * Fecho aceito depois de um `cat <<'D' > ARQ` (#11325), contado a partir da
 * linha seguinte ao D: vazio, ou UMA linha com um comando que só LÊ o arquivo
 * como texto (helper de review/corpo de PR, `gh pr|issue comment|create|edit`,
 * `git commit [&& git push]`), com `cd X && ` opcional e argumentos simples
 * (sem `$`, crase, `\` nem aspas abertas).
 * `afterAssign`: houve `NOME=valor; ` antes do `cat` — aí só `gh (pr|issue)
 * (comment|create|edit) … --body-file …` (review da #11510).
 */
function catTail(afterAssign) {
  const consumer = afterAssign
    ? `gh (?:pr|issue) (?:comment|create|edit)${VAR_ARGS} --body-file${VAR_ARGS}`
    : `(?:npx tsx scripts/gh-pr-review-api\\.ts|npx tsx scripts/lib/gh-pr-safe-edit\\.ts|` +
      `gh (?:pr|issue) (?:comment|create|edit))${VAR_ARGS}|git commit${VAR_ARGS}${GIT_PUSH}`;
  return new RegExp(`^\\s*(?:${CD_PREFIX}(?:${consumer})\\s*)?$`);
}

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
 * aparecem; cada item é um objeto da união discriminada `via` (#10751 —
 * `pr-merge`/`api-rest`/`api-graphql`/`opaque`, descrita no topo do módulo).
 * Só `pr-merge` pode sair do modo estrito (`requiresStrict`).
 *
 * `opts.aliases`: `Map<nome, expansão>` dos aliases do gh — default: os do
 * `config.yml` do gh (`loadGhAliases`). Testes passam um Map explícito; um
 * valor que não é Map é erro de programação (`TypeError`), nunca "sem aliases".
 * `opts.onDiagnostic(kind, details)`: chamado quando o config do gh não pôde
 * ser lido por inteiro (`gh_alias_config_unreadable`/`gh_alias_config_unparsed`).
 */
export function findGhPrMergeInvocations(command, opts = {}) {
  const out = [];
  if (typeof command !== "string") return out;
  if (opts?.aliases !== undefined && !(opts.aliases instanceof Map)) {
    throw new TypeError("findGhPrMergeInvocations: opts.aliases precisa ser um Map (ou ausente)");
  }
  const onDiagnostic = typeof opts?.onDiagnostic === "function" ? opts.onDiagnostic : null;
  // Lazy: o consumidor de concessão roda depois de TODO Bash — o config do gh
  // só é lido quando aparece um `gh <subcomando não-builtin>`.
  let aliases = opts?.aliases ?? null;
  const env = {
    get aliases() {
      if (aliases === null) {
        aliases = loadGhAliases();
        if (onDiagnostic && aliases.loadError) onDiagnostic("gh_alias_config_unreadable", aliases.loadError);
        if (onDiagnostic && aliases.unparsed) onDiagnostic("gh_alias_config_unparsed", { lines: aliases.unparsed.length });
      }
      return aliases;
    },
    local: new Map(),
    importSeen: false,
    configOverridden: CONFIG_OVERRIDE_RES.some((re) => re.test(command)),
  };
  collect(command, 0, out, { skipHeredocData: isHeredocDataCommand(command) }, env);
  return out;
}

/** `true` se `command` executa um merge de PR (ver limites no topo). */
export function isGhPrMergeCommand(command, opts = {}) {
  return findGhPrMergeInvocations(command, opts).length > 0;
}

/**
 * Número da PR alvo da ÚLTIMA invocação de merge (#6303 Finding S) — de
 * `gh pr merge`, de `gh api …/pulls/N/merge` ou de um alias expandido: o
 * primeiro argumento todo-dígitos que não seja valor de uma flag (`--body
 * "100 dias"`, `--subject 5`, `-R o/r`). `undefined` quando a invocação não
 * traz número (o gh infere a PR pela branch; mutation GraphQL; caminho
 * opaco) ou não há merge nenhum. Fachada compatível sobre a união (#10751).
 */
export function extractGhPrMergeTargetPr(command, opts = {}) {
  const all = findGhPrMergeInvocations(command, opts);
  if (all.length === 0) return undefined;
  return invocationTargetPr(all[all.length - 1]);
}

/** Nº da PR de UMA invocação (`undefined` = não legível). */
export function invocationTargetPr(inv) {
  switch (inv?.via) {
    case "api-rest":
      return inv.pr ?? undefined;
    case "api-graphql":
      return undefined;
    case "pr-merge":
    case "opaque":
      return prFromMergeArgs(inv.args);
    default:
      return undefined;
  }
}

/** 1º argumento todo-dígitos que não seja valor de flag, no formato de `gh pr merge`. */
function prFromMergeArgs(args) {
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

const PR_URL_RE = /^https?:\/\/(?:www\.)?github\.com\/([^/]+\/[^/]+)\/pull\/\d+/i;

/**
 * Repos que as invocações de merge de `command` miram (#10689 M), pro modo
 * ESTRITO de `resolveMergeTargets`: `repos` = os `-R`/`--repo`/URL de PR
 * legíveis; `unknown` = alguma invocação tem o repo indeterminado (GraphQL por
 * `pullRequestId`, caminho opaco, alias ilegível, `-R "$R"`, URL/PR vinda de
 * expansão, `GH_REPO=$X`) — aí quem chama confere o lock de TODO repo permitido.
 * O repo do diretório (sem `-R`) não entra aqui: `resolveMergeTargets` já o lê.
 */
export function mergeTargetHints(command, opts = {}) {
  const repos = new Set();
  let unknown = false;
  const invocations = findGhPrMergeInvocations(command, opts);
  if (invocations.length > 0 && /GH_REPO\+?=["']?(?:\$|`)/.test(String(command))) unknown = true;
  for (const inv of invocations) {
    switch (inv.via) {
      case "api-graphql":
        unknown = true; // `pullRequestId` não diz o repo
        continue;
      case "api-rest":
        if (inv.repo.kind === "unknown") unknown = true;
        else if (inv.repo.kind === "literal") {
          if (isOpaque(inv.repo.slug)) unknown = true;
          else repos.add(inv.repo.slug);
        }
        continue; // `cwd`: o repo do diretório, que `resolveMergeTargets` já lê
      case "opaque":
        unknown = true;
        break; // os `args` legíveis ainda podem citar repos
      case "pr-merge":
        break;
      default:
        unknown = true; // forma desconhecida: fail-closed
        continue;
    }
    const args = inv.args;
    for (let k = 0; k < args.length; k++) {
      const a = args[k];
      let value = null;
      if (a === "-R" || a === "--repo") {
        value = args[k + 1] ?? SUBST;
        k++;
      } else if (a.startsWith("--repo=")) value = a.slice(7);
      else if (/^-R./.test(a)) value = a.slice(2).replace(/^=/, "");
      else if (MERGE_VALUE_FLAGS.has(a)) {
        k++; // valor de --body/--subject/…: não é PR nem repo
        continue;
      } else if (!a.startsWith("-")) {
        const url = PR_URL_RE.exec(a);
        if (url) value = url[1];
        else if (isOpaque(a)) unknown = true; // `gh pr merge "$URL"`: pode ser PR de outro repo
        continue;
      } else continue;
      if (isOpaque(value)) unknown = true;
      else repos.add(value);
    }
  }
  return { repos: [...repos], unknown };
}
