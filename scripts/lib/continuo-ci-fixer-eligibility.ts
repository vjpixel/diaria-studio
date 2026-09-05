/**
 * continuo-ci-fixer-eligibility.ts (#7446 item 3)
 *
 * Lógica PURA/testável de "fixer de CI vermelho tem prioridade sobre
 * reivindicar issue nova" — o tick que abre uma PR `continuo/*` morre
 * (budget, crash, fim do tick) antes do CI terminar; o PRÓXIMO tick
 * reivindica outra issue e nunca volta para consertar a anterior. Medido ao
 * vivo (04-05/09/2026): PR #7429/#7432, `test` (CI) em FAILURE há 17h/15h,
 * sem ninguém tentar.
 *
 * **Isto NÃO reintroduz "PR pendente bloqueia o tick"** (#6917 já corrigiu
 * essa leitura errada — "PR aberta NUNCA encerra o tick",
 * `hermes/skills/hermes-diaria-continuo/SKILL.md` §3). A diferença: #6917
 * cobre PR aguardando REVIEW (estado normal, temporário, resolvido por
 * processo externo) — não é motivo pra parar de trabalhar. Isto cobre PR com
 * CI **vermelho** (estado quebrado, ninguém mais vai consertar sozinho) —
 * muda a PRIORIDADE do que o tick faz primeiro, nunca se o tick trabalha.
 * O tick continua trabalhando; só escolhe consertar antes de reivindicar
 * issue nova.
 *
 * Cap de 1 tentativa por PR via label (`CI_FIX_ATTEMPTED_LABEL`) —
 * independente do resultado da tentativa. Sem isso, um fix que não resolve
 * de verdade vira o próprio livelock que este mecanismo existe pra evitar:
 * tick após tick tentando consertar a MESMA PR pra sempre. Depois de 1
 * tentativa (sucesso ou não), a checagem 9 de `watch-continuo-health.sh`
 * (#7446 item 6, fila de PRs sem merge) e o `escalate` do gate de merge
 * (#7446 item 2) seguem cobrindo o caso — nunca fica invisível, só para de
 * ser RETENTADO mecanicamente.
 *
 * @see scripts/check-continuo-ci-fixer-candidate.ts (I/O: `gh pr list` + `check-pr-checks-gate.ts`)
 * @see scripts/mark-continuo-ci-fix-attempted.ts (aplica o label após a tentativa)
 * @see hermes/skills/hermes-diaria-continuo/SKILL.md (§3, novo passo antes da §4)
 */

export const CI_FIX_ATTEMPTED_LABEL = "continuo-ci-fix-tentado";

/** Mesmo vocabulário de veredito de `scripts/lib/pr-checks-gate.ts`
 * (`evaluatePrChecksGate`) + `claude_binary_error` de
 * `scripts/check-pr-checks-gate.ts` — reusado, não reinventado. */
export type CiVerdict = "pass" | "fail" | "pending" | "error" | "blocked_by_conflict" | "claude_binary_error";

export interface CiFixCandidatePr {
  number: number;
  headRefName: string;
  ciVerdict: CiVerdict;
  labels: string[];
}

/**
 * Escolhe a PR `continuo/*` mais antiga (menor `number` — primeira aberta)
 * com CI genuinamente reprovado (`ciVerdict === "fail"`, nunca
 * `pending`/`error`/`blocked_by_conflict`/`claude_binary_error` — nenhum
 * desses é "sei que está quebrado", só "não sei ainda" ou "não é um
 * veredito real sobre o código") e que ainda não recebeu 1 tentativa de
 * conserto (`CI_FIX_ATTEMPTED_LABEL` ausente). `null` quando não há
 * candidata — o chamador segue normalmente para reivindicar issue nova.
 */
export function selectCiFixCandidate(prs: CiFixCandidatePr[]): number | null {
  const candidates = prs.filter(
    (pr) =>
      pr.headRefName.startsWith("continuo/") &&
      pr.ciVerdict === "fail" &&
      !pr.labels.includes(CI_FIX_ATTEMPTED_LABEL),
  );
  if (candidates.length === 0) return null;
  return candidates.reduce((oldest, pr) => (pr.number < oldest.number ? pr : oldest)).number;
}
