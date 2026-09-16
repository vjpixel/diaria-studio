/**
 * scripts/lib/revert-calibration-orphan.ts (#8176)
 *
 * Lógica PURA (sem I/O — testável isolada) que decide se uma PR aberta por
 * `scripts/revert-calibration.ts` ficou ÓRFÃ — aberta há mais tempo que o
 * limiar, sem ninguém tendo mergeado (ou fechado). `scripts/check-revert-
 * calibration-prs.ts` é o wrapper de CLI que busca as PRs reais via `gh` e
 * chama `selectOrphanRevertPrs`.
 *
 * ## Por que existe (#8176, opção C escolhida entre as 3 da issue)
 *
 * `revert-calibration.ts` abre a PR de revert via `spawnSync` — um
 * subprocesso, fora da ferramenta Bash de uma sessão Claude Code — e a
 * docstring dele promete "deixa pro fluxo normal de auto-merge do #5251".
 * Isso nunca acontece de fato: nenhuma sessão necessariamente está
 * observando quando o script roda (é chamado de dentro do pipeline de
 * autocalibração, #7972, ainda em construção), e o hook de review
 * automatizado pós-`gh pr create` (`pr-create-review.mjs`) é inconsistente
 * pra chamadas vindas de subprocesso (mesmo achado do #8158 item 2, causa
 * não confirmada na camada de harness, #6298).
 *
 * Das 3 alternativas da issue (A: allowlist no hook — mesmo bloqueio,
 * descartada; B: o próprio script fecha o laço, dispatchando o
 * code-reviewer — exige a ferramenta Agent de dentro de um `spawnSync`, que
 * um script não tem; C: watchdog agendado), esta é a C: não CONSERTA o
 * caminho quente (a PR continua saindo sem review garantido), mas garante
 * que o caso órfão nunca fica invisível — alguém (o editor, via alarme;
 * uma próxima rodada overnight/develop, via `/diaria-log`) sempre descobre.
 *
 * ## Critério de "órfã"
 *
 * PR ABERTA (nunca mergeada/fechada — isso já sai do filtro `--state open`
 * do caller), na branch `revert/calibration-*`, criada há mais de
 * `thresholdMs` (default 2h). Não tenta inferir "teve review de verdade" —
 * o próprio #8176 cita a mesma classe de inconsistência do #6298/#8158 pra
 * detectar isso de forma confiável; a idade sozinha já é sinal suficiente
 * pra um alarme (falso positivo aqui é barato: um PR de revert que só
 * ainda não foi olhado por atraso legítimo recebe 1 linha de log a mais).
 */

export const REVERT_CALIBRATION_BRANCH_PREFIX = "revert/calibration-";

/** 2h — cobre o tempo de review normal + folga generosa antes de soar o
 * alarme; qualquer PR de revert é, por natureza, pequena e rápida de
 * revisar (reverte um diff já visto), então não precisa de janela maior. */
export const DEFAULT_ORPHAN_THRESHOLD_MS = 2 * 60 * 60 * 1000;

export function isRevertCalibrationBranch(headRefName: string): boolean {
  return typeof headRefName === "string" && headRefName.startsWith(REVERT_CALIBRATION_BRANCH_PREFIX);
}

/** Formato mínimo que o caller (gh CLI) precisa fornecer por PR. */
export interface RevertPrCandidate {
  number: number;
  headRefName: string;
  createdAt: string; // ISO 8601
  url: string;
  /** Contagem de comentários na PR — informativa no log, não usada como filtro
   * (ver docstring do módulo: idade sozinha já é o critério). */
  comments: number;
}

export interface OrphanRevertPr extends RevertPrCandidate {
  ageHours: number;
}

/**
 * Filtra `prs` (já esperado como só as ABERTAS — o caller de CLI resolve
 * isso via `gh pr list --state open`) pras que estão na branch de revert de
 * calibração E passaram do limiar de idade. `createdAt` ilegível (não
 * `Date.parse`-ável) é descartado — nunca tratado como "há muito tempo" por
 * default; fail-quiet aqui é mais seguro que um falso alarme por dado
 * corrompido.
 */
export function selectOrphanRevertPrs(
  prs: readonly RevertPrCandidate[],
  now: number = Date.now(),
  thresholdMs: number = DEFAULT_ORPHAN_THRESHOLD_MS,
): OrphanRevertPr[] {
  const orphans: OrphanRevertPr[] = [];
  for (const pr of prs) {
    if (!isRevertCalibrationBranch(pr.headRefName)) continue;
    const createdMs = Date.parse(pr.createdAt);
    if (!Number.isFinite(createdMs)) continue;
    const ageMs = now - createdMs;
    if (ageMs < thresholdMs) continue;
    orphans.push({ ...pr, ageHours: ageMs / (60 * 60 * 1000) });
  }
  return orphans;
}
