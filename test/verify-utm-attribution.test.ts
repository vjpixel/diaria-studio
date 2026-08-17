/**
 * verify-utm-attribution.test.ts (#5545)
 *
 * Cobre o núcleo puro (evaluateArm/formatVerdictTable) com fixtures, e
 * fetchSubscriptionBody com fetch mockado (nenhuma chamada de rede real —
 * regra de dispatch overnight/#738).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  evaluateArm,
  formatVerdictTable,
  fetchSubscriptionBody,
  type ArmVerdict,
} from "../scripts/verify-utm-attribution.ts";
import { buildPreflightPlan } from "../scripts/lib/preflight-utm-arms.ts";
import type { OrigemEntryFields } from "../scripts/lib/cac.ts";

const CAMPAIGN = "preflight-2608";
const [googleAdsPlan] = buildPreflightPlan(CAMPAIGN);
const EMPTY_ORIGEM_INDEX = new Map<string, OrigemEntryFields>();

describe("evaluateArm (#5545)", () => {
  it("PASSOU quando utm_source e utm_campaign batem exato", () => {
    const body = {
      data: { utm_source: "google-ads", utm_medium: "cpc", utm_campaign: CAMPAIGN },
    };
    const v = evaluateArm(googleAdsPlan, CAMPAIGN, body, EMPTY_ORIGEM_INDEX);
    assert.equal(v.passed, true);
    assert.equal(v.subscription_found, true);
    assert.equal(v.found_utm_source, "google-ads");
    assert.equal(v.found_utm_campaign, CAMPAIGN);
  });

  it("FALHOU quando não há registro na Beehiiv (body null — 404)", () => {
    const v = evaluateArm(googleAdsPlan, CAMPAIGN, null, EMPTY_ORIGEM_INDEX);
    assert.equal(v.passed, false);
    assert.equal(v.subscription_found, false);
    assert.match(v.reason ?? "", /sem registro/);
  });

  it('FALHOU quando utm_source vem "direct" em vez do braço', () => {
    const body = { data: { utm_source: "direct", utm_campaign: CAMPAIGN } };
    const v = evaluateArm(googleAdsPlan, CAMPAIGN, body, EMPTY_ORIGEM_INDEX);
    assert.equal(v.passed, false);
    assert.match(v.reason ?? "", /utm_source obtido/);
  });

  it("FALHOU quando utm_source vem vazio/ausente", () => {
    const body = { data: { utm_campaign: CAMPAIGN } };
    const v = evaluateArm(googleAdsPlan, CAMPAIGN, body, EMPTY_ORIGEM_INDEX);
    assert.equal(v.passed, false);
    assert.equal(v.found_utm_source, null);
  });

  it("FALHOU quando utm_campaign não sobrevive (ex: veio de outro teste)", () => {
    const body = { data: { utm_source: "google-ads", utm_campaign: "outra-campanha" } };
    const v = evaluateArm(googleAdsPlan, CAMPAIGN, body, EMPTY_ORIGEM_INDEX);
    assert.equal(v.passed, false);
    assert.match(v.reason ?? "", /utm_campaign obtido/);
  });

  it("usa a origem do mapa origem-original.json quando presente (mesma derivação do cac-report)", () => {
    const body = { data: { utm_source: "brevo-diaria", utm_campaign: CAMPAIGN } };
    const idx = new Map<string, OrigemEntryFields>([
      [googleAdsPlan.email.toLowerCase(), { utm_source: "google-ads", referring_site: "" }],
    ]);
    const v = evaluateArm(googleAdsPlan, CAMPAIGN, body, idx);
    assert.equal(v.found_via_origem_override, true);
    assert.equal(v.found_utm_source, "google-ads");
    assert.equal(v.passed, true);
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
        found_via_origem_override: false,
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
        found_via_origem_override: false,
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

describe("fetchSubscriptionBody (#5545) — fetch mockado, sem rede real", () => {
  it("retorna null em 404", async () => {
    const fetchImpl = (async () => new Response(null, { status: 404 })) as unknown as typeof fetch;
    const body = await fetchSubscriptionBody("pub_1", "key", "a@x.com", fetchImpl);
    assert.equal(body, null);
  });

  it("retorna o corpo parseado em 200", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ data: { utm_source: "google-ads" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const body = await fetchSubscriptionBody("pub_1", "key", "a@x.com", fetchImpl);
    assert.deepEqual(body, { data: { utm_source: "google-ads" } });
  });

  it("lança em erro HTTP diferente de 404", async () => {
    const fetchImpl = (async () => new Response("erro", { status: 500 })) as unknown as typeof fetch;
    await assert.rejects(() => fetchSubscriptionBody("pub_1", "key", "a@x.com", fetchImpl));
  });
});
