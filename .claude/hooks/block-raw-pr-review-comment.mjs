// PreToolUse hook (matcher Bash) — recusa comentário de review postado CRU por
// um subagente `dev-*` (implementador/fixer/revisor das rodadas autônomas),
// apontando pro `scripts/gh-pr-review-api.ts` (#11300).
//
// Incidente de origem (#11300, PR #11285, `/diaria-develop` 261027b): o
// `dev-implementador` postou os 4 comentários inline do self-review (#2038)
// por `gh api` à mão, SEM o marcador `<!-- diaria-auto-review -->`. Desde o
// #11269, `scripts/resolve-review-threads.ts` só resolve thread cujos
// comentários carregam o marcador — o resto é tratado como thread do editor:
// sai em `skipped` e o Gate 2 (`--check`) fica bloqueado. O helper
// `gh-pr-review-api.ts comment|reply` acrescenta o marcador sozinho; o item 7
// das regras de dispatch já mandava usá-lo, mas a regra em prosa não segurou.
// Mesmo padrão dos guards mecânicos do #5716 e do #9161.
//
// O que conta como comentário cru (só em comando VIVO — texto citado em aspas,
// `--body "..."` e corpo de heredoc não contam):
//   - `gh api` com método de escrita (explícito por `-X`/`--method`, ou
//     implícito por `-f`/`-F`/`--field`/`--raw-field`/`--input`) num endpoint
//     `…/pulls/N/comments[/ID/replies]`, `…/pulls/comments/ID` ou
//     `…/pulls/N/reviews[/…]` — GET passa (leitura de findings é legítima);
//   - `gh api graphql` com mutation que cria/edita comentário de review
//     (`addPullRequestReviewThread`, `addPullRequestReviewComment`,
//     `addPullRequestReview`, `submitPullRequestReview`,
//     `updatePullRequestReviewComment`);
//   - `gh pr review … --comment`/`-c` — comentário geral sai por
//     `gh pr comment` (item 7 das regras de dispatch).
//
// Escopo: só quando o payload traz `agent_type` começando por `dev-` (os
// agents dedicados do #9081). Sessão interativa, coordenador e qualquer
// harness que não envie `agent_type` → não bloqueia (fail-open, mesmo
// contrato de `block-writer-destaque-write-path.mjs`). O próprio helper chama
// `gh api` por `spawnSync`, fora do Bash do agente, então não passa por aqui.
//
// LIMITES CONHECIDOS (aceitos — o custo do falso negativo é atrito no Gate 2,
// com workaround, não dano): endpoint montado em variável opaca
// (`gh api "$URL" -f …`), query GraphQL lida de arquivo (`-F query=@q.graphql`),
// comando dentro de script em arquivo, e `bash <<EOF` com o comando no corpo
// do heredoc (o corpo é descartado antes da análise, pra não bloquear um
// `cat <<EOF > corpo.md` que CITE o comando).

import { pathToFileURL } from "node:url";
import { parseShellCommands } from "./lib/gh-pr-merge-command.mjs";
import { stripHeredocSpans } from "./block-handwritten-pr-checks-loop.mjs";

/** Prefixo dos agents dedicados das rodadas autônomas (#9081). */
export const DEV_AGENT_PREFIX = "dev-";

/** Marcadores internos do lexer de `gh-pr-merge-command.mjs` (expansões do shell). */
const MARKER_RE = /[\u0000-\u0004]/g;

const ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
const WRAPPERS = new Set(["env", "command", "exec", "sudo", "timeout", "nice", "nohup", "time", "stdbuf", "!"]);
const SHELLS = new Set(["bash", "sh", "zsh", "dash"]);

/** Flags do `gh api` que consomem a palavra seguinte. */
const API_VALUE_FLAGS = new Set([
  "-X", "--method", "-H", "--header", "-f", "--raw-field", "-F", "--field", "--input",
  "-q", "--jq", "-t", "--template", "--hostname", "-p", "--preview", "--cache",
]);

/** Endpoints REST de comentário/review de PR. */
const REVIEW_ENDPOINT_RE = /(?:^|\/)pulls\/(?:[^/?]+\/)?(?:comments|reviews)(?:[/?]|$)/;

const REVIEW_MUTATION_RE =
  /\b(?:addPullRequestReviewThread|addPullRequestReviewComment|addPullRequestReview|submitPullRequestReview|updatePullRequestReviewComment)\b/;

const isGh = (w) => w === "gh" || w.endsWith("/gh");

/** Índice do `gh` na posição de comando (após atribuições/wrappers), ou -1. */
function ghIndex(words) {
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (isGh(w)) return i;
    if (ASSIGNMENT_RE.test(w) || WRAPPERS.has(w)) continue;
    // argumento de wrapper (`timeout 30`, `nice -n 5`, `env -i`)
    if (i > 0 && (w.startsWith("-") || /^\d+[smhd]?$/.test(w))) continue;
    return -1;
  }
  return -1;
}

/** Script de `bash -c '…'`/`sh -c`/`eval …`, quando o comando é um desses. */
function nestedScript(words) {
  if (words.length === 0) return null;
  const head = words[0].split("/").pop();
  if (head === "eval") return words.slice(1).join(" ");
  if (!SHELLS.has(head)) return null;
  for (let i = 1; i < words.length; i++) {
    if (/^-\w*c\w*$/.test(words[i])) return words[i + 1] ?? null;
    if (!words[i].startsWith("-")) return null;
  }
  return null;
}

/** Lê um `gh api`: endpoint, método efetivo e valores de campo. */
function readGhApi(args) {
  let endpoint = null;
  let method = null;
  let hasField = false;
  const fieldValues = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const eq = a.startsWith("--") ? a.indexOf("=") : -1;
    const flag = eq > 0 ? a.slice(0, eq) : a;
    const inlineValue = eq > 0 ? a.slice(eq + 1) : null;
    // `-XPOST`, `-fbody=x`: flag curta com valor colado
    const shortGlued = /^-[XfF].+/.test(a) ? a.slice(2) : null;
    if (API_VALUE_FLAGS.has(flag) || shortGlued !== null) {
      const name = shortGlued !== null ? a.slice(0, 2) : flag;
      const value = shortGlued ?? inlineValue ?? args[++i] ?? "";
      if (name === "-X" || name === "--method") method = value.toUpperCase();
      if (["-f", "-F", "--field", "--raw-field", "--input"].includes(name)) {
        hasField = true;
        fieldValues.push(value);
      }
      continue;
    }
    if (a.startsWith("-")) continue;
    if (endpoint === null) endpoint = a.replace(MARKER_RE, "");
  }
  return { endpoint, method: method ?? (hasField ? "POST" : "GET"), fieldValues };
}

function isReadMethod(method) {
  return method === "GET" || method === "HEAD";
}

/** Motivo do bloqueio pra um comando simples, ou `null`. */
function rawReviewCommentKind(words) {
  const gi = ghIndex(words);
  if (gi === -1) return null;
  let k = gi + 1;
  // flags globais antes do subcomando (`gh -R owner/repo api …`)
  while (k < words.length && words[k].startsWith("-")) {
    k += words[k] === "-R" || words[k] === "--repo" ? 2 : 1;
  }
  const sub = words[k];
  if (sub === "api") {
    const { endpoint, method, fieldValues } = readGhApi(words.slice(k + 1));
    if (endpoint === null || isReadMethod(method)) return null;
    if (endpoint === "graphql") {
      return fieldValues.some((v) => REVIEW_MUTATION_RE.test(v)) ? "graphql" : null;
    }
    return REVIEW_ENDPOINT_RE.test(endpoint) ? "rest" : null;
  }
  if (sub === "pr") {
    let j = k + 1;
    while (j < words.length && words[j].startsWith("-")) {
      j += words[j] === "-R" || words[j] === "--repo" ? 2 : 1;
    }
    if (words[j] !== "review") return null;
    const rest = words.slice(j + 1);
    return rest.some((w) => w === "--comment" || w === "-c" || /^-[a-z]*c[a-z]*$/.test(w)) ? "pr-review" : null;
  }
  return null;
}

/**
 * `"rest" | "graphql" | "pr-review"` quando o comando posta comentário de
 * review cru (ver o cabeçalho), `null` caso contrário.
 */
export function findRawPrReviewComment(command, depth = 0) {
  if (typeof command !== "string" || depth > 4) return null;
  for (const words of parseShellCommands(stripHeredocSpans(command))) {
    const kind = rawReviewCommentKind(words);
    if (kind) return kind;
    const nested = nestedScript(words);
    if (nested) {
      const inner = findRawPrReviewComment(nested, depth + 1);
      if (inner) return inner;
    }
  }
  return null;
}

export function isDevAgent(payload) {
  const agentType = payload?.agent_type ?? payload?.agentType ?? payload?.subagent_type;
  return typeof agentType === "string" && agentType.startsWith(DEV_AGENT_PREFIX);
}

/** Decisão completa do hook: motivo de bloqueio, ou `null`. */
export function shouldBlockRawPrReviewComment(payload) {
  if (!isDevAgent(payload)) return null;
  if (payload.tool_name && payload.tool_name !== "Bash") return null;
  return findRawPrReviewComment(payload.tool_input?.command);
}

export const RAW_PR_REVIEW_COMMENT_BLOCK_REASON =
  "Comentário de review postado cru por subagente dev-* bloqueado (#11300). Sem o marcador " +
  "`<!-- diaria-auto-review -->`, a thread é lida como do editor por `resolve-review-threads.ts` " +
  "(#11269) e trava o Gate 2. Use `npx tsx scripts/gh-pr-review-api.ts comment --pr N --path P " +
  "--line L --body-file F` (finding inline) ou `npx tsx scripts/gh-pr-review-api.ts reply --pr N " +
  "--comment-id ID --body-file F` (resposta) — os dois acrescentam o marcador. Comentário geral " +
  "na PR: `gh pr comment N --body-file F`. Ler os findings: `gh-pr-review-api.ts list-comments --pr N`.";

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let data = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => (data += chunk));
  process.stdin.on("end", () => {
    try {
      if (!shouldBlockRawPrReviewComment(JSON.parse(data || "{}"))) return;
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: RAW_PR_REVIEW_COMMENT_BLOCK_REASON,
          },
        }),
      );
    } catch {
      // Fail-open, sempre: um hook quebrado não pode travar Bash legítimo.
    }
  });
}
