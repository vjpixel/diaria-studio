/**
 * scripts/lib/open-pr-cap.ts (#12765)
 *
 * Teto GLOBAL de PRs abertos no repo, somando todas as automações
 * (overnight, contínuo, develop, sessão interativa). Antes desta issue só
 * existia o teto do contínuo (#7746, 3 PRs `continuo/*`) e o teto de
 * worktrees concorrentes da onda do overnight (#10821) — nenhum dos dois
 * olhava o total. PR escalado que ninguém resolve continuava contando zero
 * para a onda seguinte, e o número só subia.
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

/**
 * Teto de PRs abertos (não-bot) no repo. Valor escolhido no #12765; hoje igual
 * ao teto da onda do overnight (#10821), mas os dois evoluem independentes.
 */
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
  if (!Number.isInteger(cap) || cap < 0) throw new Error(`teto inválido: ${cap}`);
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

/**
 * Pure: decisão final do contínuo (#7746 + #12765). Só reivindica com vaga
 * nos DOIS tetos. Não verificado (`slots === null`) não segura o teto global
 * (fail-soft do #7746: tick travado por infra custa mais que um tick a mais).
 */
export function combineContinuoCaps(continuoMayClaim: boolean, globalSlots: number | null): {
  mayClaim: boolean;
  heldBy: "continuo" | "global" | null;
} {
  if (!continuoMayClaim) return { mayClaim: false, heldBy: "continuo" };
  if (globalSlots === 0) return { mayClaim: false, heldBy: "global" };
  return { mayClaim: true, heldBy: null };
}
