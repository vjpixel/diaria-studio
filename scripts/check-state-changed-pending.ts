#!/usr/bin/env npx tsx
/**
 * check-state-changed-pending.ts (#5476, convergência fundida em #5706)
 *
 * CLI para o gate de "re-triagem pendente" — ver `scripts/lib/state-changed-tracker.ts`
 * para a lógica pura/documentação completa do mecanismo. Este arquivo é só o
 * ponto de entrada de linha de comando, seguindo o mesmo padrão de
 * `scripts/check-overnight-token-instrumentation.ts`.
 *
 * Desde #5706, o modo padrão (checar) também roda a **re-varredura de
 * convergência** da Fase 1 passo 6 (`gh issue list --state open` completo,
 * comparado contra `goal.target_set`/`goal.tiers`/`issues[]` do plano) — um
 * ÚNICO gate cobrindo tanto pendências explícitas quanto issue nova nunca
 * triangulada, em vez de duas checagens de nome parecido e escopo diferente
 * (era a causa raiz do #5706: o coordenador rodou só a pendência explícita,
 * viu "ok" e leu isso como se cobrisse a convergência também). `gh`
 * indisponível/offline não trava a sessão — vira warning em stderr e o
 * comando degrada pro comportamento antigo (só pendência explícita), no
 * espírito fail-soft do #738; `--skip-convergence` faz o mesmo
 * proativamente.
 *
 * Uso:
 *   # checar (modo padrão): sai 1 se houver pendência OU issue nova não-triangulada
 *   npx tsx scripts/check-state-changed-pending.ts --plan data/overnight/260817/plan.json
 *
 *   # pular a re-varredura de convergência (gh indisponível/offline)
 *   npx tsx scripts/check-state-changed-pending.ts --plan {path} --skip-convergence
 *
 *   # registrar pendência (ex: acabou de aplicar uma label de classificação
 *   # ou remover uma claim de session-registry durante a rodada)
 *   npx tsx scripts/check-state-changed-pending.ts --add-pending 5480 --plan data/overnight/260817/plan.json
 *
 *   # resolver pendência (depois de reavaliar dispatch pra essa issue)
 *   npx tsx scripts/check-state-changed-pending.ts --remove-pending 5480 --plan data/overnight/260817/plan.json
 *
 * @see scripts/lib/state-changed-tracker.ts
 * @see scripts/check-overnight-token-instrumentation.ts (padrão de estilo)
 * @see scripts/check-decision-label-drift.ts (padrão de fetch de `gh issue list` fail-soft, reusado aqui)
 * @see .claude/skills/diaria-overnight/SKILL.md
 * @see .claude/skills/diaria-develop/SKILL.md
 * @see .claude/skills/diaria-continuo/SKILL.md
 */

import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import {
  addPendingToPlan,
  checkStateChangedPending,
  checkConvergenceScan,
  recordConvergenceScan,
  type ConvergenceScanIssue,
  type PlanWithGoal,
  removePendingFromPlan,
} from "./lib/state-changed-tracker.ts";

interface GhIssueListItem {
  number: number;
  labels?: Array<{ name?: string } | string>;
  body?: string | null;
}

interface FetchOpenIssuesResult {
  issues: ConvergenceScanIssue[];
  error?: string;
}

// Folga generosa sobre o backlog aberto real (34 issues na medição de
// 260819) — não um teto pensado pra nunca estourar.
// `fetchOpenIssuesForConvergence` compara `issues.length` contra este valor
// e trata bater exatamente como fetch INCOMPLETO (sinal de truncamento
// silencioso do `gh issue list --limit`) em vez de assumir cobertura
// completa sem checar — ver o comentário dentro dessa função.
const CONVERGENCE_ISSUE_LIMIT = 200;

/** Busca as issues abertas (até `CONVERGENCE_ISSUE_LIMIT`, número + labels +
 * body) via `gh issue list` — mesmo padrão fail-soft de
 * `scripts/check-decision-label-drift.ts` (`fetchOpenIssues`): nunca lança,
 * qualquer falha (CLI ausente, sem auth, rate limit, JSON malformado) volta
 * como `{ issues: [], error }` pra `main()` decidir degradar em vez de
 * travar. */
function fetchOpenIssuesForConvergence(cwd: string): FetchOpenIssuesResult {
  const result = spawnSync(
    "gh",
    [
      "issue",
      "list",
      "--state",
      "open",
      "--limit",
      String(CONVERGENCE_ISSUE_LIMIT),
      "--json",
      "number,labels,body",
    ],
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
  const issues = (parsed as GhIssueListItem[]).map((raw) => ({
    number: raw.number,
    labels: (raw.labels ?? [])
      .map((l) => (typeof l === "string" ? l : l?.name))
      .filter((n): n is string => typeof n === "string" && n.length > 0),
    body: raw.body ?? null,
  }));
  // Achado do fleet review (#5713): `--limit N` bate exatamente em N sem
  // sinalizar truncamento — se o backlog aberto real passar do limite, as
  // excedentes ficam invisíveis e o gate reportaria "ok" com issue nova de
  // verdade fora da varredura. Tratado como o MESMO caminho "não avaliado"
  // de qualquer outra falha de fetch (nunca como sucesso parcial) — o
  // chamador cai no fail-soft de `gh` indisponível, que já é honesto sobre
  // não ter rodado (Achado 1 do mesmo review).
  if (issues.length === CONVERGENCE_ISSUE_LIMIT) {
    return {
      issues: [],
      error: `gh issue list retornou exatamente ${CONVERGENCE_ISSUE_LIMIT} issues (o limite) — resultado pode estar truncado, backlog aberto pode ser maior; tratando como fetch incompleto`,
    };
  }
  return { issues };
}

function parseIssueArg(raw: string, flag: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    console.error(`[check-state-changed-pending] --${flag} inválido: ${raw}`);
    process.exit(2);
  }
  return n;
}

if (isMainModule(import.meta.url)) {
  const { values, flags } = parseArgs(process.argv.slice(2));
  const planPath = values.plan;
  if (!planPath) {
    console.error(
      "[check-state-changed-pending] uso: --plan {path} [--add-pending N | --remove-pending N]",
    );
    process.exit(2);
  }

  if (!existsSync(planPath)) {
    console.error(`[check-state-changed-pending] plan.json não encontrado: ${planPath}`);
    process.exit(2);
  }

  if (values["add-pending"] !== undefined) {
    const n = parseIssueArg(values["add-pending"], "add-pending");
    addPendingToPlan(planPath, n);
    console.log(`[check-state-changed-pending] #${n} adicionada a state_changed_issues (${planPath}).`);
    process.exit(0);
  }

  if (values["remove-pending"] !== undefined) {
    const n = parseIssueArg(values["remove-pending"], "remove-pending");
    removePendingFromPlan(planPath, n);
    console.log(`[check-state-changed-pending] #${n} removida de state_changed_issues (${planPath}).`);
    process.exit(0);
  }

  // Modo padrão: checar pendência explícita + (#5706) re-varredura de
  // convergência. Ambas rodam sempre que possível — `exit 1` se qualquer
  // uma achar algo, listando as duas categorias separadamente.
  const pendingResult = checkStateChangedPending(planPath);

  let convergenceMissing: number[] = [];
  // `convergenceRan` distingue "rodou e achou zero" de "não rodou" — achado
  // no self-review (#5706): sem essa distinção, a mensagem de sucesso final
  // reafirmava "nenhuma issue nova fora da varredura" mesmo quando a
  // varredura tinha sido pulada (`--skip-convergence` ou `gh` indisponível),
  // reintroduzindo exatamente a classe de falso-"ok" que este gate existe
  // pra fechar.
  let convergenceRan = false;
  if (flags.has("skip-convergence")) {
    console.error(
      "[check-state-changed-pending] --skip-convergence: pulando re-varredura de convergência (não avaliada nesta invocação).",
    );
  } else {
    const fetched = fetchOpenIssuesForConvergence(process.cwd());
    if (fetched.error) {
      console.error(
        `[check-state-changed-pending] gh indisponível — pulando re-varredura de convergência (fail-soft, #738): ${fetched.error}`,
      );
    } else {
      let planRaw: unknown;
      try {
        planRaw = JSON.parse(readFileSync(planPath, "utf8"));
      } catch (e) {
        console.error(
          `[check-state-changed-pending] plan.json malformado — pulando re-varredura de convergência (fail-soft, #738): ${(e as Error).message}`,
        );
        planRaw = undefined;
      }
      if (planRaw !== undefined) {
        const convergence = checkConvergenceScan(planRaw as PlanWithGoal, fetched.issues);
        convergenceMissing = convergence.status === "missing" ? convergence.issues : [];
        recordConvergenceScan(planPath, convergence.novas_encontradas);
        convergenceRan = true;
      }
    }
  }

  if (pendingResult.status === "ok" && convergenceMissing.length === 0) {
    const convergenceNote = convergenceRan
      ? "nenhuma issue nova fora da varredura"
      : "re-varredura de convergência NÃO executada (--skip-convergence ou gh indisponível) — só pendência explícita foi checada";
    console.log(`ok — nenhuma pendência de re-triagem, ${convergenceNote}`);
    process.exit(0);
  }

  if (pendingResult.status !== "ok") {
    const list = pendingResult.issues.map((n) => `#${n}`).join(", ");
    console.error(
      `pendências de re-triagem: ${list} — reavalie dispatch antes de fechar a rodada`,
    );
  }
  if (convergenceMissing.length > 0) {
    const list = convergenceMissing.map((n) => `#${n}`).join(", ");
    console.error(
      `re-varredura de convergência: issue(s) nova(s) fora de target_set/tiers/issues e não-triangulada(s) (agendada/bloqueada/fora-de-rodada): ${list} — classifique e reavalie dispatch antes de fechar a rodada`,
    );
  }
  process.exit(1);
}
