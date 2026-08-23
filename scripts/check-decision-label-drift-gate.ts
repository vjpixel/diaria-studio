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
import { detectLabelDrift, type DriftFinding } from "./lib/decision-label-drift.ts";
import { classifyExecTrack } from "./lib/issue-exec-track.ts";

/** Entrada do `plan.json` que este gate consome. `motivo`/`scope_note` são
 * onde o coordenador grava POR QUE pulou a issue (#5955). */
interface PlanIssueEntry {
  number: number;
  in_round?: boolean;
  motivo?: string;
  scope_note?: string;
}

/** Textos de prosa do plano pra uma issue, sem vazios. */
function planTextsFor(entry: PlanIssueEntry): string[] {
  return [entry.motivo, entry.scope_note].filter(
    (t): t is string => typeof t === "string" && t.trim().length > 0,
  );
}

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
function fetchOpenIssues(cwd: string): FetchOpenIssuesResult {
  const result = spawnSync(
    "gh",
    ["issue", "list", "--state", "open", "--json", "number,labels,body", "--limit", String(DRIFT_ISSUE_LIMIT)],
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
): { comments: string[] | null; error?: string } {
  const result = spawnSync(
    "gh",
    ["issue", "view", String(issue), "--json", "comments"],
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
    const parsed = JSON.parse(result.stdout) as { comments?: Array<{ body?: string }> };
    const comments = (parsed.comments ?? []).map((c) => c.body ?? "").filter((b): b is string => typeof b === "string" && b.length > 0);
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

  // Escopo do gate: as issues do PLANO da rodada (nunca todas as abertas) —
  // não reportar drift em issue que esta rodada nem olhou.
  //
  // Dentro desse escopo há duas fontes de prosa, com alcances diferentes de
  // propósito (#5955):
  //
  //   - COMENTÁRIOS: só `in_round: true`. Custam um `gh issue view` por issue,
  //     e o comportamento original do gate era este.
  //   - `motivo`/`scope_note` do plano: TODAS as issues do plano, inclusive
  //     `in_round: false`. É a correção central — a skill grava `in_round:
  //     false` justamente nas issues excluídas ANTES do despacho
  //     (`bloqueada-externa`, `fora-do-escopo`, `ambígua/trade-off-real`;
  //     SKILL.md passo 4), ou seja, as que mais provavelmente carregam um
  //     veredito que nunca virou label. Filtrar essas fora deixava o gate
  //     cego exatamente onde ele é mais necessário. Custo zero: os campos já
  //     estão no plano em disco, nenhuma chamada de rede a mais.
  const issues = normalizeIssues<PlanIssueEntry>(planRaw as IssuesBearing<PlanIssueEntry>);
  const planByNumber = new Map<number, PlanIssueEntry>();
  for (const entry of issues) planByNumber.set(entry.number, entry);
  const issueNumbers = new Set(issues.map((i) => i.number));

  const cwd = process.cwd();

  // Buscar todas as issues abertas para pegar labels atuais
  const fetched = fetchOpenIssues(cwd);
  if (fetched.error) {
    console.error(
      `[check-decision-label-drift-gate] gh indisponível — pulando checagem de drift de label (fail-soft, #738): ${fetched.error}`,
    );
    process.exit(0);
  }

  const allFindings: DriftFinding[] = [];
  let ghUnavailable = false;

  for (const issue of fetched.issues) {
    // Só checar issues que estão no plano da rodada
    if (!issueNumbers.has(issue.number)) continue;

    const entry = planByNumber.get(issue.number);
    const labels = normalizeLabels(issue);
    const planTexts = entry ? planTextsFor(entry) : [];

    // Filtro de precisão (#5955): só bloqueia a rodada por issue que AINDA
    // classifica como `overnight` — é o único caso em que a label faltante
    // muda o roteamento e a issue volta pra fila toda rodada. Todas as issues
    // aqui vêm de `gh issue list --state open`, daí o `state` fixo.
    const currentTrack = classifyExecTrack({ labels, body: issue.body, state: "OPEN" });
    if (currentTrack !== "overnight") continue;

    let commentBodies: string[] = [];
    if (entry?.in_round === true) {
      const commentsResult = fetchIssueComments(issue.number, cwd);
      if (commentsResult.error) {
        console.error(
          `[check-decision-label-drift-gate] falha ao buscar comentários de #${issue.number} (fail-soft, #738): ${commentsResult.error}`,
        );
        if (commentsResult.error.startsWith("gh não pôde ser executado")) ghUnavailable = true;
        // Sem os comentários, ainda dá pra avaliar a prosa do plano — não
        // abortar a issue inteira por causa de uma falha de fetch.
      } else {
        commentBodies = commentsResult.comments ?? [];
      }
    }

    if (commentBodies.length === 0 && planTexts.length === 0) continue;

    const findings = detectLabelDrift({
      issueNumber: issue.number,
      labels,
      commentBodies,
      planTexts,
      currentTrack,
    });
    allFindings.push(...findings);
  }

  if (ghUnavailable) {
    console.error(
      "[check-decision-label-drift-gate] gh indisponível — pulando checagem de drift de label (fail-soft, #738).",
    );
    process.exit(0);
  }

  if (allFindings.length === 0) {
    console.log("ok — nenhum drift de label de decisão detectado nas issues da rodada");
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
    console.error(`#${f.issueNumber}\t${f.patternId}\t${fonte}\t${expected}\t${actual}\t${f.commentExcerpt}`);
  }
  console.error("");
  console.error("Isto é um achado de auditoria (heurística por regex, não NLP). Confirme antes de aplicar/remover label.");
  console.error("Aplique as labels esperadas nas issues listadas (gh issue edit N --add-label ...) antes de fechar a rodada.");

  process.exit(1);
}