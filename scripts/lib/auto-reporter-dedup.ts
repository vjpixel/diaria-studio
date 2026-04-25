/**
 * auto-reporter-dedup.ts
 *
 * Pure dedup logic for the auto-reporter agent (Stage final, multi-edition).
 * Extracted from `.claude/agents/auto-reporter.md` so the consolidation rules
 * are testable and resistant to silent prompt drift across model updates.
 *
 * The agent is expected to call `consolidateSignals()` over the draft files
 * collected from N editions; the result is the list it presents to the
 * editor in the gate.
 *
 * Refs #91 (follow-up to #90 / PR #86).
 */

export type SignalKind = "source_streak" | "unfixed_issue" | "chrome_disconnects";
export type Severity = "low" | "medium" | "high";

export interface Signal {
  kind: SignalKind;
  severity: Severity;
  title: string;
  details: Record<string, unknown>;
  suggested_action?: string;
  related_issue?: string;
  /** Set during consolidation: edition that originated this signal. */
  _edition?: string;
  /** Set after consolidation: all editions where the signal recurred. */
  _editions?: string[];
}

export interface DraftFile {
  edition: string;
  collected_at: string;
  signals: Signal[];
}

/**
 * Returns the dedup key for a signal. Signals that share a key consolidate
 * into one entry.
 *
 * - `source_streak`: keyed by `details.source` so failures of the same source
 *   across editions become a single signal.
 * - `unfixed_issue`: keyed by `details.reason` + `details.section` so the
 *   same recurring problem (e.g. "unicode_corruption" in "subtitle") merges.
 * - `chrome_disconnects`: a single shared key — always consolidate counts.
 *
 * Returns null if the signal lacks the data needed to dedup. Such signals
 * pass through untouched.
 */
export function dedupKey(signal: Signal): string | null {
  switch (signal.kind) {
    case "source_streak": {
      const source = signal.details?.source;
      return typeof source === "string" && source.length > 0
        ? `source_streak:${source}`
        : null;
    }
    case "unfixed_issue": {
      const reason = signal.details?.reason;
      const section = signal.details?.section ?? "";
      if (typeof reason !== "string" || reason.length === 0) return null;
      return `unfixed_issue:${reason}:${section}`;
    }
    case "chrome_disconnects":
      return "chrome_disconnects";
    default:
      return null;
  }
}

/**
 * Severity escalates: low < medium < high. Used when consolidating to keep
 * the worst observed severity across editions.
 */
const SEVERITY_RANK: Record<Severity, number> = { low: 0, medium: 1, high: 2 };

function maxSeverity(a: Severity, b: Severity): Severity {
  return SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b;
}

/**
 * Adds two `count` fields when both are numbers; otherwise prefers whichever
 * is numeric. Used by chrome_disconnects consolidation.
 */
function combineCount(a: unknown, b: unknown): number | undefined {
  const an = typeof a === "number" ? a : null;
  const bn = typeof b === "number" ? b : null;
  if (an === null && bn === null) return undefined;
  return (an ?? 0) + (bn ?? 0);
}

/**
 * Merges two signals that share a dedup key. The first signal's title, kind,
 * suggested_action, and related_issue are preserved; severity escalates;
 * `_editions` accumulates; chrome_disconnects sums any `details.count`.
 */
export function mergeSignals(a: Signal, b: Signal): Signal {
  const editionsFromA = a._editions ?? (a._edition ? [a._edition] : []);
  const editionsFromB = b._editions ?? (b._edition ? [b._edition] : []);
  const merged: Signal = {
    ...a,
    severity: maxSeverity(a.severity, b.severity),
    _editions: dedupedEditions([...editionsFromA, ...editionsFromB]),
  };
  delete merged._edition;

  if (a.kind === "chrome_disconnects" && b.kind === "chrome_disconnects") {
    const summed = combineCount(a.details?.count, b.details?.count);
    if (summed !== undefined) {
      merged.details = { ...a.details, count: summed };
    }
  }

  return merged;
}

function dedupedEditions(editions: string[]): string[] {
  return [...new Set(editions)].sort();
}

/**
 * Top-level: takes drafts from N editions and returns a flat list of
 * signals where same-key signals are merged. Signal order is stable per
 * dedup-key first-seen across the input drafts, then by edition.
 */
export function consolidateSignals(drafts: DraftFile[]): Signal[] {
  // First pass: tag each signal with its edition for traceability.
  const tagged: Signal[] = [];
  for (const draft of drafts) {
    for (const sig of draft.signals) {
      tagged.push({ ...sig, _edition: draft.edition });
    }
  }

  // Second pass: group by dedup key (stable order: first occurrence wins).
  const buckets = new Map<string, Signal>();
  const passthrough: Signal[] = [];

  for (const sig of tagged) {
    const key = dedupKey(sig);
    if (key === null) {
      // Cannot consolidate — keep alone.
      passthrough.push(sig);
      continue;
    }
    const existing = buckets.get(key);
    if (existing) {
      buckets.set(key, mergeSignals(existing, sig));
    } else {
      // Pre-fill _editions even if it stays a single-item array, so callers
      // see consistent shape.
      buckets.set(key, {
        ...sig,
        _editions: sig._edition ? [sig._edition] : [],
      });
    }
  }

  // Strip _edition from grouped entries; they all carry _editions instead.
  const grouped = Array.from(buckets.values()).map((s) => {
    const { _edition: _omit, ...rest } = s;
    return rest;
  });

  return [...grouped, ...passthrough];
}
