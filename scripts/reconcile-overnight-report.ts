#!/usr/bin/env npx tsx
/**
 * scripts/reconcile-overnight-report.ts (#11461)
 *
 * Grava no fim do `report.md` de uma rodada overnight um bloco com o estado
 * REAL de cada PR da rodada no GitHub (mergeada, mergeada via trem, aberta,
 * fechada sem merge). Roda DEPOIS do último merge — inclusive quando o trem
 * termina depois de a sessão já ter gravado o relatório (rodada agendada
 * 261028: o relatório dizia "Nenhuma unidade mergeada" e o trem mergeou duas
 * PRs depois). Lógica pura em `scripts/lib/overnight-report-reconcile.ts`.
 *
 * PRs da rodada = `issues[].pr` do `plan.json` ∪ `--prs` ∪ (sem
 * `--no-discover`) PRs criadas desde `plan.started_at` que fecham ou
 * referenciam uma issue `in_round` do plano — o plano da 261028 ficou com
 * `pr: null` em todas as entradas.
 *
 * Uso:
 *   npx tsx scripts/reconcile-overnight-report.ts --report data/overnight/261028/report.md
 *   npx tsx scripts/reconcile-overnight-report.ts --report ... [--plan path] [--prs 1,2] [--no-discover] [--check]
 *
 * `--check` não grava: sai 1 se o bloco estiver ausente ou diferente do estado
 * atual (relatório defasado).
 *
 * Exit: 0 ok (gravado, ou `--check` em dia) · 1 `--check` defasado · 2 uso
 * inválido · 3 erro de leitura (relatório/plano/gh). Falha de `gh` nunca vira
 * "nenhuma PR": sai 3 sem tocar no arquivo.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isMainModule, parseArgs } from "./lib/cli-args.ts";
import { spawnGhSync } from "./lib/shared/gh-run.ts";
import {
  classifyPr,
  discoverRoundPrs,
  existingReconcileBody,
  extractTrainPr,
  prsFromPlan,
  renderReconcileBlock,
  renderReconcileBody,
  roundIssuesFromPlan,
  stripReconcileBlock,
  upsertReconcileBlock,
  type PrListItem,
  type PrView,
  type ReconciledPr,
} from "./lib/overnight-report-reconcile.ts";

export type GhJson = (args: string[]) => { ok: true; data: unknown } | { ok: false; error: string };

export const realGhJson: GhJson = (args) => {
  const r = spawnGhSync(args, process.cwd(), 60_000);
  if (r.status !== 0) return { ok: false, error: `gh ${args.slice(0, 3).join(" ")} saiu ${r.status}: ${r.stderr.trim()}` };
  try {
    return { ok: true, data: JSON.parse(r.stdout) };
  } catch {
    return { ok: false, error: `gh ${args.slice(0, 3).join(" ")}: resposta não é JSON` };
  }
};

function viewPr(n: number, gh: GhJson): PrView {
  const r = gh(["pr", "view", String(n), "--json", "number,title,url,state,mergedAt,comments"]);
  if (!r.ok) throw new Error(r.error);
  const d = r.data as Partial<PrView>;
  if (typeof d?.state !== "string") throw new Error(`gh pr view ${n}: payload sem state`);
  return {
    number: n,
    title: typeof d.title === "string" ? d.title : "",
    url: typeof d.url === "string" ? d.url : `#${n}`,
    state: d.state,
    mergedAt: typeof d.mergedAt === "string" && d.mergedAt ? d.mergedAt : null,
    comments: Array.isArray(d.comments) ? d.comments : [],
  };
}

export interface ReconcileResult {
  exitCode: number;
  message: string;
  prs: ReconciledPr[];
}

export function reconcileReport(params: {
  reportPath: string;
  planPath: string;
  extraPrs: number[];
  discover: boolean;
  check: boolean;
  gh: GhJson;
  now?: () => string;
}): ReconcileResult {
  const fail = (message: string): ReconcileResult => ({ exitCode: 3, message, prs: [] });
  if (!existsSync(params.reportPath)) return fail(`relatório não encontrado: ${params.reportPath}`);
  const report = readFileSync(params.reportPath, "utf8");
  let plan: unknown = null;
  if (existsSync(params.planPath)) {
    try {
      plan = JSON.parse(readFileSync(params.planPath, "utf8"));
    } catch (err) {
      return fail(`plan.json ilegível (${params.planPath}): ${(err as Error).message}`);
    }
  }

  const numbers = new Set<number>([...prsFromPlan(plan), ...params.extraPrs]);
  const startedAt = (plan as { started_at?: unknown } | null)?.started_at;
  if (params.discover && typeof startedAt === "string") {
    const r = params.gh(["pr", "list", "--state", "all", "--limit", "200", "--json", "number,createdAt,body"]);
    if (!r.ok) return fail(r.error);
    if (!Array.isArray(r.data)) return fail("gh pr list: resposta não é lista");
    for (const n of discoverRoundPrs(r.data as PrListItem[], startedAt, roundIssuesFromPlan(plan))) numbers.add(n);
  }

  let views: PrView[];
  try {
    views = [...numbers].sort((a, b) => a - b).map((n) => viewPr(n, params.gh));
  } catch (err) {
    return fail((err as Error).message);
  }
  // PR-trem citado nos comentários: precisa do estado dele pra dizer se a original foi mergeada.
  const trainStates = new Map<number, string>();
  for (const v of views) {
    if (v.state !== "CLOSED") continue;
    const t = extractTrainPr(v.comments);
    if (t === null || trainStates.has(t)) continue;
    try {
      trainStates.set(t, viewPr(t, params.gh).state);
    } catch (err) {
      return fail((err as Error).message);
    }
  }
  const prs = views.map((v) => classifyPr(v, trainStates));
  const prose = stripReconcileBlock(report);
  const body = renderReconcileBody(prs, prose);

  if (params.check) {
    const current = existingReconcileBody(report);
    if (current === body) return { exitCode: 0, message: "relatório em dia com o GitHub", prs };
    return {
      exitCode: 1,
      message: current === null ? "relatório sem bloco de reconciliação" : "bloco de reconciliação defasado (estado das PRs mudou)",
      prs,
    };
  }

  const block = renderReconcileBlock(prs, prose, (params.now ?? (() => new Date().toISOString()))());
  writeFileSync(params.reportPath, upsertReconcileBlock(report, block), "utf8");
  return { exitCode: 0, message: `bloco gravado em ${params.reportPath} (${prs.length} PR(s))`, prs };
}

function main(): void {
  const { values, flags } = parseArgs(process.argv.slice(2));
  const usage = "uso: npx tsx scripts/reconcile-overnight-report.ts --report <report.md> [--plan <plan.json>] [--prs N,M] [--no-discover] [--check]";
  if (!values.report) {
    console.error(usage);
    process.exitCode = 2;
    return;
  }
  const extraPrs: number[] = [];
  if (values.prs !== undefined) {
    for (const tok of values.prs.split(",").map((s) => s.trim()).filter(Boolean)) {
      const n = Number(tok.replace(/^#/, ""));
      if (!Number.isInteger(n) || n <= 0) {
        console.error(`--prs: token inválido "${tok}"\n${usage}`);
        process.exitCode = 2;
        return;
      }
      extraPrs.push(n);
    }
  }
  const reportPath = resolve(values.report);
  const planPath = values.plan ? resolve(values.plan) : join(dirname(reportPath), "plan.json");
  const r = reconcileReport({
    reportPath,
    planPath,
    extraPrs,
    discover: !flags.has("no-discover"),
    check: flags.has("check"),
    gh: realGhJson,
  });
  (r.exitCode === 0 ? console.log : console.error)(`[reconcile-overnight-report] ${r.message}`);
  process.exitCode = r.exitCode;
}

if (isMainModule(import.meta.url)) main();
