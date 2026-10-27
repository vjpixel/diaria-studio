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

/** O review tem identidade própria só para o lock. A exclusão de claims
 * vem da sessão que criou a PR, persistida pelo tick no corpo dela.
 * PRs antigas/sem identidade não recebem nenhuma exclusão implícita. */
export function checkContinuoPrSessionClaims(
  repoRoot: () => string, body: unknown, repo = DEFAULT_ISSUE_REPO, now = Date.now(),
): { ok: boolean; reason: string } {
  try {
    const owners = typeof body === "string"
      ? [...body.matchAll(/^<!-- continuo-owner-session: ([A-Za-z0-9_-]+) -->$/gm)].map(m => m[1])
      : [];
    if (owners.length > 1) return { ok: false, reason: "identidade da sessão dona da PR ambígua" };
    return checkPrSessionClaims(repoRoot(), body, owners[0] ?? "", repo, now);
  } catch (e) {
    return { ok: false, reason: `erro ao consultar claims: ${e instanceof Error ? e.message : String(e)}` };
  }
}
