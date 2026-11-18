// Detector de `gh pr create` compartilhado pelos guards PreToolUse de
// `gh pr create` (`block-pr-create-pii-runtime-artifacts.mjs`,
// `block-pr-create-test-runner-import.mjs`,
// `block-pr-create-orchestrator-snapshot-stale.mjs`,
// `block-pr-create-tsc-failure.mjs`) e pelo review automático PostToolUse
// (`pr-create-review.mjs`) — #13550.
//
// ANTES: os dois hooks tinham, cada um, um regex sobre `stripQuotedSpans` que
// só aceitava `gh pr create` no início da string ou logo depois de `&&`/`;`/
// `|`/`||`/newline. Qualquer prefixo que o shell executa normalmente tirava o
// comando do guard, em silêncio:
//   GH_TOKEN=x gh pr create             (atribuição de ambiente)
//   cd wt && GH_REPO=a/b gh pr create
//   env FOO=1 gh pr create / command gh pr create / time … / nohup …
//   make & FOO=1 gh pr create           (separador `&`)
//   (FOO=1 gh pr create) / { gh pr create; } / $(gh pr create)
//   gh -R o/r pr create                 (flag global antes do subcomando)
// No PreToolUse isso pulava o guard de PII/artefato de runtime, o de
// typecheck, o de import de test runner e o de snapshot do orchestrator; no
// PostToolUse a PR saía sem o review automático que o auto-merge do #5251
// pressupõe.
//
// AGORA: o comando passa pelo mesmo lexer do detector de `gh pr merge`
// (`parseShellCommands`, `gh-pr-merge-command.mjs`, #10681), que devolve os
// COMANDOS SIMPLES (palavras já sem aspas), e cada um é lido pela posição de
// comando: pula atribuições, palavras reservadas (`!`, `{`, `if`, …) e
// wrappers (`env`, `command`, `exec`, `nohup`, `nice`, `time`, `timeout`,
// `sudo`, `xargs`, `stdbuf`), desce em `bash -c '…'`/`eval …`/`env -S '…'`,
// exige `gh` (ou caminho terminado em `/gh`) como palavra de comando, pula as
// flags globais do gh e só então reconhece `pr create`.
//
// `gh pr create` citado entre aspas continua NÃO contando (`--body "rode gh pr
// create"` é UMA palavra, nunca a palavra de comando). Corpo de heredoc é lido
// como comandos (fail-closed, como o lexer faz para o merge): uma linha do
// corpo que comece por `gh pr create` conta — o mesmo que o regex antigo já
// fazia ao tratar newline como separador.
//
// Nunca reconhece MENOS que o regex antigo: `legacyAnchoredMatch` continua
// valendo junto (o OR é a garantia de não-regressão dos guards PreToolUse).
//
// LIMITES (iguais aos do detector de merge): alias/função de shell, expansão
// na posição de comando (`$GH pr create`), alias do gh (`gh pc`), script em
// arquivo (`bash x.sh`).

import {
  ASSIGNMENT_RE,
  RESERVED_PREFIX,
  SHELLS,
  WRAPPERS,
  parseShellCommands,
  shellDashCScript,
} from "./gh-pr-merge-command.mjs";
import { stripQuotedSpans } from "./shell-quote-strip.mjs";

/** Teto de aninhamento (`bash -c "eval '…'"`) — além dele, não reconhece. */
const MAX_DEPTH = 6;

/** Flags globais do `gh` que consomem a palavra seguinte. */
const GH_VALUE_FLAGS = new Set(["-R", "--repo", "--hostname"]);

const basename = (w) => w.split(/[\\/]/).pop() ?? w;

/** `gh` como palavra de comando: `gh`, `gh.exe`, ou caminho terminado nisso. */
function isGhWord(w) {
  return /^gh(\.exe)?$/i.test(basename(w));
}

/** O regex de antes do #13550 (âncora no início ou depois de `&&`/`;`/`|`/`||`/newline). */
export function legacyAnchoredMatch(command) {
  if (typeof command !== "string") return false;
  return /^\s*gh\s+pr\s+create\b|(?:&&|;|\|\||\||\n)\s*gh\s+pr\s+create\b/.test(stripQuotedSpans(command));
}

/** Pula flags do gh a partir de `i` (as de `GH_VALUE_FLAGS` levam a próxima palavra). */
function skipGhFlags(args, i) {
  while (i < args.length && args[i].startsWith("-") && args[i] !== "-") {
    i += GH_VALUE_FLAGS.has(args[i]) ? 2 : 1;
  }
  return i;
}

/** `args` (o que vem depois de `gh`) é `pr create`, com flags globais em qualquer ponto? */
function ghArgsArePrCreate(args) {
  let i = skipGhFlags(args, 0);
  if (args[i] !== "pr") return false;
  i = skipGhFlags(args, i + 1);
  return args[i] === "create";
}

/**
 * Um comando simples (lista de palavras) executa `gh pr create`? Desce em
 * wrappers, `bash -c`, `eval` e `env -S`.
 */
function wordsRunPrCreate(words, depth) {
  let i = 0;
  for (;;) {
    for (;;) {
      if (i < words.length && (ASSIGNMENT_RE.test(words[i]) || RESERVED_PREFIX.has(words[i]))) i++;
      else if (words[i] === "function") i += 2;
      else if (words[i] === "coproc") i++;
      else break;
    }
    if (i >= words.length) return false;
    const name = basename(words[i]).replace(/\.exe$/i, "");
    if (name === "eval") return commandRunsPrCreate(words.slice(i + 1).join(" "), depth + 1);
    if (SHELLS.has(name)) {
      const script = shellDashCScript(words, i + 1);
      return script !== null && commandRunsPrCreate(script, depth + 1);
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
      if (name === "command" && (w === "-v" || w === "-V")) return false; // só consulta
      if (w.startsWith("-") && w.length > 1) {
        const flag = w.includes("=") ? w.slice(0, w.indexOf("=")) : w;
        // `env -S 'gh pr create'` / `--split-string=…`: a string vira o comando.
        // Cluster de flags curtas com S (`env -iS 'gh pr create'`) e valor
        // colado (`env -S'gh pr create'` → palavra `-Sgh pr create`): o S
        // consome o resto do cluster ou, vazio, a próxima palavra — mesmo
        // tratamento de `shortS` do detector de merge.
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
          if (typeof value === "string" && commandRunsPrCreate(value, depth + 1)) return true;
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
  if (i >= words.length || !isGhWord(words[i])) return false;
  return ghArgsArePrCreate(words.slice(i + 1));
}

function commandRunsPrCreate(command, depth) {
  if (depth > MAX_DEPTH) return false;
  return parseShellCommands(command, depth).some((words) => wordsRunPrCreate(words, depth));
}

/**
 * `true` quando `command` executa `gh pr create` em posição de comando —
 * inclusive com atribuições de ambiente, wrappers, subshell, `&` ou flags
 * globais do gh na frente (#13550). Não-string → `false`.
 */
export function runsGhPrCreate(command) {
  if (typeof command !== "string") return false;
  return legacyAnchoredMatch(command) || commandRunsPrCreate(command, 0);
}
