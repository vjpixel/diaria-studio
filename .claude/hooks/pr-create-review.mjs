// PostToolUse hook — auto-trigger /code-review after a PR is created.
//
// Wired in .claude/settings.json under hooks.PostToolUse:
//   matcher "Bash", if "Bash(gh pr create*)", shell "bash".
//
// Gating (when this fires):
//   1. Platform: PostToolUse runs only after the Bash tool SUCCEEDS. A failed
//      `gh pr create` (e.g. "a pull request already exists", non-zero exit)
//      routes to PostToolUseFailure, not here — this is the real success gate.
//   2. `if` filter: restricts to `gh pr create*` so `gh pr view`/`gh pr list`
//      (which also print /pull/ URLs) never run it. It is a START-ANCHORED
//      prefix, so it only matches a STANDALONE `gh pr create …` call — NOT a
//      chained `git push && gh pr create …`. Create PRs with a standalone
//      `gh pr create` call so the hook fires.
//   3. This script then extracts the created PR's URL from the tool output and
//      only emits the instruction when one is present (skips `--help`, etc.).
//
// Output: a PostToolUse `additionalContext` payload instructing Claude to run
// the effort-aware /code-review on the new PR. Effort is branch-aware (#2754):
// `overnight/*` branches get `low` (token-optimized — the overnight skill's own
// subagent already does an adversarial self-review pass per unit; a second full
// multi-agent `max` review on top was double-paying for depth on low-risk P3
// hardening PRs, the single biggest token sink observed in the 260630 session).
// Everything else (develop/manual PRs) keeps `max` — speed matters more than
// token count there, and `max` doesn't cost wall-clock time, just tokens.
// Never throws / never exits non-zero, so it can't block the Bash tool.
//
// #3322: branch-prefix alone is NOT the primary signal anymore — it's a fragile
// naming convention any dispatch prompt can forget (exactly what happened in the
// 260710 incident, #3321: ~50 PRs, zero used `overnight/*`, gating silently never
// fired `low` all night). `isOvernightRoundActive` adds a second, naming-independent
// signal: a lightweight per-machine marker file written/removed by the
// `/diaria-overnight` skill itself (`scripts/overnight-session-marker.ts`, Fase 0
// passo 1 / Fase 2 passo 1) — `data/overnight/.active-session-{machine}.json`.
// Branch prefix is checked FIRST (cheap, no disk/process I/O) as a fast-path; the
// active-session check is the fallback that makes the gate correct even when
// naming drifts again.
//
// Deliberately NOT `data/overnight/{AAMMDD}/plan.json` (the coordinator's own
// progress-tracking document, owned by an unrelated statusline feature, schema
// still evolving). An earlier revision of this fix reused it, and code review
// surfaced 3 real gaps: (1) no staleness bound — a crashed/abandoned round stayed
// "active" forever; (2) the plan-lookup only ever inspects the single
// lexicographically-most-recent round directory — if that happens to belong to a
// DIFFERENT machine, this machine's own active round is never even checked; (3)
// inverted fail-direction inherited from a progress-bar helper (unrecognized/
// missing issue status ⇒ "still going", the wrong default for a cost gate, which
// wants "on doubt, assume NOT active" so it falls back to the expensive default).
// A dedicated, per-machine, self-timestamped marker avoids all three by
// construction — the entire contract is "exists + fresh + mine".
//
// Also deliberately self-contained (no `scripts/*.ts` imports): this hook's own
// invariant is "never throws, never blocks `gh pr create`" — a static top-level
// `import` of a project `.ts` file executes before any try/catch in this file and
// would crash the WHOLE hook (silently, zero stdout) on any Node build without
// native TS type-stripping (this repo has no `engines` pin, and sessions can run
// in differently-provisioned local/cloud/worktree environments). Path/tag logic
// here is intentionally duplicated (not imported) from
// `scripts/overnight-session-marker.ts`, which is the write/remove side used only
// by the skill's own coordinator — see that file's docblock for the split
// rationale. Keep the two in sync by hand; each side has its own test file.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

// 24h — comfortably above the longest observed round (~16h, rodada 260611) while
// still bounding "stuck active forever" to at most a day if Fase 2's cleanup is
// ever skipped (crash, kill -9, etc).
const MAX_SESSION_AGE_MS = 24 * 60 * 60 * 1000;

/** Sanitiza o hostname pra um nome de arquivo seguro. Nunca lança — "unknown" em falha. */
function localMachineTag() {
  try {
    return (hostname() || "unknown").replace(/[^a-zA-Z0-9_-]/g, "_");
  } catch {
    return "unknown";
  }
}

/**
 * Resolve a raiz do checkout PRINCIPAL do repo — nunca a raiz de um worktree
 * vinculado. `git rev-parse --git-common-dir` retorna o `.git` COMPARTILHADO
 * entre todos os worktrees (o do checkout principal) mesmo quando executado de
 * dentro de um worktree linkado; derivar a raiz de `import.meta.url` (a
 * localização do PRÓPRIO arquivo deste hook) não faz essa distinção — resolveria
 * pra dentro do worktree, que não tem a junction `data/` (confirmado: todo
 * subagente implementador do overnight roda com `isolation: "worktree"`, e
 * SKILL.md já documenta "worktree novo não tem node_modules/ nem a junction
 * data/"). Usar a raiz errada faria este guard nunca encontrar
 * `data/overnight/`, justamente no processo que mais precisa dele — o subagente
 * cujo PR está sendo avaliado agora mesmo.
 */
function resolveMainRepoRoot(execFn = execFileSync) {
  try {
    const gitDir = execFn("git", ["rev-parse", "--git-common-dir"], {
      encoding: "utf8",
      timeout: 10_000,
    }).trim();
    return dirname(resolvePath(gitDir));
  } catch {
    // Fallback só correto quando este arquivo roda do checkout principal (nunca
    // de um worktree) — pior caso equivale ao comportamento pré-#3322 (cai pro
    // branch-prefix check).
    return join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  }
}

function activeSessionPath(repoRoot, tag) {
  return join(repoRoot, "data", "overnight", `.active-session-${tag}.json`);
}

/**
 * #3322: true quando há uma rodada `/diaria-overnight` genuinamente em progresso
 * NESTA máquina — independe 100% de como o subagente nomeou a branch do PR.
 *
 * Fail-open pra `false` (não força low) em qualquer erro, marker ausente, ou
 * marker mais velho que `MAX_SESSION_AGE_MS` — mesma direção fail-safe do resto
 * do hook: na dúvida, mantém o default mais caro (max), nunca o mais barato.
 */
export function isOvernightRoundActive(
  repoRoot = resolveMainRepoRoot(),
  machineTag = localMachineTag(),
  now = Date.now(),
) {
  try {
    const markerPath = activeSessionPath(repoRoot, machineTag);
    if (!existsSync(markerPath)) return false;
    const marker = JSON.parse(readFileSync(markerPath, "utf8"));
    const startedAtMs = Date.parse(marker.started_at);
    if (!Number.isFinite(startedAtMs)) return false;
    return now - startedAtMs <= MAX_SESSION_AGE_MS;
  } catch {
    return false;
  }
}

/**
 * Resolve o headRefName de um PR e decide o effort de /code-review.
 * `execFn` é injetável (default = execFileSync real) pra ser testável sem gh live.
 * `checkRoundActive` é injetável (default = isOvernightRoundActive real) pra ser
 * testável sem tocar `data/overnight/` no disco real.
 * Fail-safe: qualquer erro (gh indisponível, PR não encontrado, timeout) → "max".
 *
 * Retorna `{ effort, warning }`: `warning` é `null` no caminho feliz, ou uma nota
 * (#3322 direção 3) quando o effort só resolveu `low` via o guard de sessão ativa
 * — ou seja, a branch NÃO seguiu a convenção `overnight/*` (#3321) mesmo com uma
 * rodada ativa. O guard já corrige o effort sozinho; o warning só torna essa
 * divergência de naming visível ao coordenador em vez de passar em silêncio (era
 * justamente o silêncio do fallback antigo que atrasou a detecção do #3321).
 */
export function resolveEffort(prUrl, execFn = execFileSync, checkRoundActive = isOvernightRoundActive) {
  try {
    const num = prUrl.match(/\/pull\/(\d+)/)?.[1];
    if (!num) return { effort: "max", warning: null };
    const branch = execFn(
      "gh",
      ["pr", "view", num, "--json", "headRefName", "--jq", ".headRefName"],
      { encoding: "utf8", timeout: 10_000 },
    ).trim();
    if (branch.startsWith("overnight/")) return { effort: "low", warning: null };
    if (checkRoundActive()) {
      return {
        effort: "low",
        warning:
          `branch "${branch}" não usa o prefixo overnight/ apesar de uma sessão ` +
          "overnight ativa nesta máquina (data/overnight/.active-session-*.json) — " +
          "SKILL.md diaria-overnight (Fase 1, passo 2) deveria ter instruído esse " +
          "prefixo no dispatch do subagente implementador (#3321). Effort resolvido " +
          "como low via guard de sessão ativa (#3322), não pelo naming da branch.",
      };
    }
    return { effort: "max", warning: null };
  } catch {
    return { effort: "max", warning: null }; // fail-safe: estado desconhecido → mantém o default mais caro.
  }
}

/** Monta o additionalContext do hook a partir da URL do PR, effort resolvido e warning opcional. Pure/testável. */
export function buildReviewInstruction(prUrl, effort, warning = null) {
  const effortNote =
    effort === "low"
      ? "at LOW effort (overnight branch — token-optimized; fewer, high-confidence findings only)"
      : "at ULTRACODE / maximum effort: the full multi-agent review (many finder angles -> verify -> sweep, recall mode)";
  const warningNote = warning ? ` [aviso: ${warning}]` : "";
  return (
    `A pull request was just created: ${prUrl} — per project policy, run ` +
    `\`/code-review ${effort} --comment\` on it now, ${effortNote}, ` +
    "posting findings as inline PR comments. Do NOT use cloud `ultra` (it is user-triggered/billed and cannot be self-launched)." +
    warningNote
  );
}

// #2019: CLI guard — só roda o corpo do hook quando este arquivo é o entrypoint
// (nunca ao ser importado por test/pr-create-review-hook.test.ts).
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
      const resp =
        typeof payload.tool_response === "string"
          ? payload.tool_response
          : JSON.stringify(payload.tool_response ?? "");
      const match = resp.match(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/);
      if (match) {
        const { effort, warning } = resolveEffort(match[0]);
        process.stdout.write(
          JSON.stringify({
            hookSpecificOutput: {
              hookEventName: "PostToolUse",
              additionalContext: buildReviewInstruction(match[0], effort, warning),
            },
          }),
        );
      }
    } catch {
      // Swallow everything: a hook that errors must not block the PR creation.
    }
  });
}
