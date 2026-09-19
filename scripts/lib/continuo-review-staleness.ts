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
