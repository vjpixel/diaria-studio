/** Automatic timeline persistence for wave dispatch and lifecycle events (#12011). */
import { normalizeIssues } from "./plan-issues-normalize.ts";
import { issueKeyOfPlanEntry, toIssueKey } from "./issue-key.ts";
import { readPlanJson } from "./plan-safe-backup.ts";
import { writeFileAtomic } from "./atomic-write.ts";

export function recordUnitTimeline(
  plan: Record<string, unknown>, ids: readonly (number | string)[],
  event: string, timestamp: string,
): Record<string, unknown> {
  if (!/^(dispatch|pr_opened|ci_green|merged|draft|pulada|fix_iteration_[1-9]\d*)$/.test(event) ||
      !Number.isFinite(Date.parse(timestamp))) return plan;
  const keys = new Set(ids.map(toIssueKey).filter(Boolean));
  const normalized = normalizeIssues<Record<string, unknown>>(plan as import("./plan-issues-normalize.ts").IssuesBearing<Record<string, unknown>>);
  const update = (entry: Record<string, unknown>, index: number) => {
    const key = issueKeyOfPlanEntry(normalized[index]);
    if (!key || !keys.has(key)) return entry;
    const tl = entry.timeline && typeof entry.timeline === "object" && !Array.isArray(entry.timeline)
      ? entry.timeline as Record<string, unknown> : {};
    // Preserve the first observation, including timestamps written by the coordinator.
    if (tl[event]) return entry;
    return { ...entry, timeline: { ...tl, [event]: timestamp } };
  };
  const raw = plan.issues;
  if (Array.isArray(raw)) return { ...plan, issues: raw.map(update) };
  if (raw && typeof raw === "object") {
    return { ...plan, issues: Object.fromEntries(Object.entries(raw).map(([key, entry], index) =>
      [key, update(entry as Record<string, unknown>, index)])) };
  }
  return plan;
}

/** Called only for confirmed successful train outcomes, even before report.md exists. */
export function recordTrainMergedTimeline(planPath: string, prs: readonly number[], timestamp: string): void {
  if (prs.length === 0) return;
  const read = readPlanJson(planPath);
  if (read.status !== "ok") throw new Error(read.message);
  const ids = normalizeIssues<Record<string, unknown>>(read.plan).filter((i) =>
    prs.includes(Number(String(i.pr).replace(/^#/, "")))).map(issueKeyOfPlanEntry).filter((k) => k !== null);
  const next = recordUnitTimeline(read.plan, ids, "merged", timestamp);
  if (JSON.stringify(next) !== JSON.stringify(read.plan)) writeFileAtomic(planPath, JSON.stringify(next, null, 2) + "\n");
}
