/**
 * scripts/lib/open-pr-cap.ts (#12765)
 *
 * Teto GLOBAL de PRs abertos no repo, somando todas as automações
 * (overnight, contínuo, develop, sessão interativa). Antes desta issue só
 * existia o teto do contínuo (#7746, 3 PRs `continuo/*`) e o teto de
 * worktrees concorrentes da onda do overnight (#10821, 10) — nenhum dos dois
 * olhava o total. PR escalado que ninguém resolve continuava contando zero
 * para a onda seguinte, e o número só subia (15 abertos em 10/11/2026).
 *
 * O teto não impede trabalho: ele muda o QUE a rodada faz. Sem vaga, a
 * rodada drena (rebase, fix de CI, merge, destino da escalada vencida —
 * `scripts/list-continuo-escalation-queue.ts`) em vez de abrir PR nova.
 *
 * Conta drafts e resgates (`continuo/rescue-*`) de propósito: são justamente
 * os que ficavam parados. Só PR de bot de dependência fica de fora — ele tem
 * ciclo próprio e não sai de nenhuma rodada.
 *
 * Puro (sem I/O). CLI: `scripts/check-open-pr-cap.ts`.
 */

/** Teto de PRs abertos (não-bot) no repo. Igual ao teto da onda do overnight (#10821). */
export const OPEN_PR_CAP = 10;

export interface OpenPrLike {
  number?: number;
  headRefName: string;
  author?: { login?: string } | null;
}

export interface OpenPrSlots {
  open: number;
  cap: number;
  /** Vagas para PR nova: `max(0, cap - open)`. */
  slots: number;
  counted: number[];
}

/** Pure: PR de bot de dependência (Dependabot/Renovate) não conta no teto. */
export function isDependencyBotPr(pr: OpenPrLike): boolean {
  const login = (pr.author?.login ?? "").toLowerCase();
  if (/(^|\/)(dependabot|renovate)(\[bot\])?$/.test(login)) return true;
  return /^(dependabot|renovate)\//.test(pr.headRefName);
}

/** Pure: quantas PRs novas ainda cabem. Nunca lança. */
export function computeOpenPrSlots(prs: OpenPrLike[], cap: number = OPEN_PR_CAP): OpenPrSlots {
  const counted = prs.filter((pr) => !isDependencyBotPr(pr));
  return {
    open: counted.length,
    cap,
    slots: Math.max(0, cap - counted.length),
    counted: counted.map((pr) => pr.number).filter((n): n is number => typeof n === "number"),
  };
}

/**
 * Pure: a onda cabe nas vagas de PR aberta? Cada unidade vira 1 PR, então a
 * onda não pode ter mais unidades que `slots`. Devolve a mensagem de recusa,
 * ou `null` se cabe.
 */
export function waveOpenPrCapError(unitCount: number, slots: number): string | null {
  if (!Number.isInteger(slots) || slots < 0) return `--open-pr-slots inválido: ${slots}`;
  if (unitCount <= slots) return null;
  return slots === 0
    ? `teto de PRs abertos atingido (0 vagas, #12765) — drenar as PRs abertas antes de abrir onda nova`
    : `onda com ${unitCount} unidades estoura as ${slots} vaga(s) do teto de PRs abertos (#12765)`;
}
