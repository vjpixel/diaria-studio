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
// Tests: getCouponUsage — PII guard + KV-first behavior (#2718, #2726)
// ---------------------------------------------------------------------------

describe("getCouponUsage — PII guard (/api/coupons)", () => {
  // Env sem STATS_CACHE: testa o guard de flag e o fallback "sem Stripe + sem KV → null"
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const makeEnv = (opts: { tabEnabled?: string; apiKey?: string }) =>
    ({
      COUPONS_TAB_ENABLED: opts.tabEnabled,
      STRIPE_API_KEY: opts.apiKey,
      STATS_CACHE: undefined as any, // KVNamespace só disponível no runtime do Worker
    }) as any;

  it("retorna null quando COUPONS_TAB_ENABLED está ausente", async () => {
    const result = await getCouponUsage(makeEnv({}), false);
    assert.equal(result, null, "deve retornar null → rota retornaria 404");
  });

  it("retorna null quando COUPONS_TAB_ENABLED='false'", async () => {
    const result = await getCouponUsage(makeEnv({ tabEnabled: "false" }), false);
    assert.equal(result, null, "deve retornar null → rota retornaria 404");
  });

  it("retorna null quando KV e STRIPE_API_KEY estão ausentes (flag ON)", async () => {
    // Cobre o path: STATS_CACHE undefined → sem KV → sem Stripe key → null
    const result = await getCouponUsage(makeEnv({ tabEnabled: "true" }), false);
    assert.equal(result, null, "KV vazio + sem Stripe key → deve retornar null → rota retornaria 404");
  });

  // Regressão #2726: o comportamento KV-first (cobre o path principal do PR)
  it("retorna dados do KV mesmo sem STRIPE_API_KEY quando KV tem dados (isFresh=false)", async () => {
    const mockKv = { get: async () => syntheticUsage, put: async () => {} };
    const result = await getCouponUsage(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { COUPONS_TAB_ENABLED: "true", STRIPE_API_KEY: undefined, STATS_CACHE: mockKv as any },
      false,
    );
    assert.notEqual(result, null, "KV hit deve retornar dados mesmo sem STRIPE_API_KEY");
    assert.deepEqual(result, syntheticUsage);
  });

  it("retorna dados do KV quando isFresh=true mas STRIPE_API_KEY ausente (KV-only deployment)", async () => {
    // Em KV-only, isFresh=true não tem fonte mais fresca que o KV — deve servir KV.
    const mockKv = { get: async () => syntheticUsage, put: async () => {} };
    const result = await getCouponUsage(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { COUPONS_TAB_ENABLED: "true", STRIPE_API_KEY: undefined, STATS_CACHE: mockKv as any },
      true, // isFresh=true
    );
    assert.notEqual(result, null, "KV-only + isFresh=true: sem Stripe disponível → retorna KV como melhor disponível");
    assert.deepEqual(result, syntheticUsage);
  });

  it("retorna null quando isFresh=true, KV vazio e STRIPE_API_KEY ausente", async () => {
    const mockKv = { get: async () => null, put: async () => {} };
    const result = await getCouponUsage(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { COUPONS_TAB_ENABLED: "true", STRIPE_API_KEY: undefined, STATS_CACHE: mockKv as any },
      true,
    );
    assert.equal(result, null, "isFresh=true + KV vazio + sem Stripe → null");
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

    it("contém o painel de cupons (div id=panel-cupons)", () => {
      // #2741: checa o DIV do painel, não a string crua — o seletor CSS
      // `#panel-cupons` é estático (sempre no <style>), então `includes("panel-cupons")`
      // passaria mesmo sem o painel. Simétrico com o teste PII-off do bloco (b).
      assert.ok(html.includes('id="panel-cupons"'), "deve conter o div do painel de cupons");
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

    // Regressão #2741: a aba de Cupons foi adicionada (#2718) mas as regras CSS
    // `:checked` esqueceram os cupons — o label aparecia mas clicar não exibia o
    // painel (ficava display:none). Sintoma: "a aba não tem conteúdo".
    it("CSS exibe o painel quando a aba Cupons é selecionada (regra :checked)", () => {
      assert.ok(
        html.includes("#tab-cupons:checked ~ .tab-panels #panel-cupons"),
        "sem esta regra, clicar na aba Cupons não mostra o painel (fica display:none)",
      );
    });

    it("CSS destaca o label da aba Cupons quando selecionada", () => {
      assert.ok(
        html.includes('#tab-cupons:checked ~ .tab-bar label[for="tab-cupons"]'),
        "aba Cupons deve receber o estilo de aba ativa quando selecionada",
      );
    });
  });

  describe("(b) com null (PII-off guarantee)", () => {
    const html = renderDashboardHtml(emptyCampaigns, [], null, null, null, null);

    it("NÃO contém o painel de cupons (div id=panel-cupons)", () => {
      // #2741: a regra CSS `#panel-cupons` é estática (sempre no <style>), então
      // checamos o DIV do painel — não a string crua — pra não confundir seletor
      // com conteúdo. O painel/PII só é renderizado quando couponUsage != null.
      assert.ok(!html.includes('id="panel-cupons"'), "div do painel de cupons não deve aparecer quando desabilitado");
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
