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
import {
  checkCoverage,
  checkLabelCoverage,
  deriveCandidateIssues,
  deriveLabelCandidates,
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

function fetchPrBody(pr: number, cwd: string): GhFetchResult<{ body: string | null }> {
  return ghJson<{ body: string | null }>(["pr", "view", String(pr), "--json", "body"], cwd);
}

/** #5844: pede `labels` no MESMO fetch de comentários — todo candidato de
 * label (`deriveLabelCandidates`) já é, por construção, candidato de
 * comentário (`pulada-sem-comentario`), então não há motivo pra uma 2ª
 * rodada de chamadas `gh issue view`. */
function fetchIssueComments(
  issue: number,
  cwd: string,
): GhFetchResult<{ comments: IssueCommentLike[]; labels: Array<{ name?: string }> }> {
  return ghJson<{ comments: IssueCommentLike[]; labels: Array<{ name?: string }> }>(
    ["issue", "view", String(issue), "--json", "comments,labels"],
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

  const issues = normalizeIssues<PlanIssueLike>(planRaw as IssuesBearing<PlanIssueLike>);
  const cwd = process.cwd();

  // Passo 1: para toda issue "mergeada" com `pr`, buscar o body do PR — só
  // então sabemos se ela usou `REFS ... NÃO CLOSES` (candidata) ou `Closes`
  // normal (dispensada, "issues resolvidas dispensam comentário extra").
  const prsToFetch = new Set<number>();
  for (const issue of issues) {
    if (issue.status === "mergeada" && typeof issue.pr === "number") prsToFetch.add(issue.pr);
  }

  let ghUnavailable = false;
  const prBodies = new Map<number, string | null>();
  for (const pr of prsToFetch) {
    const fetched = fetchPrBody(pr, cwd);
    if (fetched.error) {
      console.error(
        `[check-overnight-comment-coverage] falha ao buscar PR #${pr} (fail-soft, #738): ${fetched.error}`,
      );
      // "gh não pôde ser executado" é sinal de CLI ausente/offline — afeta
      // TODA a checagem, não só este PR; qualquer outro erro (PR
      // individual apagado/inacessível) é local a este PR só.
      if (fetched.error.startsWith("gh não pôde ser executado")) ghUnavailable = true;
      prBodies.set(pr, null);
    } else {
      prBodies.set(pr, fetched.value?.body ?? null);
    }
  }

  if (ghUnavailable) {
    console.error(
      "[check-overnight-comment-coverage] gh indisponível — pulando checagem de cobertura (fail-soft, #738).",
    );
    process.exit(0);
  }

  const candidates: CandidateIssue[] = deriveCandidateIssues(issues, prBodies);

  if (candidates.length === 0) {
    console.log("ok — nenhuma issue pulada ou mergeada-com-REFS-NÃO-CLOSES nesta rodada");
    process.exit(0);
  }

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
    const fetched = fetchIssueComments(candidate.number, cwd);
    if (fetched.error) {
      console.error(
        `[check-overnight-comment-coverage] falha ao buscar comentários de #${candidate.number} (fail-soft, #738): ${fetched.error}`,
      );
      if (fetched.error.startsWith("gh não pôde ser executado")) ghUnavailable = true;
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

  if (ghUnavailable) {
    console.error(
      "[check-overnight-comment-coverage] gh indisponível — pulando checagem de cobertura (fail-soft, #738).",
    );
    process.exit(0);
  }

  const verdict = checkCoverage(candidates, commentsByIssue);

  if (verdict.unresolved.length > 0) {
    const list = verdict.unresolved.map((c) => `#${c.number}`).join(", ");
    console.error(
      `[check-overnight-comment-coverage] não foi possível confirmar comentário para: ${list} (fetch individual falhou — fail-soft, não conta como pendência)`,
    );
  }

  // #5844: gate de LABEL — checado independente do de comentário (issue pode
  // ter o comentário e ainda faltar a label, exatamente o achado ao vivo que
  // motivou a issue). Exclui candidatas cujo fetch falhou (fail-soft, ver
  // `labelFetchFailed` acima) — nunca reporta "label ausente" por um
  // problema de rede/gh que não tem nada a ver com a label em si.
  const labelCandidates: LabelCandidateIssue[] = deriveLabelCandidates(issues).filter(
    (c) => !labelFetchFailed.has(c.number),
  );
  const labelVerdict = checkLabelCoverage(labelCandidates, labelsByIssue);

  const commentOk = verdict.status !== "missing";
  const labelOk = labelVerdict.status !== "missing";

  if (commentOk && labelOk) {
    console.log(
      `ok — todas as ${candidates.length} issue(s) candidata(s) (pulada/REFS-NÃO-CLOSES) têm comentário overnight` +
        (labelCandidates.length > 0 ? ` e as ${labelCandidates.length} com motivo mapeado têm a label esperada` : ""),
    );
    process.exit(0);
  }

  if (!commentOk) {
    const list = verdict.missing
      .map((c) => `#${c.number} (${c.reason === "pulada-sem-comentario" ? "pulada" : `PR #${c.pr} REFS-NÃO-CLOSES`})`)
      .join(", ");
    console.error(
      `cobertura de comentário faltando: ${list} — comente na issue com o que foi feito/falta antes de fechar a rodada`,
    );
  }

  if (!labelOk) {
    const list = labelVerdict.missing
      .map((c) => `#${c.number} (motivo "${c.motivo}" → label "${c.requiredLabel}" ausente)`)
      .join(", ");
    console.error(
      `cobertura de label faltando (#5844): ${list} — aplique a label esperada (gh issue edit N --add-label ...) antes de fechar a rodada`,
    );
  }

  process.exit(1);
}
