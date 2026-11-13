/**
 * scripts/lib/overnight-timeline-backfill.ts (#12874)
 *
 * Preenche `timeline.pr_opened`, `timeline.ci_green` e `timeline.merged` das
 * unidades do `plan.json` a partir do estado real das PRs no GitHub.
 *
 * Origem: na rodada 261111b todas as unidades mergeadas pelo trem saíram
 * "em andamento" no `render-overnight-timeline.ts`, sem fim nem duração. O
 * trem só grava `merged` (`recordTrainMergedTimeline`) quando recebe
 * `--report` E a entrada do plano já tem `pr` no instante do merge. O trem
 * nunca grava `pr_opened`/`ci_green`: só o coordenador, via `log-event.ts`,
 * e na 261111b ele não gravou. Este passo lê o que o GitHub já sabe
 * (`createdAt`, `mergedAt`, checks do head) e preenche o que falta, depois
 * do fato. Nunca sobrescreve timestamp já gravado (`recordUnitTimeline`
 * preserva a 1ª observação, inclusive a do coordenador).
 *
 * PR fechada pelo trem (#6300) não tem `mergedAt`: o fim dela é o `mergedAt`
 * do PR-trem citado no comentário de fechamento, e só se o PR-trem estiver
 * de fato MERGED (mesma regra de `classifyPr`, `overnight-report-reconcile.ts`).
 *
 * Puro: nenhuma chamada de rede/disco. CLI: `scripts/backfill-overnight-timeline.ts`.
 */
import { normalizeIssues, type IssuesBearing } from "./plan-issues-normalize.ts";
import { isStudioIssueKey, issueKeyOfPlanEntry } from "./issue-key.ts";
import { recordUnitTimeline } from "./overnight-unit-timeline.ts";

/** O que o GitHub diz de uma PR, já resolvido (PR-trem incluído). */
export interface PrTimelineFacts {
  pr: number;
  createdAt: string | null;
  ciGreenAt: string | null;
  mergedAt: string | null;
}

/** Conclusões de check que contam como verde (CheckRun.conclusion / StatusContext.state). */
const GREEN = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);

/**
 * Instante em que o CI do head ficou verde: o `completedAt` mais recente do
 * `statusCheckRollup`, só quando TODO check concluiu verde. Check pendente,
 * vermelho, rollup vazio ou sem nenhum `completedAt` legível → `null` (não
 * chuta). `StatusContext` (sem `completedAt`) entra só na exigência de verde.
 */
export function ciGreenAtFromRollup(rollup: unknown): string | null {
  if (!Array.isArray(rollup) || rollup.length === 0) return null;
  let latest = Number.NEGATIVE_INFINITY;
  for (const raw of rollup) {
    if (!raw || typeof raw !== "object") return null;
    const c = raw as { conclusion?: unknown; state?: unknown; completedAt?: unknown };
    const verdict = typeof c.conclusion === "string" && c.conclusion ? c.conclusion : c.state;
    if (typeof verdict !== "string" || !GREEN.has(verdict.toUpperCase())) return null;
    const t = typeof c.completedAt === "string" ? Date.parse(c.completedAt) : Number.NaN;
    if (Number.isFinite(t) && t > latest) latest = t;
  }
  return Number.isFinite(latest) ? new Date(latest).toISOString() : null;
}

/** `pr` de uma entrada do plano (número ou "#N"); `null` se ausente/ilegível. */
export function planEntryPr(entry: { pr?: unknown }): number | null {
  const raw = entry?.pr;
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw.replace(/^#/, "")) : Number.NaN;
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** PRs do diaria-studio citadas no plano (`issues[].pr`, array ou dict), sem repetir. */
export function studioPrsFromPlan(plan: Record<string, unknown>): number[] {
  const out = new Set<number>();
  for (const entry of normalizeIssues<Record<string, unknown>>(plan as IssuesBearing<Record<string, unknown>>)) {
    const key = issueKeyOfPlanEntry(entry);
    // PR de outro repo pode ter o mesmo número de uma PR do studio (#10618).
    if (!key || !isStudioIssueKey(key)) continue;
    const pr = planEntryPr(entry);
    if (pr !== null) out.add(pr);
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * Entradas do studio com `pr` PRESENTE mas ilegível (ex. `"abc"`, `0`): não
 * podem sumir em silêncio do backfill, viram mensagem (`chave: pr=<valor>`).
 */
export function unparseablePrEntries(plan: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const entry of normalizeIssues<Record<string, unknown>>(plan as IssuesBearing<Record<string, unknown>>)) {
    const key = issueKeyOfPlanEntry(entry);
    if (!key || !isStudioIssueKey(key)) continue;
    const raw = entry.pr;
    if (raw === undefined || raw === null || raw === "") continue;
    if (planEntryPr(entry) === null) out.push(`${key}: pr=${JSON.stringify(raw)}`);
  }
  return out;
}

export interface BackfillResult {
  plan: Record<string, unknown>;
  /** Eventos efetivamente gravados, `pr:evento` (ex. `12838:merged`). */
  filled: string[];
}

/**
 * Pure: grava os eventos que faltam nas entradas cujo `pr` tem fatos.
 * `ci_green` depois do `merged` é descartado (rerun pós-merge, não o verde
 * que liberou o merge).
 */
export function backfillTimelineFromPrFacts(
  plan: Record<string, unknown>,
  facts: readonly PrTimelineFacts[],
): BackfillResult {
  const entries = normalizeIssues<Record<string, unknown>>(plan as IssuesBearing<Record<string, unknown>>);
  let next = plan;
  const filled: string[] = [];
  for (const f of facts) {
    const keys = entries
      .filter((e) => planEntryPr(e) === f.pr)
      .map(issueKeyOfPlanEntry)
      .filter((k): k is NonNullable<typeof k> => k !== null && isStudioIssueKey(k));
    if (keys.length === 0) continue;
    const merged = f.mergedAt && Number.isFinite(Date.parse(f.mergedAt)) ? f.mergedAt : null;
    let ciGreen = f.ciGreenAt;
    if (ciGreen && merged && Date.parse(ciGreen) > Date.parse(merged)) ciGreen = null;
    const events: Array<[string, string | null]> = [["pr_opened", f.createdAt], ["ci_green", ciGreen], ["merged", merged]];
    for (const [event, ts] of events) {
      if (!ts) continue;
      const after = recordUnitTimeline(next, keys, event, ts);
      if (JSON.stringify(after) !== JSON.stringify(next)) filled.push(`${f.pr}:${event}`);
      next = after;
    }
  }
  return { plan: next, filled };
}
