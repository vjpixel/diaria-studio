// PreToolUse hook — recusa `git push` sem remote+refspec EXPLÍCITOS quando a
// chamada roda dentro de um worktree VINCULADO (#7722, item 1 do escopo
// proposto na issue — "pagam mais rápido").
//
// Incidente de origem (09/09/2026, medido ao vivo 2×): outra sessão adotou
// um worktree que não era dela e trocou a branch por baixo (`git checkout
// master` no meio de um worktree que tinha `fix/7707-7708-...` checked out).
// A sessão DONA do worktree, sem saber disso, rodou `git push` (bare) — o
// HEAD do worktree já não era mais a branch que ela pensava, e o push, sobre
// a branch ERRADA (que por acaso já estava em dia com o remoto), respondeu
// `Everything up-to-date`. **Sucesso reportado, nada empurrado** — os
// commits da sessão dona nunca saíram do worktree local.
//
// `git push` bare depende inteiramente de qual branch está checked out NO
// MOMENTO da chamada — e um worktree, ao contrário de uma sessão de
// terminal isolada, pode ter a branch trocada por baixo por OUTRO processo
// (mesma máquina, mesmo checkout físico, `.git` é só um ARQUIVO apontando
// pro repo principal — nada no worktree em si impede outra sessão de rodar
// comandos ali). Exigir `git push <remote> <refspec>` explícito remove essa
// ambiguidade estruturalmente: mesmo que o HEAD do worktree tenha sido
// trocado por baixo, `git push origin <branch>` push a branch NOMEADA (ela
// não precisa nem estar checked out — `git push` aceita qualquer ref local
// válido), não "o que HEAD apontar for".
//
// Escopo deliberadamente restrito ao item 1 da issue (#7722) — não
// implementa os itens 2-4 (correção do `startDir` do beacon pra refletir o
// worktree real, claim de worktree, guard de `git commit`), que ficam como
// follow-up. Este guard sozinho já elimina o modo de falha SILENCIOSO
// descrito no incidente (push que reporta sucesso sem empurrar nada) — não
// impede a troca de branch em si (isso seria o item 3), só força que
// qualquer `push` subsequente nomeie explicitamente o que está sendo
// empurrado.
//
// Fora de escopo, de propósito: `git push` no checkout PRINCIPAL (não é
// worktree — o padrão de trabalho ali já é diferente, e o guard mira
// especificamente o cenário "worktree compartilhável entre sessões" descrito
// na issue); `git push --tags`/`--all`/`--mirror` (não dependem de qual
// branch está checked out — a ambiguidade que este guard existe pra fechar
// não se aplica).
//
// Self-contained (nenhum import de `scripts/*.ts`) — mesma razão documentada
// nos hooks irmãos (`block-branch-checkout-main.mjs`,
// `block-unsafe-shared-checkout-ops.mjs`): import estático de `.ts` quebra
// o hook inteiro, em silêncio, num Node sem type-stripping nativo.
//
// Detecção de "é worktree": mesmo mecanismo de `block-branch-checkout-
// main.mjs` — deriva a raiz a partir de ONDE ESTE ARQUIVO MORA
// (`import.meta.url`), não do `cwd` do payload (que os hooks não recebem).
// Cada worktree de subagente (`isolation: "worktree"`) tem sua PRÓPRIA cópia
// deste arquivo sob `<worktree>/.claude/hooks/`, então o hook que roda ali
// sempre resolve a raiz PARA O PRÓPRIO worktree.

import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Remove o CONTEÚDO de spans entre aspas (simples ou duplas), preservando
 * tudo fora deles. Duplicado dos hooks irmãos (self-contained).
 */
export function stripQuotedSpans(command) {
  let result = "";
  let i = 0;
  const n = command.length;
  while (i < n) {
    const ch = command[i];
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

const SEPARATOR_RE = /(?:&&|;|\|\||\||\n)/;

/**
 * Remove o CORPO de heredocs (`<<EOF ... EOF`, `<<'EOF' ... EOF`,
 * `<<-EOF ... EOF`), preservando a linha de abertura. Duplicado de
 * `stripHeredocSpans` em `block-unsafe-shared-checkout-ops.mjs` (#7757) —
 * fix iteration 1 do #7767: este hook novo tinha `commandSegments` próprio
 * SEM essa correção, então um heredoc cujo corpo citasse a linha literal
 * `git push` (ex: corpo de um `gh issue comment`/`gh pr create --body-file`
 * documentando este mesmo hook) era detectado como push real — mesma
 * classe de falso-positivo do Modo 2 do #7757, reintroduzida por
 * duplicação em vez de reuso (self-contained hooks não importam um do
 * outro — cada um carrega sua própria cópia mínima).
 */
export function stripHeredocSpans(command) {
  if (typeof command !== "string") return command;
  const startRe = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/g;
  let result = "";
  let lastIndex = 0;
  let m;
  while ((m = startRe.exec(command)) !== null) {
    if (m.index < lastIndex) continue; // dentro de um heredoc já removido
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

function commandSegments(command) {
  if (typeof command !== "string") return [];
  const stripped = stripQuotedSpans(stripHeredocSpans(command));
  return stripped
    .split(SEPARATOR_RE)
    .map((seg) => seg.trim().split(/\s+/).filter(Boolean))
    .filter((tokens) => tokens.length > 0);
}

/** Flags que tornam `git push` independente de qual branch está checked out. */
const BRANCH_INDEPENDENT_FLAGS = new Set(["--tags", "--all", "--mirror"]);

/**
 * `true` quando o refspec (2º argumento não-flag de `git push`, ex:
 * `<branch>` em `git push origin <branch>`) ainda depende de HEAD — `HEAD`
 * puro, ou `HEAD:<algo>` (lado esquerdo do refspec é HEAD). Achado do
 * self-review (#7767): `git push origin <branch>` só fecha a ambiguidade
 * quando `<branch>` é um NOME de branch, não o símbolo `HEAD` — `git push
 * origin HEAD` reintroduz exatamente o problema que este guard existe pra
 * fechar (empurra o que HEAD apontar for no momento, não uma branch
 * nomeada).
 */
function refspecDependsOnHead(refspec) {
  const leftSide = refspec.split(":")[0];
  return leftSide.toUpperCase() === "HEAD";
}

/**
 * `true` quando `tokens` é um segmento `git push` SEM remote+refspec
 * explícitos — bare (`git push`), só remote (`git push origin`), só flags
 * (`git push -u`), ou refspec que ainda depende de HEAD (`git push origin
 * HEAD`, ver `refspecDependsOnHead`). `git push origin <branch-nomeada>`
 * (≥2 argumentos não-flag, refspec ≠ HEAD) sempre passa. `--tags`/`--all`/
 * `--mirror` também passam (não dependem de branch checked out).
 */
export function isBareGitPush(tokens) {
  if (tokens[0]?.toLowerCase() !== "git" || tokens[1]?.toLowerCase() !== "push") return false;
  const rest = tokens.slice(2);
  if (rest.some((t) => BRANCH_INDEPENDENT_FLAGS.has(t))) return false;
  const nonFlags = rest.filter((t) => !t.startsWith("-"));
  if (nonFlags.length < 2) return true;
  return nonFlags.slice(1).some(refspecDependsOnHead);
}

/** `true` se `command` contém algum `git push` bare (ver `isBareGitPush`). */
export function commandHasBareGitPush(command) {
  return commandSegments(command).some(isBareGitPush);
}

/** Duplicado de `isLinkedWorktree` dos hooks irmãos. */
function statIsDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function isLinkedWorktree(startDir) {
  try {
    const gitPath = join(startDir, ".git");
    if (!existsSync(gitPath)) return false;
    return !statIsDirectory(gitPath);
  } catch {
    return false;
  }
}

export const BARE_PUSH_IN_WORKTREE_BLOCK_REASON =
  "`git push` sem remote+refspec EXPLÍCITOS bloqueado dentro de worktree pelo guard mecânico do " +
  "overnight/develop (#7722, item 1) — um worktree pode ter a branch trocada por baixo por OUTRA " +
  "sessão (mesmo `.git` compartilhado do repo principal); um `git push` bare depende inteiramente de " +
  "qual branch está checked out NO MOMENTO da chamada, e se essa branch já estiver em dia com o " +
  "remoto (ex: por ter sido trocada pra `master`), o push responde 'Everything up-to-date' SEM " +
  "empurrar nada — sucesso silencioso, nenhum erro. Rode `git push origin <sua-branch>` (nomeando a " +
  "branch explicitamente): isso empurra a branch CERTA independente do que HEAD apontar for no " +
  "momento. `git push --tags`/`--all`/`--mirror` não são afetados (não dependem de branch checked " +
  "out) e passam normalmente. Ver context/overnight-dispatch-rules.md e a issue #7722 pro incidente " +
  "completo.";

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
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
      if (!commandHasBareGitPush(command)) return;
      const hookDir = dirname(fileURLToPath(import.meta.url));
      const checkoutRoot = join(hookDir, "..", "..");
      if (!isLinkedWorktree(checkoutRoot)) return; // fora de escopo: só worktree
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: BARE_PUSH_IN_WORKTREE_BLOCK_REASON,
          },
        }),
      );
    } catch {
      // Fail-open, sempre: um hook quebrado não pode travar Bash legítimo.
    }
  });
}
