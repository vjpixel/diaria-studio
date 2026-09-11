/**
 * test/calibration-cadence-guard.test.ts (#7979)
 *
 * Cobre scripts/lib/calibration-cadence-guard.ts — os 3 guardrails de
 * cadência (digest, novo candidato, orçamento de parâmetro) e o ranking
 * de candidatos por valor.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { evaluateCadence, rankQueuedCandidates, MAX_LIVE_CALIBRATABLE_PARAMS, MAX_NEW_CANDIDATES_PER_WEEK, MAX_SIGNOFF_DIGESTS_PER_WEEK } from "../scripts/lib/calibration-cadence-guard.ts";

const NOW = "2026-09-11T12:00:00.000Z";

function daysAgo(n: number): string {
  return new Date(new Date(NOW).getTime() - n * 24 * 60 * 60 * 1000).toISOString();
}

describe("evaluateCadence (#7979)", () => {
  it("estado vazio: tudo liberado, sem razões de bloqueio", () => {
    const d = evaluateCadence({ candidateOpenedAt: [], digestSentAt: [], liveCalibratableParamCount: 5 }, NOW);
    assert.equal(d.canOpenNewCandidate, true);
    assert.equal(d.canSendSignoffDigest, true);
    assert.equal(d.atParamBudgetCap, false);
    assert.deepEqual(d.reasons, []);
  });

  it("candidato aberto há 3 dias: cooldown ativo, bloqueia novo candidato", () => {
    const d = evaluateCadence({ candidateOpenedAt: [daysAgo(3)], digestSentAt: [], liveCalibratableParamCount: 5 }, NOW);
    assert.equal(d.canOpenNewCandidate, false);
    assert.match(d.reasons.join(" "), /cooldown/);
  });

  it("candidato aberto há 8 dias (fora da janela de 7): não bloqueia mais", () => {
    const d = evaluateCadence({ candidateOpenedAt: [daysAgo(8)], digestSentAt: [], liveCalibratableParamCount: 5 }, NOW);
    assert.equal(d.canOpenNewCandidate, true);
  });

  it("candidato aberto EXATAMENTE 7 dias atrás: fora da janela (limite exclusivo — >=7 dias não conta)", () => {
    const sevenDaysAgo = new Date(new Date(NOW).getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const d = evaluateCadence({ candidateOpenedAt: [sevenDaysAgo], digestSentAt: [], liveCalibratableParamCount: 5 }, NOW);
    assert.equal(d.canOpenNewCandidate, true);
  });

  it("digest enviado hoje: teto de digest bloqueia novo digest na mesma semana", () => {
    const d = evaluateCadence({ candidateOpenedAt: [], digestSentAt: [daysAgo(0)], liveCalibratableParamCount: 5 }, NOW);
    assert.equal(d.canSendSignoffDigest, false);
    assert.match(d.reasons.join(" "), /digest/);
  });

  it("liveCalibratableParamCount no teto (15): atParamBudgetCap true", () => {
    const d = evaluateCadence({ candidateOpenedAt: [], digestSentAt: [], liveCalibratableParamCount: MAX_LIVE_CALIBRATABLE_PARAMS }, NOW);
    assert.equal(d.atParamBudgetCap, true);
    assert.match(d.reasons.join(" "), /orçamento/);
  });

  it("liveCalibratableParamCount 1 abaixo do teto: ainda liberado", () => {
    const d = evaluateCadence({ candidateOpenedAt: [], digestSentAt: [], liveCalibratableParamCount: MAX_LIVE_CALIBRATABLE_PARAMS - 1 }, NOW);
    assert.equal(d.atParamBudgetCap, false);
  });

  it("timestamp futuro (nowMs - ts < 0) não conta como 'na última semana' — proteção contra relógio desincronizado", () => {
    const future = new Date(new Date(NOW).getTime() + 24 * 60 * 60 * 1000).toISOString();
    const d = evaluateCadence({ candidateOpenedAt: [future], digestSentAt: [], liveCalibratableParamCount: 5 }, NOW);
    assert.equal(d.canOpenNewCandidate, true);
  });

  it("timestamp inválido (data não-parseável) é ignorado, não quebra o cálculo nem conta como bloqueio", () => {
    const d = evaluateCadence({ candidateOpenedAt: ["não-é-uma-data"], digestSentAt: [], liveCalibratableParamCount: 5 }, NOW);
    assert.equal(d.canOpenNewCandidate, true);
  });

  it("constantes exportadas batem com o texto do design (#7972 §4)", () => {
    assert.equal(MAX_NEW_CANDIDATES_PER_WEEK, 1);
    assert.equal(MAX_SIGNOFF_DIGESTS_PER_WEEK, 1);
    assert.equal(MAX_LIVE_CALIBRATABLE_PARAMS, 15);
  });
});

describe("rankQueuedCandidates (#7979)", () => {
  it("ordena por value (effectSize × confidence) desc", () => {
    const ranked = rankQueuedCandidates([
      { feature: "a", effectSize: 0.1, confidence: 0.9 },
      { feature: "b", effectSize: 0.5, confidence: 0.9 },
      { feature: "c", effectSize: 0.3, confidence: 0.5 },
    ]);
    assert.deepEqual(ranked.map((c) => c.feature), ["b", "c", "a"]);
  });

  it("empate em value: desempata por nome de feature (ordem alfabética, determinístico)", () => {
    const ranked = rankQueuedCandidates([
      { feature: "zebra", effectSize: 0.5, confidence: 0.5 },
      { feature: "abacate", effectSize: 0.5, confidence: 0.5 },
    ]);
    assert.deepEqual(ranked.map((c) => c.feature), ["abacate", "zebra"]);
  });

  it("lista vazia: retorna vazio", () => {
    assert.deepEqual(rankQueuedCandidates([]), []);
  });

  it("value é computado corretamente (effectSize × confidence)", () => {
    const ranked = rankQueuedCandidates([{ feature: "x", effectSize: 0.4, confidence: 0.5 }]);
    assert.equal(ranked[0].value, 0.2);
  });
});
