#!/usr/bin/env npx tsx
/**
 * check-decision-label-drift-gate.ts (#5892)
 *
 * CLI para o gate de "drift de label de decisão" — usa a lógica pura de
 * `scripts/lib/decision-label-drift.ts` e o mesmo padrão de fetch fail-soft
 * dos outros gates da Fase 2 (`check-state-changed-pending.ts`,
 * `check-overnight-comment-coverage.ts`, `check-pr-terminal-state.ts`).
 *
 * Roda no gate 0.8 da Fase 2 (compilação do relatório), logo após
 * `check-pr-terminal-state.ts` — bloqueia (`exit 1`) se houver drift
 * detectado entre prosa dos comentários e labels estruturais. `gh`
 * indisponível → fail-soft (#738): vira warning em stderr, `exit 0` (não
 * trava a rodada por causa de rede/CLI ausente).
 *
 * Uso:
 *   npx tsx scripts/check-decision-label-drift-gate.ts --plan data/overnight/260819/plan.json
 *   npx tsx scripts/check-decision-label-drift-gate.ts --plan {path} --skip-gh-checks
 *
 * @see scripts/lib/decision-label-drift.ts
 * @see scripts/check-state-changed-pending.ts (padrão de estilo/gate irmão)
 * @see .claude/skills/diaria-overnight/SKILL.md (Fase 2, gate 0.8)
 * @see .claude/skills/diaria-develop/SKILL.md (gate equivalente)
 */

import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import { normalizeIssues, type IssuesBearing } from "./lib/plan-issues-normalize.ts";
import { groupPlanEntriesByRepo, labelInRepo } from "./lib/plan-issue-ref.ts";
import { loadIssueRepos } from "./lib/issue-repos.ts";
import {
  detectLabelDriftDetailed,
  type DriftFinding,
  type SuppressedFinding,
} from "./lib/decision-label-drift.ts";
import { buildGateEvaluations, type GatePlanIssue } from "./lib/decision-label-drift-gate.ts";
import { trustedCommentBodies } from "./lib/trusted-comment-author.ts";

interface GhIssueListItem {
  number: number;
  labels?: Array<{ name?: string } | string>;
  /** Necessário pro marcador `aguardando-ate:` que `classifyExecTrack` lê
   * (#5955) — sem ele, issue `agendada` seria avaliada como `overnight`. */
  body?: string;
}

interface FetchOpenIssuesResult {
  issues: GhIssueListItem[];
  error?: string;
}

const DRIFT_ISSUE_LIMIT = 200;

/** Busca issues abertas (número + labels) via `gh issue list` — fail-soft. */
function fetchOpenIssues(cwd: string, repo?: string): FetchOpenIssuesResult {
  // #10618 (fatia 4): `repo` = outro repo da allowlist → `-R owner/repo`.
  const result = spawnSync(
    "gh",
    ["issue", "list", ...(repo ? ["-R", repo] : []), "--state", "open", "--json", "number,labels,body", "--limit", String(DRIFT_ISSUE_LIMIT)],
    { cwd, encoding: "utf8", timeout: 30_000 },
  );
  if (result.error) {
    return { issues: [], error: `gh não pôde ser executado: ${result.error.message}` };
  }
  if (result.status !== 0) {
    const stderr = (result.stderr ?? "").toString().trim();
    return { issues: [], error: `gh issue list saiu com status ${result.status}${stderr ? `: ${stderr}` : ""}` };
  }
  if (!result.stdout) {
    return { issues: [], error: "gh issue list retornou stdout vazio" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (e) {
    return { issues: [], error: `JSON malformado de gh issue list: ${(e as Error).message}` };
  }
  if (!Array.isArray(parsed)) {
    return { issues: [], error: "gh issue list retornou payload que não é um array" };
  }
  return { issues: parsed as GhIssueListItem[] };
}

/** Busca comentários de uma issue via `gh issue view` — fail-soft. */
function fetchIssueComments(
  issue: number,
  cwd: string,
  repo?: string,
): { comments: string[] | null; error?: string } {
  const result = spawnSync(
    "gh",
    ["issue", "view", String(issue), ...(repo ? ["-R", repo] : []), "--json", "comments"],
    { cwd, encoding: "utf8", timeout: 30_000 },
  );
  if (result.error) {
    return { comments: null, error: `gh não pôde ser executado: ${result.error.message}` };
  }
  if (result.status !== 0) {
    const stderr = (result.stderr ?? "").toString().trim();
    return { comments: null, error: `gh issue view saiu com status ${result.status}${stderr ? `: ${stderr}` : ""}` };
  }
  if (!result.stdout) return { comments: null, error: "gh retornou stdout vazio" };
  try {
    const parsed = JSON.parse(result.stdout) as { comments?: unknown };
    // #9752: só autor confiável (OWNER/MEMBER/COLLABORATOR) — repo público.
    const comments = (trustedCommentBodies(parsed?.comments ?? []) ?? []).filter((b) => b.length > 0);
    return { comments };
  } catch (e) {
    return { comments: null, error: `JSON malformado: ${(e as Error).message}` };
  }
}

function normalizeLabels(issue: GhIssueListItem): string[] {
  return (issue.labels ?? [])
    .map((l) => (typeof l === "string" ? l : l?.name))
    .filter((n): n is string => typeof n === "string" && n.length > 0);
}

if (isMainModule(import.meta.url)) {
  const { values, flags } = parseArgs(process.argv.slice(2));
  const planPath = values.plan;
  if (!planPath) {
    console.error("[check-decision-label-drift-gate] uso: --plan {path} [--skip-gh-checks]");
    process.exit(2);
  }
  if (!existsSync(planPath)) {
    console.error(`[check-decision-label-drift-gate] plan.json não encontrado: ${planPath}`);
    process.exit(2);
  }

  if (flags.has("skip-gh-checks")) {
    console.error(
      "[check-decision-label-drift-gate] --skip-gh-checks: pulando checagem de drift de label (não avaliada nesta invocação).",
    );
    process.exit(0);
  }

  let planRaw: unknown;
  try {
    planRaw = JSON.parse(readFileSync(planPath, "utf8"));
  } catch (e) {
    console.error(
      `[check-decision-label-drift-gate] plan.json malformado — pulando checagem (fail-soft, #738): ${(e as Error).message}`,
    );
    process.exit(0);
  }

  // Escopo, corte por track e decisão de buscar comentários vivem em
  // `lib/decision-label-drift-gate.ts` (#5955) — puros e testados sem `gh`.
  // #10778 → #10618 (fatia 4): cada repo é avaliado sozinho, com labels e
  // comentários buscados NO REPO DELE (`gh … -R owner/repo`). Só fica fora a
  // entrada de repo fora da allowlist `issue_repos` ou de identidade
  // desconhecida, com aviso explícito.
  const { groups, unknown } = groupPlanEntriesByRepo(
    normalizeIssues<GatePlanIssue>(planRaw as IssuesBearing<GatePlanIssue>),
  );
  const cwd = process.cwd();
  const allowedRepos = new Set(loadIssueRepos(cwd));
  const skipped = [...unknown];
  for (const g of groups) {
    if (!allowedRepos.has(g.repo)) skipped.push(...g.entries.map((e) => `${labelInRepo(g.repo, e.number)} (repo fora de issue_repos)`));
  }
  if (skipped.length > 0) {
    console.error(
      `[check-decision-label-drift-gate] ${skipped.length} entrada(s) FORA desta checagem (repo fora de issue_repos ou identidade desconhecida): ${skipped.join(", ")}`,
    );
  }

  const allFindings: Array<DriftFinding & { label: string; repo?: string }> = [];
  const allSuppressed: Array<SuppressedFinding & { label: string }> = [];
  let ghUnavailable = false;

  const reposNotEvaluated: string[] = [];
  for (const g of groups) {
    if (!allowedRepos.has(g.repo)) continue;
    const repoArg = g.isDefault ? undefined : g.repo;
    // Buscar todas as issues abertas DO REPO DO GRUPO para pegar labels atuais
    const fetched = fetchOpenIssues(cwd, repoArg);
    if (fetched.error) {
      if (g.isDefault) {
        console.error(
          `[check-decision-label-drift-gate] gh indisponível — pulando checagem de drift de label (fail-soft, #738): ${fetched.error}`,
        );
        process.exit(0);
      }
      // #10618 (fatia 4): falha só num repo extra NÃO descarta o veredito
      // do studio já calculado — o repo fica fora, com ressalva na linha final.
      console.error(
        `[check-decision-label-drift-gate] ${g.repo}: lista de issues abertas indisponível — entrada(s) desse repo NÃO avaliada(s) (fail-soft, #738): ${fetched.error}`,
      );
      reposNotEvaluated.push(g.repo);
      continue;
    }

    const evaluations = buildGateEvaluations(
      g.entries,
      fetched.issues.map((i) => ({ number: i.number, labels: normalizeLabels(i), body: i.body })),
    );

    // #10618 (fatia 4, review): achados do grupo ficam num buffer local e só
    // entram no veredito se o grupo terminar. Falha de PROCESSO (spawn,
    // timeout) ao ler comentários de um repo extra tira só aquele repo do
    // veredito (`reposNotEvaluated`) — nunca descarta o que o studio já achou.
    // No repo default continua sendo o fail-soft global de sempre (#738).
    const groupFindings: typeof allFindings = [];
    const groupSuppressed: typeof allSuppressed = [];
    let groupAbandoned = false;
    for (const evaluation of evaluations) {
      let commentBodies: string[] = [];
      if (evaluation.needsComments) {
        const commentsResult = fetchIssueComments(evaluation.issueNumber, cwd, repoArg);
        if (commentsResult.error) {
          console.error(
            `[check-decision-label-drift-gate] falha ao buscar comentários de ${labelInRepo(g.repo, evaluation.issueNumber)} (fail-soft, #738): ${commentsResult.error}`,
          );
          if (commentsResult.error.startsWith("gh não pôde ser executado")) {
            if (g.isDefault) {
              ghUnavailable = true;
            } else {
              reposNotEvaluated.push(g.repo);
              groupAbandoned = true;
              break;
            }
          }
          // Sem os comentários, ainda dá pra avaliar a prosa do plano — não
          // abortar a issue inteira por causa de uma falha de fetch.
        } else {
          commentBodies = commentsResult.comments ?? [];
        }
      }

      const detailed = detectLabelDriftDetailed({
        issueNumber: evaluation.issueNumber,
        labels: evaluation.labels,
        commentBodies,
        planTexts: evaluation.planTexts,
        currentTrack: evaluation.currentTrack,
      });
      groupFindings.push(
        ...detailed.findings.map((f) => ({ ...f, label: labelInRepo(g.repo, f.issueNumber), ...(repoArg ? { repo: repoArg } : {}) })),
      );
      groupSuppressed.push(...detailed.suppressedByRoute.map((f) => ({ ...f, label: labelInRepo(g.repo, f.issueNumber) })));
    }
    if (groupAbandoned) {
      console.error(
        `[check-decision-label-drift-gate] ${g.repo}: gh falhou ao ler comentários — entrada(s) desse repo NÃO avaliada(s); o veredito dos demais repos segue (fail-soft por repo, #738).`,
      );
      continue;
    }
    allFindings.push(...groupFindings);
    allSuppressed.push(...groupSuppressed);
  }

  if (ghUnavailable) {
    console.error(
      "[check-decision-label-drift-gate] gh indisponível — pulando checagem de drift de label (fail-soft, #738).",
    );
    process.exit(0);
  }

  // Supressão fica visível mesmo quando o gate passa limpo (#6301 finding
  // 1) — "ok" abaixo NÃO deve mascarar "havia drift, mas um route-issue
  // posterior apagou". Não afeta o exit code: supressão é auditoria, não
  // motivo pra bloquear a rodada.
  if (allSuppressed.length > 0) {
    console.error(
      `[check-decision-label-drift-gate] ${allSuppressed.length} achado(s) SUPRIMIDO(S) por route-issue posterior (não bloqueiam o gate — ver docstring de scripts/lib/decision-label-drift.ts, seção "route-issue posterior vence"):`,
    );
    for (const s of allSuppressed) {
      console.error(`  ${s.label}\t${s.patternId}\t${s.commentExcerpt}`);
    }
    console.error("");
  }

  if (allFindings.length === 0) {
    const ressalvas = [
      ...(skipped.length > 0 ? [`${skipped.length} entrada(s) FORA desta checagem`] : []),
      ...(reposNotEvaluated.length > 0 ? [`repo(s) NÃO avaliado(s): ${reposNotEvaluated.join(", ")}`] : []),
    ];
    console.log(
      `ok${reposNotEvaluated.length > 0 ? " PARCIAL" : ""} — nenhum drift de label de decisão detectado nas issues da rodada${ressalvas.length > 0 ? ` (exceto ${ressalvas.join("; ")}, ver stderr)` : ""}`,
    );
    process.exit(0);
  }

  // Reportar achados
  console.error(`check-decision-label-drift-gate: ${allFindings.length} drift(s) de label detectado(s) — comentário sugere deferimento/decisão, label estrutural não bate.`);
  console.error("");
  console.error("issue\tpadrão\tfonte\tlabels esperadas (any-of)\tlabels atuais\ttrecho");
  for (const f of allFindings) {
    const expected = f.expectedLabels.join("|");
    const actual = f.actualLabels.length > 0 ? f.actualLabels.join(",") : "(nenhuma)";
    const fonte = f.source === "plan" ? "plan.json" : "comentário";
    console.error(`${f.label}\t${f.patternId}\t${fonte}\t${expected}\t${actual}\t${f.commentExcerpt}`);
  }
  console.error("");
  console.error("Isto é um achado de auditoria (heurística por regex, não NLP). Confirme antes de aplicar/remover label.");
  console.error("Aplique as labels esperadas nas issues listadas (gh issue edit N [-R owner/repo] --add-label ...) antes de fechar a rodada.");

  process.exit(1);
}