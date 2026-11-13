#!/usr/bin/env npx tsx
/**
 * scripts/backfill-overnight-timeline.ts (#12874)
 *
 * Preenche no `plan.json` da rodada os `timeline.pr_opened`, `ci_green` e
 * `merged` que faltam, a partir do estado real das PRs (`gh pr view`). PR
 * fechada pelo trem usa o `mergedAt` do PR-trem (o `ci_green` é sempre o da
 * própria PR). Nunca sobrescreve timestamp já gravado. Lógica pura em
 * `scripts/lib/overnight-timeline-backfill.ts`.
 *
 * Roda sozinho quando o `run-merge-train.ts` com `--report` chega ao fim
 * (`finish`, fail-soft) e pode ser chamado à mão antes do
 * `render-overnight-timeline.ts`:
 *   npx tsx scripts/backfill-overnight-timeline.ts --plan data/overnight/261111b/plan.json [--dry-run]
 *
 * `--dry-run` não grava o backfill, mas a leitura do plano (`readPlanJson`)
 * ainda pode restaurar o `plan.json` a partir de uma cópia de conflito.
 *
 * Exit: 0 ok (gravado ou nada a gravar) · 2 uso inválido / plano ausente ou
 * ilegível · 3 parcial: alguma PR não pôde ser lida ou alguma entrada tem
 * `pr` ilegível (as lidas são gravadas mesmo assim; falha de `gh` nunca vira
 * "PR sem merge").
 */
import { isMainModule, parseArgs } from "./lib/cli-args.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { readPlanJson } from "./lib/plan-safe-backup.ts";
import { extractTrainPr } from "./lib/overnight-report-reconcile.ts";
import {
  backfillTimelineFromPrFacts,
  ciGreenAtFromRollup,
  studioPrsFromPlan,
  unparseablePrEntries,
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

/**
 * Cache do PR-trem: guarda a leitura E a falha. Um PR-trem cobre várias
 * unidades; sem guardar a falha, cada unidade repetiria a chamada (até 60s
 * de timeout do `gh` cada).
 */
type TrainCache = Map<number, RawView | Error>;

/**
 * Fatos de timeline de uma PR, seguindo o PR-trem quando a PR foi fechada por
 * ele. O `ci_green` é sempre o do head da PRÓPRIA unidade: o rollup do
 * PR-trem é o verde do lote, não o que liberou a unidade, então sem verde
 * próprio fica `null`.
 */
export function fetchPrTimelineFacts(pr: number, gh: GhJson, trainCache: TrainCache = new Map()): PrTimelineFacts {
  const v = viewPr(pr, gh);
  const ownGreen = ciGreenAtFromRollup(v.statusCheckRollup);
  if (v.state === "MERGED") return { pr, createdAt: v.createdAt, ciGreenAt: ownGreen, mergedAt: v.mergedAt };
  const train = v.state === "CLOSED" ? extractTrainPr(v.comments) : null;
  if (train !== null) {
    let tv = trainCache.get(train);
    if (tv === undefined) {
      try {
        tv = viewPr(train, gh);
      } catch (err) {
        tv = err instanceof Error ? err : new Error(String(err));
      }
      trainCache.set(train, tv);
    }
    if (tv instanceof Error) throw new Error(`PR-trem #${train}: ${tv.message}`);
    if (tv.state === "MERGED") return { pr, createdAt: v.createdAt, ciGreenAt: ownGreen, mergedAt: tv.mergedAt };
  }
  // Aberta ou fechada sem merge: só o que já aconteceu de fato.
  return { pr, createdAt: v.createdAt, ciGreenAt: ownGreen, mergedAt: null };
}

/** 0 ok · 2 plano ausente/ilegível · 3 parcial (alguma PR não lida ou `pr` ilegível). */
type BackfillExitCode = 0 | 2 | 3;

export interface BackfillCliResult {
  exitCode: BackfillExitCode;
  messages: string[];
  filled: string[];
}

/**
 * Lê o plano para saber as PRs, busca os fatos no `gh` (lento) e só então
 * RELÊ o plano e aplica + grava em sequência: o coordenador pode ter gravado
 * no plano durante as chamadas ao `gh`, e aplicar sobre a 1ª leitura
 * apagaria essa escrita (lost update).
 *
 * `--dry-run` não grava o backfill, mas `readPlanJson` ainda pode restaurar
 * o plano a partir de uma cópia de conflito (`plan-safe-backup.ts`), como em
 * qualquer leitor do plano.
 */
export function backfillPlanTimeline(params: { planPath: string; gh: GhJson; dryRun?: boolean; warn?: (m: string) => void }): BackfillCliResult {
  const first = readPlanJson(params.planPath, { warn: params.warn });
  if (first.status !== "ok") return { exitCode: 2, messages: [first.message], filled: [] };
  const facts: PrTimelineFacts[] = [];
  const messages: string[] = [];
  let failures = 0;
  for (const bad of unparseablePrEntries(first.plan)) {
    failures++;
    messages.push(`entrada com pr ilegível, timeline dela fica como está: ${bad}`);
  }
  const trainCache: TrainCache = new Map();
  for (const pr of studioPrsFromPlan(first.plan)) {
    try {
      facts.push(fetchPrTimelineFacts(pr, params.gh, trainCache));
    } catch (err) {
      failures++;
      messages.push(`PR #${pr} não lida, timeline dela fica como está: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const fresh = readPlanJson(params.planPath, { warn: params.warn });
  if (fresh.status !== "ok") return { exitCode: 2, messages: [...messages, fresh.message], filled: [] };
  const { plan, filled } = backfillTimelineFromPrFacts(fresh.plan, facts);
  if (filled.length > 0 && !params.dryRun) writeFileAtomic(params.planPath, JSON.stringify(plan, null, 2) + "\n");
  messages.push(
    filled.length === 0
      ? "nada a preencher"
      : `${params.dryRun ? "(dry-run) preencheria" : "preenchido"}: ${filled.join(", ")}`,
  );
  return { exitCode: failures > 0 ? 3 : 0, messages, filled };
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
