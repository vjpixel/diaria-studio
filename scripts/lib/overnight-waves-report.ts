/**
 * scripts/lib/overnight-waves-report.ts (#8496)
 *
 * Leitor de `plan.waves[]` (#8486/#8492) — o que faltava pra a decisão A/B
 * do teto 3→6 (#8486) parar de depender de alguém fazer a conta à mão.
 * Puro (sem I/O — CLI de scan de disco vive em `scripts/report-overnight-waves.ts`).
 *
 * Responde as 3 perguntas que a issue #8496 e o SKILL.md já sabem que
 * importam:
 * - **Distribuição de `unit_count`**: quantas ondas tiveram 1, 2, 3... unidades.
 * - **Fração de ondas com `cap_hit`**: `cap_hit` quase sempre `false` significa
 *   que a fila nunca tinha unidades independentes suficientes pra o teto ser
 *   de fato o limite.
 * - **`pr→merge` p90 segmentado por `cap_hit`**: contexto, não critério. Desde
 *   o trem de merge (#6300) esse trecho mede a fila do merge serial e o
 *   coordenador (#13271), não o número de worktrees; o limiar absoluto de
 *   ~30 min que decidia a reversão do teto ficou defasado (#13270).
 * - **Critério de reversão do teto (v2, #13270)**: compara as ondas cheias
 *   (`cap_hit: true`) com as outras em dois sinais que o teto de fato mexe —
 *   taxa de `draft-ci-vermelho` (trabalho desassistido queimado, o risco que o
 *   teto defende) e `dispatch→PR` p50 (implementadores concorrendo). Ver
 *   `evaluateWaveCapReversal`.
 *
 * `pr→merge` de uma UNIDADE (não de uma issue isolada) é definido como o
 * intervalo entre o `pr_opened` MAIS CEDO e o `merged` MAIS TARDE entre as
 * issues da unidade — mesma convenção de "representante do lote" que
 * `render-overnight-timeline.ts` usa (uma unidade em lote compartilha 1 PR).
 * Unidade sem `pr_opened`+`merged` completos em NENHUMA issue (pulada, CI
 * vermelho persistente, ainda em voo) não entra no p90 — só unidades
 * efetivamente mergeadas respondem "quanto tempo levou".
 */

import { waveIssueKey, type OvernightWaveRecord, type WaveIssueId } from "./overnight-waves.ts";
import { issueKeyOfPlanEntry, type IssueKey } from "./issue-key.ts";
import type { PlanIssue } from "../render-overnight-timeline.ts";

export interface WaveUnitDuration {
  issues: WaveIssueId[];
  cap_hit: boolean;
  /** ms entre o pr_opened mais cedo e o merged mais tarde da unidade; null se incompleto. */
  duration_ms: number | null;
  /** ms entre o dispatch mais cedo e o pr_opened mais cedo da unidade; null se incompleto (#13270). */
  dispatch_to_pr_ms: number | null;
  /**
   * Desfecho da unidade (#13270): `draft` se alguma issue terminou
   * `draft-ci-vermelho`, senão `merged` se alguma terminou `mergeada`, senão
   * `other` (pulada, retida, ainda em voo). Só `draft`/`merged` entram na taxa.
   */
  outcome: "draft" | "merged" | "other";
}

/** Status de `plan.issues[]` que o critério de reversão lê (#13270). */
const DRAFT_STATUS = "draft-ci-vermelho";
const MERGED_STATUS = "mergeada";

/** Pure: índice `owner/repo#N -> PlanIssue` (#10618, fatia 4: por chave, a
 * design#21 não colide com a studio#21), ignorando entradas sem identidade. */
function indexIssuesByKey(issues: PlanIssue[]): Map<IssueKey, PlanIssue> {
  const map = new Map<IssueKey, PlanIssue>();
  for (const issue of issues) {
    const key = issueKeyOfPlanEntry(issue);
    if (key) map.set(key, issue);
  }
  return map;
}

function parseISO(s: string | undefined): number | null {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

/**
 * Pure: computa a duração pr→merge de cada UNIDADE de cada onda, cruzando
 * `waves[].units[].issues` com o `timeline` de cada issue em `issues`
 * (já normalizado — ver `normalizeIssues` de `plan-issues-normalize.ts`).
 */
export function computeWaveUnitDurations(
  waves: OvernightWaveRecord[],
  issues: PlanIssue[],
): WaveUnitDuration[] {
  const byKey = indexIssuesByKey(issues);
  const out: WaveUnitDuration[] = [];
  for (const wave of waves) {
    for (const unit of wave.units) {
      let earliestDispatch: number | null = null;
      let earliestOpen: number | null = null;
      let latestMerged: number | null = null;
      let anyDraft = false;
      let anyMerged = false;
      for (const id of unit.issues) {
        const key = waveIssueKey(id);
        const issue = key ? byKey.get(key) : undefined;
        const tl = issue?.timeline;
        const dispatch = parseISO(tl?.dispatch);
        const open = parseISO(tl?.pr_opened);
        const merged = parseISO(tl?.merged);
        if (dispatch !== null && (earliestDispatch === null || dispatch < earliestDispatch)) earliestDispatch = dispatch;
        if (open !== null && (earliestOpen === null || open < earliestOpen)) earliestOpen = open;
        if (merged !== null && (latestMerged === null || merged > latestMerged)) latestMerged = merged;
        if (issue?.status === DRAFT_STATUS) anyDraft = true;
        if (issue?.status === MERGED_STATUS) anyMerged = true;
      }
      const duration_ms =
        earliestOpen !== null && latestMerged !== null && latestMerged >= earliestOpen
          ? latestMerged - earliestOpen
          : null;
      const dispatch_to_pr_ms =
        earliestDispatch !== null && earliestOpen !== null && earliestOpen >= earliestDispatch
          ? earliestOpen - earliestDispatch
          : null;
      const outcome = anyDraft ? "draft" : anyMerged ? "merged" : "other";
      out.push({ issues: unit.issues, cap_hit: wave.cap_hit, duration_ms, dispatch_to_pr_ms, outcome });
    }
  }
  return out;
}

/** Pure: percentil (0-100) de uma amostra numérica via interpolação linear (nearest-rank simplificado). Amostra vazia -> null. */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  const frac = rank - lo;
  return sorted[lo] + (sorted[hi] - sorted[lo]) * frac;
}

export interface WavesAggregateReport {
  rounds_scanned: number;
  waves_total: number;
  /** unit_count -> quantidade de ondas com esse tamanho. */
  unit_count_distribution: Record<number, number>;
  cap_hit_count: number;
  cap_hit_fraction: number;
  /** Unidades com duração conhecida (pr_opened + merged presentes), por grupo cap_hit. */
  pr_to_merge_p90_ms: { cap_hit_true: number | null; cap_hit_false: number | null };
  /** Tamanho de cada amostra usada no p90 (unidades com duração conhecida). */
  pr_to_merge_sample_size: { cap_hit_true: number; cap_hit_false: number };
  /** Sinais do critério de reversão do teto, por grupo `cap_hit` (#13270). */
  reversal_signals: { cap_hit_true: WaveGroupSignals; cap_hit_false: WaveGroupSignals };
  /** Critério de reversão do teto (v2) avaliado sobre `reversal_signals` (#13270). */
  reversal: WaveCapReversalVerdict;
}

/** Sinais que o teto da onda de fato mexe, num grupo de ondas (#13270). */
export interface WaveGroupSignals {
  /** Unidades com desfecho `draft` (alguma issue `draft-ci-vermelho`). */
  draft: number;
  /** Unidades com desfecho `merged` (sem draft). */
  merged: number;
  /** `draft / (draft + merged)`; null sem nenhuma unidade com desfecho. */
  draft_rate: number | null;
  /** p50 de `dispatch→PR` das unidades com os dois marcos. */
  dispatch_to_pr_p50_ms: number | null;
  dispatch_to_pr_n: number;
}

/**
 * Critério de reversão do teto, v2 (#13270, decisão do editor de 16/11/2026:
 * manter o teto em 10 e rever o critério). O v1 (#8486, mantido no #10821) era
 * `pr→merge` p90 acima de ~30 min nas ondas cheias = voltar a 6. Ficou
 * defasado com o trem de merge (#6300): o `pr→merge` passou a medir a fila do
 * merge serial e o coordenador, que crescem com o número de PRs prontas e não
 * com o de worktrees, e o limiar absoluto disparava em qualquer teto (as ondas
 * sem `cap_hit` também passavam de 30 min, 56m de p90 na leitura da #13270).
 *
 * O v2 compara as ondas cheias com as outras (mesmo instrumento, mesma época)
 * em dois sinais que o teto pode piorar:
 * - **`draft-ci-vermelho`**: trabalho desassistido queimado, o risco que o
 *   teto sempre defendeu. Dispara com taxa das ondas cheias >= `draft_ratio`×
 *   a das outras E pelo menos `draft_min_full` drafts nas cheias (1 contra 0
 *   não é sinal).
 * - **`dispatch→PR` p50**: implementadores concorrendo por máquina e limite de
 *   uso. Dispara com p50 das cheias >= `dispatch_p50_ratio`× o das outras.
 *   p50, não p90: a amostra das cheias é pequena (n=25 na leitura da #13270) e
 *   o p90 de n pequeno é 1 ou 2 unidades.
 *
 * Cada sinal só é avaliado com amostra mínima; sem nenhum avaliável o veredito
 * é `sem-amostra`. Os números são premissa declarada no #13270 (não medidos
 * contra um incidente), revistos pelo editor quando quiser.
 */
export const WAVE_CAP_REVERSAL = {
  /** Unidades com desfecho (draft + merged) exigidas em cada grupo. */
  min_outcomes: 20,
  draft_ratio: 2,
  draft_min_full: 3,
  dispatch_p50_ratio: 1.5,
  /** Unidades com `dispatch→PR` exigidas em cada grupo. */
  dispatch_min_n: 10,
} as const;

export type WaveCapReversalSignal = "draft-ci-vermelho" | "dispatch-pr";

/**
 * Veredito do critério de reversão v2 (#13270):
 * - `sem-amostra`: nenhum dos dois sinais tem amostra mínima.
 * - `nao-disparou`: nenhum sinal avaliado disparou (`evaluated` diz quais foram).
 * - `disparou`: ao menos um sinal disparou (`reasons`). Leitura direta: voltar
 *   o teto a 6. A decisão segue com o editor; o relatório só faz a conta.
 */
export type WaveCapReversalVerdict =
  | { verdict: "sem-amostra" }
  | { verdict: "nao-disparou"; evaluated: WaveCapReversalSignal[] }
  | { verdict: "disparou"; reasons: WaveCapReversalSignal[] };

/** Pure: avalia o critério de reversão v2 a partir dos sinais dos dois grupos. */
export function evaluateWaveCapReversal(signals: {
  cap_hit_true: WaveGroupSignals;
  cap_hit_false: WaveGroupSignals;
}): WaveCapReversalVerdict {
  const full = signals.cap_hit_true;
  const other = signals.cap_hit_false;
  const C = WAVE_CAP_REVERSAL;
  const evaluated: WaveCapReversalSignal[] = [];
  const reasons: WaveCapReversalSignal[] = [];

  if (
    full.draft + full.merged >= C.min_outcomes &&
    other.draft + other.merged >= C.min_outcomes &&
    full.draft_rate !== null &&
    other.draft_rate !== null
  ) {
    evaluated.push("draft-ci-vermelho");
    const ratioHit = other.draft_rate === 0 ? full.draft_rate > 0 : full.draft_rate >= C.draft_ratio * other.draft_rate;
    if (full.draft >= C.draft_min_full && ratioHit) reasons.push("draft-ci-vermelho");
  }

  if (
    full.dispatch_to_pr_n >= C.dispatch_min_n &&
    other.dispatch_to_pr_n >= C.dispatch_min_n &&
    full.dispatch_to_pr_p50_ms !== null &&
    other.dispatch_to_pr_p50_ms !== null &&
    other.dispatch_to_pr_p50_ms > 0
  ) {
    evaluated.push("dispatch-pr");
    if (full.dispatch_to_pr_p50_ms >= C.dispatch_p50_ratio * other.dispatch_to_pr_p50_ms) reasons.push("dispatch-pr");
  }

  if (reasons.length > 0) return { verdict: "disparou", reasons };
  if (evaluated.length === 0) return { verdict: "sem-amostra" };
  return { verdict: "nao-disparou", evaluated };
}

/** Pure: sinais do critério de reversão de um grupo de unidades (#13270). */
export function groupSignals(units: WaveUnitDuration[]): WaveGroupSignals {
  const draft = units.filter((u) => u.outcome === "draft").length;
  const merged = units.filter((u) => u.outcome === "merged").length;
  const d2p = units.filter((u) => u.dispatch_to_pr_ms !== null).map((u) => u.dispatch_to_pr_ms as number);
  return {
    draft,
    merged,
    draft_rate: draft + merged === 0 ? null : draft / (draft + merged),
    dispatch_to_pr_p50_ms: percentile(d2p, 50),
    dispatch_to_pr_n: d2p.length,
  };
}

/**
 * Pure: agrega N rondas (cada uma: `waves[]` + `issues[]` já normalizado) numa
 * `WavesAggregateReport`. Rondas sem `waves` (plano legado, pré-#8486) contam
 * pra `rounds_scanned` mas não contribuem nenhuma onda.
 */
export function aggregateWaveRounds(
  rounds: Array<{ waves?: OvernightWaveRecord[]; issues: PlanIssue[] }>,
): WavesAggregateReport {
  const allWaves: OvernightWaveRecord[] = [];
  const allDurations: WaveUnitDuration[] = [];
  for (const round of rounds) {
    const waves = round.waves ?? [];
    allWaves.push(...waves);
    allDurations.push(...computeWaveUnitDurations(waves, round.issues));
  }

  const unit_count_distribution: Record<number, number> = {};
  let cap_hit_count = 0;
  for (const w of allWaves) {
    unit_count_distribution[w.unit_count] = (unit_count_distribution[w.unit_count] ?? 0) + 1;
    if (w.cap_hit) cap_hit_count++;
  }

  const durTrue = allDurations.filter((d) => d.cap_hit && d.duration_ms !== null).map((d) => d.duration_ms as number);
  const durFalse = allDurations.filter((d) => !d.cap_hit && d.duration_ms !== null).map((d) => d.duration_ms as number);

  const pr_to_merge_p90_ms = {
    cap_hit_true: percentile(durTrue, 90),
    cap_hit_false: percentile(durFalse, 90),
  };
  const reversal_signals = {
    cap_hit_true: groupSignals(allDurations.filter((d) => d.cap_hit)),
    cap_hit_false: groupSignals(allDurations.filter((d) => !d.cap_hit)),
  };
  return {
    rounds_scanned: rounds.length,
    waves_total: allWaves.length,
    unit_count_distribution,
    cap_hit_count,
    cap_hit_fraction: allWaves.length === 0 ? 0 : cap_hit_count / allWaves.length,
    pr_to_merge_p90_ms,
    pr_to_merge_sample_size: {
      cap_hit_true: durTrue.length,
      cap_hit_false: durFalse.length,
    },
    reversal_signals,
    reversal: evaluateWaveCapReversal(reversal_signals),
  };
}

/** Formata ms em "1h23m"/"45m"/"—" — mesmo estilo de `render-overnight-timeline.ts`. */
export function fmtDurationMs(ms: number | null): string {
  if (ms === null) return "—";
  const totalMin = Math.round(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m}m`;
  return `${h}h${String(m).padStart(2, "0")}m`;
}

/**
 * Renderiza o `WavesAggregateReport` em markdown — usado tanto pelo CLI
 * standalone (`report-overnight-waves.ts`) quanto pela linha de resumo da
 * Fase 2 do overnight (#8496 item 2), que embute a versão de UMA rodada só.
 */
export function renderWavesReportMarkdown(report: WavesAggregateReport): string {
  const lines: string[] = [];
  lines.push(`Rondas: ${report.rounds_scanned} | Ondas: ${report.waves_total}`);
  if (report.waves_total === 0) {
    lines.push("Nenhuma onda registrada (plan.json sem `waves[]` — rodadas anteriores ao #8486, ou nenhuma unidade despachada).");
    return lines.join("\n");
  }
  lines.push("");
  lines.push("| unit_count | ondas |");
  lines.push("| --- | --- |");
  for (const k of Object.keys(report.unit_count_distribution).map(Number).sort((a, b) => a - b)) {
    lines.push(`| ${k} | ${report.unit_count_distribution[k]} |`);
  }
  lines.push("");
  lines.push(
    `cap_hit: ${report.cap_hit_count}/${report.waves_total} (${(report.cap_hit_fraction * 100).toFixed(1)}%)`,
  );
  lines.push("");
  lines.push(
    `pr→merge p90 (cap_hit=true): ${fmtDurationMs(report.pr_to_merge_p90_ms.cap_hit_true)} (n=${report.pr_to_merge_sample_size.cap_hit_true})`,
  );
  lines.push(
    `pr→merge p90 (cap_hit=false): ${fmtDurationMs(report.pr_to_merge_p90_ms.cap_hit_false)} (n=${report.pr_to_merge_sample_size.cap_hit_false})`,
  );
  lines.push("(pr→merge é contexto: mede a fila do merge serial e o coordenador, não decide o teto — #13270, #13271.)");
  lines.push("");
  const s = report.reversal_signals;
  lines.push(`draft-ci-vermelho (cap_hit=true): ${fmtDraft(s.cap_hit_true)}`);
  lines.push(`draft-ci-vermelho (cap_hit=false): ${fmtDraft(s.cap_hit_false)}`);
  lines.push(
    `dispatch→PR p50 (cap_hit=true): ${fmtDurationMs(s.cap_hit_true.dispatch_to_pr_p50_ms)} (n=${s.cap_hit_true.dispatch_to_pr_n})`,
  );
  lines.push(
    `dispatch→PR p50 (cap_hit=false): ${fmtDurationMs(s.cap_hit_false.dispatch_to_pr_p50_ms)} (n=${s.cap_hit_false.dispatch_to_pr_n})`,
  );
  lines.push("");
  lines.push(renderReversalLine(report.reversal));
  return lines.join("\n");
}

function fmtDraft(g: WaveGroupSignals): string {
  const total = g.draft + g.merged;
  const pct = g.draft_rate === null ? "—" : `${(g.draft_rate * 100).toFixed(1)}%`;
  return `${g.draft}/${total} unidades com desfecho (${pct})`;
}

const SIGNAL_LABEL: Record<WaveCapReversalSignal, string> = {
  "draft-ci-vermelho": "draft-ci-vermelho",
  "dispatch-pr": "dispatch→PR p50",
};

/** Linha do critério de reversão do teto, v2 (#13270). */
export function renderReversalLine(r: WaveCapReversalVerdict): string {
  const C = WAVE_CAP_REVERSAL;
  const regra =
    `Critério de reversão do teto (ondas cheias contra as outras: draft-ci-vermelho >= ${C.draft_ratio}x e >= ${C.draft_min_full}, ` +
    `ou dispatch→PR p50 >= ${C.dispatch_p50_ratio}x)`;
  switch (r.verdict) {
    case "sem-amostra":
      return `${regra}: sem amostra mínima (${C.min_outcomes} unidades com desfecho ou ${C.dispatch_min_n} com dispatch→PR em cada grupo).`;
    case "nao-disparou":
      return `${regra}: não disparou (avaliado: ${r.evaluated.map((x) => SIGNAL_LABEL[x]).join(", ")}).`;
    case "disparou":
      return `${regra}: DISPAROU (${r.reasons.map((x) => SIGNAL_LABEL[x]).join(", ")}). Leitura direta: voltar o teto a 6; a decisão é do editor.`;
  }
}
