#!/usr/bin/env npx tsx
/**
 * scripts/backfill-overnight-timeline.ts (#12874)
 *
 * Preenche no `plan.json` da rodada os `timeline.pr_opened`, `ci_green` e
 * `merged` que faltam, a partir do estado real das PRs (`gh pr view`). PR
 * fechada pelo trem usa o `mergedAt` do PR-trem. Nunca sobrescreve timestamp
 * já gravado. Lógica pura em `scripts/lib/overnight-timeline-backfill.ts`.
 *
 * Roda sozinho no fim do `run-merge-train.ts --report …` (fail-soft) e pode
 * ser chamado à mão antes do `render-overnight-timeline.ts`:
 *   npx tsx scripts/backfill-overnight-timeline.ts --plan data/overnight/261111b/plan.json [--dry-run]
 *
 * Exit: 0 ok (gravado ou nada a gravar) · 2 uso inválido / plano ausente ou
 * ilegível · 3 alguma PR não pôde ser lida (as lidas são gravadas mesmo assim;
 * falha de `gh` nunca vira "PR sem merge").
 */
import { isMainModule, parseArgs } from "./lib/cli-args.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { readPlanJson } from "./lib/plan-safe-backup.ts";
import { extractTrainPr } from "./lib/overnight-report-reconcile.ts";
import {
  backfillTimelineFromPrFacts,
  ciGreenAtFromRollup,
  studioPrsFromPlan,
  type PrTimelineFacts,
} from "./lib/overnight-timeline-backfill.ts";
import { realGhJson, type GhJson } from "./reconcile-overnight-report.ts";

interface RawView {
  state: string;
  createdAt: string | null;
  mergedAt: string | null;
  comments: Array<{ body?: unknown; authorAssociation?: unknown }>;
  statusCheckRollup: unknown;
}

function viewPr(n: number, gh: GhJson): RawView {
  const r = gh(["pr", "view", String(n), "--json", "state,createdAt,mergedAt,comments,statusCheckRollup"]);
  if (!r.ok) throw new Error(r.error);
  const d = r.data as Record<string, unknown> | null;
  if (typeof d?.state !== "string") throw new Error(`gh pr view ${n}: payload sem state`);
  const str = (v: unknown) => (typeof v === "string" && v ? v : null);
  return {
    state: d.state,
    createdAt: str(d.createdAt),
    mergedAt: str(d.mergedAt),
    comments: Array.isArray(d.comments) ? (d.comments as RawView["comments"]) : [],
    statusCheckRollup: d.statusCheckRollup,
  };
}

/** Fatos de timeline de uma PR, seguindo o PR-trem quando a PR foi fechada por ele. */
export function fetchPrTimelineFacts(pr: number, gh: GhJson, trainCache = new Map<number, RawView>()): PrTimelineFacts {
  const v = viewPr(pr, gh);
  const ownGreen = ciGreenAtFromRollup(v.statusCheckRollup);
  if (v.state === "MERGED") return { pr, createdAt: v.createdAt, ciGreenAt: ownGreen, mergedAt: v.mergedAt };
  const train = v.state === "CLOSED" ? extractTrainPr(v.comments) : null;
  if (train !== null) {
    let tv = trainCache.get(train);
    if (!tv) {
      tv = viewPr(train, gh);
      trainCache.set(train, tv);
    }
    if (tv.state === "MERGED") {
      return { pr, createdAt: v.createdAt, ciGreenAt: ownGreen ?? ciGreenAtFromRollup(tv.statusCheckRollup), mergedAt: tv.mergedAt };
    }
  }
  // Aberta ou fechada sem merge: só o que já aconteceu de fato.
  return { pr, createdAt: v.createdAt, ciGreenAt: ownGreen, mergedAt: null };
}

export interface BackfillCliResult {
  exitCode: number;
  messages: string[];
  filled: string[];
}

export function backfillPlanTimeline(params: { planPath: string; gh: GhJson; dryRun?: boolean; warn?: (m: string) => void }): BackfillCliResult {
  const read = readPlanJson(params.planPath, { warn: params.warn });
  if (read.status !== "ok") return { exitCode: 2, messages: [read.message], filled: [] };
  const facts: PrTimelineFacts[] = [];
  const messages: string[] = [];
  const trainCache = new Map<number, RawView>();
  for (const pr of studioPrsFromPlan(read.plan)) {
    try {
      facts.push(fetchPrTimelineFacts(pr, params.gh, trainCache));
    } catch (err) {
      messages.push(`PR #${pr} não lida, timeline dela fica como está: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const { plan, filled } = backfillTimelineFromPrFacts(read.plan, facts);
  if (filled.length > 0 && !params.dryRun) writeFileAtomic(params.planPath, JSON.stringify(plan, null, 2) + "\n");
  messages.push(
    filled.length === 0
      ? "nada a preencher"
      : `${params.dryRun ? "(dry-run) preencheria" : "preenchido"}: ${filled.join(", ")}`,
  );
  return { exitCode: messages.length > 1 ? 3 : 0, messages, filled };
}

if (isMainModule(import.meta.url)) {
  const { values, flags } = parseArgs(process.argv.slice(2));
  if (!values.plan) {
    console.error("uso: npx tsx scripts/backfill-overnight-timeline.ts --plan <plan.json> [--dry-run]");
    process.exit(2);
  }
  const r = backfillPlanTimeline({ planPath: values.plan, gh: realGhJson, dryRun: flags.has("dry-run") });
  for (const m of r.messages) (r.exitCode === 0 ? console.log : console.error)(`[backfill-overnight-timeline] ${m}`);
  process.exitCode = r.exitCode;
}
