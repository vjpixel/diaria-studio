#!/usr/bin/env npx tsx
/**
 * #9463 — gate: issue `pulada` por `requer-sessao-local`/`guard-de-execucao`
 * em plan.json não pode continuar na trilha Overnight (seria repescada).
 * Bloqueada/agendada/fechada não é acusada (#9516). exit 1 = há issue sem roteamento (corrigir: route-issue --track develop).
 *
 * Uso: npx tsx scripts/check-skipped-develop-track.ts --plan data/overnight/AAMMDD/plan.json
 */
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import {
  findUnroutedSkips,
  planIssuesRequiringRouting,
  type IssueSnapshot,
  type SkippedPlanIssue,
} from "./lib/skipped-develop-track.ts";
import { normalizeIssues } from "./lib/plan-issues-normalize.ts";

if (isMainModule(import.meta.url)) {
  const { values } = parseArgs(process.argv.slice(2));
  if (!values.plan || !existsSync(values.plan)) {
    console.error("[check-skipped-develop-track] uso: --plan {path existente}");
    process.exit(2);
  }
  const plan = JSON.parse(readFileSync(values.plan, "utf8"));
  const numbers = planIssuesRequiringRouting(plan);
  const snapshots = new Map<number, IssueSnapshot>();
  let ghFailures = 0;
  for (const n of numbers) {
    try {
      const raw = execFileSync("gh", ["api", `repos/vjpixel/diaria-studio/issues/${n}`], { encoding: "utf8" });
      const j = JSON.parse(raw) as { labels: { name: string }[]; body: string | null; state?: string };
      snapshots.set(n, { labels: j.labels.map((l) => l.name), body: j.body ?? "", state: j.state ?? null });
    } catch (e) {
      ghFailures++;
      console.warn(`[check-skipped-develop-track] #${n}: gh falhou, ignorada (${(e as Error).message.split("\n")[0]})`);
    }
  }
  const bad = findUnroutedSkips(normalizeIssues(plan) as SkippedPlanIssue[], snapshots);
  if (ghFailures > 0 && !bad.length) {
    console.error(`[check-skipped-develop-track] ${ghFailures} issue(s) não verificadas (gh falhou) — não dá pra afirmar ok`);
    process.exit(2);
  }
  if (bad.length) {
    console.error(`[check-skipped-develop-track] sem trilha Develop: ${bad.map((n) => "#" + n).join(", ")}`);
    console.error("  corrigir: npx tsx scripts/route-issue.ts --issue N --track develop --reason \"...\"");
    process.exit(1);
  }
  console.log("ok — toda issue pulada por guard/sessão-local está na trilha Develop");
}
