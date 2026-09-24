/**
 * scripts/lib/continuo-stuck-pr.ts (#8767)
 *
 * Lógica PURA do "estado terminal" de PR `continuo/*` travada. Achado ao vivo
 * (24/09/2026): 4 PRs paradas 1-2 dias (#8703, #8705, #8754, #8755) porque o
 * laço do contínuo não tinha saída que RESOLVESSE nada:
 *
 *   - o cap de 1 tentativa de CI-fix (#7446 item 3) terminava em
 *     `continuo-escalado`, e o pickup do overnight só mergeia PR LIMPA —
 *     ninguém re-rodava CI, trazia master ou fechava;
 *   - PR rejeitada levava review novo a cada push, cada um achando um
 *     problema diferente (#8703: 8 reviews, 6 rejects) — sem teto;
 *   - PR cuja issue já tinha sido fechada por outro commit do master (#8754,
 *     issue #8665 fechada por `a3d82510`) seguia aberta.
 *
 * `decideStuckPrAction` decide UMA ação por PR, em ordem de precedência. As
 * três saídas de fechamento devolvem a issue à fila (a issue continua
 * aberta, com comentário resumindo o que falhou) — fechar a PR nunca fecha a
 * issue. `update_branch` é a única ação não-terminal e acontece no máximo 1x
 * por PR (marcador), então o laço sempre termina.
 *
 * @see scripts/continuo-resolve-stuck-prs.ts (I/O: `gh`)
 * @see hermes/scripts/continuo-pr-review.sh (chama o resolvedor antes do laço de review)
 */
import { CI_FIX_ATTEMPTED_LABEL, type CiVerdict } from "./continuo-ci-fixer-eligibility.ts";

/** Label de PR que aguarda triagem humana por construção (rescue, #7484) —
 * nunca tocada aqui. */
export const EXECUTION_BLOCK_LABEL = "bloqueio-execucao";

/** Teto de reviews `verdict=reject` antes de fechar a PR. 3 = a PR teve 2
 * chances de conserto depois do 1º reject; a #8703 mostrou que acima disso
 * cada review novo só acha um problema diferente, sem convergir. */
export const REJECT_CAP = 3;

/** PR precisa estar parada (sem commit novo) há pelo menos isto antes de
 * qualquer ação que não seja o superseded-check — dá ao tick do contínuo
 * que está trabalhando nela tempo de terminar, e evita `update-branch`
 * concorrente com um push em andamento. */
export const STALE_HOURS_BEFORE_ACTION = 6;

/** Marcador do comentário que registra o `update-branch` já feito. */
export const UPDATE_BRANCH_MARKER = "<!-- continuo-stuck: update-branch -->";

export interface StuckPrInput {
  number: number;
  title: string;
  body: string;
  headRefName: string;
  isDraft: boolean;
  labels: readonly string[];
  /** `MERGEABLE` | `CONFLICTING` | `UNKNOWN` (gh pr list `mergeable`). */
  mergeable: string | null;
  ciVerdict: CiVerdict;
  /** Estado de cada issue referenciada como "fecha esta issue". */
  linkedIssues: readonly { number: number; state: "OPEN" | "CLOSED" }[];
  /** Nº de comentários com marcador `continuo-review ... verdict=reject`. */
  rejectCount: number;
  /** Algum comentário já contém `UPDATE_BRANCH_MARKER`. */
  updateBranchDone: boolean;
  /** Commits do master que a branch ainda não tem (`compare.behind_by`);
   * `null` = desconhecido (falha de rede) — nunca lido como 0. */
  behindBy: number | null;
  /** Horas desde o último commit da PR; `null` = desconhecido. */
  hoursSinceLastCommit: number | null;
}

export type StuckPrAction =
  | { kind: "skip"; reason: string }
  | { kind: "close_superseded"; issues: number[] }
  | { kind: "close_reject_cap"; rejectCount: number }
  | { kind: "close_conflict" }
  | { kind: "update_branch"; behindBy: number }
  | { kind: "close_ci_red" };

const CLOSING_KEYWORD_RE = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|fecha)\s*:?\s+#(\d+)/gi;
const TITLE_ISSUE_RE = /^[a-z]+\(#(\d+)\)/i;
const NEGATED_CLOSE_RE = /N[ÃA]O\s+CLOSES/i;

/**
 * Issues que a PR declara fechar: `fix(#N): ...` no título + palavras-chave
 * de fechamento no corpo (`Closes #N`, `Fecha #N`, ...). "REFS #N, NÃO
 * CLOSES" (PR de rescue, #7130) nunca conta — por isso a checagem negativa
 * antes. Pura, ordenada, sem duplicatas.
 */
export function extractLinkedIssues(title: string, body: string): number[] {
  const found = new Set<number>();
  if (!NEGATED_CLOSE_RE.test(body)) {
    const t = TITLE_ISSUE_RE.exec(title.trim());
    if (t) found.add(Number(t[1]));
    for (const m of body.matchAll(CLOSING_KEYWORD_RE)) found.add(Number(m[1]));
  }
  return [...found].sort((a, b) => a - b);
}

/** Conta reviews `verdict=reject` pelo marcador estruturado do gate (#6926) —
 * nunca pela prosa "Review automatizado", que qualquer sessão reproduz. */
export function countRejectReviews(commentBodies: readonly string[]): number {
  return commentBodies.filter((b) => /<!-- continuo-review: [^>]*verdict=reject\b/.test(b)).length;
}

function isStale(pr: StuckPrInput): boolean {
  return pr.hoursSinceLastCommit !== null && pr.hoursSinceLastCommit >= STALE_HOURS_BEFORE_ACTION;
}

/**
 * Ordem de precedência (a primeira que casa vence):
 *
 * 1. fora de escopo (não `continuo/*`, draft, `bloqueio-execucao`) → skip.
 * 2. TODAS as issues declaradas já fechadas → `close_superseded` (sem
 *    esperar staleness: o trabalho já está no master).
 * 3. `rejectCount >= REJECT_CAP` + parada → `close_reject_cap`.
 * 4. `CONFLICTING` + parada → `close_conflict` (nenhum ramo do contínuo
 *    resolve conflito: o ci-fixer pula `blocked_by_conflict`).
 * 5. CI `fail` + atrás do master + sem `update-branch` anterior + parada →
 *    `update_branch` (falha pode ser do base; não gasta o cap de CI-fix).
 * 6. CI `fail` + cap de CI-fix gasto + (`update-branch` já feito OU em dia
 *    com o master) + parada → `close_ci_red`.
 * 7. resto → skip (inclui CI `fail` ainda sem tentativa: é do ci-fixer §3b).
 */
export function decideStuckPrAction(pr: StuckPrInput): StuckPrAction {
  if (!pr.headRefName.startsWith("continuo/")) return { kind: "skip", reason: "branch fora de continuo/*" };
  if (pr.isDraft) return { kind: "skip", reason: "draft (triagem humana por construção)" };
  if (pr.labels.includes(EXECUTION_BLOCK_LABEL)) return { kind: "skip", reason: `label ${EXECUTION_BLOCK_LABEL}` };

  if (pr.linkedIssues.length > 0 && pr.linkedIssues.every((i) => i.state === "CLOSED")) {
    return { kind: "close_superseded", issues: pr.linkedIssues.map((i) => i.number) };
  }

  if (!isStale(pr)) return { kind: "skip", reason: `commit há menos de ${STALE_HOURS_BEFORE_ACTION}h (ou idade desconhecida)` };

  if (pr.rejectCount >= REJECT_CAP) return { kind: "close_reject_cap", rejectCount: pr.rejectCount };

  if (pr.mergeable === "CONFLICTING") return { kind: "close_conflict" };

  if (pr.ciVerdict !== "fail") return { kind: "skip", reason: `CI ${pr.ciVerdict}` };

  if (!pr.updateBranchDone && pr.behindBy !== null && pr.behindBy > 0) {
    return { kind: "update_branch", behindBy: pr.behindBy };
  }

  const ciFixSpent = pr.labels.includes(CI_FIX_ATTEMPTED_LABEL);
  const baseRuledOut = pr.updateBranchDone || pr.behindBy === 0;
  if (ciFixSpent && baseRuledOut) return { kind: "close_ci_red" };

  return { kind: "skip", reason: ciFixSpent ? "atrás do master desconhecido" : "CI-fix ainda não tentado (ci-fixer §3b)" };
}

/** Comentário de fechamento da PR — explica o motivo e que a issue volta à fila. */
export function buildCloseComment(action: StuckPrAction, pr: Pick<StuckPrInput, "linkedIssues">): string {
  const open = pr.linkedIssues.filter((i) => i.state === "OPEN").map((i) => `#${i.number}`);
  const back = open.length > 0 ? ` A issue (${open.join(", ")}) segue aberta e volta à fila com o histórico desta PR.` : "";
  switch (action.kind) {
    case "close_superseded":
      return `Fechada pelo resolvedor de PRs travadas (#8767): as issues declaradas (${action.issues.map((n) => `#${n}`).join(", ")}) já foram fechadas por outro commit do master — superseded.`;
    case "close_reject_cap":
      return `Fechada pelo resolvedor de PRs travadas (#8767): ${action.rejectCount} reviews \`verdict=reject\` sem convergir (teto ${REJECT_CAP}).${back}`;
    case "close_conflict":
      return `Fechada pelo resolvedor de PRs travadas (#8767): conflito com o master e nenhum commit novo há ${STALE_HOURS_BEFORE_ACTION}h+.${back}`;
    case "close_ci_red":
      return `Fechada pelo resolvedor de PRs travadas (#8767): CI segue vermelho depois da tentativa de conserto (\`${CI_FIX_ATTEMPTED_LABEL}\`) e com a branch em dia com o master — a falha é desta PR, não do base.${back}`;
    default:
      return "";
  }
}

/** Comentário na issue quando a PR dela é fechada sem merge. */
export function buildIssueRequeueComment(prNumber: number, action: StuckPrAction): string {
  return `PR #${prNumber} fechada sem merge pelo resolvedor de PRs travadas (#8767, motivo: \`${action.kind}\`). A issue volta à fila — leia os reviews daquela PR antes de reimplementar, pra não repetir os mesmos achados.`;
}
