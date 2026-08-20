/**
 * test/trade-off-label-gate.test.ts (#5821)
 *
 * Cobre `scripts/lib/trade-off-label-gate.ts` — a lógica pura do gate de
 * "label trade-off-real removida após decisão cat. C". O I/O (gh CLI) fica
 * no entrypoint `scripts/check-trade-off-label-cleared.ts`, testado aqui só
 * via a função pura que ele orquestra (mesmo padrão de
 * `test/check-overnight-comment-coverage.test.ts` para o gate irmão).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatDecisionMarker, type IssueDecision } from "../scripts/lib/issue-decisions.ts";
import { checkTradeOffLabelCleared, TRADE_OFF_LABEL } from "../scripts/lib/trade-off-label-gate.ts";

const decision: IssueDecision = {
  decided_at: "2026-08-20T12:00:00.000Z",
  pergunta: "formato A ou B de log?",
  resposta: "formato A — decisão do editor.",
  sessao: "develop",
};

describe("checkTradeOffLabelCleared", () => {
  it("sem nenhuma decisão registrada => 'no-decision' (gate não se aplica ainda)", () => {
    const result = checkTradeOffLabelCleared([TRADE_OFF_LABEL, "enhancement"], []);
    assert.equal(result.status, "no-decision");
    assert.equal(result.decision, null);
  });

  it("#5821 regressão: decisão registrada MAS label trade-off-real ainda presente => 'label-not-removed' (bloqueia)", () => {
    const bodies = [formatDecisionMarker(decision)];
    const result = checkTradeOffLabelCleared(["trade-off-real", "P3"], bodies);
    assert.equal(result.status, "label-not-removed");
    assert.deepEqual(result.decision, decision);
  });

  it("decisão registrada e label já removida => 'ok'", () => {
    const bodies = [formatDecisionMarker(decision)];
    const result = checkTradeOffLabelCleared(["P3", "enhancement"], bodies);
    assert.equal(result.status, "ok");
    assert.deepEqual(result.decision, decision);
  });

  it("nenhuma label na issue + decisão registrada => 'ok' (nada a remover)", () => {
    const bodies = [formatDecisionMarker(decision)];
    const result = checkTradeOffLabelCleared([], bodies);
    assert.equal(result.status, "ok");
  });

  it("múltiplos comentários — usa a decisão MAIS RECENTE (mesmo contrato de latestDecisionFor)", () => {
    const older: IssueDecision = { ...decision, decided_at: "2026-08-18T09:00:00.000Z", resposta: "resposta antiga" };
    const bodies = [formatDecisionMarker(older), formatDecisionMarker(decision)];
    const result = checkTradeOffLabelCleared([TRADE_OFF_LABEL], bodies);
    assert.equal(result.status, "label-not-removed");
    assert.equal(result.decision?.decided_at, decision.decided_at);
  });

  it("comentários sem nenhum marcador válido => 'no-decision', mesmo com prosa mencionando decisão", () => {
    const bodies = ["Decisão do editor: formato A. (sem o marcador estruturado, issue pré-#5373)"];
    const result = checkTradeOffLabelCleared([TRADE_OFF_LABEL], bodies);
    assert.equal(result.status, "no-decision");
  });

  it("nunca lança com input vazio/degenerado", () => {
    assert.doesNotThrow(() => checkTradeOffLabelCleared([], []));
  });
});
