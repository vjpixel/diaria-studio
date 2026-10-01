// PreToolUse hook — recusa laço `until`/`while`/`for` escrito à mão em torno
// de `gh pr checks` (#9161), apontando pra `scripts/lib/wait-pr-checks.sh`.
//
// Incidente de origem (#9161, 30/09/2026): `watch-continuo-health.sh` achou
// 3 laços `until gh pr checks N --json bucket --jq '...' | grep -q true; do
// sleep 30; done` vivos há 103-242min, vigiando PRs (#9130, #9147) JÁ
// mergeadas. Dois deles usavam `--jq 'all(.bucket!="pending")'` — filtro
// inválido sobre array, o jq falha, `2>/dev/null` engole o erro e a condição
// de saída NUNCA pode ser satisfeita. Mesma classe do #6921 (5 laços `while
// true` órfãos por até 15h) e do #8425 (laço `until` órfão 5h+). O helper
// com teto de vida já existe desde o #6921 — o que faltava era um guard
// mecânico: a disciplina "use o helper" em prosa não segurou 3 incidentes.
//
// Escopo: só o laço de polling ESCRITO À MÃO (palavra-chave de laço no
// início de um segmento + `sleep` + `gh pr checks` no mesmo comando — ver
// `commandHasHandwrittenPrChecksLoop` pros trade-offs).
// `gh pr checks N` pontual e `gh pr checks N --watch` passam — o problema é
// a condição de saída artesanal, não o comando.
//
// Self-contained (nenhum import de `scripts/*.ts`) — mesma razão dos hooks
// irmãos: import estático de `.ts` quebra o hook inteiro, em silêncio, num
// Node sem type-stripping nativo. `stripQuotedSpans`/`stripHeredocSpans`
// duplicados de `block-worktree-bare-push.mjs` pelo mesmo motivo (paridade
// travada em `test/hook-command-tokenizer-parity-7896.test.ts`) — assim um
// `gh issue comment --body "..."`/heredoc que CITE o laço não é bloqueado.

import { pathToFileURL } from "node:url";

/** Remove o CONTEÚDO de spans entre aspas (simples ou duplas). */
export function stripQuotedSpans(command) {
  let result = "";
  let i = 0;
  const n = command.length;
  while (i < n) {
    const ch = command[i];
    // `\x` fora de aspas é caractere literal (`don\'t`), não abre span —
    // sem isto a aspa escapada engolia o resto do comando (#9197).
    if (ch === "\\" && i + 1 < n) {
      // `\<newline>` é continuação de linha: o shell junta as duas linhas
      // (`git \<nl>push` = `git push`), então some sem virar separador (#9214).
      if (command[i + 1] !== "\n") result += command.slice(i, i + 2);
      i += 2;
      continue;
    }
    // ANSI-C quoting (`$'don\'t'`): dentro dele `\'` é escape, ao contrário
    // da aspa simples comum — sem isto o scanner fechava o span cedo (#9214).
    if (ch === "$" && command[i + 1] === "'") {
      let j = i + 2;
      while (j < n && command[j] !== "'") {
        if (command[j] === "\\") j++;
        j++;
      }
      i = j + 1;
      continue;
    }
    if (ch === "'") {
      let j = i + 1;
      while (j < n && command[j] !== "'") j++;
      i = j + 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      while (j < n && command[j] !== '"') {
        if (command[j] === "\\") j++;
        j++;
      }
      i = j + 1;
      continue;
    }
    result += ch;
    i++;
  }
  return result;
}

/** Remove o CORPO de heredocs, preservando a linha de abertura. */
export function stripHeredocSpans(command) {
  if (typeof command !== "string") return command;
  // `(?<!<)`: `<<<` é here-string, não heredoc — sem o lookbehind o 2º `<`
  // casava `<<palavra` e engolia o resto do comando (#9197).
  const startRe = /(?<!<)<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/g;
  let result = "";
  let lastIndex = 0;
  let m;
  while ((m = startRe.exec(command)) !== null) {
    if (m.index < lastIndex) continue;
    if (insideArithmetic(command, m.index)) continue; // `$((a<<b))` é shift, não heredoc (#9214)
    const delim = m[2];
    const isDashVariant = m[0].startsWith("<<-");
    const markerEnd = m.index + m[0].length;
    const lineEnd = command.indexOf("\n", markerEnd);
    if (lineEnd === -1) {
      result += command.slice(lastIndex);
      lastIndex = command.length;
      break;
    }
    const bodyStart = lineEnd + 1;
    const terminatorRe = new RegExp(`^${isDashVariant ? "[ \\t]*" : ""}${delim}[ \\t]*$`, "m");
    const termMatch = terminatorRe.exec(command.slice(bodyStart));
    const stripEnd = termMatch ? bodyStart + termMatch.index + termMatch[0].length : command.length;
    result += command.slice(lastIndex, lineEnd + 1);
    lastIndex = stripEnd;
    startRe.lastIndex = stripEnd;
  }
  result += command.slice(lastIndex);
  return result;
}

// `&` e crase também separam (fix de review #9187): `cmd & until ...` e
// `` `gh pr checks` `` não podem esconder o laço dentro de outro token.
const SEPARATOR_RE = /(?:&&|;|\|\||\||&|`|\n|\(|\)|\{|\})/;
const LOOP_KEYWORDS = new Set(["until", "while", "for"]);
// Palavras reservadas/prefixos que podem PRECEDER o laço no mesmo segmento
// (`then while ...`, `time until ...`, `! until ...`, `nohup ...`).
const LEADING_PREFIXES = new Set(["then", "else", "elif", "do", "time", "!", "nohup", "exec", "command"]);
// Aspas logo depois de `bash -c`/`sh -c`/`eval` são código vivo, não texto.
const SHELL_C_BEFORE_QUOTE_RE = /(?:^|[\s;&|(])(?:(?:\/[\w./-]*\/)?(?:ba|z|da)?sh\s+(?:-\w+\s+)*-\w*c|eval)\s*$/;

/**
 * Separa o que o shell EXECUTA do que é só texto (fix de review #9187).
 * Devolve `outer` (o comando sem o conteúdo das aspas, como
 * `stripQuotedSpans`) + `subs`: trechos que, apesar de estarem entre aspas,
 * são código vivo — `$(...)`/crase dentro de aspas DUPLAS (o bash expande)
 * e o argumento entre aspas de `bash -c`/`sh -c`/`eval`. Fora desses casos,
 * aspas seguem sendo texto (citação em `gh issue comment --body '...'`).
 */
export function splitLiveCode(command) {
  let outer = "";
  const subs = [];
  let i = 0;
  const n = command.length;
  while (i < n) {
    const ch = command[i];
    if (ch === "\\" && i + 1 < n) {
      outer += command.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < n && command[j] !== ch) {
        if (ch === '"' && command[j] === "\\") j++;
        j++;
      }
      const body = command.slice(i + 1, j);
      if (SHELL_C_BEFORE_QUOTE_RE.test(outer)) subs.push(body);
      else if (ch === '"') subs.push(...commandSubstitutions(body));
      i = j + 1;
      continue;
    }
    outer += ch;
    i++;
  }
  return { outer, subs };
}

/** Corpos de `$(...)` (com aninhamento) e de crase dentro de `text`. */
function commandSubstitutions(text) {
  const out = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\\") {
      i++; // `\$(`/`` \` `` escapados são texto literal
      continue;
    }
    if (text[i] === "$" && text[i + 1] === "(") {
      let depth = 1;
      let j = i + 2;
      while (j < text.length && depth > 0) {
        if (text[j] === "(") depth++;
        else if (text[j] === ")") depth--;
        j++;
      }
      out.push(text.slice(i + 2, depth === 0 ? j - 1 : j));
      i = j - 1;
    } else if (text[i] === "`") {
      const j = text.indexOf("`", i + 1);
      const end = j === -1 ? text.length : j;
      out.push(text.slice(i + 1, end));
      i = end;
    }
  }
  return out;
}

/** Todos os segmentos de código vivo do comando, recursivamente. */
function liveSegments(command, depth = 0) {
  if (typeof command !== "string" || depth > 4) return [];
  const { outer, subs } = splitLiveCode(stripHeredocSpans(command));
  const segments = outer
    .split(SEPARATOR_RE)
    .map((seg) => seg.trim().split(/\s+/).filter(Boolean))
    .filter((tokens) => tokens.length > 0);
  for (const sub of subs) segments.push(...liveSegments(sub, depth + 1));
  return segments;
}

function dropLeadingPrefixes(tokens) {
  let k = 0;
  while (k < tokens.length && LEADING_PREFIXES.has(tokens[k])) k++;
  return tokens.slice(k);
}

function segmentHasGhPrChecks(tokens) {
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] !== "gh" && !tokens[i].endsWith("/gh")) continue;
    let k = i + 1;
    // flags globais do gh antes do subcomando (`gh -R owner/repo pr checks`)
    while (k < tokens.length && tokens[k].startsWith("-")) {
      k += tokens[k] === "-R" || tokens[k] === "--repo" ? 2 : 1;
    }
    if (tokens[k] === "pr" && tokens[k + 1] === "checks") return true;
  }
  return false;
}

const isSleep = (t) => t === "sleep" || t.endsWith("/sleep");

/**
 * `true` quando o comando tem um laço de POLLING escrito à mão: palavra-chave
 * de laço (`until`/`while`/`for`, após prefixos como `then`/`time`/`!`) no
 * início de algum segmento, um `sleep` e um `gh pr checks` — contando o
 * código vivo dentro de `$(...)`, crase e `bash -c '...'`/`eval`, e
 * ignorando texto citado em aspas/heredoc.
 *
 * Trade-offs aceitos, deliberadamente enviesados pra BLOQUEAR: as três peças
 * são procuradas no comando inteiro, não só entre o laço e o seu `done`
 * (`for ...; done; sleep 5; gh pr checks 1` é bloqueado), e um laço finito
 * com pausa (`for pr in 1 2; do gh pr checks $pr; sleep 2; done`) também. O
 * custo de um falso positivo é reescrever com `wait-pr-checks.sh` ou separar
 * em duas chamadas; o de um falso negativo é um processo órfão por horas.
 * Exigir o `sleep` deixa passar o laço de disparo único sem pausa.
 */
export function commandHasHandwrittenPrChecksLoop(command) {
  const segments = liveSegments(command);
  if (!segments.some((t) => LOOP_KEYWORDS.has(dropLeadingPrefixes(t)[0]))) return false;
  if (!segments.some((t) => t.some(isSleep))) return false;
  return segments.some(segmentHasGhPrChecks);
}

export const HANDWRITTEN_PR_CHECKS_LOOP_BLOCK_REASON =
  "Laço `until`/`while`/`for` escrito à mão em torno de `gh pr checks` bloqueado (#9161). Laços assim " +
  "não têm teto de vida e já ficaram órfãos por horas vigiando PRs mergeadas (#6921, #8425, #9161) — " +
  "um `--jq` inválido com `2>/dev/null` torna a condição de saída impossível. Use " +
  "`scripts/lib/wait-pr-checks.sh <PR> [timeout_secs=1800] [poll_secs=20]` (teto de vida embutido; " +
  "exit 0 = saiu de pending, 1 = timeout, 2 = uso inválido, 3 = erro persistente do gate, " +
  "6 = gh incompatível — ver o cabeçalho do script) e depois leia o resultado com " +
  "`gh pr checks <PR>` pontual.";

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  // #9197: path com espaço/não-ASCII chega percent-encoded em import.meta.url
  (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) ||
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  let data = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => (data += chunk));
  process.stdin.on("end", () => {
    try {
      const payload = JSON.parse(data || "{}");
      if (payload.tool_name && payload.tool_name !== "Bash") return;
      const command = payload.tool_input?.command;
      if (typeof command !== "string") return;
      if (!commandHasHandwrittenPrChecksLoop(command)) return;
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: HANDWRITTEN_PR_CHECKS_LOOP_BLOCK_REASON,
          },
        }),
      );
    } catch {
      // Fail-open, sempre: um hook quebrado não pode travar Bash legítimo.
    }
  });
}

/** true quando `index` cai dentro de `((...))`/`$((...))` aberto na mesma
 * linha — ali `<<` é shift aritmético, não heredoc (#9214). Usado por
 * `stripHeredocSpans`; cópia idêntica nos hooks irmãos (paridade travada em
 * `test/hook-command-tokenizer-parity-7896.test.ts`). */
function insideArithmetic(command, index) {
  const lineStart = command.lastIndexOf("\n", index - 1) + 1;
  const before = command.slice(lineStart, index);
  const open = before.lastIndexOf("((");
  return open !== -1 && before.indexOf("))", open) === -1;
}
