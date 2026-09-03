/**
 * verify-utm-attribution.test.ts (#5545, migrado pro Kit no #7359)
 *
 * Cobre o núcleo puro (evaluateArm/formatVerdictTable) com fixtures — o
 * lookup de rede real (`getKitSubscriberByEmail`) já tem cobertura própria
 * em `kit-subscribers.test.ts`/testes de `count-subscriptions-by-utm.ts`,
 * não duplicado aqui.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { evaluateArm, formatVerdictTable, type ArmVerdict } from "../scripts/verify-utm-attribution.ts";
import { buildPreflightPlan } from "../scripts/lib/preflight-utm-arms.ts";
import type { KitSubscriberSummary } from "../scripts/lib/kit-subscribers.ts";

const CAMPAIGN = "preflight-2609";
const [googleAdsPlan] = buildPreflightPlan(CAMPAIGN);

function kitSub(fields: Record<string, string> = {}): KitSubscriberSummary {
  return { id: 1, email_address: googleAdsPlan.email, state: "active", created_at: "x", fields };
}

describe("evaluateArm (#5545, Kit desde #7359)", () => {
  it("PASSOU quando fields.utm_source/utm_campaign batem exato", () => {
    const sub = kitSub({ utm_source: "google-ads", utm_medium: "cpc", utm_campaign: CAMPAIGN });
    const v = evaluateArm(googleAdsPlan, CAMPAIGN, sub);
    assert.equal(v.passed, true);
    assert.equal(v.subscription_found, true);
    assert.equal(v.found_utm_source, "google-ads");
    assert.equal(v.found_utm_campaign, CAMPAIGN);
  });

  it("FALHOU quando não há registro no Kit (subscriber null)", () => {
    const v = evaluateArm(googleAdsPlan, CAMPAIGN, null);
    assert.equal(v.passed, false);
    assert.equal(v.subscription_found, false);
    assert.match(v.reason ?? "", /sem registro no Kit/);
  });

  it('FALHOU quando fields.utm_source vem "direct" em vez do braço', () => {
    const sub = kitSub({ utm_source: "direct", utm_campaign: CAMPAIGN });
    const v = evaluateArm(googleAdsPlan, CAMPAIGN, sub);
    assert.equal(v.passed, false);
    assert.match(v.reason ?? "", /utm_source obtido/);
  });

  it("FALHOU quando fields.utm_source vem vazio/ausente", () => {
    const sub = kitSub({ utm_campaign: CAMPAIGN });
    const v = evaluateArm(googleAdsPlan, CAMPAIGN, sub);
    assert.equal(v.passed, false);
    assert.equal(v.found_utm_source, null);
  });

  it("FALHOU quando fields ausente por completo (sem attribution.utm_source como fallback — Kit nunca populariza isso via API)", () => {
    const sub = kitSub();
    const v = evaluateArm(googleAdsPlan, CAMPAIGN, sub);
    assert.equal(v.passed, false);
    assert.equal(v.found_utm_source, null);
  });

  it("FALHOU quando utm_campaign não sobrevive (ex: veio de outro teste)", () => {
    const sub = kitSub({ utm_source: "google-ads", utm_campaign: "outra-campanha" });
    const v = evaluateArm(googleAdsPlan, CAMPAIGN, sub);
    assert.equal(v.passed, false);
    assert.match(v.reason ?? "", /utm_campaign obtido/);
  });
});

describe("formatVerdictTable (#5545)", () => {
  it("reporta RESULTADO GERAL: PASSOU quando os 3 braços passam", () => {
    const verdicts: ArmVerdict[] = [
      {
        arm: "google-ads",
        email: "a@x.com",
        expected_utm_source: "google-ads",
        expected_utm_campaign: CAMPAIGN,
        found_utm_source: "google-ads",
        found_utm_campaign: CAMPAIGN,
        subscription_found: true,
        passed: true,
      },
    ];
    const out = formatVerdictTable(verdicts);
    assert.match(out, /RESULTADO GERAL: PASSOU \(1\/1 braços\)/);
  });

  it("reporta RESULTADO GERAL: FALHOU e o motivo quando algum braço falha", () => {
    const verdicts: ArmVerdict[] = [
      {
        arm: "meta-ads",
        email: "b@x.com",
        expected_utm_source: "meta-ads",
        expected_utm_campaign: CAMPAIGN,
        found_utm_source: "direct",
        found_utm_campaign: CAMPAIGN,
        subscription_found: true,
        passed: false,
        reason: 'utm_source obtido ("direct") difere do esperado ("meta-ads")',
      },
    ];
    const out = formatVerdictTable(verdicts);
    assert.match(out, /RESULTADO GERAL: FALHOU \(0\/1 braços\)/);
    assert.match(out, /FALHOU — utm_source obtido/);
  });
});
