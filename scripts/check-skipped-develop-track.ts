#!/usr/bin/env npx tsx
/**
 * #9463 — gate: issue `pulada` por `requer-sessao-local`/`guard-de-execucao`
 * em plan.json não pode continuar na trilha Overnight (seria repescada).
 * Bloqueada/agendada/fechada não é acusada (#9516). exit 1 = há issue sem roteamento (corrigir: route-issue --track develop).
 *
 * #10618 (fatia 3): entrada de outro repo (`"vjpixel/diaria-design#21"`) é
 * consultada no repo DELA (`gh api repos/{owner}/{repo}/issues/N`), nunca na
 * studio#21. Repo fora da allowlist `platform.config.json → issue_repos` e
 * identidade desconhecida contam como não verificadas (exit 2 se nada mais
 * reprovar), igual a uma falha de `gh`.
 *
 * Uso: npx tsx scripts/check-skipped-develop-track.ts --plan data/overnight/AAMMDD/plan.json
 */
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import {
  findUnroutedSkipKeys,
  planIssueKeysRequiringRouting,
  type IssueSnapshot,
  type SkippedPlanIssue,
} from "./lib/skipped-develop-track.ts";
import { normalizeIssues } from "./lib/plan-issues-normalize.ts";
import { loadIssueRepos } from "./lib/issue-repos.ts";
import { issueKeyLabel, issueNumberInRepo, repoOfIssueKey, type IssueKey } from "./lib/issue-key.ts";

if (isMainModule(import.meta.url)) {
  const { values } = parseArgs(process.argv.slice(2));
  if (!values.plan || !existsSync(values.plan)) {
    console.error("[check-skipped-develop-track] uso: --plan {path existente}");
    process.exit(2);
  }
  const plan = JSON.parse(readFileSync(values.plan, "utf8"));
  const { keys, unknownEntries } = planIssueKeysRequiringRouting(plan);
  const allowlist = new Set(loadIssueRepos(process.cwd()));
  const snapshots = new Map<IssueKey, IssueSnapshot>();
  let ghFailures = unknownEntries.length;
  for (const d of unknownEntries) {
    console.warn(`[check-skipped-develop-track] ${d}: identidade desconhecida (repo/ref ilegível) — não verificada`);
  }
  for (const key of keys) {
    const repo = repoOfIssueKey(key);
    const label = issueKeyLabel(key);
    if (!allowlist.has(repo)) {
      ghFailures++;
      console.warn(`[check-skipped-develop-track] ${label}: ${repo} fora de issue_repos — não verificada`);
      continue;
    }
    try {
      const raw = execFileSync("gh", ["api", `repos/${repo}/issues/${issueNumberInRepo(key)}`], { encoding: "utf8" });
      const j = JSON.parse(raw) as { labels: { name: string }[]; body: string | null; state?: string };
      snapshots.set(key, { labels: j.labels.map((l) => l.name), body: j.body ?? "", state: j.state ?? null });
    } catch (e) {
      ghFailures++;
      console.warn(`[check-skipped-develop-track] ${label}: gh falhou, ignorada (${(e as Error).message.split("\n")[0]})`);
    }
  }
  const bad = findUnroutedSkipKeys(normalizeIssues(plan) as SkippedPlanIssue[], snapshots);
  if (ghFailures > 0 && !bad.length) {
    console.error(
      `[check-skipped-develop-track] ${ghFailures} issue(s) não verificadas (gh falhou, repo fora de issue_repos ou identidade desconhecida — ver avisos acima) — não dá pra afirmar ok`,
    );
    process.exit(2);
  }
  if (bad.length) {
    console.error(`[check-skipped-develop-track] sem trilha Develop: ${bad.map(issueKeyLabel).join(", ")}`);
    console.error("  corrigir: npx tsx scripts/route-issue.ts --issue N --track develop --reason \"...\"  (outro repo: --issue owner/repo#N)");
    process.exit(1);
  }
  console.log("ok — toda issue pulada por guard/sessão-local está na trilha Develop");
}
