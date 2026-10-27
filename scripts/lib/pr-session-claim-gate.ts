/** #11372: claims efetivas protegem também o merge, inclusive de PR órfã. */
import { checkSessionsScanHealth, isIssueClaimedByOther } from "./session-registry.ts";
import { extractClosingIssueNumbers } from "./continuo-superseded-check.ts";
import { DEFAULT_ISSUE_REPO } from "./issue-repos.ts";

export function checkPrSessionClaims(
  repoRoot: string, body: unknown, sessionId: string,
  repo = DEFAULT_ISSUE_REPO, now = Date.now(),
): { ok: boolean; reason: string } {
  if (typeof body !== "string") return { ok: false, reason: "corpo da PR ilegível" };
  const health = checkSessionsScanHealth(repoRoot);
  if (!health.ok) return { ok: false, reason: `registry ilegível: ${health.error}` };
  for (const n of extractClosingIssueNumbers(body)) {
    const owner = isIssueClaimedByOther(repoRoot, { repo, number: n }, sessionId, now);
    if (owner) return {
      ok: false,
      reason: `${repo}#${n} reivindicada pela sessão ${owner.sessionId} (${owner.kind}/${owner.machineTag})`,
    };
  }
  return { ok: true, reason: "nenhuma issue reivindicada por outra sessão" };
}
