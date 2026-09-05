/**
 * trade-off-label-gate.ts (#5821)
 *
 * Lógica PURA/testável para o gate mecânico de "alguém decidiu a ambiguidade
 * de trade-off editorial e esqueceu de remover a label `trade-off-real`
 * depois de postar o comentário de decisão".
 *
 * A regra existia só em prosa (`.claude/skills/diaria-develop/SKILL.md`,
 * Fase 0.5: "o develop remove essa label ao fechar a cat. C") — dependia do
 * agente lembrar de rodar `gh issue edit N --remove-label trade-off-real`
 * como um passo mecânico SEPARADO, logo depois de postar o comentário de
 * decisão (`formatDecisionMarker`/`latestDecisionFor`, ver
 * `scripts/lib/issue-decisions.ts`). Incidente de referência (#5415, achado
 * na #5821): a decisão foi postada, a label ficou.
 *
 * **Quem decide mudou no #7493; o gate, não.** Até 05/09/2026 a decisão
 * vinha só do `/diaria-develop` (cat. C), porque `classifyExecTrack` roteava
 * a label pra Develop e uma issue com a label esquecida ficava presa NAQUELA
 * fila. Desde o #7493 a label classifica `overnight` e a decisão típica é
 * tomada no BRIEFING da Fase 0 — o esquecimento agora prende a issue na fila
 * de PERGUNTAS do briefing, fazendo o editor responder de novo, em cada
 * rodada, algo que ele já respondeu. Dano diferente, mesmo defeito, mesmo
 * gate: por isso ele roda nos dois fluxos (briefing do overnight, Fase 0.5
 * do develop) sem nenhuma mudança de lógica — a checagem sempre foi
 * "decisão registrada × label ainda presente", nunca "qual sessão decidiu".
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
