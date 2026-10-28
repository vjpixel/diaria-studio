/**
 * scripts/lib/overnight-report-reconcile.ts (#11461)
 *
 * Reconcilia o `report.md` de uma rodada overnight com o estado REAL das PRs
 * no GitHub, depois do último merge.
 *
 * Origem: a rodada agendada 261028 gravou "Nenhuma unidade mergeada" e
 * encerrou (sessão single-turn); o trem de merge mergeou #11436 e #11438
 * depois disso e ninguém regravou o relatório — a superfície de Relatórios
 * (`/relatorios`) mentia sobre a rodada. A prosa do relatório é escrita
 * num instante; o estado das PRs muda depois. Este módulo não reescreve a
 * prosa: mantém, no fim do arquivo, um bloco delimitado com o estado de cada
 * PR lido do GitHub, idempotente (rodar de novo só substitui o bloco).
 *
 * Puro: nenhuma chamada de rede/disco. O CLI
 * (`scripts/reconcile-overnight-report.ts`) busca os dados e grava o arquivo.
 */
import { parseClosesIssues } from "./merge-train.ts";
import { isTrustedCommentAuthor } from "./trusted-comment-author.ts";

export const RECONCILE_START = "<!-- overnight-reconcile:start -->";
export const RECONCILE_END = "<!-- overnight-reconcile:end -->";

export type PrFinalState = "merged" | "merged-via-train" | "open" | "closed";

export interface PrView {
  number: number;
  title: string;
  url: string;
  /** `OPEN` | `CLOSED` | `MERGED` (gh pr view --json state). */
  state: string;
  mergedAt: string | null;
  comments: Array<{ body?: unknown; authorAssociation?: unknown }>;
}

export interface ReconciledPr {
  number: number;
  title: string;
  url: string;
  state: PrFinalState;
  /** PR-trem que levou esta PR pra master (só `merged-via-train`). */
  trainPr?: number;
  mergedAt?: string | null;
}

/** Comentário que o trem posta na PR original antes de fechá-la (`merge-train-live.ts`). */
const TRAIN_COMMENT_RE = /Mergeado via trem de merge \(#6300\) — PR-trem #(\d+)/;

/** PR-trem citado num comentário de autor confiável (item 30: autor sem vínculo não conta). */
export function extractTrainPr(comments: PrView["comments"]): number | null {
  for (const c of comments) {
    if (!isTrustedCommentAuthor(c)) continue;
    const m = typeof c.body === "string" ? TRAIN_COMMENT_RE.exec(c.body) : null;
    if (m) return Number(m[1]);
  }
  return null;
}

/**
 * Estado final de uma PR. PR fechada pelo trem só conta como mergeada se o
 * PR-trem citado estiver de fato MERGED (`trainStates`); senão é `closed`.
 */
export function classifyPr(view: PrView, trainStates: ReadonlyMap<number, string>): ReconciledPr {
  const base = { number: view.number, title: view.title, url: view.url };
  if (view.state === "MERGED") return { ...base, state: "merged", mergedAt: view.mergedAt };
  if (view.state === "OPEN") return { ...base, state: "open" };
  const train = extractTrainPr(view.comments);
  if (train !== null && trainStates.get(train) === "MERGED") return { ...base, state: "merged-via-train", trainPr: train };
  return { ...base, state: "closed" };
}

/** PRs citadas no `plan.json` (`issues[].pr`, número ou "#N"). */
export function prsFromPlan(plan: unknown): number[] {
  const issues = (plan as { issues?: unknown })?.issues;
  if (!Array.isArray(issues)) return [];
  const out = new Set<number>();
  for (const i of issues as Array<{ pr?: unknown }>) {
    const raw = i?.pr;
    const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw.replace(/^#/, "")) : NaN;
    if (Number.isInteger(n) && n > 0) out.add(n);
  }
  return [...out].sort((a, b) => a - b);
}

/** Issues do plano que entraram na rodada (`in_round: true`). */
export function roundIssuesFromPlan(plan: unknown): Set<number> {
  const issues = (plan as { issues?: unknown })?.issues;
  const out = new Set<number>();
  if (!Array.isArray(issues)) return out;
  for (const i of issues as Array<{ number?: unknown; in_round?: unknown }>) {
    if (i?.in_round === true && typeof i.number === "number") out.add(i.number);
  }
  return out;
}

export interface PrListItem {
  number: number;
  createdAt: string;
  body: string;
}

/**
 * PRs da rodada que o `plan.json` não registrou (o plano da 261028 ficou com
 * `pr: null` em todas): criadas a partir de `startedAt` e que fecham (`Closes`)
 * ou referenciam (`REFS #N`) alguma issue da rodada.
 */
export function discoverRoundPrs(list: PrListItem[], startedAt: string, roundIssues: ReadonlySet<number>): number[] {
  const startMs = Date.parse(startedAt);
  if (!Number.isFinite(startMs) || roundIssues.size === 0) return [];
  const out: number[] = [];
  for (const p of list) {
    const created = Date.parse(p.createdAt);
    if (!Number.isFinite(created) || created < startMs) continue;
    const cited = new Set(parseClosesIssues(p.body ?? ""));
    for (const m of (p.body ?? "").matchAll(/\bREFS\s+#(\d+)/gi)) cited.add(Number(m[1]));
    if ([...cited].some((n) => roundIssues.has(n))) out.push(p.number);
  }
  return out.sort((a, b) => a - b);
}

const STATE_LABEL: Record<PrFinalState, string> = {
  merged: "mergeada",
  "merged-via-train": "mergeada via trem",
  open: "aberta",
  closed: "fechada sem merge",
};

/** Frases que o relatório costuma gravar antes dos merges e que o bloco desmente. */
const STALE_NO_MERGE_RE = /nenhuma unidade mergeada/i;

/** Corpo do bloco sem a linha de timestamp: é o que `--check` compara. */
export function renderReconcileBody(prs: ReconciledPr[], reportProse: string): string {
  const lines: string[] = [];
  const merged = prs.filter((p) => p.state === "merged" || p.state === "merged-via-train").length;
  const open = prs.filter((p) => p.state === "open").length;
  const closed = prs.filter((p) => p.state === "closed").length;
  if (prs.length === 0) {
    lines.push("Nenhuma PR da rodada encontrada (nem no plan.json, nem por descoberta).");
  } else {
    lines.push(`${merged} mergeada(s), ${open} aberta(s), ${closed} fechada(s) sem merge.`);
    lines.push("");
    lines.push("| PR | estado | título |");
    lines.push("|---|---|---|");
    for (const p of prs) {
      const state = p.state === "merged-via-train" ? `${STATE_LABEL[p.state]} #${p.trainPr}` : STATE_LABEL[p.state];
      lines.push(`| [#${p.number}](${p.url}) | ${state} | ${p.title.replace(/\|/g, "\\|")} |`);
    }
  }
  if (merged > 0 && STALE_NO_MERGE_RE.test(reportProse)) {
    lines.push("");
    lines.push("Atenção: o texto acima foi escrito antes dos merges e diz que nenhuma unidade foi mergeada. Vale esta tabela.");
  }
  return lines.join("\n");
}

export function renderReconcileBlock(prs: ReconciledPr[], reportProse: string, nowIso: string): string {
  return [
    RECONCILE_START,
    "## Estado das PRs no GitHub (reconciliado)",
    "",
    `Lido em ${nowIso} por \`scripts/reconcile-overnight-report.ts\` (#11461).`,
    "",
    renderReconcileBody(prs, reportProse),
    RECONCILE_END,
  ].join("\n");
}

/** Texto do relatório sem o bloco de reconciliação (a "prosa" original). */
export function stripReconcileBlock(report: string): string {
  const s = report.indexOf(RECONCILE_START);
  const e = report.indexOf(RECONCILE_END);
  if (s === -1 || e === -1 || e < s) return report;
  return (report.slice(0, s) + report.slice(e + RECONCILE_END.length)).replace(/\n{3,}$/, "\n\n");
}

/** Substitui o bloco existente ou o acrescenta no fim. Idempotente. */
export function upsertReconcileBlock(report: string, block: string): string {
  const s = report.indexOf(RECONCILE_START);
  const e = report.indexOf(RECONCILE_END);
  if (s !== -1 && e !== -1 && e > s) {
    return report.slice(0, s) + block + report.slice(e + RECONCILE_END.length);
  }
  return `${report.replace(/\s+$/, "")}\n\n${block}\n`;
}

/** Corpo do bloco já gravado (sem cabeçalho/timestamp), ou `null` se não houver bloco. */
export function existingReconcileBody(report: string): string | null {
  const s = report.indexOf(RECONCILE_START);
  const e = report.indexOf(RECONCILE_END);
  if (s === -1 || e === -1 || e < s) return null;
  const inner = report.slice(s + RECONCILE_START.length, e).split("\n");
  // cabeçalho: "", "## ...", "", "Lido em ...", "" — o corpo começa depois da linha "Lido em".
  const idx = inner.findIndex((l) => l.startsWith("Lido em "));
  if (idx === -1) return null; // bloco editado à mão ou de formato antigo: trata como defasado
  return inner.slice(idx + 2).join("\n").replace(/\n+$/, "");
}
