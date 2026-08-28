import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  decideDmarcEnforcement,
  nextEnforcementStep,
  DEFAULT_DMARC_THRESHOLDS,
  MIN_VOLUME_FOR_DECISION,
  MIN_MATURITY_DAYS,
  type DmarcSignals,
} from "../scripts/lib/dmarc-enforcement-policy.ts";

function signals(over: Partial<DmarcSignals> = {}): DmarcSignals {
  return {
    totalConsidered: 200,
    bouncedCount: 0,
    complainedCount: 0,
    daysSinceFirstSend: MIN_MATURITY_DAYS,
    ...over,
  };
}

describe("nextEnforcementStep", () => {
  it("none -> quarantine -> reject -> reject (teto, nunca lança)", () => {
    assert.equal(nextEnforcementStep("none"), "quarantine");
    assert.equal(nextEnforcementStep("quarantine"), "reject");
    assert.equal(nextEnforcementStep("reject"), "reject");
  });
});

describe("decideDmarcEnforcement — volume insuficiente", () => {
  it("totalConsidered abaixo do piso => insufficient-volume, hold, nextPolicy null", () => {
    const d = decideDmarcEnforcement(
      signals({ totalConsidered: MIN_VOLUME_FOR_DECISION - 1, bouncedCount: 0, complainedCount: 0 }),
      "none",
    );
    assert.equal(d.level, "insufficient-volume");
    assert.equal(d.recommendation, "hold");
    assert.equal(d.nextPolicy, null);
  });

  it("totalConsidered === 0 não lança nem produz NaN (fallback pra 0%)", () => {
    const d = decideDmarcEnforcement(signals({ totalConsidered: 0, bouncedCount: 0, complainedCount: 0 }), "none");
    assert.equal(d.level, "insufficient-volume");
    assert.equal(d.bounceRatePct, 0);
    assert.equal(d.complaintRatePct, 0);
  });

  it("piso é INCLUSIVO do lado saudável — exatamente no piso, com sinal limpo e maduro, decide normalmente", () => {
    const d = decideDmarcEnforcement(
      signals({ totalConsidered: MIN_VOLUME_FOR_DECISION, bouncedCount: 0, complainedCount: 0 }),
      "none",
    );
    assert.notEqual(d.level, "insufficient-volume");
  });
});

describe("decideDmarcEnforcement — sinal não saudável (bounce/complaint)", () => {
  it("bounce >= limiar => unhealthy; política atual 'none' => recomendação hold (nada pra recuar)", () => {
    const bounced = Math.ceil((DEFAULT_DMARC_THRESHOLDS.bounce / 100) * 200);
    const d = decideDmarcEnforcement(signals({ bouncedCount: bounced, complainedCount: 0 }), "none");
    assert.equal(d.level, "unhealthy");
    assert.equal(d.recommendation, "hold");
    assert.equal(d.nextPolicy, null);
  });

  it("bounce >= limiar E política já escalada ('quarantine') => consider-rollback", () => {
    const bounced = Math.ceil((DEFAULT_DMARC_THRESHOLDS.bounce / 100) * 200) + 5;
    const d = decideDmarcEnforcement(signals({ bouncedCount: bounced }), "quarantine");
    assert.equal(d.level, "unhealthy");
    assert.equal(d.recommendation, "consider-rollback");
    // Decisão de rollback é sempre humana — nunca prescreve nextPolicy automático.
    assert.equal(d.nextPolicy, null);
  });

  it("complaint >= limiar (independente de bounce) também dispara unhealthy", () => {
    const complained = Math.ceil((DEFAULT_DMARC_THRESHOLDS.complaint / 100) * 200) + 1;
    const d = decideDmarcEnforcement(signals({ bouncedCount: 0, complainedCount: complained }), "none");
    assert.equal(d.level, "unhealthy");
    assert.match(d.reasons.join(" "), /complaint/);
  });

  it("logo abaixo do limiar de bounce (com o resto saudável e maduro) NÃO é unhealthy", () => {
    const belowThreshold = Math.floor((DEFAULT_DMARC_THRESHOLDS.bounce / 100) * 200) - 1;
    const d = decideDmarcEnforcement(signals({ bouncedCount: Math.max(0, belowThreshold), complainedCount: 0 }), "none");
    assert.notEqual(d.level, "unhealthy");
  });
});

describe("decideDmarcEnforcement — maturidade do domínio", () => {
  it("sinal limpo mas sem nenhum broadcast completado (daysSinceFirstSend null) => healthy-immature, hold", () => {
    const d = decideDmarcEnforcement(signals({ daysSinceFirstSend: null }), "none");
    assert.equal(d.level, "healthy-immature");
    assert.equal(d.recommendation, "hold");
    assert.equal(d.nextPolicy, null);
  });

  it("sinal limpo mas dias < piso de maturidade => healthy-immature, hold", () => {
    const d = decideDmarcEnforcement(signals({ daysSinceFirstSend: MIN_MATURITY_DAYS - 1 }), "none");
    assert.equal(d.level, "healthy-immature");
  });

  it("exatamente no piso de maturidade (inclusive) + sinal limpo => healthy, escalate", () => {
    const d = decideDmarcEnforcement(signals({ daysSinceFirstSend: MIN_MATURITY_DAYS }), "none");
    assert.equal(d.level, "healthy");
    assert.equal(d.recommendation, "escalate");
  });
});

describe("decideDmarcEnforcement — caminho feliz (healthy => escalate)", () => {
  it("none -> recomenda escalar pra quarantine", () => {
    const d = decideDmarcEnforcement(signals(), "none");
    assert.equal(d.level, "healthy");
    assert.equal(d.recommendation, "escalate");
    assert.equal(d.nextPolicy, "quarantine");
  });

  it("quarantine -> recomenda escalar pra reject", () => {
    const d = decideDmarcEnforcement(signals(), "quarantine");
    assert.equal(d.nextPolicy, "reject");
  });

  it("reject -> já no teto, nextPolicy continua 'reject' (não-op, nunca lança)", () => {
    const d = decideDmarcEnforcement(signals(), "reject");
    assert.equal(d.level, "healthy");
    assert.equal(d.nextPolicy, "reject");
  });
});

describe("decideDmarcEnforcement — nunca lança sobre entrada corrompida", () => {
  it("totalConsidered não-finito (NaN) => insufficient-volume, nunca NaN vazando pro nível", () => {
    const d = decideDmarcEnforcement(signals({ totalConsidered: NaN }), "none");
    assert.equal(d.level, "insufficient-volume");
    assert.equal(Number.isFinite(d.bounceRatePct), true);
    assert.equal(Number.isFinite(d.complaintRatePct), true);
  });

  it("bouncedCount negativo (corrompido) nunca produz taxa negativa nem 'unhealthy' fabricado", () => {
    const d = decideDmarcEnforcement(signals({ bouncedCount: -5 }), "none");
    assert.equal(d.bounceRatePct, 0);
  });
});
