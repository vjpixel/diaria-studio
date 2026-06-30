/**
 * test/dashboard-coupons-tab.test.ts (#2718)
 *
 * Cobre:
 *  (a) Com `couponUsage` sintético: output contém `panel-cupons` e o email de teste.
 *  (b) Com `null`: output NÃO contém `panel-cupons` NEM nenhum email — garantia PII-off.
 *  (c) As 4 abas existentes estão presentes em ambos os casos.
 *
 * Usa fixtures 100% sintéticas: nenhum id real nem email real commitado.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  renderDashboardHtml,
  renderCouponTabPanel,
  getCouponUsage,
} from "../workers/brevo-dashboard/src/index.ts";
import type { CouponUsageReport } from "../scripts/lib/stripe-coupons.ts";

// ---------------------------------------------------------------------------
// Fixture sintética — IDs e emails exclusivamente @example.com
// ---------------------------------------------------------------------------

const syntheticUsage: CouponUsageReport = {
  NEWS50: {
    couponIds: ["cpnSYNTH50"],
    timesRedeemed: 2,
    rowCount: 2,
    totalProjectedDiscountCents: 44900,
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
      {
        coupon_code: "NEWS50",
        coupon_id: "cpnSYNTH50",
        percent_off: 50,
        duration: "once",
        customer: "cus_TEST2",
        customer_email: "test2@example.com",
        subscription: "sub_SYNTH2",
        status: "trialing",
        created: 1782400000,
        plan_amount_cents: 44900,
        currency: "brl",
        interval: "year",
        discount_value_cents: 22450,
      },
    ],
  },
  NEWS25: {
    couponIds: ["cpnSYNTH25"],
    timesRedeemed: 1,
    rowCount: 1,
    totalProjectedDiscountCents: 7493,
    redemptions: [
      {
        coupon_code: "NEWS25",
        coupon_id: "cpnSYNTH25",
        percent_off: 25,
        duration: "repeating",
        customer: "cus_TEST3",
        customer_email: "test3@example.com",
        subscription: "sub_SYNTH3",
        status: "active",
        created: 1782450000,
        plan_amount_cents: 9990,
        currency: "brl",
        interval: "month",
        discount_value_cents: 7493,
      },
    ],
  },
};

// Campanhas mínimas para renderDashboardHtml não explodir
const emptyCampaigns: [] = [];

// ---------------------------------------------------------------------------
// Tests: getCouponUsage — PII guard para a rota /api/coupons
// Testável sem runtime do Worker porque o guard retorna null antes de tocar KV/Stripe.
// ---------------------------------------------------------------------------

describe("getCouponUsage — PII guard (/api/coupons)", () => {
  // Env mínima: sem STATS_CACHE (o guard retorna null antes de qualquer KV access)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const makeEnv = (opts: { tabEnabled?: string; apiKey?: string }) =>
    ({
      COUPONS_TAB_ENABLED: opts.tabEnabled,
      STRIPE_API_KEY: opts.apiKey,
      STATS_CACHE: undefined as any, // KVNamespace only available in Worker runtime
    }) as any;

  it("retorna null quando COUPONS_TAB_ENABLED está ausente", async () => {
    const result = await getCouponUsage(makeEnv({}), false);
    assert.equal(result, null, "deve retornar null → rota retornaria 404");
  });

  it("retorna null quando COUPONS_TAB_ENABLED='false'", async () => {
    const result = await getCouponUsage(makeEnv({ tabEnabled: "false" }), false);
    assert.equal(result, null, "deve retornar null → rota retornaria 404");
  });

  it("retorna null quando STRIPE_API_KEY está ausente (mesmo com flag ON)", async () => {
    const result = await getCouponUsage(makeEnv({ tabEnabled: "true" }), false);
    assert.equal(result, null, "sem chave Stripe → deve retornar null → rota retornaria 404");
  });
});

// ---------------------------------------------------------------------------
// Tests: renderCouponTabPanel (unitário, sem deps do dashboard)
// ---------------------------------------------------------------------------

describe("renderCouponTabPanel", () => {
  const html = renderCouponTabPanel(syntheticUsage);

  it("contém coupon-summary e coupon-detail", () => {
    assert.ok(html.includes("coupon-summary"), "deve ter seção coupon-summary");
    assert.ok(html.includes("coupon-detail"), "deve ter seção coupon-detail");
  });

  it("contém o email sintético test1@example.com", () => {
    assert.ok(html.includes("test1@example.com"), "deve listar test1@example.com");
  });

  it("escapa HTML no email (XSS-safe)", () => {
    const malicious: CouponUsageReport = {
      XSS: {
        couponIds: ["cpn_xss"],
        timesRedeemed: 1,
        rowCount: 1,
        totalProjectedDiscountCents: 0,
        redemptions: [
          {
            coupon_code: "XSS",
            coupon_id: "cpn_xss",
            percent_off: null,
            duration: "once",
            customer: "cus_xss",
            customer_email: '<script>alert("xss")</script>@example.com',
            subscription: "sub_xss",
            status: "active",
            created: 1782383062,
            plan_amount_cents: 0,
            currency: "brl",
            interval: "month",
            discount_value_cents: 0,
          },
        ],
      },
    };
    const h = renderCouponTabPanel(malicious);
    assert.ok(!h.includes("<script>"), "email malicioso deve ser escapado");
    assert.ok(h.includes("&lt;script&gt;"), "email escapado deve conter &lt;script&gt;");
  });
});

// ---------------------------------------------------------------------------
// Tests: renderDashboardHtml — tab habilitada vs. desabilitada
// ---------------------------------------------------------------------------

describe("renderDashboardHtml — couponUsage", () => {
  describe("(a) com fixture sintética (couponUsage != null)", () => {
    const html = renderDashboardHtml(emptyCampaigns, [], null, null, null, syntheticUsage);

    it("contém panel-cupons", () => {
      assert.ok(html.includes("panel-cupons"), "deve conter o painel de cupons");
    });

    it("contém tab-cupons (radio input)", () => {
      assert.ok(html.includes('id="tab-cupons"'), "deve conter o radio da aba");
    });

    it("contém tablabel-cupons (label)", () => {
      assert.ok(html.includes("tablabel-cupons"), "deve conter o label da aba");
    });

    it("contém o email sintético test1@example.com", () => {
      assert.ok(html.includes("test1@example.com"), "deve listar test1@example.com no painel");
    });
  });

  describe("(b) com null (PII-off guarantee)", () => {
    const html = renderDashboardHtml(emptyCampaigns, [], null, null, null, null);

    it("NÃO contém panel-cupons", () => {
      assert.ok(!html.includes("panel-cupons"), "panel-cupons não deve aparecer quando desabilitado");
    });

    it("NÃO contém tab-cupons (radio input)", () => {
      assert.ok(!html.includes('id="tab-cupons"'), "radio da aba não deve aparecer quando desabilitado");
    });

    it("NÃO contém tablabel-cupons", () => {
      assert.ok(!html.includes("tablabel-cupons"), "label da aba não deve aparecer quando desabilitado");
    });

    it("NÃO contém nenhum email @example.com (prova de PII-off)", () => {
      // Nenhum email de fixture pode vazar quando couponUsage é null
      assert.ok(!html.includes("test1@example.com"), "test1@example.com não deve aparecer");
      assert.ok(!html.includes("test2@example.com"), "test2@example.com não deve aparecer");
      assert.ok(!html.includes("test3@example.com"), "test3@example.com não deve aparecer");
      assert.ok(!html.includes("@example.com"), "nenhum @example.com deve aparecer");
    });
  });

  describe("(c) as 4 abas existentes estão presentes em ambos os casos", () => {
    const withCoupons = renderDashboardHtml(emptyCampaigns, [], null, null, null, syntheticUsage);
    const withoutCoupons = renderDashboardHtml(emptyCampaigns, [], null, null, null, null);

    for (const [label, html] of [
      ["com couponUsage", withCoupons],
      ["sem couponUsage (null)", withoutCoupons],
    ] as [string, string][]) {
      it(`panel-visaogeral presente [${label}]`, () => {
        assert.ok(html.includes("panel-visaogeral"), `panel-visaogeral deve estar presente [${label}]`);
      });
      it(`panel-engajamento presente [${label}]`, () => {
        assert.ok(html.includes("panel-engajamento"), `panel-engajamento deve estar presente [${label}]`);
      });
      it(`panel-links presente [${label}]`, () => {
        assert.ok(html.includes("panel-links"), `panel-links deve estar presente [${label}]`);
      });
      it(`panel-contatos presente [${label}]`, () => {
        assert.ok(html.includes("panel-contatos"), `panel-contatos deve estar presente [${label}]`);
      });
    }
  });
});
