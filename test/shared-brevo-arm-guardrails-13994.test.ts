/**
 * #13994: os guardrails por braço (`evaluateArmGuardrails`,
 * `CTA_SPAM_BREACH_YELLOW_PCT`) e os formatadores BRT (`fmtTimeBRT`,
 * `fmtClockBRT`) saíram do Worker brevo-dashboard para `scripts/lib/shared/`,
 * para o pipeline e o Studio pararem de importar `workers/*\/src`. O Worker
 * reexporta. Este teste trava que o Worker e o pipeline usam a MESMA função
 * (referência idêntica), não duas cópias que podem divergir em silêncio.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import * as shared from "../scripts/lib/shared/brevo-arm-guardrails.ts";
import * as worker from "../workers/brevo-dashboard/src/experiment-cta.ts";
import * as sharedBrt from "../scripts/lib/shared/brt.ts";
import * as renderLinks from "../workers/brevo-dashboard/src/render-links.ts";
import * as workerIndex from "../workers/brevo-dashboard/src/index.ts";

describe("#13994: núcleos do brevo-dashboard em scripts/lib/shared", () => {
  it("experiment-cta reexporta os guardrails de shared/ (mesma referência)", () => {
    assert.equal(worker.evaluateArmGuardrails, shared.evaluateArmGuardrails);
    assert.equal(worker.CTA_SPAM_BREACH_YELLOW_PCT, shared.CTA_SPAM_BREACH_YELLOW_PCT);
    assert.equal(workerIndex.evaluateArmGuardrails, shared.evaluateArmGuardrails);
  });

  it("render-links reexporta fmtTimeBRT/fmtClockBRT de shared/brt.ts", () => {
    assert.equal(renderLinks.fmtTimeBRT, sharedBrt.fmtTimeBRT);
    assert.equal(renderLinks.fmtClockBRT, sharedBrt.fmtClockBRT);
    assert.equal(workerIndex.fmtTimeBRT, sharedBrt.fmtTimeBRT);
  });

  it("evaluateArmGuardrails mantém o comportamento (spam pelo limiar próprio, zero com treatZeroAsBreach)", () => {
    const m: shared.ArmMetrics = {
      armId: "a", label: "A", campaignCount: 1, sent: 1000, delivered: 1000, uniqueViews: 0,
      uniqueClicks: 0, decisionClicks: 0, unsubscriptions: 0, complaints: 1, hardBounces: 0, softBounces: 0,
    };
    const dash = shared.evaluateArmGuardrails(m);
    assert.equal(dash.spamRatePct, 0.1);
    assert.equal(dash.spamBreach, true);
    assert.equal(dash.openBreach, false, "0% de abertura na dashboard é dado propagando, não breach");
    assert.equal(shared.evaluateArmGuardrails(m, undefined, { treatZeroAsBreach: true }).openBreach, true);
  });

  it("fmtTimeBRT/fmtClockBRT: bordas preservadas", () => {
    assert.equal(sharedBrt.fmtTimeBRT(null), "—");
    assert.equal(sharedBrt.fmtTimeBRT("não-é-data"), "não-é-data");
    assert.equal(sharedBrt.fmtClockBRT(Number.NaN), "—");
    assert.match(sharedBrt.fmtClockBRT(Date.UTC(2026, 10, 28, 12, 5)), /09:05/);
  });
});
