#!/usr/bin/env npx tsx
/** #11372. Exit 0 livre; 1 claim alheia; 3 erro. Reexecutar antes do merge. */
import { spawnSync } from "node:child_process";
import { isMainModule, parseArgs } from "./lib/cli-args.ts";
import { checkPrSessionClaims } from "./lib/pr-session-claim-gate.ts";
import { resolveRepoRoot } from "./lib/session-registry.ts";
import { ISSUE_REPOS_CONFIG_ROOT, resolvePrTargetRepo } from "./lib/issue-repos.ts";

export function run(): number {
  const { values, flags } = parseArgs(process.argv.slice(2));
  const pr = Number(values.pr);
  if (!Number.isInteger(pr) || pr <= 0 || !values["session-id"])
    throw new Error("uso: --pr N --session-id ID [--repo owner/name | --issue ref]");
  const target = resolvePrTargetRepo(values, flags, ISSUE_REPOS_CONFIG_ROOT);
  if ("error" in target) throw new Error(target.error);
  const r = spawnSync("gh", ["pr", "view", String(pr), ...(target.repo ? ["-R", target.repo] : []), "--json", "body"], { encoding: "utf8", timeout: 30_000 });
  if (r.error || r.status !== 0) throw new Error(`gh falhou: ${r.error?.message ?? r.stderr}`);
  const result = checkPrSessionClaims(resolveRepoRoot(ISSUE_REPOS_CONFIG_ROOT), JSON.parse(r.stdout).body, values["session-id"], target.repo);
  console.log(JSON.stringify(result));
  if (!result.ok) console.error(result.reason);
  return result.ok ? 0 : 1;
}
if (isMainModule(import.meta.url)) {
  try { process.exitCode = run(); }
  catch (e) { console.error(String(e)); process.exitCode = 3; }
}
