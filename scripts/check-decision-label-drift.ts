#!/usr/bin/env npx tsx
/**
 * check-decision-label-drift.ts (#5589)
 *
 * CLI de AUDITORIA (não gate) — ver `scripts/lib/decision-label-drift.ts`
 * pra lógica pura/documentação completa do guard. Este arquivo é só o ponto
 * de entrada de linha de comando, buscando issues abertas + comentários via
 * `gh` e reportando via stdout. Segue o mesmo padrão de
 * `scripts/check-state-changed-pending.ts` / `scripts/lib/issue-decisions.ts`.
 *
 * Sempre sai com `exit 0` — é ferramenta de achado, não gate. Rodar
 * manualmente durante briefing de rodada (overnight/develop/continuo) ou
 * ad-hoc pra auditar drift acumulado. Integração automática numa skill (ex:
 * rodar sozinho na Fase 0) NÃO está implementada nesta unidade — ver
 * sugestão no PR body.
 *
 * Uso:
 *   npx tsx scripts/check-decision-label-drift.ts
 *   npx tsx scripts/check-decision-label-drift.ts --issue 5239
 *   npx tsx scripts/check-decision-label-drift.ts --limit 100 --comments-per-issue 10
 *
 * @see scripts/lib/decision-label-drift.ts
 * @see scripts/lib/issue-decisions.ts (fetchCommentBodies, reusado aqui)
 * @see scripts/lib/issue-exec-track.ts (classificador que este guard mantém honesto)
 */

import { spawnSync } from "node:child_process";
import { isMainModule, parseArgs } from "./lib/cli-args.ts";
import { fetchCommentBodies } from "./lib/issue-decisions.ts";
import { detectLabelDrift, type DriftFinding } from "./lib/decision-label-drift.ts";

interface GhIssueListItem {
  number: number;
  labels?: Array<{ name?: string }>;
}

const DEFAULT_ISSUE_LIMIT = 300;
const DEFAULT_COMMENTS_PER_ISSUE = 20;

export interface FetchOpenIssuesResult {
  issues: GhIssueListItem[];
  /** Presente quando a busca falhou por qualquer motivo — o array `issues`
   * acima fica vazio (ou parcial, nunca) nesse caso e NÃO deve ser lido como
   * "consultei e não achei nada". `main()` imprime isto antes de seguir. */
  error?: string;
}

/** Busca issues abertas (número + labels) via `gh issue list`. Nunca lança —
 * qualquer falha (CLI ausente, sem auth, rate limit, JSON malformado) volta
 * como `{ issues: [], error: "..." }` em vez de `[]` silencioso, pra `main()`
 * poder avisar explicitamente que o resultado abaixo pode estar incompleto. */
export function fetchOpenIssues(cwd: string, limit: number): FetchOpenIssuesResult {
  const result = spawnSync(
    "gh",
    ["issue", "list", "--state", "open", "--json", "number,labels", "--limit", String(limit)],
    { cwd, encoding: "utf8", timeout: 30_000 },
  );
  if (result.error) {
    return { issues: [], error: `gh não pôde ser executado: ${result.error.message}` };
  }
  if (result.status !== 0) {
    const stderr = (result.stderr ?? "").toString().trim();
    return {
      issues: [],
      error: `gh issue list saiu com status ${result.status}${stderr ? `: ${stderr}` : ""}`,
    };
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

function normalizeLabels(issue: GhIssueListItem): string[] {
  return (issue.labels ?? [])
    .map((l) => l.name)
    .filter((n): n is string => typeof n === "string" && n.length > 0);
}

function printFindings(findings: DriftFinding[]): void {
  if (findings.length === 0) {
    console.log("check-decision-label-drift: nenhum drift encontrado.");
    return;
  }
  console.log(
    `check-decision-label-drift: ${findings.length} achado(s) — comentário sugere deferimento/decisão, label estrutural não bate.\n`,
  );
  console.log("issue\tpadrão\tlabels esperadas (any-of)\tlabels atuais\ttrecho do comentário");
  for (const f of findings) {
    const expected = f.expectedLabels.join("|");
    const actual = f.actualLabels.length > 0 ? f.actualLabels.join(",") : "(nenhuma)";
    console.log(`#${f.issueNumber}\t${f.patternId}\t${expected}\t${actual}\t${f.commentExcerpt}`);
  }
  console.log(
    "\nIsto é um achado, não um erro fatal — heurística por regex, não NLP (ver docstring de scripts/lib/decision-label-drift.ts). Confirme antes de aplicar/remover label.",
  );
}

/** Resolve um flag numérico posicional (`--limit`, `--comments-per-issue`)
 * pro default quando ausente, inválido (NaN, typo) ou não-positivo (`0`,
 * negativo) — avisando via `console.error` sempre que o valor passado NÃO
 * for usado, pra não cair no default silenciosamente (diferente de
 * `--issue`, que já validava e avisava algumas linhas acima). */
function resolvePositiveInt(raw: string | undefined, fallback: number, flagName: string): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    console.error(
      `check-decision-label-drift: --${flagName} inválido ("${raw}") — usando default ${fallback}.`,
    );
    return fallback;
  }
  return value;
}

function main(): void {
  const { values } = parseArgs(process.argv.slice(2));
  const cwd = process.cwd();

  const singleIssue = values.issue ? Number(values.issue) : undefined;
  if (values.issue !== undefined && (!Number.isInteger(singleIssue) || (singleIssue as number) <= 0)) {
    console.error(`check-decision-label-drift: --issue inválido: ${values.issue}`);
    process.exitCode = 0; // auditoria — nunca sai != 0
    return;
  }

  const issueLimit = resolvePositiveInt(values.limit, DEFAULT_ISSUE_LIMIT, "limit");
  const commentsPerIssue = resolvePositiveInt(
    values["comments-per-issue"],
    DEFAULT_COMMENTS_PER_ISSUE,
    "comments-per-issue",
  );

  const fetchResult = fetchOpenIssues(cwd, issueLimit);
  if (fetchResult.error) {
    console.error(
      `check-decision-label-drift: falha ao consultar gh issue list — resultado abaixo pode estar incompleto: ${fetchResult.error}`,
    );
  }
  const issues = singleIssue
    ? fetchResult.issues.filter((i) => i.number === singleIssue)
    : fetchResult.issues;

  if (issues.length === 0 && singleIssue) {
    // Issue pode existir mas estar fechada, ou `gh` indisponível — sempre
    // fail-soft, nunca trata como erro do guard em si.
    console.log(`check-decision-label-drift: #${singleIssue} não encontrada entre as issues abertas.`);
    return;
  }

  const allFindings: DriftFinding[] = [];
  for (const issue of issues) {
    const labels = normalizeLabels(issue);
    const comments = fetchCommentBodies(issue.number, cwd);
    // Só os N mais recentes — "comentários recentes" é o escopo pedido pela
    // issue; comentário antigo (pré-sessões de backlog) não é o alvo deste
    // guard e só infla ruído.
    const recentComments = comments.slice(-commentsPerIssue);
    allFindings.push(
      ...detectLabelDrift({ issueNumber: issue.number, labels, commentBodies: recentComments }),
    );
  }

  printFindings(allFindings);
  process.exitCode = 0; // sempre 0 — ferramenta de auditoria, não gate
}

if (isMainModule(import.meta.url)) {
  main();
}
