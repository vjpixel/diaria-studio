/**
 * trade-off-label-gate.ts (#5821)
 *
 * Lógica PURA/testável para o gate mecânico de "o `/diaria-develop` decidiu
 * uma cat. C (trade-off editorial) e esqueceu de remover a label
 * `trade-off-real` depois de postar o comentário de decisão".
 *
 * A regra existia só em prosa (`.claude/skills/diaria-develop/SKILL.md`,
 * Fase 0.5: "o develop remove essa label ao fechar a cat. C") — dependia do
 * agente lembrar de rodar `gh issue edit N --remove-label trade-off-real`
 * como um passo mecânico SEPARADO, logo depois de postar o comentário de
 * decisão (`formatDecisionMarker`/`latestDecisionFor`, ver
 * `scripts/lib/issue-decisions.ts`). Incidente de referência (#5415, achado
 * na #5821): a decisão foi postada, a label ficou. `classifyExecTrack`
 * (`scripts/lib/issue-exec-track.ts`) usa a presença de `trade-off-real`
 * pra rotear pro Develop — uma issue já decidida mas com a label esquecida
 * fica presa nessa fila pra sempre, é reavaliada de novo por uma sessão
 * futura, e o mesmo "esqueci de tirar a label" pode se repetir.
 *
 * O I/O (buscar labels + comentários via `gh`) fica no entrypoint CLI
 * (`scripts/check-trade-off-label-cleared.ts`) — este módulo só decide, a
 * partir de dados já buscados, se o gate passa. Mesmo padrão de
 * `scripts/lib/overnight-comment-coverage.ts`/`scripts/lib/state-changed-tracker.ts`.
 *
 * ## Veredito
 *
 * Três estados, não dois — "sem decisão ainda" não é o mesmo que "ok":
 *
 *   - `"no-decision"`  : nenhum marcador `decisao-editor` (#5373) encontrado
 *                        nos comentários. Gate não se aplica ainda — cat. C
 *                        pendente de decisão não é o problema que este gate
 *                        cobre (isso é escopo do briefing/gate humano do
 *                        `/diaria-develop`, não deste guard mecânico).
 *   - `"label-not-removed"` : existe decisão registrada E a label
 *                        `trade-off-real` ainda está presente — **isto é o
 *                        bug que a #5821 corrige**. Bloqueia.
 *   - `"ok"`           : ou não há decisão ainda (nada a checar), ou há
 *                        decisão E a label já foi removida.
 *
 * Puro, sem rede — recebe labels + bodies de comentário já buscados,
 * 100% testável via fixture.
 */
import { latestDecisionFor, type IssueDecision } from "./issue-decisions.ts";

export const TRADE_OFF_LABEL = "trade-off-real";

export type TradeOffLabelGateStatus = "ok" | "no-decision" | "label-not-removed";

export interface TradeOffLabelGateResult {
  status: TradeOffLabelGateStatus;
  /** A decisão mais recente encontrada nos comentários, ou `null` se nenhuma. */
  decision: IssueDecision | null;
}

/**
 * Decide o veredito do gate a partir de labels e bodies de comentário já
 * buscados (I/O é responsabilidade do chamador). Nunca lança.
 */
export function checkTradeOffLabelCleared(
  labels: readonly string[],
  commentBodies: readonly string[],
): TradeOffLabelGateResult {
  const decision = latestDecisionFor(commentBodies);
  if (!decision) {
    return { status: "no-decision", decision: null };
  }
  const stillLabeled = labels.some((l) => l === TRADE_OFF_LABEL);
  return {
    status: stillLabeled ? "label-not-removed" : "ok",
    decision,
  };
}
