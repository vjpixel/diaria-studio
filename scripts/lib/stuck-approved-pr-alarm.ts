/**
 * scripts/lib/stuck-approved-pr-alarm.ts (#12950 item 5)
 *
 * Lógica PURA do alarme "PR aprovada e verde parada há mais de N horas".
 * Achado da #12950 (12/11/2026): #12896 e #12897 (review approve, CI verde)
 * ficaram 1-2 dias sem merge, escaladas em todo tick do contínuo por um
 * `mergeable=UNKNOWN` transitório, e #12920 (approve, verde) ficou retida
 * como draft. Nenhum alarme olhava esse estado: `stale-red-pr-alarm.ts`
 * (#8530) só pega CI vermelho, e a fila de escalada
 * (`list-continuo-escalation-queue.ts`) só mostra a PR depois de 24h.
 *
 * Este alarme independe de escalada: basta a PR estar aprovada, verde e
 * aberta há >= `thresholdHours` (default 4h), contadas desde a ABERTURA
 * (`createdAt`), não desde a aprovação. PR aprovada e verde que
 * ninguém mergeia é trabalho pronto parado, e ainda ocupa o teto global de
 * PRs abertas (#12765).
 *
 * "Aprovada" = `reviewDecision === "APPROVED"` do GitHub OU o marcador de
 * review independente mais recente com `verdict=approve`
 * (`extractIndependentReviewVerdict`, o mesmo que o gate do contínuo lê).
 * Se o marcador traz `head=<sha>` e ele não bate com o HEAD atual, a
 * aprovação cobre um commit antigo e não conta (mesma regra do #6926).
 *
 * Fora do alarme: PR retida (label `retido-para-editor` ou marcador no
 * corpo, via `evaluatePrRetido`, #10278)
 * e draft com `bloqueio-execucao` (bloqueio de execução declarado, #12460).
 * Draft sem essa label entra, marcado como draft: foi o caso da #12920.
 *
 * `scripts/stuck-approved-pr-alarm.ts` faz o I/O; mesmo molde de
 * `scripts/lib/stale-red-pr-alarm.ts`.
 */
import { evaluatePrChecksGate } from "./pr-checks-gate.ts";
import { extractIndependentReviewHeadSha, extractIndependentReviewVerdict } from "./pr-review-authenticity.ts";
import { evaluatePrRetido } from "./pr-retido-para-editor.ts";
import { EXECUTION_BLOCK_LABEL } from "./continuo-stuck-pr.ts";
import { isDefaultIssueRepo, normalizeRepoSlug } from "./issue-repos.ts";

const MS_PER_HOUR = 60 * 60 * 1000;

export const DEFAULT_STUCK_APPROVED_THRESHOLD_HOURS = 4;

/** O que `gh pr list --json number,title,body,isDraft,labels,createdAt,mergeable,statusCheckRollup,reviewDecision,headRefOid` devolve. */
export interface StuckApprovedPrBasicEntry {
  number: number;
  /**
   * Repo da PR (`owner/name`). Ausente = repo default (diaria-studio). O
   * alarme varre todos os repos de `issue_repos` (#13003): o número colide
   * entre repos, então a identidade da PR é repo + número.
   */
  repo?: string;
  title: string;
  /** Corpo da PR: o marcador `<!-- retido-para-editor -->` também retém (#10278). */
  body?: string | null;
  isDraft: boolean;
  labels: readonly string[];
  /** ISO 8601. */
  createdAt: string;
  mergeable?: string | null;
  statusCheckRollup: unknown;
  reviewDecision?: string | null;
  headRefOid?: string | null;
}

/** Básico + `comments` de `gh pr view N --json comments` (só candidatos). */
export interface StuckApprovedPrEntry extends StuckApprovedPrBasicEntry {
  comments: unknown;
}

export interface StuckApprovedPrFinding {
  number: number;
  /** Repo da PR; ausente = repo default (#13003). */
  repo?: string;
  title: string;
  isDraft: boolean;
  hoursOpen: number;
  approvedBy: "github-review" | "independent-review";
  /** `mergeable` lido nesta varredura (`UNKNOWN` costuma ser o motivo da escalada, #12950 item 1). */
  mergeable: string | null;
}

function isExcluded(pr: StuckApprovedPrBasicEntry): boolean {
  // Mesma fonte de verdade dos gates de merge: label OU marcador no corpo.
  // `retido: null` só ocorre com labels ilegíveis (não com o array já
  // normalizado daqui); conta como retida, fail-closed.
  if (evaluatePrRetido({ labels: [...pr.labels], body: pr.body ?? undefined }).retido !== false) return true;
  return pr.isDraft && pr.labels.includes(EXECUTION_BLOCK_LABEL);
}

function hoursOpen(pr: StuckApprovedPrBasicEntry, now: Date): number | null {
  const ms = Date.parse(pr.createdAt);
  if (Number.isNaN(ms)) return null;
  return (now.getTime() - ms) / MS_PER_HOUR;
}

/**
 * Filtra, só com o payload barato do `gh pr list`, quem justifica o
 * round-trip de `comments`: CI verde (verdict `pass`), aberta há
 * `>= thresholdHours`, fora das exclusões. `createdAt` ilegível nunca vira
 * candidata (não inventa idade).
 */
export function selectStuckApprovedCandidates(
  prs: readonly StuckApprovedPrBasicEntry[],
  now: Date,
  thresholdHours: number,
): StuckApprovedPrBasicEntry[] {
  return prs.filter((pr) => {
    if (isExcluded(pr)) return false;
    const age = hoursOpen(pr, now);
    if (age === null || age < thresholdHours) return false;
    // `UNKNOWN` entra de propósito: é transitório (#12950 item 1) e foi
    // justamente o que segurou #12896/#12897. `CONFLICTING` sai: a PR não
    // está pronta, precisa de rebase (caminho do fixer, não deste alarme).
    if (pr.mergeable === "CONFLICTING") return false;
    return evaluatePrChecksGate(pr.statusCheckRollup, { mergeable: pr.mergeable ?? undefined }).verdict === "pass";
  });
}

/** Aprovação vigente da PR, ou `null`. */
export function approvalSource(pr: StuckApprovedPrEntry): StuckApprovedPrFinding["approvedBy"] | null {
  if (pr.reviewDecision === "APPROVED") return "github-review";
  if (extractIndependentReviewVerdict(pr.comments) !== "approve") return null;
  const reviewedHead = extractIndependentReviewHeadSha(pr.comments);
  if (reviewedHead && pr.headRefOid && !pr.headRefOid.startsWith(reviewedHead) && !reviewedHead.startsWith(pr.headRefOid)) {
    return null; // aprovação de um HEAD antigo (#6926)
  }
  return "independent-review";
}

/**
 * Achados: candidata (revalidada aqui, defesa em profundidade) com
 * aprovação vigente. Ordena da mais antiga para a mais nova.
 */
export function evaluateStuckApprovedPrs(
  prs: readonly StuckApprovedPrEntry[],
  now: Date,
  thresholdHours: number,
): StuckApprovedPrFinding[] {
  const findings: StuckApprovedPrFinding[] = [];
  for (const pr of selectStuckApprovedCandidates(prs, now, thresholdHours) as StuckApprovedPrEntry[]) {
    const approvedBy = approvalSource(pr);
    if (approvedBy === null) continue;
    findings.push({
      number: pr.number,
      ...(pr.repo !== undefined ? { repo: pr.repo } : {}),
      title: pr.title,
      isDraft: pr.isDraft,
      hoursOpen: hoursOpen(pr, now) ?? 0,
      approvedBy,
      mergeable: pr.mergeable ?? null,
    });
  }
  return findings.sort((a, b) => b.hoursOpen - a.hoursOpen);
}

/**
 * Referência legível da PR (#13003): `#N` no repo default (forma de sempre,
 * mantém a chave de conjunto e o texto das issues já abertas), `owner/name#N`
 * em outro repo — o `#21` do diaria-design não é o `#21` do studio.
 */
export function stuckApprovedPrRef(f: Pick<StuckApprovedPrFinding, "number" | "repo">): string {
  if (f.repo === undefined || isDefaultIssueRepo(f.repo)) return `#${f.number}`;
  return `${normalizeRepoSlug(f.repo) ?? f.repo}#${f.number}`;
}

/**
 * O que a run faz com o resultado (#12950, review). `skippedCandidates` =
 * candidatas cujo `gh pr view --json comments` falhou: não deu pra checar
 * a aprovação delas.
 *
 * - `close`: nenhum achado E nada pulado. Só aqui a issue única é fechada.
 * - `notify`: há achados e nada pulado: alarma e comenta o conjunto novo.
 * - `notify-partial`: há achados mas algo foi pulado: alarma (os achados são
 *   reais), mas NÃO comenta o conjunto (seria um conjunto incompleto, que
 *   viraria marcador "visto" errado) e a run sai 1.
 * - `hold`: nenhum achado mas algo foi pulado: não fecha (a PR pulada pode
 *   estar parada), não comenta, sai 1.
 */
export type StuckApprovedRunOutcome = "close" | "notify" | "notify-partial" | "hold";

export function decideStuckApprovedRunOutcome(findingsCount: number, skippedCandidates: number): StuckApprovedRunOutcome {
  if (skippedCandidates > 0) return findingsCount > 0 ? "notify-partial" : "hold";
  return findingsCount > 0 ? "notify" : "close";
}

/** Fingerprint FIXO: 1 issue enquanto houver PR parada (lição do #8767). */
export const STUCK_APPROVED_PR_ALARM_FINGERPRINT = "approved-green-prs";

/** Chave do conjunto (decide se vale comentar a atualização na issue). */
export function stuckApprovedPrSetKey(findings: readonly StuckApprovedPrFinding[]): string {
  // Repo default primeiro, por número (a chave de sempre quando só há PR do
  // studio); depois os outros repos, qualificados (#13003).
  const defaults = findings.filter((f) => stuckApprovedPrRef(f).startsWith("#"));
  const others = findings.filter((f) => !stuckApprovedPrRef(f).startsWith("#"));
  return [
    ...defaults.map((f) => f.number).sort((a, b) => a - b).map(String),
    ...others.map((f) => stuckApprovedPrRef(f)).sort(),
  ].join(",");
}

export function stuckApprovedPrSetMarker(setKey: string): string {
  return `<!-- stuck-approved-set: ${setKey} -->`;
}

export function needsStuckApprovedSetComment(issueTexts: readonly string[], setKey: string): boolean {
  const marker = stuckApprovedPrSetMarker(setKey);
  return !issueTexts.some((t) => t.includes(marker));
}

export function buildStuckApprovedPrAlarmEmail(
  findings: readonly StuckApprovedPrFinding[],
  thresholdHours: number,
  now: Date,
): { subject: string; body: string } {
  const subject = `${findings.length} PR(s) aprovada(s) e verde(s) abertas há >= ${thresholdHours}h (desde a abertura) sem merge`;
  const lines = findings.map((f) => {
    const flags = [
      f.isDraft ? "draft" : null,
      f.mergeable && f.mergeable !== "MERGEABLE" ? `mergeable=${f.mergeable}` : null,
      f.approvedBy === "github-review" ? "approve no GitHub" : "approve do review independente",
    ].filter((x): x is string => x !== null);
    return `- PR ${stuckApprovedPrRef(f)} "${f.title}": aberta há ${f.hoursOpen.toFixed(1)}h (${flags.join(", ")}).`;
  });
  const body = [
    `Varredura de ${now.toISOString()}, limiar ${thresholdHours}h.`,
    "",
    ...lines,
    "",
    "Estas PRs têm review approve e CI verde e seguem abertas. Fora da lista: retidas (label ou marcador retido-para-editor) e draft com bloqueio-execucao.",
    "Ação: passar pelo Gate 2 e mergear (`check-continuo-merge-gate.ts --pr N` mostra o motivo da retenção; PR de outro repo leva `--repo owner/name`); draft sem bloqueio real sai de draft antes.",
  ].join("\n");
  return { subject, body };
}
