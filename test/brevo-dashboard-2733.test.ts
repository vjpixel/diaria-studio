/**
 * test/brevo-dashboard-2733.test.ts (#2733)
 *
 * Regressão: durante rate-limit do Brevo, as abas KV-independentes (Cupons,
 * Contatos) NÃO congelam junto com o fallback — devem renderizar FRESCAS do KV.
 *
 * O bug original (#2733): o fallback #2280 servia o HTML inteiro do último render
 * bom (que podia ser pré-deploy, sem a aba de Cupons). Enquanto o Brevo estivesse
 * em rate-limit, dado KV recém-publicado ficava escondido por até 1h.
 *
 * O fix re-renderiza no 429 com campanhas cruas do KV (stale) + `readKvTabs`
 * (fresco). Testamos as peças unitárias que compõem esse caminho:
 *   (a) readKvTabs lê Cupons/Contatos do KV independente do Brevo.
 *   (b) renderDashboardHtml com campanhas STALE ([] ou do cache) + cupons frescos
 *       produz a aba de Cupons.
 *   (c) buildStaleResponse preserva a aba de Cupons + injeta o banner de rate-limit.
 *
 * Fixtures 100% sintéticas — nenhum id/email real.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  readKvTabs,
  renderDashboardHtml,
  buildStaleResponse,
  buildRateLimitFallback,
  COUPONS_KV_KEY,
  COHORTS_KV_KEY,
  MV_STATUS_KV_KEY,
  CONTACTS_SUMMARY_KV_KEY,
  EIA_ENGAGEMENT_KV_KEY,
  LASTGOOD_CAMPAIGNS_KEY,
  type ContactsSummary,
} from "../workers/brevo-dashboard/src/index.ts";
import type { CouponUsageReport } from "../scripts/lib/stripe-coupons.ts";

const syntheticCoupons: CouponUsageReport = {
  NEWS50: {
    couponIds: ["cpnSYNTH50"],
    timesRedeemed: 1,
    rowCount: 1,
    totalProjectedDiscountCents: 22450,
    redemptions: [
      {
        coupon_code: "NEWS50",
        coupon_id: "cpnSYNTH50",
        percent_off: 50,
        duration: "once",
        customer: "cus_TEST1",
        customer_email: "test1@example.com",
        subscription: "sub_SYNTH1",
        status: "active",
        created: 1782383062,
        plan_amount_cents: 44900,
        currency: "brl",
        interval: "year",
        discount_value_cents: 22450,
      },
    ],
  },
};

const syntheticContacts: ContactsSummary = {
  generated_at: "2026-06-30T23:00:00.000Z",
  total: 100,
  brevo: { synced_rows: 40, has_signal: true },
  by_tier: { "1": 10, "2": 20 },
  eligibility: { eligible: 95, ineligible: 5, by_reason: { mv_rejected: 5 } },
  priority_points: { lt0: 3, eq0: 90, p1_40: 6, p41_80: 1, gt80: 0, optin: 0 },
  mv: { verified: 40, none: 60 },
  engagement: { with_opens: 12, with_clicks: 3 },
};

// KV mock que honra `.get(key, "json")` → objeto parseado; `.get(key)` → string.
function makeKv(initial: Record<string, string>) {
  const store = new Map(Object.entries(initial));
  return {
    get: async (key: string, type?: string) => {
      const val = store.get(key);
      if (val == null) return null;
      return type === "json" ? JSON.parse(val) : val;
    },
    put: async (key: string, value: string) => { store.set(key, value); },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe("#2733 — abas KV não congelam no rate-limit do Brevo", () => {
  it("readKvTabs lê as 5 seções KV (Cupons/Contatos/coortes/MV/É IA?) independente do Brevo", async () => {
    const kv = makeKv({
      [COUPONS_KV_KEY]: JSON.stringify(syntheticCoupons),
      [CONTACTS_SUMMARY_KV_KEY]: JSON.stringify(syntheticContacts),
      [COHORTS_KV_KEY]: JSON.stringify({ marker: "cohorts-fixture" }),
      [MV_STATUS_KV_KEY]: JSON.stringify({ marker: "mv-fixture" }),
      [EIA_ENGAGEMENT_KV_KEY]: JSON.stringify({ editions: [{ edition: "260418", total_votes: 1, voted_a: 1, voted_b: 0, pct_correct: 100, correct_choice: "A" }], updated_at: "2026-07-01T09:00:00.000Z" }),
    });
    const env = { COUPONS_TAB_ENABLED: "true", STATS_CACHE: kv };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { couponUsage, contactsSummary, cohorts, mvStatus, eiaEngagement } = await readKvTabs(env as any, false);
    assert.notEqual(couponUsage, null, "Cupons deve vir do KV");
    assert.deepEqual(couponUsage, syntheticCoupons);
    assert.notEqual(contactsSummary, null, "Contatos deve vir do KV");
    assert.equal(contactsSummary?.total, 100);
    assert.notEqual(cohorts, null, "coortes devem vir do KV");
    assert.notEqual(mvStatus, null, "status MV deve vir do KV");
    assert.notEqual(eiaEngagement, null, "engajamento do É IA? deve vir do KV (#2738)");
    assert.equal(eiaEngagement?.editions[0]?.edition, "260418");
  });

  it("readKvTabs retorna null para seções ausentes no KV (sem crashar)", async () => {
    const kv = makeKv({ [COUPONS_KV_KEY]: JSON.stringify(syntheticCoupons) });
    const env = { COUPONS_TAB_ENABLED: "true", STATS_CACHE: kv };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { cohorts, mvStatus, contactsSummary, eiaEngagement } = await readKvTabs(env as any, false);
    assert.equal(cohorts, null);
    assert.equal(mvStatus, null);
    assert.equal(contactsSummary, null);
    assert.equal(eiaEngagement, null, "#2738: também deve degradar pra null sem quebrar");
  });

  it("render com campanhas STALE vazias + cupons frescos → aba de Cupons presente", () => {
    // Simula o caminho do catch: staleCampaigns=[] (cache miss) mas cupons do KV.
    const html = renderDashboardHtml([], [], null, null, syntheticContacts, syntheticCoupons);
    assert.ok(html.includes("tablabel-cupons"), "label da aba Cupons presente mesmo sem campanhas");
    assert.ok(html.includes("panel-cupons"), "painel de Cupons presente");
    assert.ok(html.includes("panel-contatos"), "painel de Contatos presente");
    assert.ok(html.includes("test1@example.com"), "dado de cupom renderizado");
  });

  it("buildStaleResponse preserva a aba de Cupons + injeta banner de rate-limit", async () => {
    const html = renderDashboardHtml([], [], null, null, syntheticContacts, syntheticCoupons);
    const resp = buildStaleResponse(html, 120);
    assert.strictEqual(resp.status, 200, "fallback é 200, não 503");
    assert.strictEqual(resp.headers.get("X-Dashboard-Stale"), "rate-limit");
    const body = await resp.text();
    assert.ok(body.includes("tablabel-cupons"), "aba Cupons sobrevive ao fallback de rate-limit");
    assert.ok(body.includes("panel-contatos"), "aba Contatos sobrevive ao fallback");
    assert.ok(body.includes("rate-limit"), "banner de rate-limit injetado");
    assert.ok(body.includes("Cupons e Contatos estão atualizados"), "banner deixa claro que KV está fresco");
  });

  it("cache de campanhas cruas (LASTGOOD_CAMPAIGNS_KEY) tem o shape { campaigns, scheduled }", async () => {
    // Documenta/verifica o contrato lido pelo catch: as campanhas stale vêm desse
    // envelope. Sem cache → catch usa [] (coberto pelo teste de render acima).
    const kv = makeKv({
      [LASTGOOD_CAMPAIGNS_KEY]: JSON.stringify({ campaigns: [{ id: 1 }], scheduled: [{ id: 2 }] }),
    });
    const raw = (await kv.get(LASTGOOD_CAMPAIGNS_KEY, "json")) as {
      campaigns?: unknown[];
      scheduled?: unknown[];
    };
    assert.ok(Array.isArray(raw.campaigns) && raw.campaigns.length === 1, "campaigns no envelope");
    assert.ok(Array.isArray(raw.scheduled) && raw.scheduled.length === 1, "scheduled no envelope");
  });

  it("COUPONS_TAB_ENABLED != true → readKvTabs não expõe cupons (PII gate mantido)", async () => {
    const kv = makeKv({ [COUPONS_KV_KEY]: JSON.stringify(syntheticCoupons) });
    const env = { COUPONS_TAB_ENABLED: "false", STATS_CACHE: kv };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { couponUsage } = await readKvTabs(env as any, false);
    assert.equal(couponUsage, null, "flag OFF → cupons null mesmo com KV populado");
  });
});

// ---------------------------------------------------------------------------
// buildRateLimitFallback — o CAMINHO que tinha o bug (#2733 + #633).
// Exercita a lógica real do catch de 429: lê campanhas stale + readKvTabs FRESCO
// + render + banner, com guardas de shape e throw-safety. Se alguém reverter o
// fallback pra servir HTML congelado, estes testes falham.
// ---------------------------------------------------------------------------

describe("buildRateLimitFallback (#2733 — fallback de 429 não congela abas KV)", () => {
  it("serve Cupons FRESCOS do KV + banner de rate-limit (o fix do #2733)", async () => {
    // Cache de campanhas ausente → staleCampaigns=[]; cupons vêm do KV FRESCO.
    const kv = makeKv({
      [COUPONS_KV_KEY]: JSON.stringify(syntheticCoupons),
      [CONTACTS_SUMMARY_KV_KEY]: JSON.stringify(syntheticContacts),
    });
    const env = { COUPONS_TAB_ENABLED: "true", STATS_CACHE: kv };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const resp = await buildRateLimitFallback(env as any, 120);
    assert.strictEqual(resp.status, 200, "fallback é 200 (stale), não 503");
    assert.strictEqual(resp.headers.get("X-Dashboard-Stale"), "rate-limit");
    const body = await resp.text();
    assert.ok(body.includes("tablabel-cupons"), "aba Cupons FRESCA sobrevive ao 429");
    assert.ok(body.includes("test1@example.com"), "dado de cupom do KV renderizado");
    assert.ok(body.includes("panel-contatos"), "aba Contatos presente");
    assert.ok(body.includes("rate-limit"), "banner de rate-limit injetado");
  });

  it("KV miss de cupons + STRIPE_API_KEY configurada → ZERO chamada externa (#2779)", async () => {
    // Regressão #2779: o fallback de rate-limit é desenhado pra não depender de
    // NENHUMA chamada externa — mas um KV miss em `coupons:usage` com
    // STRIPE_API_KEY setada caía no fetchCouponUsage ao vivo (isFresh=false não
    // cobria o miss). Cenário real: 429 do Brevo + TTL de 300s dos cupons
    // expirado no mesmo instante (cold start / primeiro deploy).
    const kv = makeKv({
      [CONTACTS_SUMMARY_KV_KEY]: JSON.stringify(syntheticContacts),
      // sem COUPONS_KV_KEY → miss
    });
    const env = { COUPONS_TAB_ENABLED: "true", STRIPE_API_KEY: "sk_test_synthetic", STATS_CACHE: kv };
    const realFetch = globalThis.fetch;
    const externalCalls: string[] = [];
    globalThis.fetch = (async (input: unknown) => {
      externalCalls.push(String(input));
      throw new Error("chamada externa proibida no fallback de rate-limit");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const resp = await buildRateLimitFallback(env as any, 120);
      assert.strictEqual(resp.status, 200, "fallback continua servindo o stale 200");
      const body = await resp.text();
      assert.ok(body.includes("panel-contatos"), "abas de KV presentes normalmente");
      assert.deepEqual(externalCalls, [], "o caminho de erro NUNCA faz chamada externa (Stripe incluso)");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("STATS_CACHE ausente → 503 amigável (nunca crasha)", async () => {
    const env = { COUPONS_TAB_ENABLED: "true", STATS_CACHE: undefined };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const resp = await buildRateLimitFallback(env as any, 90);
    assert.strictEqual(resp.status, 503, "sem KV → rateLimitResponse 503");
  });

  it("KV corrompido (campaigns não-array) → guard Array.isArray, NUNCA 500/throw", async () => {
    const kv = makeKv({
      [COUPONS_KV_KEY]: JSON.stringify(syntheticCoupons),
      // valor corrompido: campaigns como string em vez de array
      [LASTGOOD_CAMPAIGNS_KEY]: JSON.stringify({ campaigns: "corrompido", scheduled: 0 }),
    });
    const env = { COUPONS_TAB_ENABLED: "true", STATS_CACHE: kv };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await assert.doesNotReject(() => buildRateLimitFallback(env as any, 60), "não deve lançar");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const resp = await buildRateLimitFallback(env as any, 60);
    assert.ok(resp.status === 200 || resp.status === 503, "degrada graciosamente (200 stale ou 503)");
    const body = await resp.text();
    assert.ok(body.includes("tablabel-cupons") || resp.status === 503, "cupons ainda frescos no 200");
  });
});
