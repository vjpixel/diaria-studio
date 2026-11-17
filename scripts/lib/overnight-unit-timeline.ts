/** Automatic timeline persistence for wave dispatch and lifecycle events (#12011). */
import { normalizeIssues } from "./plan-issues-normalize.ts";
import { isStudioIssueKey, issueKeyOfPlanEntry, toIssueKey } from "./issue-key.ts";
import { readPlanJson } from "./plan-safe-backup.ts";
import { writeFileAtomic } from "./atomic-write.ts";

/**
 * Marcos de timeline que `recordUnitTimeline` grava (#12011). Fonte ÚNICA: o
 * `log-event.ts` usa o mesmo predicado para decidir se persiste o evento, em
 * vez de repetir a regex (#13271: duas cópias divergentes deixariam um marco
 * novo aceito por uma e descartado em silêncio pela outra).
 *
 * `review_done` (#13271): review e tratamento dos findings concluídos sobre o
 * HEAD avaliado. `gate2` (#13271): as condições do Gate 2 passaram sobre o
 * mesmo HEAD (CI, threads, retido). Separados de `ci_green` para medir onde
 * vai o tempo entre a PR aberta e o merge.
 */
export const TIMELINE_EVENT_RE = /^(dispatch|pr_opened|ci_green|review_done|gate2|merged|draft|pulada|fix_iteration_[1-9]\d*)$/;

export function isTimelineEvent(event: string): boolean {
  return TIMELINE_EVENT_RE.test(event);
}

export function recordUnitTimeline(
  plan: Record<string, unknown>, ids: readonly (number | string)[],
  event: string, timestamp: string,
): Record<string, unknown> {
  if (!isTimelineEvent(event) ||
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
  // The train only merges diaria-studio PRs: a PR number is only meaningful
  // for studio issues (another repo's PR may share the same number).
  const ids = normalizeIssues<Record<string, unknown>>(read.plan)
    .filter((i) => prs.includes(Number(String(i.pr).replace(/^#/, ""))))
    .map(issueKeyOfPlanEntry)
    .filter((k): k is NonNullable<typeof k> => k !== null && isStudioIssueKey(k));
  const next = recordUnitTimeline(read.plan, ids, "merged", timestamp);
  if (JSON.stringify(next) !== JSON.stringify(read.plan)) writeFileAtomic(planPath, JSON.stringify(next, null, 2) + "\n");
}
