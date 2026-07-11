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
// signal: an overnight round is genuinely in progress on THIS machine (per
// `data/overnight/{AAMMDD}/plan.json`, same store the skill already writes/reads).
// Branch prefix is checked FIRST (cheap, no disk I/O) as a fast-path; the active-round
// check is the fallback that makes the gate correct even when naming drifts again.

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readTodayPlan, isTerminalForBar, isForeignDevelopPlan } from "../../scripts/overnight-statusline.ts";
import { getMachineId } from "../../scripts/lib/machine-id.ts";

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * #3322: true quando há uma rodada `/diaria-overnight` genuinamente em progresso
 * NESTA máquina — independe 100% de como o subagente nomeou a branch do PR.
 *
 * Reusa a mesma leitura/schema que `scripts/overnight-statusline.ts` já usa pra
 * statusLine (`readTodayPlan`, `isTerminalForBar`) em vez de inventar um novo
 * arquivo de lock: `plan.json` já é reescrito a cada dispatch/transição da
 * rodada, então "todas as issues em status terminal" já É o sinal de "rodada
 * encerrada" — não precisa de um marker paralelo pra manter sincronizado.
 *
 * `isForeignDevelopPlan` (nome herdado de #3033, mas a checagem é genérica —
 * só olha `plan.machine_id`) filtra plan.json de OUTRA máquina sincronizado
 * via a mesma junction OneDrive `data/`: sem isso, uma rodada overnight ativa
 * na máquina A forçaria `low` num PR manual aberto na máquina B.
 *
 * Fail-open pra `false` (não força low) em qualquer erro ou estado
 * inconclusivo — mesma direção fail-safe do resto do hook: na dúvida, mantém
 * o default mais caro (max), nunca o mais barato.
 */
export function isOvernightRoundActive(cwd = PROJECT_ROOT, localMachineId = getMachineId()) {
  try {
    const plan = readTodayPlan(cwd);
    if (!plan || !Array.isArray(plan.issues) || plan.issues.length === 0) return false;
    if (isForeignDevelopPlan(plan, localMachineId)) return false;
    return !plan.issues.every((issue) => isTerminalForBar(issue.status));
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
          `branch "${branch}" não usa o prefixo overnight/ apesar de uma rodada ` +
          "overnight ativa nesta máquina (data/overnight/{AAMMDD}/plan.json) — " +
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
