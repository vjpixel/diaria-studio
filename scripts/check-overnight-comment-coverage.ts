#!/usr/bin/env npx tsx
/**
 * check-overnight-comment-coverage.ts (#5816)
 *
 * CLI para o gate de "cobertura de comentário" — ver
 * `scripts/lib/overnight-comment-coverage.ts` para a lógica pura/docs
 * completas do mecanismo. Este arquivo só busca os dados via `gh` e monta o
 * veredito, mesmo padrão de `scripts/check-state-changed-pending.ts`.
 *
 * Roda no gate 0.5 da Fase 2 (compilação do relatório), logo após
 * `check-state-changed-pending.ts` — bloqueia (`exit 1`) se sobrar issue
 * `pulada` ou `mergeada`-com-`REFS-NÃO-CLOSES` sem comentário overnight
 * correspondente. `gh` indisponível → fail-soft (#738): vira warning em
 * stderr, `exit 0` (não trava a rodada por causa de rede/CLI ausente).
 *
 * Uso:
 *   npx tsx scripts/check-overnight-comment-coverage.ts --plan data/overnight/260819/plan.json
 *   npx tsx scripts/check-overnight-comment-coverage.ts --plan {path} --skip-gh-checks
 *
 * @see scripts/lib/overnight-comment-coverage.ts
 * @see scripts/check-state-changed-pending.ts (padrão de estilo/gate irmão)
 * @see .claude/skills/diaria-overnight/SKILL.md (Fase 2, gate 0.5)
 * @see .claude/skills/diaria-develop/SKILL.md (gate equivalente)
 */

import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import { normalizeIssues, type IssuesBearing } from "./lib/plan-issues-normalize.ts";
import { groupPlanEntriesByRepo, labelInRepo } from "./lib/plan-issue-ref.ts";
import { loadIssueRepos } from "./lib/issue-repos.ts";
import {
  checkCoverage,
  checkLabelCoverage,
  deriveCandidateIssues,
  deriveLabelCandidates,
  sessionKindFromPlanPath,
  type CandidateIssue,
  type IssueCommentLike,
  type LabelCandidateIssue,
  type PlanIssueLike,
} from "./lib/overnight-comment-coverage.ts";

interface GhFetchResult<T> {
  value: T | null;
  error?: string;
}

/** Fail-soft: nunca lança. `gh` ausente, sem auth, rate-limited, JSON
 * malformado — tudo vira `{ value: null, error }` pro chamador decidir. */
function ghJson<T>(args: string[], cwd: string): GhFetchResult<T> {
  const result = spawnSync("gh", args, { cwd, encoding: "utf8", timeout: 30_000 });
  if (result.error) {
    return { value: null, error: `gh não pôde ser executado: ${result.error.message}` };
  }
  if (result.status !== 0) {
    const stderr = (result.stderr ?? "").toString().trim();
    return { value: null, error: `gh saiu com status ${result.status}${stderr ? `: ${stderr}` : ""}` };
  }
  if (!result.stdout) return { value: null, error: "gh retornou stdout vazio" };
  try {
    return { value: JSON.parse(result.stdout) as T };
  } catch (e) {
    return { value: null, error: `JSON malformado: ${(e as Error).message}` };
  }
}

/** #10618 (fatia 4): `-R owner/repo` quando o grupo é de outro repo da allowlist. */
function repoArgs(repo?: string): string[] {
  return repo ? ["-R", repo] : [];
}

function fetchPrBody(pr: number, cwd: string, repo?: string): GhFetchResult<{ body: string | null }> {
  return ghJson<{ body: string | null }>(["pr", "view", String(pr), ...repoArgs(repo), "--json", "body"], cwd);
}

/** #5844: pede `labels` no MESMO fetch de comentários — todo candidato de
 * label (`deriveLabelCandidates`) já é, por construção, candidato de
 * comentário (`pulada-sem-comentario`), então não há motivo pra uma 2ª
 * rodada de chamadas `gh issue view`. */
function fetchIssueComments(
  issue: number,
  cwd: string,
  repo?: string,
): GhFetchResult<{ comments: IssueCommentLike[]; labels: Array<{ name?: string }> }> {
  return ghJson<{ comments: IssueCommentLike[]; labels: Array<{ name?: string }> }>(
    ["issue", "view", String(issue), ...repoArgs(repo), "--json", "comments,labels"],
    cwd,
  );
}

if (isMainModule(import.meta.url)) {
  const { values, flags } = parseArgs(process.argv.slice(2));
  const planPath = values.plan;
  if (!planPath) {
    console.error("[check-overnight-comment-coverage] uso: --plan {path} [--skip-gh-checks]");
    process.exit(2);
  }
  if (!existsSync(planPath)) {
    console.error(`[check-overnight-comment-coverage] plan.json não encontrado: ${planPath}`);
    process.exit(2);
  }

  if (flags.has("skip-gh-checks")) {
    console.error(
      "[check-overnight-comment-coverage] --skip-gh-checks: pulando checagem de cobertura (não avaliada nesta invocação).",
    );
    process.exit(0);
  }

  let planRaw: unknown;
  try {
    planRaw = JSON.parse(readFileSync(planPath, "utf8"));
  } catch (e) {
    console.error(
      `[check-overnight-comment-coverage] plan.json malformado — pulando checagem (fail-soft, #738): ${(e as Error).message}`,
    );
    process.exit(0);
  }

  // #10778 → #10618 (fatia 4): cada repo é avaliado sozinho, com PR,
  // comentários e labels buscados NO REPO DELE (`gh … -R owner/repo`) — o PR
  // mora no repo da issue. Só fica fora a entrada de repo fora da allowlist
  // `issue_repos` ou de identidade desconhecida, com aviso.
  const { groups, unknown } = groupPlanEntriesByRepo(
    normalizeIssues<PlanIssueLike>(planRaw as IssuesBearing<PlanIssueLike>),
  );
  const cwd = process.cwd();
  const allowedRepos = new Set(loadIssueRepos(cwd));
  const skipped = [...unknown];
  for (const g of groups) {
    if (!allowedRepos.has(g.repo)) skipped.push(...g.entries.map((e) => `${labelInRepo(g.repo, e.number)} (repo fora de issue_repos)`));
  }
  if (skipped.length > 0) {
    console.error(
      `[check-overnight-comment-coverage] ${skipped.length} entrada(s) FORA desta checagem (repo fora de issue_repos ou identidade desconhecida): ${skipped.join(", ")}`,
    );
  }

  // #6115: a sessão chamadora vem do path do plan.json — comentário de
  // cobertura postado por /diaria-develop diz "develop", não "overnight".
  const kind = sessionKindFromPlanPath(planPath);

  let ghUnavailable = false;
  let candidatesTotal = 0;
  let labelCandidatesTotal = 0;
  const unresolvedLabels: string[] = [];
  const missingComment: string[] = [];
  const missingLabel: string[] = [];
  // #10618 (fatia 4, review): falha num repo EXTRA nunca derruba o veredito
  // do studio nem some em silêncio. Falha de processo (spawn/timeout) tira o
  // repo inteiro (`reposNotEvaluated`); erro de API (403/404) num PR/issue
  // daquele repo conta em `partialFailures` — as duas viram "PARCIAL" na
  // linha final. No repo default o comportamento é o de sempre: falha de
  // processo = fail-soft global (#738), erro individual = local àquele item.
  const reposNotEvaluated: string[] = [];
  const partialFailures = new Map<string, number>();
  const notePartial = (repo: string) => partialFailures.set(repo, (partialFailures.get(repo) ?? 0) + 1);
  const isSpawnFailure = (err: string) => err.startsWith("gh não pôde ser executado");

  for (const g of groups) {
    if (!allowedRepos.has(g.repo)) continue;
    const repoArg = g.isDefault ? undefined : g.repo;
    const issues = g.entries;
    const label = (n: number) => labelInRepo(g.repo, n);

    // Passo 1: para toda issue "mergeada" com `pr`, buscar o body do PR — só
    // então sabemos se ela usou `REFS ... NÃO CLOSES` (candidata) ou `Closes`
    // normal (dispensada, "issues resolvidas dispensam comentário extra").
    const prsToFetch = new Set<number>();
    for (const issue of issues) {
      if (issue.status === "mergeada" && typeof issue.pr === "number") prsToFetch.add(issue.pr);
    }

    const prBodies = new Map<number, string | null>();
    let groupAbandoned = false;
    for (const pr of prsToFetch) {
      const fetched = fetchPrBody(pr, cwd, repoArg);
      if (fetched.error) {
        console.error(
          `[check-overnight-comment-coverage] falha ao buscar ${repoArg ? `${repoArg} ` : ""}PR #${pr} (fail-soft, #738): ${fetched.error}`,
        );
        // "gh não pôde ser executado" é sinal de CLI ausente/offline — afeta
        // TODA a checagem do repo, não só este PR; qualquer outro erro (PR
        // individual apagado/inacessível) é local a este PR só.
        if (isSpawnFailure(fetched.error)) {
          if (g.isDefault) ghUnavailable = true;
          else groupAbandoned = true;
          break;
        }
        if (!g.isDefault) notePartial(g.repo);
        prBodies.set(pr, null);
      } else {
        prBodies.set(pr, fetched.value?.body ?? null);
      }
    }
    if (ghUnavailable) break;
    if (groupAbandoned) {
      reposNotEvaluated.push(g.repo);
      continue;
    }

    const candidates: CandidateIssue[] = deriveCandidateIssues(issues, prBodies);
    if (candidates.length === 0) continue;

    // Passo 2: para cada candidata, buscar os comentários E labels da issue
    // (#5844 — mesmo fetch cobre os dois gates, ver docstring de fetchIssueComments).
    const commentsByIssue = new Map<number, IssueCommentLike[] | null>();
    const labelsByIssue = new Map<number, string[]>();
    // #5844 (achado do self-review): fetch falho não pode virar "label ausente"
    // — mesma disciplina fail-soft do gate de comentário (#738). Guarda quem
    // falhou pra excluir da checagem de label abaixo, em vez de reportar como
    // missing por um problema de rede/gh que nada tem a ver com a label em si.
    const labelFetchFailed = new Set<number>();
    for (const candidate of candidates) {
      const fetched = fetchIssueComments(candidate.number, cwd, repoArg);
      if (fetched.error) {
        console.error(
          `[check-overnight-comment-coverage] falha ao buscar comentários de ${label(candidate.number)} (fail-soft, #738): ${fetched.error}`,
        );
        if (isSpawnFailure(fetched.error)) {
          if (g.isDefault) ghUnavailable = true;
          else groupAbandoned = true;
          break;
        }
        if (!g.isDefault) notePartial(g.repo);
        commentsByIssue.set(candidate.number, null);
        labelFetchFailed.add(candidate.number);
      } else {
        commentsByIssue.set(candidate.number, fetched.value?.comments ?? []);
        labelsByIssue.set(
          candidate.number,
          (fetched.value?.labels ?? []).map((l) => l.name).filter((n): n is string => typeof n === "string"),
        );
      }
    }
    if (ghUnavailable) break;
    if (groupAbandoned) {
      reposNotEvaluated.push(g.repo);
      continue;
    }

    // Review 2, item 4: só conta candidatas de grupo AVALIADO — grupo
    // abandonado acima (falha de processo no repo extra) não infla o N.
    candidatesTotal += candidates.length;
    const verdict = checkCoverage(candidates, commentsByIssue, kind ?? undefined);
    unresolvedLabels.push(...verdict.unresolved.map((c) => label(c.number)));

    // #5844: gate de LABEL — checado independente do de comentário (issue pode
    // ter o comentário e ainda faltar a label, exatamente o achado ao vivo que
    // motivou a issue). Exclui candidatas cujo fetch falhou (fail-soft, ver
    // `labelFetchFailed` acima) — nunca reporta "label ausente" por um
    // problema de rede/gh que não tem nada a ver com a label em si.
    const labelCandidates: LabelCandidateIssue[] = deriveLabelCandidates(issues).filter(
      (c) => !labelFetchFailed.has(c.number),
    );
    labelCandidatesTotal += labelCandidates.length;
    const labelVerdict = checkLabelCoverage(labelCandidates, labelsByIssue);

    if (verdict.status === "missing") {
      missingComment.push(
        ...verdict.missing.map(
          (c) =>
            `${label(c.number)} (${c.reason === "pulada-sem-comentario" ? "pulada" : `${repoArg ? `${repoArg} ` : ""}PR #${c.pr} REFS-NÃO-CLOSES`})`,
        ),
      );
    }
    if (labelVerdict.status === "missing") {
      missingLabel.push(
        ...labelVerdict.missing.map((c) => `${label(c.number)} (motivo "${c.motivo}" → label "${c.requiredLabel}" ausente)`),
      );
    }
  }

  if (ghUnavailable) {
    console.error(
      "[check-overnight-comment-coverage] gh indisponível — pulando checagem de cobertura (fail-soft, #738).",
    );
    process.exit(0);
  }

  for (const repo of reposNotEvaluated) {
    console.error(
      `[check-overnight-comment-coverage] ${repo}: gh falhou ao executar — entrada(s) desse repo NÃO avaliada(s); o veredito dos demais repos segue (fail-soft por repo, #738).`,
    );
  }
  const partialNote = [
    ...reposNotEvaluated.map((r) => `${r} (gh falhou)`),
    ...[...partialFailures].map(([r, n]) => `${r} (${n} consulta(s) com erro)`),
  ];
  const okPrefix = partialNote.length > 0 ? "ok PARCIAL" : "ok";
  // O "PARCIAL" já vem no prefixo (`ok PARCIAL`); aqui só o que ficou de fora.
  const partialSuffix = partialNote.length > 0 ? ` (NÃO avaliados: ${partialNote.join(", ")})` : "";
  if (partialNote.length > 0) {
    console.error(`[check-overnight-comment-coverage] PARCIAL — NÃO avaliados: ${partialNote.join(", ")}`);
  }

  if (candidatesTotal === 0) {
    console.log(
      `${okPrefix} — nenhuma issue pulada ou mergeada-com-REFS-NÃO-CLOSES nesta rodada${skipped.length > 0 ? ` (exceto ${skipped.length} entrada(s) FORA desta checagem, ver stderr)` : ""}${partialSuffix}`,
    );
    process.exit(0);
  }

  if (unresolvedLabels.length > 0) {
    console.error(
      `[check-overnight-comment-coverage] não foi possível confirmar comentário para: ${unresolvedLabels.join(", ")} (fetch individual falhou — fail-soft, não conta como pendência)`,
    );
  }

  if (missingComment.length === 0 && missingLabel.length === 0) {
    console.log(
      `${okPrefix} — todas as ${candidatesTotal} issue(s) candidata(s) (pulada/REFS-NÃO-CLOSES) têm comentário overnight` +
        (labelCandidatesTotal > 0 ? ` e as ${labelCandidatesTotal} com motivo mapeado têm a label esperada` : "") +
        (skipped.length > 0 ? ` (exceto ${skipped.length} entrada(s) FORA desta checagem, ver stderr)` : "") +
        partialSuffix,
    );
    process.exit(0);
  }

  if (missingComment.length > 0) {
    console.error(
      `cobertura de comentário faltando: ${missingComment.join(", ")} — comente na issue com o que foi feito/falta antes de fechar a rodada`,
    );
  }

  if (missingLabel.length > 0) {
    console.error(
      `cobertura de label faltando (#5844): ${missingLabel.join(", ")} — aplique a label esperada (gh issue edit N [-R owner/repo] --add-label ...) antes de fechar a rodada`,
    );
  }

  process.exit(1);
}
