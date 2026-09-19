/**
 * scripts/lib/continuo-review-staleness.ts (#8445)
 *
 * Decide se o review independente mais recente de uma PR ainda cobre o HEAD
 * atual. Existe porque `continuo-pr-review.sh` tratava "já tem review" como
 * "não precisa revisar" — mas o CI fixer (ou qualquer push posterior) muda o
 * HEAD DEPOIS do review, e o portão de merge (`continuo-merge-gate.ts`, #5716)
 * escala toda PR cuja revisão não cobre o SHA atual. Resultado medido ao vivo
 * (19/09/2026, #8381/#8367): review `reject` no SHA A, fixer empurra o SHA B,
 * o script conclui "já com review — direto ao merge", o gate escala por
 * "HEAD mudou", e ninguém jamais revisa o SHA B — todo tick repete o mesmo
 * par de linhas, eternamente. Review de SHA antigo não é review desta PR.
 *
 * Só `stale` quando os DOIS SHAs são conhecidos e diferem. SHA desconhecido
 * (marcador legado sem `head=`, ou `gh` sem `headRefOid`) NUNCA vira `stale`:
 * re-revisar a cada tick uma PR cujo marcador nunca carrega `head=` seria um
 * laço de custo — o portão de merge já escala esse caso por conta própria.
 * Puro: sem I/O.
 */

export type ReviewStalenessVerdict = "fresh" | "stale" | "unknown";

export interface ReviewStalenessResult {
  verdict: ReviewStalenessVerdict;
  reason: string;
}

export function evaluateReviewStaleness(input: {
  currentHeadSha: string | null;
  reviewedHeadSha: string | null;
}): ReviewStalenessResult {
  const { currentHeadSha, reviewedHeadSha } = input;
  if (!currentHeadSha) {
    return { verdict: "unknown", reason: "HEAD atual da PR desconhecido — não dá pra comparar com a revisão" };
  }
  if (!reviewedHeadSha) {
    return {
      verdict: "unknown",
      reason: "review sem `head=` (marcador legado) ou ausente — o portão de merge escala esse caso; re-revisar aqui viraria laço",
    };
  }
  if (currentHeadSha !== reviewedHeadSha) {
    return {
      verdict: "stale",
      reason: `review cobre ${reviewedHeadSha}, HEAD atual é ${currentHeadSha} — push posterior à revisão, o SHA atual nunca foi revisado`,
    };
  }
  return { verdict: "fresh", reason: "review cobre o HEAD atual" };
}

/**
 * Exit code distintivo pra `stale`. NÃO pode ser 1: Node/tsx saem 1 em toda
 * exceção não tratada, então um crash do CLI seria indistinguível de "stale"
 * e dispararia review pago (Sonnet, até 1800s) a cada tick — o laço que o
 * #8445 existe pra eliminar (achado do review da PR #8451).
 */
export const STALE_EXIT_CODE = 10;

/** Teto de re-reviews por par PR+SHA: se a sessão sai 0 sem postar marcador
 *  válido, o review antigo continua o mais recente e a PR seguiria `stale`
 *  pra sempre. */
export const MAX_RE_REVIEW_ATTEMPTS = 2;

export type ReReviewAttempts = Record<string, number>;

/** Decide se ainda cabe uma tentativa pra `pr@sha` e devolve o novo estado.
 *  Puro: quem grava/lê o arquivo é o CLI. */
export function consumeReReviewAttempt(
  state: ReReviewAttempts,
  pr: number,
  sha: string,
  max: number = MAX_RE_REVIEW_ATTEMPTS,
): { allowed: boolean; next: ReReviewAttempts } {
  const key = `${pr}@${sha}`;
  const used = Number.isInteger(state[key]) ? state[key] : 0;
  if (used >= max) return { allowed: false, next: state };
  return { allowed: true, next: { ...state, [key]: used + 1 } };
}

// ── Verificação automática do fix #8445 (não depende de alguém lembrar) ────────

/** 2 ticks do merger (cron de 120m): se a PR está `stale`, sem nenhuma tentativa
 *  registrada e o HEAD já tem mais que isso, o merger NÃO está agindo. */
export const MERGER_SILENT_HOURS = 4;

export interface StaleReviewProbe {
  pr: number;
  headRefName: string;
  currentHeadSha: string | null;
  reviewedHeadSha: string | null;
  headCommittedAt: string | null;
}

export type StaleReviewFindingKind = "re-review-esgotado" | "merger-nao-tenta";

export interface StaleReviewFinding {
  pr: number;
  headRefName: string;
  kind: StaleReviewFindingKind;
  attemptsUsed: number;
  headAgeHours: number | null;
  currentHeadSha: string;
  reviewedHeadSha: string;
}

/**
 * Invariante do #8445: PR com review obsoleto não pode ficar assim. Dois modos
 * de falha, ambos silenciosos sem esta checagem:
 *  - `re-review-esgotado`: o merger re-revisou {MAX} vezes e o SHA atual segue
 *    sem review válido (sessão sai 0 sem postar marcador, marcador malformado…).
 *  - `merger-nao-tenta`: `stale`, zero tentativas e HEAD antigo — o fix não foi
 *    implantado no checkout do cron, o arquivo de estado não grava, ou o merger
 *    está parado. Sem idade legível do HEAD não dá pra afirmar: não alarma.
 * Puro: sem I/O. `attempts` é o conteúdo de data/continuo/re-review-attempts.json.
 */
export function evaluateStaleReviewHealth(
  probes: readonly StaleReviewProbe[],
  attempts: ReReviewAttempts,
  nowIso: string,
  opts: { maxAttempts?: number; silentHours?: number } = {},
): StaleReviewFinding[] {
  const max = opts.maxAttempts ?? MAX_RE_REVIEW_ATTEMPTS;
  const silentHours = opts.silentHours ?? MERGER_SILENT_HOURS;
  const nowMs = Date.parse(nowIso);
  const findings: StaleReviewFinding[] = [];
  for (const p of probes) {
    const s = evaluateReviewStaleness({ currentHeadSha: p.currentHeadSha, reviewedHeadSha: p.reviewedHeadSha });
    if (s.verdict !== "stale" || !p.currentHeadSha || !p.reviewedHeadSha) continue;
    const raw = attempts[`${p.pr}@${p.currentHeadSha}`];
    const attemptsUsed = Number.isInteger(raw) ? raw : 0;
    const committedMs = p.headCommittedAt ? Date.parse(p.headCommittedAt) : NaN;
    const headAgeHours =
      Number.isFinite(committedMs) && Number.isFinite(nowMs) ? Math.max(0, (nowMs - committedMs) / 3_600_000) : null;
    const base = {
      pr: p.pr,
      headRefName: p.headRefName,
      attemptsUsed,
      headAgeHours,
      currentHeadSha: p.currentHeadSha,
      reviewedHeadSha: p.reviewedHeadSha,
    };
    if (attemptsUsed >= max) {
      findings.push({ ...base, kind: "re-review-esgotado" });
    } else if (attemptsUsed === 0 && headAgeHours !== null && headAgeHours >= silentHours) {
      findings.push({ ...base, kind: "merger-nao-tenta" });
    }
  }
  return findings;
}

export function attemptsFilePath(repoRoot: string): string {
  return `${repoRoot.replace(/[\/]+$/, "")}/data/continuo/re-review-attempts.json`;
}
