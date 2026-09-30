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
// Escopo: só o laço de polling ESCRITO À MÃO (palavra-chave de laço como 1º
// token de um segmento + `sleep` + `gh pr checks` no mesmo comando).
// `gh pr checks N` pontual e `gh pr checks N --watch` passam — o problema é
// a condição de saída artesanal, não o comando.
//
// Self-contained (nenhum import de `scripts/*.ts`) — mesma razão dos hooks
// irmãos: import estático de `.ts` quebra o hook inteiro, em silêncio, num
// Node sem type-stripping nativo. `stripQuotedSpans`/`stripHeredocSpans`
// duplicados de `block-worktree-bare-push.mjs` pelo mesmo motivo — assim um
// `gh issue comment --body "..."`/heredoc que CITE o laço não é bloqueado.

/** Remove o CONTEÚDO de spans entre aspas (simples ou duplas). */
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

/** Remove o CORPO de heredocs, preservando a linha de abertura. */
export function stripHeredocSpans(command) {
  if (typeof command !== "string") return command;
  const startRe = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/g;
  let result = "";
  let lastIndex = 0;
  let m;
  while ((m = startRe.exec(command)) !== null) {
    if (m.index < lastIndex) continue;
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

const SEPARATOR_RE = /(?:&&|;|\|\||\||\n|\(|\)|\{|\})/;
const LOOP_KEYWORDS = new Set(["until", "while", "for"]);

function commandSegments(command) {
  if (typeof command !== "string") return [];
  return stripQuotedSpans(stripHeredocSpans(command))
    .split(SEPARATOR_RE)
    .map((seg) => seg.trim().split(/\s+/).filter(Boolean))
    .filter((tokens) => tokens.length > 0);
}

function segmentHasGhPrChecks(tokens) {
  for (let i = 0; i + 2 < tokens.length; i++) {
    if (tokens[i] === "gh" && tokens[i + 1] === "pr" && tokens[i + 2] === "checks") return true;
  }
  return false;
}

/**
 * `true` quando o comando tem um laço de POLLING escrito à mão: palavra-chave
 * de laço (`until`/`while`/`for`) como 1º token de algum segmento, um `sleep`
 * e um `gh pr checks`, todos fora de aspas/heredoc. Exigir o `sleep` deixa
 * passar laços de disparo único sobre uma lista (`for pr in 1 2; do gh pr
 * checks $pr; done`), que terminam sozinhos.
 */
export function commandHasHandwrittenPrChecksLoop(command) {
  const segments = commandSegments(command);
  if (!segments.some((t) => LOOP_KEYWORDS.has(t[0]))) return false;
  if (!segments.some((t) => t.includes("sleep"))) return false;
  return segments.some(segmentHasGhPrChecks);
}

export const HANDWRITTEN_PR_CHECKS_LOOP_BLOCK_REASON =
  "Laço `until`/`while`/`for` escrito à mão em torno de `gh pr checks` bloqueado (#9161). Laços assim " +
  "não têm teto de vida e já ficaram órfãos por horas vigiando PRs mergeadas (#6921, #8425, #9161) — " +
  "um `--jq` inválido com `2>/dev/null` torna a condição de saída impossível. Use " +
  "`scripts/lib/wait-pr-checks.sh <PR> [timeout_secs=1800] [poll_secs=20]` (teto de vida embutido; " +
  "exit 0 = saiu de pending, 1 = timeout, 3 = erro persistente) e depois leia o resultado com " +
  "`gh pr checks <PR>` pontual.";

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
